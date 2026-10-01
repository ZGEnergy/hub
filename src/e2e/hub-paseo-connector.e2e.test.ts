import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chromium, type Browser, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, it } from "vitest";
import { z } from "zod";
import { HubE2E } from "./harness/index.js";

/**
 * The OAuth-linked Paseo connector end to end: the built self-hosted Hub, a source-built Paseo
 * daemon enrolled in it, and real Claude agents. The token comes from Hub's own OAuth endpoints
 * and screens driven in Chromium; every tool call goes through the official MCP client.
 */
const describeConnector = process.env["RUN_HUB_CONNECTOR_E2E"] === "1" ? describe : describe.skip;

/** Never served: the browser's navigation to it is intercepted, as a client's callback would be. */
const REDIRECT_URI = "https://chatgpt.example/connector/oauth_callback";
const SCOPES = "paseo:read paseo:run paseo:cancel offline_access";
const TOOLS = [
  "cancel_agent",
  "get_agent",
  "get_connection",
  "list_agents",
  "list_runtimes",
  "send_agent_message",
  "start_agent",
];
const LONG_TASK =
  "Count from 1 to 3000. Write every number on its own line and nothing else. Do not use any tools.";

const TextContent = z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1);
const ErrorContent = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const ConnectionContent = z.object({
  machine: z.object({ name: z.string(), online: z.boolean() }),
  workingDirectory: z.string(),
  scopes: z.array(z.string()),
});
const RuntimesContent = z.object({
  runtimes: z.array(
    z.object({
      provider: z.string(),
      status: z.string(),
      enabled: z.boolean(),
      models: z.array(z.object({ id: z.string(), isDefault: z.boolean() })),
    }),
  ),
});
const OperationContent = z.object({
  operationId: z.string(),
  state: z.string(),
  agentId: z.string().nullable(),
});
const AgentContent = z.object({
  type: z.literal("agent"),
  agent: z.object({ agentId: z.string(), status: z.string() }),
  timeline: z.object({
    entries: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  }),
});
const AgentsContent = z.object({
  agents: z.array(
    z.object({
      agentId: z.string(),
      liveState: z.object({ available: z.boolean(), status: z.string().optional() }),
    }),
  ),
});
const DaemonAgent = z.object({
  Id: z.string(),
  Provider: z.string(),
  Status: z.string(),
  Archived: z.boolean(),
  Cwd: z.string(),
});
const DaemonListedAgent = z.object({ id: z.string(), name: z.string() });

type AgentView = z.infer<typeof AgentContent>;

interface ToolResult {
  isError: boolean;
  structured: unknown;
  text: string;
}

describeConnector("Paseo connector against a real daemon and real agents", () => {
  let hub: HubE2E;
  let browser: Browser;
  let page: Page;
  let origin: string;
  let token: string;
  let machineName: string;
  let workingDirectory: string;
  let model: string | undefined;
  /** The first launch, kept to replay its request key and to read it after a Hub restart. */
  let first: { requestKey: string; title: string; agentId: string; operationId: string };
  let cancelled: string;
  /** Nonsecret identities and states, printed once for the run record. */
  const evidence: Record<string, unknown> = {};
  const password = randomBytes(18).toString("base64url");
  const email = `connector-${randomUUID()}@paseo.test`;

  beforeAll(async () => {
    hub = await HubE2E.start({ realAgent: true, productionRuntime: true });
    origin = hub.publicOrigin;
    workingDirectory = hub.workspaceDirectory;
    const enrollment = await hub.connect();
    await hub.daemonIsConnected();
    machineName = await hub.daemonSlug(enrollment.daemonId);
    browser = await chromium.launch();
    page = await browser.newPage();
    token = await linkThroughOAuth();
  }, 300_000);

  afterAll(async () => {
    process.stdout.write(`Connector E2E evidence ${JSON.stringify(evidence)}\n`);
    await browser?.close();
    const shutdown = await hub?.stop();
    assert.deepEqual(shutdown?.leakedProcesses ?? [], []);
  }, 120_000);

  /**
   * Discovery, dynamic registration, Hub sign-in on the connect page, machine and directory
   * selection, consent, and a PKCE code exchange naming the connector resource.
   */
  async function linkThroughOAuth(): Promise<string> {
    const resource = `${origin}/mcp/paseo`;
    const protectedResource = z
      .object({ resource: z.string(), authorization_servers: z.array(z.string()) })
      .parse(await json(`${origin}/.well-known/oauth-protected-resource/mcp/paseo`));
    assert.equal(protectedResource.resource, resource);
    assert.deepEqual(protectedResource.authorization_servers, [origin]);
    const server = z
      .object({
        issuer: z.string(),
        authorization_endpoint: z.string(),
        token_endpoint: z.string(),
        registration_endpoint: z.string(),
        code_challenge_methods_supported: z.array(z.string()),
      })
      .parse(await json(`${origin}/.well-known/oauth-authorization-server`));
    assert.equal(server.issuer, origin);
    assert.deepEqual(server.code_challenge_methods_supported, ["S256"]);

    const registered = await fetch(server.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Connector E2E",
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    assert.ok(registered.ok, `client registration returned HTTP ${registered.status}`);
    const clientId = z.object({ client_id: z.string() }).parse(await registered.json()).client_id;

    const signedUp = await fetch(`${origin}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ name: "Connector Operator", email, password }),
    });
    assert.equal(signedUp.status, 200, "sign-up");
    await hub.addSeededOrganizationMember(email);

    const verifier = randomBytes(32).toString("base64url");
    const state = randomUUID();
    const callback = new Promise<URL>((resolve) => {
      void page.route(`${REDIRECT_URI}**`, async (route) => {
        resolve(new URL(route.request().url()));
        await route.fulfill({ status: 200, contentType: "text/plain", body: "linked" });
      });
    });
    await page.goto(
      `${server.authorization_endpoint}?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        scope: SCOPES,
        state,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        resource,
      }).toString()}`,
    );
    assert.equal(new URL(page.url()).pathname, "/oauth/connect");
    const signIn = page.getByRole("form", { name: "Sign in" });
    await signIn.getByLabel("Email").fill(email);
    await signIn.getByLabel("Password").fill(password);
    await signIn.getByRole("button", { name: "Sign in" }).click();

    const connect = page.getByRole("form", { name: "Connect a machine" });
    // A session without an active organization meets Hub's own organization gate first; choosing
    // one keeps the signed authorization URL.
    const gate = page.getByRole("heading", { name: "Choose an organization" });
    await connect.or(gate).waitFor({ timeout: 30_000 });
    if (await gate.isVisible()) {
      await page
        .getByRole("list", { name: "Organizations" })
        .getByRole("button", { name: /Hub E2E/u })
        .click();
    }
    await connect.waitFor({ timeout: 30_000 });
    await connect.getByRole("combobox", { name: "Machine" }).click();
    await page.getByRole("option", { name: new RegExp(escapeRegExp(machineName), "u") }).click();
    await connect.getByLabel("Working directory").fill(workingDirectory);
    await connect.getByRole("button", { name: "Continue" }).click();

    await page.waitForURL((url) => url.pathname === "/oauth/consent", { timeout: 30_000 });
    const decision = page.getByRole("group", { name: "Decision" });
    await decision.waitFor({ timeout: 30_000 });
    await page.getByText(workingDirectory, { exact: true }).waitFor();
    await decision.getByRole("button", { name: "Approve" }).click();

    const returned = await callback;
    assert.equal(returned.searchParams.get("state"), state);
    const code = returned.searchParams.get("code");
    assert.ok(code, "the consent redirect carries an authorization code");
    const exchanged = await fetch(server.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
        resource,
      }).toString(),
    });
    assert.equal(exchanged.status, 200, "code exchange");
    const tokens = z
      .object({ access_token: z.string(), refresh_token: z.string(), scope: z.string() })
      .parse(await exchanged.json());
    assert.deepEqual(tokens.scope.split(" ").toSorted(), SCOPES.split(" ").toSorted());
    return tokens.access_token;
  }

  async function connectorClient(): Promise<Client> {
    const client = new Client({ name: "connector-e2e", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp/paseo`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    // The SDK's getter is typed `string | undefined` while its Transport interface uses an
    // exact-optional `sessionId?: string`; the runtime class is the SDK's official transport.
    // @ts-expect-error upstream SDK exactOptionalPropertyTypes mismatch
    await client.connect(transport);
    return client;
  }

  async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const client = await connectorClient();
    try {
      const result = await client.callTool({ name, arguments: args });
      return {
        isError: result.isError === true,
        structured: result.structuredContent,
        text: TextContent.parse(result.content)
          .map((part) => part.text)
          .join("\n"),
      };
    } finally {
      await client.close();
    }
  }

  async function succeeded<T>(schema: z.ZodType<T>, name: string, args = {}): Promise<T> {
    const result = await call(name, args);
    assert.equal(result.isError, false, `${name} failed: ${result.text}`);
    return schema.parse(result.structured);
  }

  async function failedWith(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await call(name, args);
    assert.equal(result.isError, true, `${name} unexpectedly succeeded: ${result.text}`);
    return ErrorContent.parse(result.structured).error.code;
  }

  function launch(task: string, title: string, requestKey: string = randomUUID()) {
    return {
      request_key: requestKey,
      task,
      title,
      provider: "claude",
      ...(model === undefined ? {} : { model }),
    };
  }

  async function agentView(agentId: string): Promise<AgentView> {
    return succeeded(AgentContent, "get_agent", { agent_id: agentId, limit: 100 });
  }

  async function waitForAgent(
    agentId: string,
    done: (view: AgentView) => boolean,
    description: string,
    timeoutMs = 240_000,
  ): Promise<AgentView> {
    const deadline = Date.now() + timeoutMs;
    let last: AgentView | undefined;
    while (Date.now() < deadline) {
      last = await agentView(agentId);
      if (done(last)) return last;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(`Timed out waiting for ${description}; last status ${last?.agent.status}`);
  }

  function assistantText(view: AgentView): string {
    return view.timeline.entries
      .filter((entry) => entry.type === "assistant_message")
      .map((entry) => entry.text ?? "")
      .join("\n");
  }

  /** How many lines of the count the agent has written so far. */
  function countedLines(view: AgentView): number {
    return assistantText(view)
      .split("\n")
      .filter((line) => /^\d+$/u.test(line.trim())).length;
  }

  async function daemonAgent(agentId: string) {
    return DaemonAgent.parse(await hub.inspectDaemonAgent(agentId));
  }

  async function initializeStatus(authorization: string) {
    const response = await fetch(`${origin}/mcp/paseo`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization,
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
    return { status: response.status, challenge: response.headers.get("www-authenticate") ?? "" };
  }

  it("1. lists the seven tools, the bound machine and directory, and a ready Claude", async () => {
    const anonymous = await initializeStatus("Bearer not-a-token");
    assert.equal(anonymous.status, 401);
    assert.equal(
      anonymous.challenge,
      `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp/paseo"`,
    );

    const client = await connectorClient();
    const tools = await client.listTools();
    await client.close();
    assert.deepEqual(tools.tools.map((tool) => tool.name).toSorted(), TOOLS);

    const connection = await succeeded(ConnectionContent, "get_connection");
    assert.equal(connection.machine.name, machineName);
    assert.equal(connection.machine.online, true);
    assert.equal(connection.workingDirectory, workingDirectory);
    assert.deepEqual(connection.scopes.toSorted(), ["paseo:cancel", "paseo:read", "paseo:run"]);

    const deadline = Date.now() + 90_000;
    let claude: z.infer<typeof RuntimesContent>["runtimes"][number] | undefined;
    while (Date.now() < deadline) {
      const runtimes = await succeeded(RuntimesContent, "list_runtimes");
      claude = runtimes.runtimes.find((runtime) => runtime.provider === "claude");
      if (claude?.status === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    assert.equal(claude?.status, "ready", "claude runtime is ready");
    assert.equal(claude?.enabled, true);
    // The smallest listed model keeps the real turns short; the default otherwise.
    model = claude?.models.find((candidate) => /haiku/iu.test(candidate.id))?.id;
    Object.assign(evidence, { machineName, workingDirectory, model: model ?? "default" });
  }, 180_000);

  it("2-3. starts a Claude agent in the bound directory and returns its final answer", async () => {
    const requestKey = randomUUID();
    const title = "Connector first";
    const started = await succeeded(
      OperationContent,
      "start_agent",
      launch("Reply with exactly: CONNECTOR-OK-1", title, requestKey),
    );
    assert.equal(started.state, "accepted");
    assert.ok(started.agentId);
    first = { requestKey, title, agentId: started.agentId, operationId: started.operationId };

    const onDaemon = await daemonAgent(first.agentId);
    evidence["firstAgent"] = { agentId: first.agentId, daemonCwd: onDaemon.Cwd };
    assert.equal(onDaemon.Provider, "claude");
    assert.equal(onDaemon.Cwd, workingDirectory);
    assert.equal(onDaemon.Archived, false);

    const finished = await waitForAgent(
      first.agentId,
      (view) => view.agent.status === "idle" && assistantText(view).includes("CONNECTOR-OK-1"),
      "the first answer",
    );
    assert.ok(
      finished.timeline.entries.some(
        (entry) => entry.type === "user_message" && entry.text?.includes("CONNECTOR-OK-1"),
      ),
    );
  }, 300_000);

  it("4. sends a follow-up that the same session answers", async () => {
    const sent = await succeeded(OperationContent, "send_agent_message", {
      request_key: randomUUID(),
      agent_id: first.agentId,
      text: "Reply with exactly: CONNECTOR-OK-2",
    });
    assert.equal(sent.state, "accepted");
    assert.equal(sent.agentId, first.agentId);
    const answered = await waitForAgent(
      first.agentId,
      (view) => view.agent.status === "idle" && assistantText(view).includes("CONNECTOR-OK-2"),
      "the follow-up answer",
    );
    assert.ok(assistantText(answered).includes("CONNECTOR-OK-1"), "same session, earlier answer");
  }, 300_000);

  it("5. replays a launch's request key without creating a second agent", async () => {
    const replayed = await succeeded(
      OperationContent,
      "start_agent",
      launch("Reply with exactly: CONNECTOR-OK-1", first.title, first.requestKey),
    );
    assert.equal(replayed.operationId, first.operationId);
    assert.equal(replayed.agentId, first.agentId);
    const named = (await hub.daemonAgents())
      .map((agent) => DaemonListedAgent.parse(agent))
      .filter((agent) => agent.name === first.title);
    assert.deepEqual(
      named.map((agent) => agent.id),
      [first.agentId],
    );
  }, 120_000);

  it("6. cancels a long-running turn and keeps the session", async () => {
    const started = await succeeded(
      OperationContent,
      "start_agent",
      launch(LONG_TASK, "Connector cancel"),
    );
    assert.ok(started.agentId);
    cancelled = started.agentId;
    // Cancel mid-answer: the turn is running and has already streamed part of the count.
    const counting = await waitForAgent(
      cancelled,
      (view) => view.agent.status === "running" && countedLines(view) >= 20,
      "the count to be under way",
      90_000,
    );
    const cancel = await succeeded(
      z.object({ agentId: z.string(), cancelRequested: z.literal(true) }),
      "cancel_agent",
      { agent_id: cancelled },
    );
    assert.equal(cancel.agentId, cancelled);
    const stopped = await waitForAgent(
      cancelled,
      (view) => view.agent.status !== "running",
      "the cancelled turn to stop",
      60_000,
    );
    const countedAtStop = countedLines(stopped);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const later = await agentView(cancelled);
    evidence["cancelledAgent"] = {
      agentId: cancelled,
      linesBeforeCancel: countedLines(counting),
      linesAtStop: countedAtStop,
      statusAfterCancel: stopped.agent.status,
    };
    assert.equal(stopped.agent.status, "idle");
    assert.ok(countedAtStop < 3000, "the count was interrupted");
    assert.equal(later.agent.status, "idle");
    assert.equal(countedLines(later), countedAtStop, "nothing more was written after the cancel");
    const onDaemon = await daemonAgent(cancelled);
    assert.equal(onDaemon.Archived, false);
    assert.notEqual(onDaemon.Status, "running");
  }, 180_000);

  it("7. cannot see, read, message or cancel an agent started outside the connector", async () => {
    const unrelated = await hub.createUnrelatedLocalAgent(
      "Reply with exactly: UNRELATED-OK",
      "claude",
    );
    evidence["unrelatedAgent"] = unrelated;
    const listed = await succeeded(AgentsContent, "list_agents");
    const ids = listed.agents.map((agent) => agent.agentId);
    assert.ok(!ids.includes(unrelated), "the unrelated agent is not listed");
    assert.deepEqual(ids.toSorted(), [first.agentId, cancelled].toSorted());

    assert.equal(await failedWith("get_agent", { agent_id: unrelated }), "not_found");
    assert.equal(
      await failedWith("send_agent_message", {
        request_key: randomUUID(),
        agent_id: unrelated,
        text: "Reply with exactly: LEAKED",
      }),
      "not_found",
    );
    assert.equal(await failedWith("cancel_agent", { agent_id: unrelated }), "not_found");

    const onDaemon = await daemonAgent(unrelated);
    assert.equal(onDaemon.Cwd, workingDirectory, "same directory, still not the connector's");
    assert.equal(onDaemon.Archived, false);
    const timeline = JSON.stringify(await hub.daemonAgentTimeline(unrelated));
    assert.ok(!timeline.includes("LEAKED"), "the refused message never reached the daemon");
  }, 180_000);

  it("8. keeps owned agents reachable after a Hub restart", async () => {
    await hub.restartHubAndReconnect();
    const listed = await succeeded(AgentsContent, "list_agents");
    assert.deepEqual(
      listed.agents.map((agent) => agent.agentId).toSorted(),
      [first.agentId, cancelled].toSorted(),
    );
    const view = await agentView(first.agentId);
    assert.ok(assistantText(view).includes("CONNECTOR-OK-2"));
  }, 240_000);

  // Step numbers follow the scenario; the offline step runs before revocation, which ends the link.
  it("10. reports an offline machine explicitly and queues nothing", async () => {
    hub.setDaemonReachable(false);
    try {
      const deadline = Date.now() + 60_000;
      let online = true;
      while (online && Date.now() < deadline) {
        online = (await succeeded(ConnectionContent, "get_connection")).machine.online;
        if (online) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      assert.equal(online, false, "Hub sees the machine offline");
      assert.equal(await failedWith("get_agent", { agent_id: first.agentId }), "machine_offline");
      assert.equal(
        await failedWith("start_agent", launch("Reply with exactly: OFFLINE", "Connector offline")),
        "machine_offline",
      );
      const listed = await succeeded(AgentsContent, "list_agents");
      assert.equal(listed.agents.length, 2, "no operation claimed an agent while offline");
      assert.ok(listed.agents.every((agent) => !agent.liveState.available));
    } finally {
      hub.setDaemonReachable(true);
    }
    await hub.daemonReconnected();
    const named = (await hub.daemonAgents())
      .map((agent) => DaemonListedAgent.parse(agent))
      .filter((agent) => agent.name === "Connector offline");
    assert.deepEqual(named, [], "the offline launch never reached the daemon");
    const deadline = Date.now() + 60_000;
    let online = false;
    while (!online && Date.now() < deadline) {
      online = (await succeeded(ConnectionContent, "get_connection")).machine.online;
      if (!online) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(online, true, "the machine is back online");
  }, 300_000);

  it("9. revokes the connection without stopping a running agent", async () => {
    const started = await succeeded(
      OperationContent,
      "start_agent",
      launch(LONG_TASK, "Connector revoke"),
    );
    assert.ok(started.agentId);
    const running = started.agentId;
    await waitForAgent(
      running,
      (view) => view.agent.status === "running" && countedLines(view) >= 20,
      "the count to be under way",
      90_000,
    );

    await page.goto(`${origin}/oauth/connections`);
    const table = page.getByRole("table", { name: "Connected apps" });
    const row = table.getByRole("row").filter({ hasText: workingDirectory });
    await row
      .getByRole("button", { name: `Actions for ${machineName} ${workingDirectory}` })
      .click();
    await page.getByRole("menuitem", { name: "Revoke" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Revoke connection" }).click();
    await row.getByText("Revoked").waitFor({ timeout: 30_000 });

    const refused = await initializeStatus(`Bearer ${token}`);
    assert.equal(refused.status, 401);
    assert.ok(refused.challenge.includes('error="invalid_token"'), "revoked token is invalid");
    const onDaemon = await daemonAgent(running);
    assert.equal(onDaemon.Status, "running", "revocation does not stop the running agent");
    assert.equal(onDaemon.Archived, false);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const stillRunning = await daemonAgent(running);
    evidence["revokedWhileRunning"] = {
      agentId: running,
      daemonStatusAtRevocation: onDaemon.Status,
      daemonStatusThreeSecondsLater: stillRunning.Status,
    };
    assert.equal(stillRunning.Status, "running", "nothing stopped it after revocation either");
  }, 180_000);
});

async function json(url: string): Promise<unknown> {
  const response = await fetch(url);
  assert.equal(response.status, 200, `GET ${new URL(url).pathname}`);
  return response.json();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
