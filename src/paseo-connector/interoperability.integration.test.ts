import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { get, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApplicationRuntime } from "../application-runtime.js";
import { composeEntitlements } from "../auth/entitlements.js";
import { createAuthServer, type AuthServer } from "../auth/server.js";
import type { DaemonConnection } from "../daemons/protocol.js";
import { createDatabase } from "../db/pg.js";
import {
  embeddedDatabaseRuntime,
  postgresDatabaseRuntime,
  type DatabaseRuntimeBundle,
} from "../db/runtime/index.js";
import type { Database } from "../db/types.js";
import { createFetchServer } from "../http/node-server.js";
import { Route as AuthorizationServerRoute } from "../routes/[.]well-known/oauth-authorization-server.js";
import { Route as ProtectedResourceRoute } from "../routes/[.]well-known/oauth-protected-resource/mcp/paseo.js";
import { Route as PaseoMcpRoute } from "../routes/mcp/paseo.js";
import { startApplication, stopApplication } from "../server/runtime.js";
import { CONNECTOR_FLOW_PARAM } from "./contracts.js";
import { ConnectorFlowError } from "./flow.js";
import {
  AgentsContent,
  Browser,
  callTool,
  connectMcp,
  daemonConnection,
  enrollConnectorDaemon,
  FakeDaemon,
  jwtClaims,
  OperationContent,
  toolError,
} from "./test-fixture.js";

/**
 * Any standards-compatible MCP client can link and use the Paseo Agent Connector: two unrelated
 * clients — a hosted app with an HTTPS callback and a native app with a loopback callback
 * (RFC 8252) — each discover, register, authorize and call the tools over real HTTP, and each
 * reaches only the connection its own consent created.
 */
const HOSTED_CLIENT = {
  name: "Example MCP Client",
  redirectUri: "https://client.example/oauth/callback",
};
const LOOPBACK_CLIENT = {
  name: "Loopback Desktop Agent",
  redirectUri: "http://127.0.0.1:43117/callback",
};
/** RFC 8252 §7.3: a native app's loopback listener gets whatever port is free at run time. */
const LOOPBACK_OTHER_PORT = "http://127.0.0.1:51234/callback";
const LOCALHOST_CLIENT = {
  name: "Localhost Desktop Agent",
  redirectUri: "http://localhost:43118/callback",
};
const SECRET = "connector-interop-test-secret-at-least-32-characters";
const SCOPES = "paseo:read paseo:run paseo:cancel offline_access";
const WORKING_DIRECTORY = "/srv/work/project";
const SEVEN_TOOLS = [
  "cancel_agent",
  "get_agent",
  "get_connection",
  "list_agents",
  "list_runtimes",
  "send_agent_message",
  "start_agent",
];

const ProtectedResourceMetadata = z.object({
  resource: z.string(),
  authorization_servers: z.array(z.string()).min(1),
});
const AuthorizationServerMetadata = z.object({
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string(),
  revocation_endpoint: z.string(),
});
const Tokens = z.object({ access_token: z.string(), refresh_token: z.string() });
const OAuthError = z.object({ error: z.string() });
const ConnectionContent = z.object({
  connectionId: z.string(),
  workingDirectory: z.string(),
});
const RuntimesContent = z.object({
  runtimes: z.array(
    z.object({
      provider: z.string(),
      status: z.string(),
      enabled: z.boolean(),
      models: z.array(z.object({ id: z.string(), isDefault: z.boolean() })),
      defaultModeId: z.string().nullable(),
    }),
  ),
});
const AgentContent = z.object({
  type: z.literal("agent"),
  agent: z.object({ agentId: z.string() }),
});

let postgres: StartedPostgreSqlContainer;
beforeAll(async () => {
  postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
}, 120_000);
afterAll(async () => {
  await postgres?.stop();
});

describe.each(["embedded", "postgres"] as const)(
  "Paseo Agent Connector interoperability on %s",
  (kind) => {
    let root: string;
    let bundle: DatabaseRuntimeBundle;
    let database: Database;
    let auth: AuthServer;
    let http: HttpServer;
    /** Hub's public origin: the loopback address this test's HTTP server listens on. */
    let origin: string;
    /** The machines currently connected to Hub. */
    const online = new Map<string, DaemonConnection>();

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "hub-connector-interop-"));
      if (kind === "embedded") {
        bundle = await embeddedDatabaseRuntime(join(root, "database"));
      } else {
        const url = new URL(postgres.getConnectionUri());
        url.pathname = `/connector_interop_${randomUUID().replaceAll("-", "")}`;
        bundle = await postgresDatabaseRuntime(url.href);
      }
      await bundle.runtime.migrate();
      database = createDatabase(bundle.runtime, bundle.locks);
      const mcpRoute = handlersOf<"POST">(PaseoMcpRoute.options.server?.handlers);
      const resourceRoute = handlersOf<"GET">(ProtectedResourceRoute.options.server?.handlers);
      const serverRoute = handlersOf<"GET">(AuthorizationServerRoute.options.server?.handlers);
      // Hub's auth handler, the connector MCP route and both discovery documents, as the app
      // server dispatches them.
      http = createFetchServer((request) => {
        const { pathname } = new URL(request.url);
        if (pathname.startsWith("/api/auth/")) return auth.handle(request);
        if (pathname === "/mcp/paseo" && request.method === "POST") {
          return mcpRoute.POST({ request });
        }
        if (pathname === "/.well-known/oauth-protected-resource/mcp/paseo") {
          return resourceRoute.GET({ request });
        }
        if (pathname === "/.well-known/oauth-authorization-server") {
          return serverRoute.GET({ request });
        }
        return new Response(null, { status: 404 });
      });
      http.listen(0, "127.0.0.1");
      await once(http, "listening");
      const address = http.address();
      if (address === null || typeof address === "string") throw new Error("not listening on TCP");
      origin = `http://127.0.0.1:${address.port}`;
      auth = createAuthServer({
        database: bundle.runtime,
        locks: bundle.locks,
        entitlements: composeEntitlements(database, bundle.runtime).service,
        secret: SECRET,
        baseURL: origin,
        policy: { registrationMode: "open", organizationCreation: "open", bootstrap: undefined },
        paseoConnector: true,
      });
      await startApplication(() =>
        createApplicationRuntime({
          database,
          auth,
          entitlements: composeEntitlements(database, bundle.runtime).service,
          billing: null,
          daemonConnectionForId: (daemonId) => online.get(daemonId),
          close: () => Promise.resolve(),
        }),
      );
    }, 120_000);

    afterAll(async () => {
      http?.closeAllConnections();
      http?.close();
      await stopApplication();
      await auth?.close();
      await bundle?.runtime.close();
      await rm(root, { recursive: true, force: true });
    });

    /** A Hub user who manages one enrolled, connected machine. */
    async function operator() {
      const browser = new Browser(auth, origin);
      await browser.signUp();
      const organizationId = await browser.createOrganization();
      const daemonId = await enrollConnectorDaemon(database, organizationId);
      const daemon = new FakeDaemon();
      online.set(daemonId, daemonConnection(daemon));
      return { browser, daemonId, daemon };
    }
    type Operator = Awaited<ReturnType<typeof operator>>;

    /**
     * What any MCP client does first: an unauthenticated MCP request, the protected-resource
     * metadata its challenge names, then the authorization server's metadata.
     */
    async function discover() {
      const challenged = await fetch(`${origin}/mcp/paseo`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      expect(challenged.status).toBe(401);
      const metadataUrl = /resource_metadata="([^"]+)"/u.exec(
        challenged.headers.get("www-authenticate") ?? "",
      )?.[1];
      expect(metadataUrl).toBeDefined();
      const resource = ProtectedResourceMetadata.parse(await (await fetch(metadataUrl!)).json());
      const server = AuthorizationServerMetadata.parse(
        await (
          await fetch(`${resource.authorization_servers[0]}/.well-known/oauth-authorization-server`)
        ).json(),
      );
      return { resource: resource.resource, ...server };
    }
    type Discovered = Awaited<ReturnType<typeof discover>>;

    /** RFC 7591 dynamic registration of a public client, with `scope` only when given. */
    async function register(
      discovered: Discovered,
      client: { name: string; redirectUri: string },
      scope?: string,
    ) {
      const response = await fetch(discovered.registration_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: client.name,
          redirect_uris: [client.redirectUri],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          ...(scope === undefined ? {} : { scope }),
        }),
      });
      expect(response.status).toBe(201);
      const { client_id } = z.object({ client_id: z.string() }).parse(await response.json());
      return { ...client, clientId: client_id, discovered };
    }
    type RegisteredClient = Awaited<ReturnType<typeof register>>;

    /**
     * The client's authorization request with PKCE S256 and the resource, as the browser sends
     * it. A `scope` of null leaves the parameter out.
     */
    async function requestAuthorization(
      user: Operator,
      client: RegisteredClient,
      redirectUri: string,
      scope: string | null = SCOPES,
    ) {
      const verifier = randomBytes(32).toString("base64url");
      const state = randomUUID();
      const authorization = await navigate(
        `${client.discovered.authorization_endpoint}?${new URLSearchParams({
          response_type: "code",
          client_id: client.clientId,
          redirect_uri: redirectUri,
          ...(scope === null ? {} : { scope }),
          state,
          code_challenge: createHash("sha256").update(verifier).digest("base64url"),
          code_challenge_method: "S256",
          resource: client.discovered.resource,
        }).toString()}`,
        user.browser.headers().get("cookie") ?? "",
      );
      expect(authorization.status).toBe(302);
      return { location: new URL(authorization.location ?? "", origin), verifier, state };
    }

    /**
     * The authorization request, then the user's own steps on Hub's connect and consent pages
     * (through the server-function surface those pages call). Returns the code the client's
     * callback receives.
     */
    async function authorize(
      user: Operator,
      client: RegisteredClient,
      redirectUri = client.redirectUri,
    ) {
      const {
        location: connect,
        verifier,
        state,
      } = await requestAuthorization(user, client, redirectUri);
      expect(connect.pathname).toBe("/oauth/connect");

      const connector = auth.connector!;
      const selected = await connector.selectMachine(
        {
          oauthQuery: connect.search,
          daemonId: user.daemonId,
          workingDirectory: WORKING_DIRECTORY,
        },
        user.browser.headers(),
      );
      const consentUrl = new URL(selected.redirectTo, origin);
      const flowId = consentUrl.searchParams.get(CONNECTOR_FLOW_PARAM) ?? "";
      consentUrl.searchParams.delete(CONNECTOR_FLOW_PARAM);
      const consent = { oauthQuery: consentUrl.search, flowId };
      // The consent page names the app that asked, by its own registration.
      expect(await connector.describeConsent(consent, user.browser.headers())).toMatchObject({
        clientName: client.name,
        redirectTarget: new URL(redirectUri).origin,
      });
      const approved = await connector.decideConsent(
        { ...consent, accept: true },
        user.browser.headers(),
      );
      const callback = new URL(approved.redirectTo);
      expect(`${callback.origin}${callback.pathname}`).toBe(redirectUri);
      expect(callback.searchParams.get("state")).toBe(state);
      const code = callback.searchParams.get("code");
      expect(code).not.toBeNull();
      return { code: code!, verifier, redirectUri };
    }

    function token(client: RegisteredClient, form: Record<string, string>): Promise<Response> {
      return fetch(client.discovered.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.clientId,
          resource: client.discovered.resource,
          ...form,
        }).toString(),
      });
    }

    /** The PKCE code exchange of `grant`, presented by `presenter`. */
    function exchange(
      presenter: RegisteredClient,
      grant: { code: string; verifier: string; redirectUri: string },
    ): Promise<Response> {
      return token(presenter, {
        grant_type: "authorization_code",
        code: grant.code,
        code_verifier: grant.verifier,
        redirect_uri: grant.redirectUri,
      });
    }

    async function link(user: Operator, client: RegisteredClient, redirectUri?: string) {
      const exchanged = await exchange(client, await authorize(user, client, redirectUri));
      expect(exchanged.status).toBe(200);
      return Tokens.parse(await exchanged.json());
    }

    async function oauthError(response: Response) {
      return { status: response.status, error: OAuthError.parse(await response.json()).error };
    }

    function connectionOf(accessToken: string): unknown {
      return jwtClaims(accessToken)[`${origin}/claims/paseo-connection`];
    }

    type Runtime = z.infer<typeof RuntimesContent>["runtimes"][number];
    const firstReady = (runtimes: Runtime[]) => runtimes.find(usable);
    const lastReady = (runtimes: Runtime[]) => runtimes.findLast(usable);
    function usable(runtime: Runtime): boolean {
      return runtime.status === "ready" && runtime.enabled;
    }

    /**
     * Starts an agent with the provider `pick` chooses from the client's own catalog, its
     * non-default model when it has one (else its default) and its default mode.
     */
    async function startFromCatalog(
      client: Client,
      pick: (runtimes: Runtime[]) => Runtime | undefined,
    ) {
      const { runtimes } = RuntimesContent.parse(
        (await callTool(client, "list_runtimes")).structured,
      );
      const runtime = pick(runtimes);
      expect(runtime).toBeDefined();
      const model = (runtime!.models.find((entry) => !entry.isDefault) ?? runtime!.models[0])?.id;
      const mode = runtime!.defaultModeId ?? undefined;
      const started = await callTool(client, "start_agent", {
        request_key: randomUUID(),
        task: "Make the suite green",
        title: "Fix tests",
        provider: runtime!.provider,
        ...(model === undefined ? {} : { model }),
        ...(mode === undefined ? {} : { mode }),
      });
      expect(started.isError).toBe(false);
      const operation = OperationContent.parse(started.structured);
      expect(operation.state).toBe("accepted");
      return { agentId: operation.agentId!, provider: runtime!.provider, model, mode };
    }

    async function listedAgents(client: Client): Promise<string[]> {
      return AgentsContent.parse((await callTool(client, "list_agents")).structured).agents.map(
        (agent) => agent.agentId,
      );
    }

    /** The owner reads its agent; the other client cannot reach it, and the machine never hears. */
    async function expectOwnedOnlyBy(
      owner: Client,
      other: Client,
      agentId: string,
      daemon: FakeDaemon,
    ) {
      const read = await callTool(owner, "get_agent", { agent_id: agentId });
      expect(AgentContent.parse(read.structured).agent.agentId).toBe(agentId);
      expect(await listedAgents(owner)).toContain(agentId);

      const reached = daemon.calls.filter((entry) => entry.agentId === agentId).length;
      const attempts: [string, Record<string, unknown>][] = [
        ["get_agent", { agent_id: agentId }],
        ["send_agent_message", { request_key: randomUUID(), agent_id: agentId, text: "hi" }],
        ["cancel_agent", { agent_id: agentId }],
      ];
      for (const [name, args] of attempts) {
        expect((await toolError(other, name, args)).code).toBe("not_found");
      }
      expect(await listedAgents(other)).not.toContain(agentId);
      expect(daemon.calls.filter((entry) => entry.agentId === agentId)).toHaveLength(reached);
    }

    async function toolNames(client: Client): Promise<string[]> {
      return (await client.listTools()).tools.map((tool) => tool.name).toSorted();
    }

    it("links an HTTPS client and a loopback client of one user to separate connections", async () => {
      const user = await operator();
      const discovered = await discover();
      const hosted = await register(discovered, HOSTED_CLIENT);
      const loopback = await register(discovered, LOOPBACK_CLIENT);
      expect(hosted.clientId).not.toBe(loopback.clientId);
      // Same user, same machine, same directory: still one connection per consent.
      const hostedTokens = await link(user, hosted);
      const loopbackTokens = await link(user, loopback);
      const a = await connectMcp(`${origin}/mcp/paseo`, hostedTokens.access_token, "hosted-app");
      const b = await connectMcp(
        `${origin}/mcp/paseo`,
        loopbackTokens.access_token,
        "desktop-agent",
      );
      try {
        expect(await toolNames(a)).toEqual(SEVEN_TOOLS);
        expect(await toolNames(b)).toEqual(SEVEN_TOOLS);
        const connectionA = ConnectionContent.parse(
          (await callTool(a, "get_connection")).structured,
        );
        const connectionB = ConnectionContent.parse(
          (await callTool(b, "get_connection")).structured,
        );
        expect(connectionA.connectionId).not.toBe(connectionB.connectionId);
        expect(connectionOf(hostedTokens.access_token)).toBe(connectionA.connectionId);
        expect(connectionOf(loopbackTokens.access_token)).toBe(connectionB.connectionId);
        // Connected apps lists each connection under the name its own client registered.
        const listed = await auth.connector!.listConnections(user.browser.headers());
        expect(listed).toHaveLength(2);
        expect(listed).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              connectionId: connectionA.connectionId,
              clientName: HOSTED_CLIENT.name,
            }),
            expect.objectContaining({
              connectionId: connectionB.connectionId,
              clientName: LOOPBACK_CLIENT.name,
            }),
          ]),
        );

        // Both callers see the same catalog, and each launch runs exactly the caller's own pick.
        const catalog = (await callTool(a, "list_runtimes")).structured;
        expect((await callTool(b, "list_runtimes")).structured).toEqual(catalog);
        const startedA = await startFromCatalog(a, firstReady);
        const startedB = await startFromCatalog(b, lastReady);
        expect(startedA.provider).not.toBe(startedB.provider);
        expect(user.daemon.createOptions).toHaveLength(2);
        for (const [index, started] of [startedA, startedB].entries()) {
          expect(user.daemon.createOptions[index]).toMatchObject({
            provider: started.provider,
            model: started.model,
            mode: started.mode,
            cwd: WORKING_DIRECTORY,
          });
        }

        await expectOwnedOnlyBy(a, b, startedA.agentId, user.daemon);
        await expectOwnedOnlyBy(b, a, startedB.agentId, user.daemon);
      } finally {
        await a.close();
        await b.close();
      }
    });

    it("keeps two users' clients to their own machines and agents", async () => {
      const first = await operator();
      const second = await operator();
      const discovered = await discover();
      const hosted = await register(discovered, HOSTED_CLIENT);
      const loopback = await register(discovered, LOOPBACK_CLIENT);
      const a = await connectMcp(`${origin}/mcp/paseo`, (await link(first, hosted)).access_token);
      const b = await connectMcp(
        `${origin}/mcp/paseo`,
        (await link(second, loopback)).access_token,
      );
      try {
        expect((await callTool(a, "list_runtimes")).structured).toEqual(
          (await callTool(b, "list_runtimes")).structured,
        );
        const agentA = (await startFromCatalog(a, firstReady)).agentId;
        const agentB = (await startFromCatalog(b, firstReady)).agentId;
        expect(first.daemon.createOptions).toEqual(second.daemon.createOptions);
        expect(second.daemon.agents.has(agentA)).toBe(false);
        expect(first.daemon.agents.has(agentB)).toBe(false);

        await expectOwnedOnlyBy(a, b, agentA, first.daemon);
        await expectOwnedOnlyBy(b, a, agentB, second.daemon);
        // Neither client's foreign attempts reached the other user's machine at all.
        expect(first.daemon.calls.filter((entry) => entry.agentId === agentB)).toEqual([]);
        expect(second.daemon.calls.filter((entry) => entry.agentId === agentA)).toEqual([]);
      } finally {
        await a.close();
        await b.close();
      }
    });

    it("binds codes and refresh tokens to the client they were issued to", async () => {
      const user = await operator();
      const discovered = await discover();
      const hosted = await register(discovered, HOSTED_CLIENT);
      const loopback = await register(discovered, LOOPBACK_CLIENT);

      // Another client presenting the code, verifier and redirect issued to `hosted` is refused.
      // The pinned library consumes the code before it compares clients, so the code is spent.
      const grant = await authorize(user, hosted);
      expect(await oauthError(await exchange(loopback, grant))).toEqual({
        status: 401,
        error: "invalid_client",
      });
      expect(await oauthError(await exchange(hosted, grant))).toEqual({
        status: 401,
        error: "invalid_grant",
      });

      // A refresh token presented by the other client is refused without spending it.
      const tokens = await link(user, hosted);
      const refresh = (presenter: RegisteredClient, refreshToken: string) =>
        token(presenter, { grant_type: "refresh_token", refresh_token: refreshToken });
      const revoke = (presenter: RegisteredClient, refreshToken: string) =>
        fetch(discovered.revocation_endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: presenter.clientId,
            token: refreshToken,
            token_type_hint: "refresh_token",
          }).toString(),
        });
      expect(await oauthError(await refresh(loopback, tokens.refresh_token))).toEqual({
        status: 400,
        error: "invalid_client",
      });
      // RFC 7009: revocation by another client answers 200 and changes nothing.
      expect((await revoke(loopback, tokens.refresh_token)).status).toBe(200);
      const refreshed = await refresh(hosted, tokens.refresh_token);
      expect(refreshed.status).toBe(200);
      const rotated = Tokens.parse(await refreshed.json());
      expect(connectionOf(rotated.access_token)).toBe(connectionOf(tokens.access_token));

      // A public client revokes its own refresh token with its client_id alone.
      expect((await revoke(hosted, rotated.refresh_token)).status).toBe(200);
      expect(await oauthError(await refresh(hosted, rotated.refresh_token))).toEqual({
        status: 400,
        error: "invalid_grant",
      });
    });

    it("accepts a loopback IP callback on any port, but a localhost one only on its own", async () => {
      const user = await operator();
      const discovered = await discover();
      const loopback = await register(discovered, LOOPBACK_CLIENT);
      const tokens = await link(user, loopback, LOOPBACK_OTHER_PORT);
      expect(jwtClaims(tokens.access_token)["aud"]).toBe(discovered.resource);

      // The pinned library ignores the port only for loopback IP literals, not for `localhost`.
      const localhost = await register(discovered, LOCALHOST_CLIENT);
      const refused = await requestAuthorization(
        user,
        localhost,
        "http://localhost:43119/callback",
      );
      expect(refused.location.pathname).not.toBe("/oauth/connect");
      expect(refused.location.searchParams.get("error")).toBe("invalid_redirect");
    });

    it("defaults an omitted scope to the client's registered scopes, shown at consent", async () => {
      const user = await operator();
      const discovered = await discover();
      // Registered without `scope`, so the library registers all four.
      const client = await register(discovered, HOSTED_CLIENT);
      const { location: connect, verifier } = await requestAuthorization(
        user,
        client,
        client.redirectUri,
        null,
      );
      expect(connect.pathname).toBe("/oauth/connect");
      // The library writes the defaulted scope into the signed query Hub binds to.
      expect(connect.searchParams.get("scope")?.split(" ").toSorted()).toEqual(
        SCOPES.split(" ").toSorted(),
      );

      const connector = auth.connector!;
      const selected = await connector.selectMachine(
        {
          oauthQuery: connect.search,
          daemonId: user.daemonId,
          workingDirectory: WORKING_DIRECTORY,
        },
        user.browser.headers(),
      );
      const consentUrl = new URL(selected.redirectTo, origin);
      const flowId = consentUrl.searchParams.get(CONNECTOR_FLOW_PARAM) ?? "";
      consentUrl.searchParams.delete(CONNECTOR_FLOW_PARAM);
      const consent = { oauthQuery: consentUrl.search, flowId };
      // The user sees, and approves, exactly the defaulted scopes.
      const summary = await connector.describeConsent(consent, user.browser.headers());
      expect([...summary.scopes].toSorted()).toEqual(
        ["paseo:cancel", "paseo:read", "paseo:run"].toSorted(),
      );
      expect(summary.staysConnected).toBe(true);
      const approved = await connector.decideConsent(
        { ...consent, accept: true },
        user.browser.headers(),
      );
      const code = new URL(approved.redirectTo).searchParams.get("code");
      expect(code).not.toBeNull();

      const exchanged = await exchange(client, {
        code: code!,
        verifier,
        redirectUri: client.redirectUri,
      });
      expect(exchanged.status).toBe(200);
      const tokens = Tokens.parse(await exchanged.json());
      expect(String(jwtClaims(tokens.access_token)["scope"]).split(" ").toSorted()).toEqual(
        SCOPES.split(" ").toSorted(),
      );
    });

    it("refuses at machine selection when the defaulted scope holds no connector scope", async () => {
      const user = await operator();
      const discovered = await discover();
      const client = await register(discovered, HOSTED_CLIENT, "offline_access");
      const { location: connect } = await requestAuthorization(
        user,
        client,
        client.redirectUri,
        null,
      );
      expect(connect.pathname).toBe("/oauth/connect");
      expect(connect.searchParams.get("scope")).toBe("offline_access");
      await expect(
        auth.connector!.selectMachine(
          {
            oauthQuery: connect.search,
            daemonId: user.daemonId,
            workingDirectory: WORKING_DIRECTORY,
          },
          user.browser.headers(),
        ),
      ).rejects.toBeInstanceOf(ConnectorFlowError);
      expect(await auth.connector!.listConnections(user.browser.headers())).toEqual([]);
    });
  },
);

/** A file route's server method handlers, called directly as the app server dispatches them. */
type RouteHandlers<Method extends string> = Record<
  Method,
  (context: { request: Request }) => Response | Promise<Response>
>;

function handlersOf<Method extends string>(handlers: unknown): RouteHandlers<Method> {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the generated route types cannot express calling one handler directly
  return handlers as RouteHandlers<Method>;
}

/**
 * A top-level browser navigation over real HTTP, redirects not followed. Node's fetch always
 * declares itself `sec-fetch-mode: cors`, which the OAuth library answers with JSON instead of the
 * redirect a browser gets.
 */
function navigate(url: string, cookie: string): Promise<{ status: number; location?: string }> {
  return new Promise((resolve, reject) => {
    get(url, { headers: { accept: "text/html", "sec-fetch-mode": "navigate", cookie } }, (res) => {
      res.resume();
      resolve({
        status: res.statusCode ?? 0,
        ...(res.headers.location === undefined ? {} : { location: res.headers.location }),
      });
    }).on("error", reject);
  });
}
