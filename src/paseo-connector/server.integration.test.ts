import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createApplicationRuntime } from "../application-runtime.js";
import { composeEntitlements } from "../auth/entitlements.js";
import { createAuthServer, type AuthServer } from "../auth/server.js";
import type { DaemonConnection } from "../daemons/protocol.js";
import { createDatabase } from "../db/pg.js";
import { embeddedDatabaseRuntime, type DatabaseRuntimeBundle } from "../db/runtime/index.js";
import type { Database } from "../db/types.js";
import { createFetchServer } from "../http/node-server.js";
import { Route as PaseoMcpRoute } from "../routes/mcp/paseo.js";
import { startApplication, stopApplication } from "../server/runtime.js";
import { CONNECTOR_FLOW_PARAM } from "./contracts.js";
import { handlePaseoConnectorMcp } from "./server.js";
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

const ORIGIN = "http://localhost:3000";
const RESOURCE = `${ORIGIN}/mcp/paseo`;
const RESOURCE_METADATA = `${ORIGIN}/.well-known/oauth-protected-resource/mcp/paseo`;
/** Another origin of the same Hub database: a real Hub-signed token for a different resource. */
const OTHER_ORIGIN = "http://127.0.0.1:3000";
const REDIRECT_URI = "https://client.example/oauth/callback";
const SECRET = "connector-mcp-test-secret-at-least-32-characters";
const WORKING_DIRECTORY = "/srv/work/project";
const ALL_SCOPES = "paseo:read paseo:run paseo:cancel offline_access";

const CursorContent = z.object({ epoch: z.string(), seq: z.number() });
const AgentContent = z.object({
  type: z.literal("agent"),
  agent: z.object({ agentId: z.string(), status: z.string() }),
  timeline: z.object({
    epoch: z.string(),
    entries: z.array(
      z.object({ seqStart: z.number(), type: z.string(), text: z.string().optional() }),
    ),
    startCursor: CursorContent.nullable(),
    endCursor: CursorContent.nullable(),
    hasOlder: z.boolean(),
    hasNewer: z.boolean(),
    reset: z.boolean(),
    staleCursor: z.boolean(),
  }),
});

describe("Paseo Agent Connector MCP endpoint", () => {
  let root: string;
  let bundle: DatabaseRuntimeBundle;
  let database: Database;
  let auth: AuthServer;
  let otherAuth: AuthServer;
  let http: HttpServer;
  let endpoint: string;
  /** The machines currently connected to Hub; a missing entry is an offline machine. */
  const online = new Map<string, DaemonConnection>();

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "hub-connector-mcp-"));
    bundle = await embeddedDatabaseRuntime(join(root, "database"));
    await bundle.runtime.migrate();
    database = createDatabase(bundle.runtime, bundle.locks);
    const authFor = (baseURL: string) =>
      createAuthServer({
        database: bundle.runtime,
        locks: bundle.locks,
        entitlements: composeEntitlements(database, bundle.runtime).service,
        secret: SECRET,
        baseURL,
        policy: { registrationMode: "open", organizationCreation: "open", bootstrap: undefined },
        paseoConnector: true,
      });
    auth = authFor(ORIGIN);
    otherAuth = authFor(OTHER_ORIGIN);
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
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the generated route type cannot express calling one handler directly
    const handlers = PaseoMcpRoute.options.server?.handlers as unknown as RouteHandlers;
    // The route's own method handlers, as the app server dispatches them.
    http = createFetchServer((request) => {
      if (new URL(request.url).pathname !== "/mcp/paseo")
        return new Response(null, { status: 404 });
      if (request.method === "POST") return handlers.POST({ request });
      if (request.method === "GET") return handlers.GET();
      if (request.method === "DELETE") return handlers.DELETE();
      return new Response(null, { status: 405 });
    });
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const address = http.address();
    if (address === null || typeof address === "string") throw new Error("not listening on TCP");
    endpoint = `http://127.0.0.1:${address.port}/mcp/paseo`;
  }, 120_000);

  afterAll(async () => {
    http?.closeAllConnections();
    http?.close();
    await stopApplication();
    await otherAuth?.close();
    await auth?.close();
    await bundle?.runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  /** A Hub user with one enrolled, connected machine, linked through the real OAuth flow. */
  async function linkedAccount(scope = ALL_SCOPES) {
    const browser = new Browser(auth, ORIGIN);
    await browser.signUp();
    const organizationId = await browser.createOrganization();
    const daemonId = await enrollConnectorDaemon(database, organizationId);
    const daemon = new FakeDaemon();
    online.set(daemonId, daemonConnection(daemon));
    const { tokens, connectionId } = await linkAndExchange(auth, browser, daemonId, scope);
    return { browser, daemonId, daemon, token: tokens.access_token, connectionId };
  }

  /** Dynamic registration, authorization, machine selection, consent and a PKCE code exchange. */
  async function linkAndExchange(
    server: AuthServer,
    browser: Browser,
    daemonId: string,
    scope: string,
  ) {
    const connector = server.connector!;
    const origin = connector.endpoints.issuer;
    const registered = await server.handle(
      new Request(`${origin}/api/auth/oauth2/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Example MCP Client",
          redirect_uris: [REDIRECT_URI],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
      }),
    );
    const clientId = z.object({ client_id: z.string() }).parse(await registered.json()).client_id;
    const verifier = randomBytes(32).toString("base64url");
    const authorize = await browser.get(
      `/api/auth/oauth2/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        scope,
        state: randomUUID(),
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        resource: connector.endpoints.resource,
      }).toString()}`,
    );
    const connectQuery = new URL(authorize.headers.get("location") ?? "", origin).search;
    const selected = await connector.selectMachine(
      { oauthQuery: connectQuery, daemonId, workingDirectory: WORKING_DIRECTORY },
      browser.headers(),
    );
    const consentUrl = new URL(selected.redirectTo, origin);
    const flowId = consentUrl.searchParams.get(CONNECTOR_FLOW_PARAM) ?? "";
    consentUrl.searchParams.delete(CONNECTOR_FLOW_PARAM);
    const approved = await connector.decideConsent(
      { oauthQuery: consentUrl.search, flowId, accept: true },
      browser.headers(),
    );
    const code = new URL(approved.redirectTo).searchParams.get("code") ?? "";
    const exchanged = await server.handle(
      new Request(`${origin}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: verifier,
          redirect_uri: REDIRECT_URI,
          resource: connector.endpoints.resource,
        }).toString(),
      }),
    );
    expect(exchanged.status).toBe(200);
    const tokens = z.object({ access_token: z.string() }).parse(await exchanged.json());
    const connections = await connector.listConnections(browser.headers());
    return { tokens, connectionId: connections[0]!.connectionId };
  }

  const mcp = (token: string) => connectMcp(endpoint, token);

  /** What an MCP client sends first, without the SDK, to read the HTTP-level answer. */
  function initialize(authorization?: string): Promise<Response> {
    return fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(authorization === undefined ? {} : { authorization }),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "probe", version: "1.0.0" },
        },
      }),
    });
  }

  function launch(task = "Fix the failing test") {
    return { request_key: randomUUID(), task, title: "Fix tests", provider: "claude" };
  }

  it("serves 503 without a database and 404 when the connector is disabled", async () => {
    const request = () => new Request(RESOURCE, { method: "POST" });
    expect(
      (await handlePaseoConnectorMcp({ status: "database_unavailable" }, request())).status,
    ).toBe(503);
    expect((await handlePaseoConnectorMcp({ status: "disabled" }, request())).status).toBe(404);
  });

  it("challenges a request without a usable token with the resource metadata location", async () => {
    // RFC 6750 §3.1: no error code when no bearer token was presented at all.
    for (const authorization of [undefined, "Basic dXNlcjpwYXNz"]) {
      const response = await initialize(authorization);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe(
        `Bearer resource_metadata="${RESOURCE_METADATA}"`,
      );
    }
    // A presented token that is not valid says so.
    const response = await initialize("Bearer not-a-token");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${RESOURCE_METADATA}", error="invalid_token"`,
    );
  });

  it("answers 503, never a re-link challenge, when Hub cannot read its signing keys", async () => {
    const { token } = await linkedAccount();
    await bundle.runtime.query("alter table jwks rename to jwks_offline");
    let response: Response;
    try {
      response = await initialize(`Bearer ${token}`);
    } finally {
      await bundle.runtime.query("alter table jwks_offline rename to jwks");
    }
    expect(response.status).toBe(503);
    expect(response.headers.get("www-authenticate")).toBeNull();
    // The same token is fine once the keys can be read again.
    expect((await initialize(`Bearer ${token}`)).status).toBe(200);
  });

  it("rejects a Hub-signed token issued for another resource", async () => {
    const { browser, daemonId } = await linkedAccount();
    const elsewhere = new Browser(otherAuth, OTHER_ORIGIN, browser.email);
    await elsewhere.signIn();
    const { tokens } = await linkAndExchange(otherAuth, elsewhere, daemonId, ALL_SCOPES);
    expect(jwtClaims(tokens.access_token)["aud"]).toBe(`${OTHER_ORIGIN}/mcp/paseo`);

    const response = await initialize(`Bearer ${tokens.access_token}`);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${RESOURCE_METADATA}", error="invalid_token"`,
    );
  });

  it("lists exactly the seven connector tools with read-only and destructive hints", async () => {
    const { token } = await linkedAccount();
    const client = await mcp(token);
    try {
      const { tools } = await client.listTools();
      const hints = Object.fromEntries(
        tools.map((tool) => [
          tool.name,
          [tool.annotations?.readOnlyHint, tool.annotations?.destructiveHint],
        ]),
      );
      expect(hints).toEqual({
        get_connection: [true, false],
        list_runtimes: [true, false],
        list_agents: [true, false],
        get_agent: [true, false],
        start_agent: [false, true],
        send_agent_message: [false, true],
        cancel_agent: [false, false],
      });
      for (const tool of tools) expect(tool.inputSchema.type).toBe("object");
      const getAgent = tools.find((tool) => tool.name === "get_agent");
      expect(Object.keys(getAgent?.inputSchema.properties ?? {})).toEqual(
        expect.arrayContaining(["agent_id", "operation_id", "cursor", "limit"]),
      );
      expect(
        Object.keys(
          tools.find((tool) => tool.name === "start_agent")?.inputSchema.properties ?? {},
        ),
      ).not.toContain("cwd");
    } finally {
      await client.close();
    }
  });

  it("lets a read-only token read but never launch", async () => {
    const { token, daemon } = await linkedAccount("paseo:read");
    const client = await mcp(token);
    try {
      const connection = await callTool(client, "get_connection");
      expect(connection.structured).toMatchObject({
        machine: { online: true },
        workingDirectory: WORKING_DIRECTORY,
        scopes: ["paseo:read"],
      });
      expect(connection.text).toContain(WORKING_DIRECTORY);
      expect((await callTool(client, "list_agents")).structured).toEqual({ agents: [] });

      const refused = await toolError(client, "start_agent", launch());
      expect(refused.code).toBe("insufficient_scope");
      expect(refused.text).toContain("paseo:run");
      expect(daemon.calls.map((entry) => entry.method)).not.toContain("create");
    } finally {
      await client.close();
    }
  });

  it("launches, reads the real timeline with cursors, follows up and interrupts an owned agent", async () => {
    const { token, daemon } = await linkedAccount();
    const client = await mcp(token);
    try {
      expect((await callTool(client, "list_runtimes")).text).toContain("claude (Claude): ready");

      const started = await callTool(client, "start_agent", launch("Make the suite green"));
      expect(started.isError).toBe(false);
      const operation = OperationContent.parse(started.structured);
      expect(operation.state).toBe("accepted");
      const agentId = operation.agentId!;
      daemon.append(agentId, { type: "tool_call", name: "Bash", status: "completed" });
      daemon.append(agentId, { type: "assistant_message", text: "All 42 tests pass now." });

      const tail = await callTool(client, "get_agent", { agent_id: agentId });
      const page = AgentContent.parse(tail.structured);
      expect(page.timeline.entries.map((entry) => entry.text ?? entry.type)).toEqual([
        "Make the suite green",
        "tool_call",
        "All 42 tests pass now.",
      ]);
      expect(tail.text).toContain("All 42 tests pass now.");
      expect(page.timeline.endCursor).toEqual({ epoch: "epoch-1", seq: 3 });

      // A page boundary: the newest two, then the older one through the returned cursor.
      const newest = AgentContent.parse(
        (await callTool(client, "get_agent", { agent_id: agentId, limit: 2 })).structured,
      );
      expect(newest.timeline.entries.map((entry) => entry.seqStart)).toEqual([2, 3]);
      expect(newest.timeline.hasOlder).toBe(true);
      const older = AgentContent.parse(
        (
          await callTool(client, "get_agent", {
            agent_id: agentId,
            cursor: newest.timeline.startCursor,
            direction: "before",
          })
        ).structured,
      );
      expect(older.timeline.entries.map((entry) => entry.text)).toEqual(["Make the suite green"]);

      // The daemon rewrites the timeline: the old cursor yields a reset tail page, said aloud.
      daemon.rewrite(agentId);
      const reset = await callTool(client, "get_agent", {
        agent_id: agentId,
        cursor: page.timeline.endCursor,
      });
      expect(AgentContent.parse(reset.structured).timeline).toMatchObject({
        epoch: "epoch-2",
        reset: true,
        staleCursor: true,
      });
      expect(reset.text).toContain("discard earlier cursors");

      const followUp = await callTool(client, "send_agent_message", {
        request_key: randomUUID(),
        agent_id: agentId,
        text: "Now update the changelog",
      });
      expect(OperationContent.parse(followUp.structured)).toMatchObject({
        state: "accepted",
        agentId,
      });

      const cancelled = await callTool(client, "cancel_agent", { agent_id: agentId });
      expect(cancelled.structured).toEqual({ agentId, cancelRequested: true });
      expect(daemon.calls.filter((entry) => entry.method.startsWith("control"))).toEqual([
        { method: "control:interrupt", agentId },
      ]);
      expect(
        AgentsContent.parse((await callTool(client, "list_agents")).structured).agents,
      ).toEqual([expect.objectContaining({ agentId })]);
    } finally {
      await client.close();
    }
  });

  it("conceals agents this connection did not start", async () => {
    const { token, daemon } = await linkedAccount();
    daemon.seed("someone-elses-agent");
    daemon.append("someone-elses-agent", { type: "assistant_message", text: "private result" });
    const client = await mcp(token);
    try {
      const foreign = await toolError(client, "get_agent", { agent_id: "someone-elses-agent" });
      const missing = await toolError(client, "get_agent", { agent_id: `agent-${randomUUID()}` });
      expect(foreign).toEqual({ ...missing, text: foreign.text });
      expect(foreign.code).toBe("not_found");
      expect(foreign.text).not.toContain("someone-elses-agent");
      expect(
        (await toolError(client, "cancel_agent", { agent_id: "someone-elses-agent" })).code,
      ).toBe("not_found");
      const listed = await callTool(client, "list_agents");
      expect(listed.structured).toEqual({ agents: [] });
      expect(daemon.calls.filter((entry) => entry.agentId === "someone-elses-agent")).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("reports an offline machine explicitly instead of queueing or claiming success", async () => {
    const { token, daemon, daemonId } = await linkedAccount();
    const client = await mcp(token);
    try {
      const agentId = OperationContent.parse(
        (await callTool(client, "start_agent", launch())).structured,
      ).agentId!;
      const calls = daemon.calls.length;
      online.delete(daemonId);

      expect((await callTool(client, "get_connection")).structured).toMatchObject({
        machine: { online: false },
      });
      expect((await toolError(client, "get_agent", { agent_id: agentId })).code).toBe(
        "machine_offline",
      );
      expect((await toolError(client, "start_agent", launch())).code).toBe("machine_offline");
      expect(daemon.calls).toHaveLength(calls);
    } finally {
      await client.close();
    }
  });

  it("requires a re-link once the connection is revoked", async () => {
    const { token, browser, connectionId } = await linkedAccount();
    expect((await initialize(`Bearer ${token}`)).status).toBe(200);
    await auth.connector!.revokeConnection({ connectionId }, browser.headers());

    const response = await initialize(`Bearer ${token}`);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${RESOURCE_METADATA}", error="invalid_token"`,
    );
  });

  it("never cancels an agent when the caller abandons a request", async () => {
    const { token, daemon } = await linkedAccount();
    let release: () => void = () => undefined;
    const sendHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sendStarted: () => void = () => undefined;
    const sending = new Promise<void>((resolve) => {
      sendStarted = resolve;
    });
    daemon.beforeSend = () => {
      sendStarted();
      return sendHeld;
    };
    const client = await mcp(token);
    try {
      const abort = new AbortController();
      const pending = client.callTool({ name: "start_agent", arguments: launch() }, undefined, {
        signal: abort.signal,
      });
      await sending;
      abort.abort();
      await expect(pending).rejects.toThrow();
      release();
      await vi.waitFor(() => {
        expect([...daemon.agents.values()][0]?.snapshot.status).toBe("running");
      });

      const listed = AgentsContent.parse((await callTool(client, "list_agents")).structured);
      expect(listed.agents).toHaveLength(1);
      expect(daemon.calls.map((entry) => entry.method)).not.toContain("control:interrupt");
      expect(daemon.calls.map((entry) => entry.method)).not.toContain("control:archive");
    } finally {
      await client.close();
    }
  });
});

/** The route's method handlers, called directly. */
interface RouteHandlers {
  POST(context: { request: Request }): Response | Promise<Response>;
  GET(): Response | Promise<Response>;
  DELETE(): Response | Promise<Response>;
}
