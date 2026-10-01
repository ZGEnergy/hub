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
});
const AccessToken = z.object({ access_token: z.string() });
const Tokens = AccessToken.extend({ refresh_token: z.string() });
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

    /** RFC 7591 dynamic registration of a public client. */
    async function register(discovered: Discovered, client: { name: string; redirectUri: string }) {
      const response = await fetch(discovered.registration_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: client.name,
          redirect_uris: [client.redirectUri],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
      });
      expect(response.status).toBe(201);
      const { client_id } = z.object({ client_id: z.string() }).parse(await response.json());
      return { ...client, clientId: client_id, discovered };
    }
    type RegisteredClient = Awaited<ReturnType<typeof register>>;

    /**
     * The client's authorization request with PKCE S256 and the resource, then the user's own
     * steps on Hub's connect and consent pages (through the server-function surface those pages
     * call). Returns the code the client's callback receives.
     */
    async function authorize(user: Operator, client: RegisteredClient) {
      const verifier = randomBytes(32).toString("base64url");
      const state = randomUUID();
      const authorization = await navigate(
        `${client.discovered.authorization_endpoint}?${new URLSearchParams({
          response_type: "code",
          client_id: client.clientId,
          redirect_uri: client.redirectUri,
          scope: SCOPES,
          state,
          code_challenge: createHash("sha256").update(verifier).digest("base64url"),
          code_challenge_method: "S256",
          resource: client.discovered.resource,
        }).toString()}`,
        user.browser.headers().get("cookie") ?? "",
      );
      expect(authorization.status).toBe(302);
      const connect = new URL(authorization.location ?? "", origin);
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
        redirectTarget: new URL(client.redirectUri).origin,
      });
      const approved = await connector.decideConsent(
        { ...consent, accept: true },
        user.browser.headers(),
      );
      const callback = new URL(approved.redirectTo);
      expect(`${callback.origin}${callback.pathname}`).toBe(client.redirectUri);
      expect(callback.searchParams.get("state")).toBe(state);
      const code = callback.searchParams.get("code");
      expect(code).not.toBeNull();
      return { code: code!, verifier };
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

    /** The PKCE code exchange, presented by `presenter` for a code issued to `client`. */
    function exchange(
      presenter: RegisteredClient,
      client: RegisteredClient,
      grant: { code: string; verifier: string },
    ): Promise<Response> {
      return token(presenter, {
        grant_type: "authorization_code",
        code: grant.code,
        code_verifier: grant.verifier,
        redirect_uri: client.redirectUri,
      });
    }

    async function link(user: Operator, client: RegisteredClient) {
      const exchanged = await exchange(client, client, await authorize(user, client));
      expect(exchanged.status).toBe(200);
      return Tokens.parse(await exchanged.json());
    }

    async function oauthError(response: Response) {
      return { status: response.status, error: OAuthError.parse(await response.json()).error };
    }

    function connectionOf(accessToken: string): unknown {
      return jwtClaims(accessToken)[`${origin}/claims/paseo-connection`];
    }

    /** Starts an agent with a provider, model and mode chosen from the client's own catalog. */
    async function startFromCatalog(client: Client) {
      const { runtimes } = RuntimesContent.parse(
        (await callTool(client, "list_runtimes")).structured,
      );
      const runtime = runtimes.find((entry) => entry.status === "ready" && entry.enabled);
      expect(runtime).toBeDefined();
      const model = runtime!.models.find((entry) => entry.isDefault) ?? runtime!.models[0];
      const started = await callTool(client, "start_agent", {
        request_key: randomUUID(),
        task: "Make the suite green",
        title: "Fix tests",
        provider: runtime!.provider,
        ...(model === undefined ? {} : { model: model.id }),
        ...(runtime!.defaultModeId === null ? {} : { mode: runtime!.defaultModeId }),
      });
      expect(started.isError).toBe(false);
      const operation = OperationContent.parse(started.structured);
      expect(operation.state).toBe("accepted");
      return operation.agentId!;
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
        const listed = await auth.connector!.listConnections(user.browser.headers());
        expect(listed.map((connection) => connection.connectionId).toSorted()).toEqual(
          [connectionA.connectionId, connectionB.connectionId].toSorted(),
        );

        // The runtime catalog and what a launch asks of the machine do not depend on the caller.
        expect((await callTool(a, "list_runtimes")).structured).toEqual(
          (await callTool(b, "list_runtimes")).structured,
        );
        const agentA = await startFromCatalog(a);
        const agentB = await startFromCatalog(b);
        expect(user.daemon.createOptions).toHaveLength(2);
        expect(user.daemon.createOptions[1]).toEqual(user.daemon.createOptions[0]);

        await expectOwnedOnlyBy(a, b, agentA, user.daemon);
        await expectOwnedOnlyBy(b, a, agentB, user.daemon);
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
        const agentA = await startFromCatalog(a);
        const agentB = await startFromCatalog(b);
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
      expect(await oauthError(await exchange(loopback, hosted, grant))).toEqual({
        status: 401,
        error: "invalid_client",
      });
      expect(await oauthError(await exchange(hosted, hosted, grant))).toEqual({
        status: 401,
        error: "invalid_grant",
      });

      // A refresh token presented by the other client is refused without spending it.
      const tokens = await link(user, hosted);
      const refresh = (presenter: RegisteredClient) =>
        token(presenter, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
      expect(await oauthError(await refresh(loopback))).toEqual({
        status: 400,
        error: "invalid_client",
      });
      const refreshed = await refresh(hosted);
      expect(refreshed.status).toBe(200);
      expect(connectionOf(AccessToken.parse(await refreshed.json()).access_token)).toBe(
        connectionOf(tokens.access_token),
      );
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
