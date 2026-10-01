import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createApplicationRuntime } from "../application-runtime.js";
import { composeEntitlements } from "../auth/entitlements.js";
import { createAuthServer } from "../auth/server.js";
import {
  DaemonAgentError,
  DaemonUnsupportedError,
  type AgentConnection,
  type AgentSnapshot,
  type AgentTimelineCursor,
  type AgentTimelineEntry,
  type AgentTimelinePage,
} from "../daemons/agents/index.js";
import {
  DaemonResponseLostError,
  type DaemonConnection,
  type DaemonCreateAgentOptions,
} from "../daemons/protocol.js";
import { createDatabase } from "../db/pg.js";
import {
  embeddedDatabaseRuntime,
  postgresDatabaseRuntime,
  type DatabaseRuntimeBundle,
} from "../db/runtime/index.js";
import type { Database } from "../db/types.js";
import type { HubProviderSnapshotEntry } from "../hub/protocol.js";
import type { ConnectorPrincipal } from "./authorization.js";
import {
  ConnectorError,
  type ConnectorScope,
  type Identity,
  type StartAgentInput,
} from "./contracts.js";
import { createConnectorService, type ConnectorService, type OperationResult } from "./service.js";

const WORKING_DIRECTORY = "/srv/work/project";
const anyString: unknown = expect.any(String);
const anything: unknown = expect.anything();
const T0 = new Date("2026-09-30T12:00:00.000Z");

const CATALOG: HubProviderSnapshotEntry[] = [
  {
    provider: "claude",
    status: "ready",
    enabled: true,
    label: "Claude",
    models: [
      { provider: "claude", id: "opus", label: "Opus", isDefault: true, aliases: ["best"] },
      { provider: "claude", id: "retired", label: "Retired", isSelectable: false },
    ],
    modes: [
      { id: "default", label: "Default" },
      { id: "plan", label: "Plan" },
    ],
    defaultModeId: "default",
  },
  { provider: "codex", status: "error", enabled: true, error: "not signed in" },
  { provider: "gemini", status: "ready", enabled: false },
];

interface DaemonAgent {
  snapshot: AgentSnapshot;
  options: DaemonCreateAgentOptions | null;
  epoch: string;
  entries: AgentTimelineEntry[];
}

/**
 * The daemon side of the connector, modelling the daemon's documented semantics rather than echoing
 * calls: keyed creation is idempotent per key (a different body conflicts), a message receipt is
 * idempotent per (agent, messageId), a lost acknowledgement happens after the effect, missing
 * agents are "Agent not found", and timelines page by epoch and sequence with stale-cursor resets.
 */
class DaemonDouble implements AgentConnection {
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly agents = new Map<string, DaemonAgent>();
  readonly delivered: { agentId: string; messageId: string; text: string }[] = [];
  createFault: "reject" | "lost" | "unknown" | "unsupported" | "unreadable" | undefined;
  sendFault: "reject" | "lost" | "unknown" | undefined;
  nextAgentId: string | undefined;
  beforeSend: ((agentId: string) => Promise<void>) | undefined;
  beforeCreate: (() => Promise<void>) | undefined;
  /** Faults on timeline reads and on control requests, which act before any effect. */
  readFault: "reject" | "unsupported" | "unreadable" | undefined;
  controlFault: "reject" | "unreadable" | undefined;
  private readonly creations = new Map<string, { body: string; agentId: string }>();
  private readonly receipts = new Map<string, string>();
  private sequence = 0;

  calledMethods(): string[] {
    return this.calls.map((call) => call.method);
  }

  seedAgent(agentId: string, status: AgentSnapshot["status"] = "running"): void {
    this.agents.set(agentId, {
      snapshot: { id: agentId, workspaceId: `workspace-${agentId}`, status },
      options: null,
      epoch: "epoch-1",
      entries: [],
    });
  }

  append(agentId: string, item: { type: string } & Record<string, unknown>): void {
    const agent = this.require(agentId);
    const seq = agent.entries.length + 1;
    agent.entries.push({
      provider: "claude",
      item,
      timestamp: new Date(T0.getTime() + seq * 1000).toISOString(),
      seqStart: seq,
      seqEnd: seq,
      sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
    });
  }

  async create(key: string, options: DaemonCreateAgentOptions): Promise<AgentSnapshot> {
    this.calls.push({ method: "create", args: [key, options] });
    await this.beforeCreate?.();
    if (this.createFault === "unsupported")
      throw new DaemonUnsupportedError("Update the Paseo daemon to run Hub agents");
    if (this.createFault === "reject")
      throw new DaemonAgentError("Provider claude failed to start: binary missing");
    if (this.createFault === "unknown") throw new DaemonAgentError("agent_request_outcome_unknown");
    const body = JSON.stringify(options);
    const prior = this.creations.get(key);
    if (prior !== undefined) {
      if (prior.body !== body) throw new DaemonAgentError("agent_request_key_conflict");
      return { ...this.require(prior.agentId).snapshot };
    }
    this.sequence += 1;
    const agentId = this.nextAgentId ?? `agent-${this.sequence}`;
    this.nextAgentId = undefined;
    this.agents.set(agentId, {
      snapshot: { id: agentId, workspaceId: `workspace-${agentId}`, status: "idle" },
      options,
      epoch: "epoch-1",
      entries: [],
    });
    this.creations.set(key, { body, agentId });
    // The agent exists now; these faults only lose or garble the acknowledgement.
    if (this.createFault === "lost") throw new DaemonResponseLostError();
    if (this.createFault === "unreadable") z.object({ agent: z.string() }).parse({});
    return { ...this.require(agentId).snapshot };
  }

  async get(agentId: string): Promise<AgentSnapshot> {
    this.calls.push({ method: "get", args: [agentId] });
    return { ...this.require(agentId).snapshot };
  }

  async send(agentId: string, messageId: string, text: string): Promise<void> {
    this.calls.push({ method: "send", args: [agentId, messageId, text] });
    await this.beforeSend?.(agentId);
    const agent = this.require(agentId);
    const receipt = this.receipts.get(`${agentId}:${messageId}`);
    if (receipt !== undefined) {
      if (receipt !== text) throw new DaemonAgentError("agent_request_key_conflict");
      return;
    }
    if (this.sendFault === "reject") throw new DaemonAgentError("Agent is closed");
    this.receipts.set(`${agentId}:${messageId}`, text);
    this.delivered.push({ agentId, messageId, text });
    agent.snapshot.status = "running";
    this.append(agentId, { type: "user_message", text, messageId });
    if (this.sendFault === "lost") throw new DaemonResponseLostError();
    if (this.sendFault === "unknown") throw new DaemonAgentError("agent_request_outcome_unknown");
  }

  async restore(): Promise<boolean> {
    throw new Error("the connector never restores workspaces");
  }

  async control(agentId: string, workspaceId: string, action: "interrupt" | "archive") {
    this.calls.push({ method: "control", args: [agentId, workspaceId, action] });
    if (this.controlFault === "reject")
      throw new DaemonAgentError("Permission denied: workspace.write is required");
    if (this.controlFault === "unreadable") z.object({ agent: z.string() }).parse({});
    const agent = this.require(agentId);
    if (action === "archive") this.agents.delete(agentId);
    else agent.snapshot.status = "idle";
  }

  async watch(): Promise<() => void> {
    throw new Error("the connector never watches agents");
  }

  async timeline(
    agentId: string,
    input: { cursor?: AgentTimelineCursor; direction: "tail" | "before" | "after"; limit: number },
  ): Promise<AgentTimelinePage> {
    this.calls.push({ method: "timeline", args: [agentId, input] });
    if (this.readFault === "unsupported")
      throw new DaemonUnsupportedError("Update the Paseo daemon to run Hub agents");
    if (this.readFault === "reject")
      throw new DaemonAgentError("Permission denied: workspace.read is required");
    if (this.readFault === "unreadable") z.object({ agent: z.string() }).parse({});
    const agent = this.require(agentId);
    const stale = input.cursor !== undefined && input.cursor.epoch !== agent.epoch;
    const direction = stale ? "tail" : input.direction;
    const all = agent.entries;
    const take = (entries: AgentTimelineEntry[], fromEnd: boolean) => {
      if (input.limit === 0) return entries;
      return fromEnd ? entries.slice(-input.limit) : entries.slice(0, input.limit);
    };
    const seq = input.cursor?.seq ?? 0;
    let page: AgentTimelineEntry[];
    if (direction === "tail") page = take(all, true);
    else if (direction === "after")
      page = take(
        all.filter((entry) => entry.seqStart > seq),
        false,
      );
    else
      page = take(
        all.filter((entry) => entry.seqEnd < seq),
        true,
      );
    const first = page[0];
    const last = page.at(-1);
    return {
      agent: { ...agent.snapshot },
      epoch: agent.epoch,
      reset: stale,
      staleCursor: stale,
      gap: false,
      startCursor: first === undefined ? null : { epoch: agent.epoch, seq: first.seqStart },
      endCursor: last === undefined ? null : { epoch: agent.epoch, seq: last.seqEnd },
      hasOlder: first !== undefined && first.seqStart > 1,
      hasNewer: last !== undefined && last.seqEnd < all.length,
      entries: page,
    };
  }

  private require(agentId: string): DaemonAgent {
    const agent = this.agents.get(agentId);
    if (agent === undefined) throw new DaemonAgentError(`Agent not found: ${agentId}`);
    return agent;
  }
}

function daemonConnection(daemon: DaemonDouble): DaemonConnection {
  return {
    agents: daemon,
    async getProviderSnapshot({ cwd }) {
      daemon.calls.push({ method: "snapshot", args: [cwd] });
      return {
        requestId: randomUUID(),
        ...(cwd === undefined ? {} : { cwd }),
        entries: structuredClone(CATALOG),
        generatedAt: T0.toISOString(),
      };
    },
    refreshProviderSnapshot: () => Promise.reject(new Error("not used")),
    validateAgentConfiguration: () => Promise.reject(new Error("not used")),
  };
}

/** Attaches its handler at once, so a list of these can be awaited in turn without stray rejections. */
async function rejection(promise: Promise<unknown>): Promise<ConnectorError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ConnectorError);
  if (!(error instanceof ConnectorError)) throw new Error("expected a ConnectorError");
  return error;
}

/** Real user, organization, member and enrolled daemon rows. */
async function seedMachine(bundle: DatabaseRuntimeBundle, database: Database) {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const organizationId = `org-${suffix}`;
  const users = { alice: `alice-${suffix}`, bob: `bob-${suffix}` };
  await bundle.runtime.query("insert into organization (id, name, slug) values ($1, $1, $1)", [
    organizationId,
  ]);
  for (const id of Object.values(users)) {
    await bundle.runtime.query(
      `insert into "user" (id, name, email) values ($1, $1, $1 || '@example.test')`,
      [id],
    );
    await bundle.runtime.query(
      `insert into member (id, organization_id, user_id, role) values ('member-' || $1, $2, $1, 'member')`,
      [id, organizationId],
    );
  }
  const verifier = `token-${randomUUID()}`;
  await database.issueEnrollmentToken({
    id: randomUUID(),
    verifier,
    organizationId,
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
  });
  const daemonId = randomUUID();
  await database.enrollDaemon({
    daemonId,
    idempotencyKey: randomUUID(),
    suggestedSlug: `devbox-${suffix}`,
    tokenVerifier: verifier,
    serverId: randomUUID(),
    daemonPublicKey: "public",
    credentialVerifier: "credential",
    permissions: ["hub.execute"],
    now: new Date(),
  });
  return { organizationId, daemonId, slug: `devbox-${suffix}`, ...users };
}

/** An activated connection, completed through a consumed consent flow as Task 3 does. */
async function connect(
  database: Database,
  machine: { organizationId: string; daemonId: string },
  userId: string,
  scopes: readonly ConnectorScope[] = ["paseo:read", "paseo:run", "paseo:cancel"],
) {
  const connection = await database.connector.createConnection({
    connectionId: randomUUID(),
    ownerUserId: userId,
    organizationId: machine.organizationId,
    daemonId: machine.daemonId,
    workingDirectory: WORKING_DIRECTORY,
    scopes,
    createdAt: T0,
    activatedAt: null,
    revokedAt: null,
  });
  const flow = {
    id: randomUUID(),
    sessionId: `session-${randomUUID()}`,
    ownerUserId: userId,
    authorizationFingerprint: "fingerprint",
    connectionId: connection.connectionId,
    expiresAt: new Date(Date.now() + 600_000),
    consumedAt: null,
  };
  await database.connector.createFlow(flow);
  expect(await database.connector.consumeFlow(userId, flow.sessionId, flow.id, new Date())).toBe(
    true,
  );
  const identity: Identity = {
    connectionId: connection.connectionId,
    ownerUserId: userId,
    organizationId: machine.organizationId,
    daemonId: machine.daemonId,
  };
  const principal: ConnectorPrincipal = {
    userId,
    connectionId: connection.connectionId,
    scopes,
  };
  return { identity, principal };
}

function launch(overrides: Partial<StartAgentInput> = {}): StartAgentInput {
  return {
    request_key: randomUUID(),
    task: "Fix the failing build",
    title: "Build fix",
    provider: "claude",
    ...overrides,
  };
}

let postgres: StartedPostgreSqlContainer;
beforeAll(async () => {
  postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
}, 120_000);
afterAll(async () => {
  await postgres?.stop();
});

describe.each(["embedded", "postgres"] as const)("Paseo connector service on %s", (kind) => {
  let root: string;
  let bundle: DatabaseRuntimeBundle;
  let database: Database;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "hub-connector-service-"));
    if (kind === "embedded") {
      bundle = await embeddedDatabaseRuntime(join(root, "database"));
    } else {
      const url = new URL(postgres.getConnectionUri());
      url.pathname = `/connector_service_${randomUUID().replaceAll("-", "")}`;
      bundle = await postgresDatabaseRuntime(url.href);
    }
    await bundle.runtime.migrate();
    database = createDatabase(bundle.runtime, bundle.locks);
  }, 120_000);
  afterAll(async () => {
    await bundle?.runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  let machine: Awaited<ReturnType<typeof seedMachine>>;
  let daemon: DaemonDouble;
  let online: boolean;
  let service: ConnectorService;
  let alice: Awaited<ReturnType<typeof connect>>;
  let bob: Awaited<ReturnType<typeof connect>>;
  let reported: { error: unknown; operation: string }[];

  beforeEach(async () => {
    machine = await seedMachine(bundle, database);
    daemon = new DaemonDouble();
    online = true;
    reported = [];
    const connection = daemonConnection(daemon);
    service = createConnectorService({
      database,
      connectionForDaemon: (daemonId) =>
        online && daemonId === machine.daemonId ? connection : undefined,
      now: () => T0,
      reportFailure: (error, operation) => reported.push({ error, operation }),
    });
    alice = await connect(database, machine, machine.alice);
    bob = await connect(database, machine, machine.bob);
  });

  const operationsOf = async (identity: Identity) =>
    (
      await bundle.runtime.query<{ count: number }>(
        "select count(*)::integer as count from connector_operations where connection_id = $1",
        [identity.connectionId],
      )
    ).rows[0]!.count;

  it("records ownership before sending the task, then reports the launch accepted", async () => {
    const ownedAtSend: string[][] = [];
    daemon.beforeSend = async () => {
      ownedAtSend.push(
        (await database.connector.listOwnedAgents(alice.identity)).map((agent) => agent.agentId),
      );
    };
    const result = await service.startAgent(
      alice.principal,
      launch({ model: "best", mode: "plan" }),
    );

    expect(result).toEqual({
      operationId: anyString,
      state: "accepted",
      agentId: "agent-1",
      workspaceId: "workspace-agent-1",
    });
    expect(ownedAtSend).toEqual([["agent-1"]]);
    expect(daemon.calledMethods()).toEqual(["snapshot", "create", "send"]);
    expect(daemon.calls[0]!.args).toEqual([WORKING_DIRECTORY]);
    // The bound directory, no environment, no extra tools; the alias resolves to the model id.
    expect(daemon.agents.get("agent-1")!.options).toEqual({
      provider: "claude",
      title: "Build fix",
      cwd: WORKING_DIRECTORY,
      env: {},
      toolPolicy: { preapproved: [] },
      model: "opus",
      mode: "plan",
    });
    const operation = await database.connector.findOperation(alice.identity, result.operationId);
    expect(operation).toMatchObject({ state: "accepted", errorCode: null, agentId: "agent-1" });
    expect(daemon.delivered).toEqual([
      { agentId: "agent-1", messageId: operation!.messageId, text: "Fix the failing build" },
    ]);
    expect(await database.connector.listOwnedAgents(alice.identity)).toEqual([
      expect.objectContaining({ agentId: "agent-1", launchOperationId: result.operationId }),
    ]);
  });

  it("never prompts after a rejected creation and records the failure", async () => {
    daemon.createFault = "reject";
    const sendTask = vi.spyOn(daemon, "send");
    const request = launch();

    await expect(service.startAgent(alice.principal, request)).rejects.toMatchObject({
      code: "create_rejected",
    });
    expect(sendTask).not.toHaveBeenCalled();
    expect(await database.connector.listOwnedAgents(alice.identity)).toEqual([]);

    const replay = await rejection(service.startAgent(alice.principal, request));
    expect(replay.code).toBe("create_rejected");
    expect(
      await database.connector.findOperation(alice.identity, replay.details!.operationId!),
    ).toMatchObject({ state: "failed", errorCode: "create_rejected", agentId: null });
    expect(daemon.calledMethods().filter((method) => method === "create")).toHaveLength(1);
    expect(sendTask).not.toHaveBeenCalled();
  });

  it("treats a lost creation acknowledgement as unknown and never re-creates on replay", async () => {
    daemon.createFault = "lost";
    const request = launch();
    const error = await rejection(service.startAgent(alice.principal, request));
    expect(error.code).toBe("outcome_unknown");
    expect(error.details).toEqual({ operationId: anyString, state: "outcome_unknown" });
    // The daemon did create an agent, but it was never confirmed, recorded or prompted.
    expect([...daemon.agents.keys()]).toEqual(["agent-1"]);
    expect(daemon.delivered).toEqual([]);
    expect(await database.connector.listOwnedAgents(alice.identity)).toEqual([]);
    expect(
      await database.connector.findOperation(alice.identity, error.details!.operationId!),
    ).toMatchObject({ state: "outcome_unknown", errorCode: "create_outcome_unknown" });

    daemon.createFault = undefined;
    const replay = await rejection(service.startAgent(alice.principal, request));
    expect(replay).toMatchObject({
      code: "outcome_unknown",
      details: { operationId: error.details!.operationId },
    });
    expect(daemon.calledMethods().filter((method) => method === "create")).toHaveLength(1);
    expect(daemon.delivered).toEqual([]);
  });

  it("classifies an explicit unknown outcome or an unreadable answer as unknown, never failed", async () => {
    for (const fault of ["unknown", "unreadable"] as const) {
      daemon.createFault = fault;
      const error = await rejection(service.startAgent(alice.principal, launch()));
      expect(error.code).toBe("outcome_unknown");
      expect(
        await database.connector.findOperation(alice.identity, error.details!.operationId!),
      ).toMatchObject({ state: "outcome_unknown", errorCode: "create_outcome_unknown" });
    }
    expect(daemon.delivered).toEqual([]);
  });

  it("reports an old daemon as incompatible without prompting", async () => {
    daemon.createFault = "unsupported";
    const error = await rejection(service.startAgent(alice.principal, launch()));
    expect(error.code).toBe("machine_incompatible");
    expect(
      await database.connector.findOperation(alice.identity, error.details!.operationId!),
    ).toMatchObject({ state: "failed", errorCode: "machine_incompatible" });
    expect(daemon.calledMethods()).not.toContain("send");
  });

  it("does not send the task when ownership cannot be recorded", async () => {
    const bobLaunch = await database.connector.beginOperation({
      ...bob.identity,
      id: randomUUID(),
      kind: "launch",
      requestKey: randomUUID(),
      requestFingerprint: "bob",
      creationKey: randomUUID(),
      messageId: randomUUID(),
      agentId: null,
      workspaceId: null,
      state: "creating",
      errorCode: null,
    });
    await database.connector.bindCreatedAgent(
      bob.identity,
      bobLaunch.id,
      "agent-shared",
      "workspace-shared",
      T0,
    );
    daemon.nextAgentId = "agent-shared";

    const error = await rejection(service.startAgent(alice.principal, launch()));
    expect(error.code).toBe("outcome_unknown");
    expect(error.details).toEqual({ operationId: anyString, state: "outcome_unknown" });
    expect(daemon.calledMethods()).toEqual(["snapshot", "create"]);
    expect(await database.connector.listOwnedAgents(alice.identity)).toEqual([]);
    expect(
      await database.connector.findOperation(alice.identity, error.details!.operationId!),
    ).toMatchObject({ state: "outcome_unknown", errorCode: "bind_failed", agentId: null });
    expect(await database.connector.findOwnedAgent(bob.identity, "agent-shared")).toMatchObject({
      launchOperationId: bobLaunch.id,
    });
  });

  it("keeps the created agent owned when the prompt is rejected, and replays without resending", async () => {
    daemon.sendFault = "reject";
    const request = launch();
    const error = await rejection(service.startAgent(alice.principal, request));
    expect(error.code).toBe("prompt_rejected");
    expect(error.details).toEqual({
      operationId: anyString,
      agentId: "agent-1",
      state: "created",
    });
    expect(await database.connector.findOwnedAgent(alice.identity, "agent-1")).toBeDefined();
    expect(
      await database.connector.findOperation(alice.identity, error.details!.operationId!),
    ).toMatchObject({ state: "created", errorCode: "prompt_rejected", agentId: "agent-1" });

    daemon.sendFault = undefined;
    const replay = await rejection(service.startAgent(alice.principal, request));
    expect(replay).toMatchObject({
      code: "prompt_rejected",
      details: { operationId: error.details!.operationId, agentId: "agent-1" },
    });
    expect(daemon.calledMethods().filter((method) => method === "send")).toHaveLength(1);
    expect(daemon.calledMethods().filter((method) => method === "create")).toHaveLength(1);
    expect(daemon.delivered).toEqual([]);
  });

  it("reports a lost prompt acknowledgement as unknown and never mints a new message id", async () => {
    daemon.sendFault = "lost";
    const request = launch();
    const error = await rejection(service.startAgent(alice.principal, request));
    expect(error).toMatchObject({
      code: "outcome_unknown",
      details: { agentId: "agent-1", state: "outcome_unknown" },
    });
    const operation = await database.connector.findOperation(
      alice.identity,
      error.details!.operationId!,
    );
    expect(operation).toMatchObject({
      state: "outcome_unknown",
      errorCode: "prompt_outcome_unknown",
    });

    daemon.sendFault = undefined;
    await expect(service.startAgent(alice.principal, request)).rejects.toMatchObject({
      code: "outcome_unknown",
      details: { operationId: operation!.id, agentId: "agent-1" },
    });
    const sends = daemon.calls.filter((call) => call.method === "send");
    expect(sends.map((call) => call.args[1])).toEqual([operation!.messageId]);
    expect(daemon.delivered).toHaveLength(1);
  });

  it("lets only the caller that claims a request key reach the daemon; the rest see it pending", async () => {
    const request = launch();
    // The winner's creation is held open until every other caller has answered, so the others
    // necessarily meet the claimed, still-unresolved operation.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    daemon.beforeCreate = () => held;
    const answered: OperationResult[] = [];
    const record = (result: OperationResult) => {
      answered.push(result);
      return result;
    };
    const calls = Array.from({ length: 4 }, () =>
      service.startAgent(alice.principal, request).then(record),
    );
    await vi.waitFor(() => expect(answered).toHaveLength(3), { timeout: 10_000 });
    expect(daemon.calledMethods().filter((method) => method === "create")).toHaveLength(1);
    release();
    const results = await Promise.all(calls);

    expect(new Set(results.map((result) => result.operationId)).size).toBe(1);
    const accepted = results.filter((result) => result.state === "accepted");
    expect(accepted).toEqual([
      {
        operationId: results[0]!.operationId,
        state: "accepted",
        agentId: "agent-1",
        workspaceId: "workspace-agent-1",
      },
    ]);
    expect(answered.slice(0, 3)).toEqual(
      Array.from({ length: 3 }, () => ({
        operationId: results[0]!.operationId,
        state: "creating",
        agentId: null,
        workspaceId: null,
      })),
    );
    expect(daemon.calledMethods().filter((method) => method === "create")).toHaveLength(1);
    expect(daemon.calledMethods().filter((method) => method === "send")).toHaveLength(1);
    expect(await operationsOf(alice.identity)).toBe(1);
    expect(await service.startAgent(alice.principal, request)).toEqual(accepted[0]);
  });

  it("returns the daemon's acceptance when recording it fails, and replays it as unresolved with its ids", async () => {
    const store = database.connector;
    const setOperationState = store.setOperationState.bind(store);
    const failure = new Error("connection terminated unexpectedly");
    const spy = vi
      .spyOn(store, "setOperationState")
      .mockImplementation(async (identity, operationId, state, errorCode) => {
        if (state === "accepted") throw failure;
        return setOperationState(identity, operationId, state, errorCode);
      });
    const request = launch();
    let started: OperationResult;
    let followUp: OperationResult;
    const message = { request_key: randomUUID(), agent_id: "agent-1", text: "Also add tests" };
    try {
      started = await service.startAgent(alice.principal, request);
      followUp = await service.sendAgentMessage(alice.principal, message);
    } finally {
      spy.mockRestore();
    }
    expect(started).toEqual({
      operationId: anyString,
      state: "accepted",
      agentId: "agent-1",
      workspaceId: "workspace-agent-1",
    });
    expect(followUp).toEqual({
      operationId: anyString,
      state: "accepted",
      agentId: "agent-1",
      workspaceId: null,
    });
    expect(reported).toEqual([
      { error: failure, operation: "paseo_connector.operation.record_accepted" },
      { error: failure, operation: "paseo_connector.operation.record_accepted" },
    ]);
    expect(
      await database.connector.findOperation(alice.identity, started.operationId),
    ).toMatchObject({ state: "created", errorCode: null, agentId: "agent-1" });
    expect(
      await database.connector.findOperation(alice.identity, followUp.operationId),
    ).toMatchObject({ state: "creating", errorCode: null, agentId: "agent-1" });

    expect(await rejection(service.startAgent(alice.principal, request))).toMatchObject({
      code: "outcome_unknown",
      details: { operationId: started.operationId, agentId: "agent-1", state: "created" },
    });
    expect(await service.sendAgentMessage(alice.principal, message)).toEqual({
      operationId: followUp.operationId,
      state: "creating",
      agentId: "agent-1",
      workspaceId: null,
    });
    expect(daemon.calledMethods().filter((method) => method === "send")).toHaveLength(2);
    expect(daemon.delivered.map((delivery) => delivery.text)).toEqual([
      "Fix the failing build",
      "Also add tests",
    ]);
  });

  it("names a daemon refusal as such and keeps machine_incompatible for an old daemon", async () => {
    const started = await service.startAgent(alice.principal, launch());
    const agentId = started.agentId!;
    daemon.readFault = "reject";
    expect(await rejection(service.getAgent(alice.principal, { agent_id: agentId }))).toMatchObject(
      {
        code: "daemon_rejected",
        message: "the machine refused: Permission denied: workspace.read is required",
      },
    );
    daemon.readFault = "unreadable";
    expect(await rejection(service.getAgent(alice.principal, { agent_id: agentId }))).toMatchObject(
      {
        code: "daemon_rejected",
        message: "the machine's answer could not be read",
      },
    );
    daemon.readFault = "unsupported";
    expect((await rejection(service.getAgent(alice.principal, { agent_id: agentId }))).code).toBe(
      "machine_incompatible",
    );
    daemon.controlFault = "reject";
    expect(
      await rejection(service.cancelAgent(alice.principal, { agent_id: agentId })),
    ).toMatchObject({
      code: "daemon_rejected",
      message: "the machine refused: Permission denied: workspace.write is required",
    });
    // A cancellation is a mutation: an answer that cannot be read leaves its outcome unknown.
    daemon.controlFault = "unreadable";
    expect(
      await rejection(service.cancelAgent(alice.principal, { agent_id: agentId })),
    ).toMatchObject({
      code: "outcome_unknown",
      details: { agentId },
    });
  });

  it("bounds what it accepts and what it returns", async () => {
    for (const request of [
      launch({ task: "x".repeat(100_001) }),
      launch({ title: "x".repeat(201) }),
      launch({ provider: "x".repeat(201) }),
      launch({ model: "x".repeat(201) }),
      launch({ mode: "x".repeat(201) }),
    ]) {
      await expect(service.startAgent(alice.principal, request)).rejects.toThrow();
    }
    expect(daemon.calls).toEqual([]);
    expect(await operationsOf(alice.identity)).toBe(0);

    const started = await service.startAgent(
      alice.principal,
      launch({ task: "x".repeat(100_000) }),
    );
    await expect(
      service.sendAgentMessage(alice.principal, {
        request_key: randomUUID(),
        agent_id: started.agentId!,
        text: "x".repeat(100_001),
      }),
    ).rejects.toThrow();
    const agent = daemon.agents.get(started.agentId!)!;
    agent.snapshot = {
      ...agent.snapshot,
      requiresAttention: true,
      attentionReason: "r".repeat(1_000),
      pendingPermissions: Array.from({ length: 25 }, (_, index) => ({
        id: `perm-${index}`,
        kind: "tool",
        name: "n".repeat(1_000),
        title: "t".repeat(1_000),
      })),
    };
    const result = await service.getAgent(alice.principal, { agent_id: started.agentId! });
    if (result.type !== "agent") throw new Error("expected an agent result");
    expect(result.agent.attentionReason).toHaveLength(200);
    expect(result.agent.pendingPermissionCount).toBe(25);
    expect(result.agent.pendingPermissions).toHaveLength(20);
    expect(result.agent.pendingPermissions[0]!.name).toHaveLength(200);
    expect(result.agent.pendingPermissions[0]!.title).toHaveLength(200);
  });

  it("refuses a reused request key for a different task", async () => {
    const request = launch();
    const first = await service.startAgent(alice.principal, request);
    const error = await rejection(
      service.startAgent(alice.principal, { ...request, task: "Something else" }),
    );
    expect(error.code).toBe("request_conflict");
    expect(daemon.calledMethods().filter((method) => method === "create")).toHaveLength(1);
    expect(await service.startAgent(alice.principal, request)).toEqual(first);
  });

  it("validates the runtime against the live catalog before any operation exists", async () => {
    for (const request of [
      launch({ provider: "unknown" }),
      launch({ provider: "codex" }),
      launch({ provider: "gemini" }),
      launch({ model: "retired" }),
      launch({ model: "missing" }),
      launch({ mode: "yolo" }),
    ]) {
      expect((await rejection(service.startAgent(alice.principal, request))).code).toBe(
        "runtime_unavailable",
      );
    }
    expect(daemon.calledMethods().every((method) => method === "snapshot")).toBe(true);
    expect(await operationsOf(alice.identity)).toBe(0);
  });

  it("fails offline without recording an operation and never presents cached state", async () => {
    const started = await service.startAgent(alice.principal, launch());
    online = false;
    daemon.calls.length = 0;
    expect((await rejection(service.startAgent(alice.principal, launch()))).code).toBe(
      "machine_offline",
    );
    expect(await operationsOf(alice.identity)).toBe(1);
    expect(
      (await rejection(service.getAgent(alice.principal, { agent_id: started.agentId! }))).code,
    ).toBe("machine_offline");
    expect(
      (
        await rejection(
          service.sendAgentMessage(alice.principal, {
            request_key: randomUUID(),
            agent_id: started.agentId!,
            text: "more",
          }),
        )
      ).code,
    ).toBe("machine_offline");
    expect((await rejection(service.listRuntimes(alice.principal))).code).toBe("machine_offline");
    expect(await operationsOf(alice.identity)).toBe(1);
    expect((await service.listAgents(alice.principal)).agents).toEqual([
      expect.objectContaining({ agentId: "agent-1", liveState: { available: false } }),
    ]);
    expect((await service.getConnection(alice.principal)).machine.online).toBe(false);
    expect(daemon.calls).toEqual([]);
  });

  it("conceals agents this connection does not own and never contacts the daemon for them", async () => {
    const bobs = await service.startAgent(bob.principal, launch());
    daemon.seedAgent("agent-unrelated");
    daemon.calls.length = 0;
    for (const agentId of [bobs.agentId!, "agent-unrelated", "agent-missing"]) {
      for (const attempt of [
        service.getAgent(alice.principal, { agent_id: agentId }),
        service.sendAgentMessage(alice.principal, {
          request_key: randomUUID(),
          agent_id: agentId,
          text: "hello",
        }),
        service.cancelAgent(alice.principal, { agent_id: agentId }),
      ].map(rejection)) {
        const error = await attempt;
        expect(error.code).toBe("not_found");
        expect(error.details).toBeUndefined();
      }
    }
    expect(
      (await rejection(service.getAgent(alice.principal, { operation_id: bobs.operationId }))).code,
    ).toBe("not_found");
    expect(daemon.calls).toEqual([]);
    expect(await operationsOf(alice.identity)).toBe(0);
  });

  it("lists only this connection's recorded agents with their live status", async () => {
    const mine = await service.startAgent(alice.principal, launch());
    await service.startAgent(bob.principal, launch());
    daemon.seedAgent("agent-unrelated");
    const { agents } = await service.listAgents(alice.principal);
    expect(agents).toEqual([
      {
        agentId: mine.agentId,
        workspaceId: mine.workspaceId,
        launchOperationId: mine.operationId,
        createdAt: T0.toISOString(),
        liveState: { available: true, status: "running" },
      },
    ]);
    expect(
      daemon.calls.filter((call) => call.method === "get").map((call) => call.args[0]),
    ).toEqual([mine.agentId]);
  });

  it("rejects a removed member or a revoked connection before any daemon call", async () => {
    const started = await service.startAgent(alice.principal, launch());
    daemon.calls.length = 0;
    await bundle.runtime.query("delete from member where user_id = $1", [machine.alice]);
    for (const attempt of [
      service.startAgent(alice.principal, launch()),
      service.getAgent(alice.principal, { agent_id: started.agentId! }),
      service.cancelAgent(alice.principal, { agent_id: started.agentId! }),
      service.listAgents(alice.principal),
    ].map(rejection)) {
      expect((await attempt).code).toBe("connection_revoked");
    }
    expect(
      await database.connector.revokeConnection(machine.bob, bob.principal.connectionId, T0),
    ).toBe(true);
    for (const attempt of [
      service.startAgent(bob.principal, launch()),
      service.getConnection(bob.principal),
    ].map(rejection)) {
      expect((await attempt).code).toBe("connection_revoked");
    }
    expect(daemon.calls).toEqual([]);
    // Revocation does not stop work already running.
    expect(daemon.agents.get(started.agentId!)!.snapshot.status).toBe("running");
  });

  it("lets a read-only token read but not start or message", async () => {
    const started = await service.startAgent(alice.principal, launch());
    daemon.calls.length = 0;
    const reader = { ...alice.principal, scopes: ["paseo:read"] };
    for (const attempt of [
      service.startAgent(reader, launch()),
      service.sendAgentMessage(reader, {
        request_key: randomUUID(),
        agent_id: started.agentId!,
        text: "more",
      }),
      service.cancelAgent(reader, { agent_id: started.agentId! }),
    ].map(rejection)) {
      expect((await attempt).code).toBe("insufficient_scope");
    }
    expect(daemon.calls).toEqual([]);
    await expect(service.getAgent(reader, { agent_id: started.agentId! })).resolves.toMatchObject({
      type: "agent",
    });
  });

  it("sends a follow-up once per request key", async () => {
    const started = await service.startAgent(alice.principal, launch());
    const message = {
      request_key: randomUUID(),
      agent_id: started.agentId!,
      text: "Also add tests",
    };
    const first = await service.sendAgentMessage(alice.principal, message);
    expect(first).toEqual({
      operationId: anyString,
      state: "accepted",
      agentId: started.agentId,
      workspaceId: null,
    });
    expect(await service.sendAgentMessage(alice.principal, message)).toEqual(first);
    expect(daemon.delivered.map((delivery) => delivery.text)).toEqual([
      "Fix the failing build",
      "Also add tests",
    ]);
    expect(
      (await rejection(service.sendAgentMessage(alice.principal, { ...message, text: "other" })))
        .code,
    ).toBe("request_conflict");
    expect(
      (
        await rejection(
          service.startAgent(alice.principal, launch({ request_key: message.request_key })),
        )
      ).code,
    ).toBe("request_conflict");
  });

  it("records a rejected or unconfirmed follow-up without sending it again", async () => {
    const started = await service.startAgent(alice.principal, launch());
    daemon.sendFault = "reject";
    const rejected = { request_key: randomUUID(), agent_id: started.agentId!, text: "one" };
    expect(await rejection(service.sendAgentMessage(alice.principal, rejected))).toMatchObject({
      code: "prompt_rejected",
      details: { agentId: started.agentId, state: "failed" },
    });
    daemon.sendFault = "unknown";
    const unknown = { request_key: randomUUID(), agent_id: started.agentId!, text: "two" };
    expect(await rejection(service.sendAgentMessage(alice.principal, unknown))).toMatchObject({
      code: "outcome_unknown",
      details: { agentId: started.agentId },
    });
    daemon.sendFault = undefined;
    const sendsBefore = daemon.calledMethods().filter((method) => method === "send").length;
    expect((await rejection(service.sendAgentMessage(alice.principal, rejected))).code).toBe(
      "prompt_rejected",
    );
    expect((await rejection(service.sendAgentMessage(alice.principal, unknown))).code).toBe(
      "outcome_unknown",
    );
    expect(daemon.calledMethods().filter((method) => method === "send")).toHaveLength(sendsBefore);
  });

  it("cancels by interrupting only, keeping the session", async () => {
    const started = await service.startAgent(alice.principal, launch());
    daemon.calls.length = 0;
    expect(await service.cancelAgent(alice.principal, { agent_id: started.agentId! })).toEqual({
      agentId: started.agentId,
      cancelRequested: true,
    });
    expect(daemon.calls).toEqual([
      { method: "control", args: [started.agentId, started.workspaceId, "interrupt"] },
    ]);
    const after = await service.getAgent(alice.principal, { agent_id: started.agentId! });
    expect(after).toMatchObject({ type: "agent", agent: { status: "idle" } });
  });

  it("returns a bounded timeline with cursors, reset signals and the actual status", async () => {
    const started = await service.startAgent(alice.principal, launch());
    const agentId = started.agentId!;
    for (let index = 0; index < 29; index += 1)
      daemon.append(agentId, { type: "assistant_message", text: `step ${index}` });
    daemon.append(agentId, { type: "assistant_message", text: "x".repeat(9_000) });
    daemon.append(agentId, {
      type: "tool_call",
      callId: "call-1",
      name: "Bash",
      status: "failed",
      error: { message: "exit 1" },
    });
    daemon.append(agentId, { type: "reasoning", text: "private chain of thought" });
    daemon.agents.get(agentId)!.snapshot = {
      ...daemon.agents.get(agentId)!.snapshot,
      status: "idle",
      requiresAttention: true,
      attentionReason: "permission",
      pendingPermissions: [
        { id: "perm-1", kind: "tool", name: "Bash", title: "Run rm", input: { command: "rm" } },
      ],
    };

    const tail = await service.getAgent(alice.principal, { agent_id: agentId });
    if (tail.type !== "agent") throw new Error("expected an agent result");
    expect(daemon.calls.at(-1)).toEqual({
      method: "timeline",
      args: [agentId, { direction: "tail", limit: 20 }],
    });
    expect(tail.agent).toMatchObject({
      agentId,
      status: "idle",
      requiresAttention: true,
      attentionReason: "permission",
      pendingPermissions: [{ id: "perm-1", kind: "tool", name: "Bash", title: "Run rm" }],
    });
    expect(tail.timeline.entries).toHaveLength(20);
    expect(tail.timeline).toMatchObject({ hasOlder: true, hasNewer: false, reset: false });
    const [long, tool, reasoning] = tail.timeline.entries.slice(-3);
    expect(long).toMatchObject({ type: "assistant_message", truncated: true });
    expect(long!.text).toHaveLength(8_000);
    expect(tool).toMatchObject({
      type: "tool_call",
      toolName: "Bash",
      toolStatus: "failed",
      toolError: '{"message":"exit 1"}',
    });
    expect(reasoning).toEqual(expect.not.objectContaining({ text: anything }));

    const older = await service.getAgent(alice.principal, {
      agent_id: agentId,
      cursor: tail.timeline.startCursor!,
      direction: "before",
      limit: 5,
    });
    if (older.type !== "agent") throw new Error("expected an agent result");
    expect(older.timeline.entries.map((entry) => entry.seqEnd)).toEqual([9, 10, 11, 12, 13]);

    const stale = await service.getAgent(alice.principal, {
      agent_id: agentId,
      cursor: { epoch: "epoch-0", seq: 3 },
      limit: 100,
    });
    if (stale.type !== "agent") throw new Error("expected an agent result");
    expect(stale.timeline).toMatchObject({ staleCursor: true, reset: true });
    expect(daemon.calls.at(-1)!.args[1]).toEqual({
      cursor: { epoch: "epoch-0", seq: 3 },
      direction: "after",
      limit: 100,
    });

    await expect(
      service.getAgent(alice.principal, { agent_id: agentId, limit: 0 }),
    ).rejects.toThrow();
    await expect(
      service.getAgent(alice.principal, { agent_id: agentId, limit: 101 }),
    ).rejects.toThrow();
    expect(
      daemon.calls.filter((call) => call.method === "timeline").map((call) => call.args[1]),
    ).toEqual(expect.not.arrayContaining([expect.objectContaining({ limit: 0 })]));
  });

  it("reports an owned agent whose session is gone as not found", async () => {
    const started = await service.startAgent(alice.principal, launch());
    daemon.agents.delete(started.agentId!);
    expect(
      await rejection(service.getAgent(alice.principal, { agent_id: started.agentId! })),
    ).toMatchObject({ code: "not_found", details: { agentId: started.agentId } });
  });

  it("reports an operation's stored disposition without inventing an agent", async () => {
    daemon.createFault = "lost";
    const unresolved = await rejection(service.startAgent(alice.principal, launch()));
    daemon.createFault = undefined;
    const accepted = await service.startAgent(alice.principal, launch());
    daemon.calls.length = 0;
    online = false;
    expect(
      await service.getAgent(alice.principal, { operation_id: unresolved.details!.operationId! }),
    ).toEqual({
      type: "operation",
      operation: {
        operationId: unresolved.details!.operationId,
        kind: "launch",
        state: "outcome_unknown",
        errorCode: "create_outcome_unknown",
        agentId: null,
      },
    });
    expect(
      await service.getAgent(alice.principal, { operation_id: accepted.operationId }),
    ).toMatchObject({
      operation: { state: "accepted", agentId: accepted.agentId },
    });
    expect(daemon.calls).toEqual([]);
  });

  it("describes the connection and runtimes without credentials", async () => {
    const connection = await service.getConnection(alice.principal);
    expect(connection).toEqual({
      connectionId: alice.principal.connectionId,
      machine: { name: machine.slug, online: true },
      workingDirectory: WORKING_DIRECTORY,
      scopes: ["paseo:read", "paseo:run", "paseo:cancel"],
      createdAt: T0.toISOString(),
    });
    const { runtimes } = await service.listRuntimes(alice.principal);
    expect(runtimes[0]).toEqual({
      provider: "claude",
      label: "Claude",
      status: "ready",
      enabled: true,
      models: [{ id: "opus", label: "Opus", isDefault: true }],
      modes: [
        { id: "default", label: "Default" },
        { id: "plan", label: "Plan" },
      ],
      defaultModeId: "default",
    });
    expect(runtimes.map((runtime) => [runtime.provider, runtime.status, runtime.enabled])).toEqual([
      ["claude", "ready", true],
      ["codex", "error", true],
      ["gemini", "ready", false],
    ]);
  });
});

describe("Paseo connector service across a restart", () => {
  it("still resolves owned agents after the embedded database is closed and reopened", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-connector-restart-"));
    let bundle = await embeddedDatabaseRuntime(join(root, "database"));
    try {
      await bundle.runtime.migrate();
      let database = createDatabase(bundle.runtime, bundle.locks);
      const machine = await seedMachine(bundle, database);
      const { principal } = await connect(database, machine, machine.alice);
      const daemon = new DaemonDouble();
      const connection = daemonConnection(daemon);
      const serviceFor = (current: Database) =>
        createConnectorService({ database: current, connectionForDaemon: () => connection });
      const started = await serviceFor(database).startAgent(principal, launch());

      await bundle.runtime.close();
      bundle = await embeddedDatabaseRuntime(join(root, "database"));
      await bundle.runtime.migrate();
      database = createDatabase(bundle.runtime, bundle.locks);
      const service = serviceFor(database);

      expect((await service.listAgents(principal)).agents).toEqual([
        expect.objectContaining({
          agentId: started.agentId,
          liveState: { available: true, status: "running" },
        }),
      ]);
      expect(await service.getAgent(principal, { agent_id: started.agentId! })).toMatchObject({
        type: "agent",
        agent: { agentId: started.agentId, launchOperationId: started.operationId },
      });
      expect(
        await service.getAgent(principal, { operation_id: started.operationId }),
      ).toMatchObject({ operation: { state: "accepted", agentId: started.agentId } });
    } finally {
      await bundle.runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("Paseo connector service wiring", () => {
  it("is built on the application's daemon resolver, including its test injection", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-connector-wiring-"));
    const bundle = await embeddedDatabaseRuntime(join(root, "database"));
    await bundle.runtime.migrate();
    const database = createDatabase(bundle.runtime, bundle.locks);
    const auth = createAuthServer({
      database: bundle.runtime,
      locks: bundle.locks,
      entitlements: composeEntitlements(database, bundle.runtime).service,
      secret: "connector-service-test-secret-at-least-32-characters",
      baseURL: "http://localhost:3000",
      policy: { registrationMode: "open", organizationCreation: "open", bootstrap: undefined },
    });
    try {
      const machine = await seedMachine(bundle, database);
      const { principal } = await connect(database, machine, machine.alice);
      const daemon = new DaemonDouble();
      const connection = daemonConnection(daemon);
      const application = await createApplicationRuntime({
        database,
        auth,
        entitlements: composeEntitlements(database, bundle.runtime).service,
        billing: null,
        daemonConnectionForId: (daemonId) =>
          daemonId === machine.daemonId ? connection : undefined,
        close: () => Promise.resolve(),
      });
      try {
        const connector = application.paseoConnector;
        if (connector.status !== "enabled") throw new Error("connector should be enabled");
        expect((await connector.service.getConnection(principal)).machine.online).toBe(true);
        await connector.service.listRuntimes(principal);
        expect(daemon.calls).toEqual([{ method: "snapshot", args: [WORKING_DIRECTORY] }]);
      } finally {
        await application.stop();
      }
    } finally {
      await auth.close();
      await bundle.runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
