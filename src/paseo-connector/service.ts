import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DaemonAgentError,
  DaemonUnsupportedError,
  isDaemonOutcomeUnknown,
  type AgentSnapshot,
  type AgentTimelineCursor,
  type AgentTimelineEntry,
} from "../daemons/agents/index.js";
import {
  DaemonResponseLostError,
  type DaemonConnection,
  type DaemonCreateAgentOptions,
} from "../daemons/protocol.js";
import type { Database } from "../db/types.js";
import { reportFailure } from "../failures/index.js";
import type { HubProviderSnapshot } from "../hub/protocol.js";
import {
  authorizeConnectorRequest,
  type AuthorizedConnection,
  type ConnectorPrincipal,
} from "./authorization.js";
import {
  AGENT_TIMELINE_DEFAULT_LIMIT,
  AGENT_TIMELINE_MAX_LIMIT,
  CancelAgentInput,
  ConnectorError,
  GetAgentInput,
  SendAgentMessageInput,
  StartAgentInput,
  type ConnectorErrorDetails,
  type ConnectorOperation,
  type ConnectorScope,
  type ConnectorStore,
  type Identity,
  type OperationState,
  type OwnedAgent,
} from "./contracts.js";

/**
 * A launch or follow-up the daemon accepted, or one still pending: "creating" (nothing recorded
 * yet beyond the claim) or "created" (a launch whose agent is recorded and whose task has not been
 * acknowledged). Pending is never a reason to retry with a new key; inspect the operation instead.
 */
export interface OperationResult {
  operationId: string;
  state: "accepted" | "creating" | "created";
  /** Null only for a launch whose agent is not yet recorded. */
  agentId: string | null;
  /** Set for a launch once its agent is recorded; always null for a follow-up. */
  workspaceId: string | null;
}

export interface ConnectionView {
  connectionId: string;
  machine: { name: string; online: boolean };
  workingDirectory: string;
  scopes: readonly ConnectorScope[];
  createdAt: string;
}

export interface RuntimeView {
  provider: string;
  label: string;
  status: "ready" | "loading" | "error" | "unavailable";
  enabled: boolean;
  models: { id: string; label: string; isDefault: boolean }[];
  modes: { id: string; label: string }[];
  defaultModeId: string | null;
}

export interface OwnedAgentView {
  agentId: string;
  workspaceId: string;
  launchOperationId: string;
  createdAt: string;
  /** Live status from the machine, or `available: false`; never a cached status. */
  liveState: { available: true; status: AgentSnapshot["status"] } | { available: false };
}

export interface OperationView {
  operationId: string;
  kind: ConnectorOperation["kind"];
  state: OperationState;
  errorCode: string | null;
  /** Only when the agent is recorded as this connection's; never invented. */
  agentId: string | null;
}

export interface PendingPermissionView {
  id: string | null;
  kind: string | null;
  name: string | null;
  title: string | null;
}

export interface AgentStateView {
  agentId: string;
  workspaceId: string;
  launchOperationId: string;
  createdAt: string;
  /** The daemon's own status. "idle" means no turn is running, not that the task succeeded. */
  status: AgentSnapshot["status"];
  requiresAttention: boolean;
  attentionReason: string | null;
  lastError: string | null;
  /** All approvals waiting on the operator in Paseo; the connector cannot answer them. */
  pendingPermissionCount: number;
  /** The first PERMISSION_LIMIT of them, labels capped at LABEL_LIMIT characters. */
  pendingPermissions: PendingPermissionView[];
}

export interface TimelineEntryView {
  seqStart: number;
  seqEnd: number;
  timestamp: string;
  turnId: string | null;
  type: string;
  /** Message, error, notification or todo text, capped at TEXT_LIMIT characters. */
  text?: string;
  toolName?: string;
  toolStatus?: string;
  toolError?: string;
  /** True when a text field above was cut at TEXT_LIMIT characters. */
  truncated?: boolean;
}

export interface TimelineView {
  epoch: string;
  entries: TimelineEntryView[];
  startCursor: AgentTimelineCursor | null;
  endCursor: AgentTimelineCursor | null;
  hasOlder: boolean;
  hasNewer: boolean;
  /** The daemon rewrote the timeline; earlier cursors no longer apply. */
  reset: boolean;
  /** The given cursor belonged to an older epoch; this is a fresh tail page. */
  staleCursor: boolean;
  /** Entries between the cursor and this page were dropped by the daemon. */
  gap: boolean;
}

export type GetAgentResult =
  | { type: "operation"; operation: OperationView }
  | { type: "agent"; agent: AgentStateView; timeline: TimelineView };

export interface CancelResult {
  agentId: string;
  cancelRequested: true;
}

export interface ConnectorService {
  getConnection(principal: ConnectorPrincipal): Promise<ConnectionView>;
  listRuntimes(principal: ConnectorPrincipal): Promise<{ runtimes: RuntimeView[] }>;
  startAgent(principal: ConnectorPrincipal, input: StartAgentInput): Promise<OperationResult>;
  listAgents(principal: ConnectorPrincipal): Promise<{ agents: OwnedAgentView[] }>;
  getAgent(principal: ConnectorPrincipal, input: GetAgentInput): Promise<GetAgentResult>;
  sendAgentMessage(
    principal: ConnectorPrincipal,
    input: SendAgentMessageInput,
  ): Promise<OperationResult>;
  cancelAgent(principal: ConnectorPrincipal, input: CancelAgentInput): Promise<CancelResult>;
}

/** Reports a failure the caller is not shown, with the caller's own operation id for diagnosis. */
export type FailureReporter = (
  error: unknown,
  operation: string,
  context: { operationId: string },
) => void;

export interface ConnectorServiceOptions {
  database: Database;
  /** The app's resolver (`HubRuntime.connectionForDaemon`), test injection included. */
  connectionForDaemon(daemonId: string): DaemonConnection | undefined;
  now?: () => Date;
  newId?: () => string;
  /** Where failures that must not reach the caller go; defaults to Hub's failure reporter. */
  reportFailure?: FailureReporter;
}

/** Longest single text field returned from a timeline. */
const TEXT_LIMIT = 8_000;
/** Live status is fetched for at most this many of the newest owned agents per list. */
const LIVE_STATUS_LIMIT = 50;
/** Longest attention reason or permission label returned. */
const LABEL_LIMIT = 200;
/** Most pending permissions listed per agent; `pendingPermissionCount` gives the total. */
const PERMISSION_LIMIT = 20;
/** ponytail: the registry's provider snapshot has no deadline of its own; 30s here, move it into the registry. */
const SNAPSHOT_DEADLINE_MS = 30_000;
const AGENT_NOT_FOUND = /^Agent not found\b/u;
/** Plain registry errors meaning no live socket answered. */
const OFFLINE_MESSAGES = new Set(["daemon_not_connected", "daemon disconnected"]);

/**
 * The only path from a token principal to a daemon. Every method re-authorizes, every agent it
 * names must be recorded as this connection's own, and every write is a persisted operation whose
 * request key makes a replay return the recorded disposition instead of acting twice.
 */
export function createConnectorService(options: ConnectorServiceOptions): ConnectorService {
  const { database } = options;
  const store = database.connector;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;

  const report: FailureReporter =
    options.reportFailure ??
    ((error, operation, context) => {
      reportFailure(error, { operation, component: "paseo_connector" }, { diagnostic: context });
    });

  /**
   * The daemon's acceptance is the truth: a failed write of it is reported, not raised, so the
   * caller keeps the ids instead of retrying with a new key. A replay then reports the operation
   * unresolved, with its ids, and never resends.
   */
  const recordAccepted = async (identity: Identity, operationId: string) => {
    try {
      await store.setOperationState(identity, operationId, "accepted", null);
    } catch (error) {
      report(error, "paseo_connector.operation.record_accepted", { operationId });
    }
  };

  const live = (identity: Identity): DaemonConnection => {
    const connection = options.connectionForDaemon(identity.daemonId);
    if (connection === undefined) throw new ConnectorError("machine_offline", "machine is offline");
    return connection;
  };

  return {
    async getConnection(principal) {
      const authorized = await authorizeConnectorRequest(database, principal, "paseo:read");
      return {
        connectionId: authorized.connectionId,
        machine: {
          name: authorized.daemon.slug,
          online: options.connectionForDaemon(authorized.daemonId) !== undefined,
        },
        workingDirectory: authorized.workingDirectory,
        scopes: authorized.scopes,
        createdAt: authorized.createdAt.toISOString(),
      };
    },

    async listRuntimes(principal) {
      const authorized = await authorizeConnectorRequest(database, principal, "paseo:read");
      const snapshot = await readSnapshot(live(authorized), authorized.workingDirectory);
      return {
        runtimes: snapshot.entries.map((entry) => ({
          provider: entry.provider,
          label: entry.label ?? entry.provider,
          status: entry.status,
          enabled: entry.enabled,
          models: (entry.models ?? [])
            .filter((model) => model.isSelectable !== false)
            .map((model) => ({
              id: model.id,
              label: model.label,
              isDefault: model.isDefault === true,
            })),
          modes: (entry.modes ?? []).map((mode) => ({ id: mode.id, label: mode.label })),
          defaultModeId: entry.defaultModeId ?? null,
        })),
      };
    },

    async startAgent(principal, raw) {
      const input = StartAgentInput.parse(raw);
      const authorized = await authorizeConnectorRequest(database, principal, "paseo:run");
      const identity = identityOf(authorized);
      const fingerprint = fingerprintOf({
        kind: "launch",
        task: input.task,
        title: input.title,
        provider: input.provider,
        model: input.model ?? null,
        mode: input.mode ?? null,
      });
      const existing = await store.findOperationByRequestKey(identity, input.request_key);
      if (existing !== undefined) {
        if (existing.kind !== "launch" || existing.requestFingerprint !== fingerprint)
          throw new ConnectorError("request_conflict");
        return resultForExistingOperation(existing);
      }
      // Only new work needs a live runtime; failed prerequisites never claim a request key.
      const daemon = live(identity);
      const runtime = await requireRuntime(daemon, authorized.workingDirectory, input);
      // The atomic request-key claim is the exclusion: exactly one caller inserts the operation and
      // runs the sequence; every concurrent or later caller gets the recorded disposition.
      const id = newId();
      const operation = await store.beginOperation({
        ...identity,
        id,
        kind: "launch",
        requestKey: input.request_key,
        requestFingerprint: fingerprint,
        creationKey: newId(),
        messageId: newId(),
        agentId: null,
        workspaceId: null,
        state: "creating",
        errorCode: null,
      });
      // Another caller may have claimed the key while prerequisites were checked.
      if (operation.id !== id) return resultForExistingOperation(operation);
      const settle = settler(store, identity, operation.id, report);

      let created: AgentSnapshot;
      try {
        created = await daemon.agents.create(operation.creationKey!, {
          provider: input.provider,
          title: input.title,
          cwd: authorized.workingDirectory,
          env: {},
          toolPolicy: { preapproved: [] },
          ...runtime,
        });
      } catch (error) {
        throw await createFailure(error, operation.id, settle);
      }

      try {
        await store.bindCreatedAgent(
          identity,
          operation.id,
          created.id,
          created.workspaceId,
          now(),
        );
      } catch (error) {
        // Ownership is not durable, so the task is never sent to this agent.
        report(error, "paseo_connector.operation.bind", { operationId: operation.id });
        await settle("outcome_unknown", "bind_failed");
        throw new ConnectorError(
          "outcome_unknown",
          "the agent was created but could not be recorded; the task was not sent",
          { operationId: operation.id, state: "outcome_unknown" },
        );
      }

      try {
        await daemon.agents.send(created.id, operation.messageId, input.task);
      } catch (error) {
        throw await promptFailure(error, operation, created.id, "created", settle);
      }
      await recordAccepted(identity, operation.id);
      return {
        operationId: operation.id,
        state: "accepted",
        agentId: created.id,
        workspaceId: created.workspaceId,
      };
    },

    async listAgents(principal) {
      const authorized = await authorizeConnectorRequest(database, principal, "paseo:read");
      const identity = identityOf(authorized);
      const owned = await store.listOwnedAgents(identity);
      const daemon = options.connectionForDaemon(identity.daemonId);
      const agents = await Promise.all(
        owned.map(async (agent, index): Promise<OwnedAgentView> => {
          let liveState: OwnedAgentView["liveState"] = { available: false };
          if (daemon !== undefined && index < LIVE_STATUS_LIMIT) {
            try {
              liveState = {
                available: true,
                status: (await daemon.agents.get(agent.agentId)).status,
              };
            } catch {
              // Unknown now; the durable identity is still listed.
            }
          }
          return Object.assign(ownedView(agent), { liveState });
        }),
      );
      return { agents };
    },

    async getAgent(principal, raw) {
      const input = GetAgentInput.parse(raw);
      const authorized = await authorizeConnectorRequest(database, principal, "paseo:read");
      const identity = identityOf(authorized);
      if ("operation_id" in input) {
        const operation = await store.findOperation(identity, input.operation_id);
        if (operation === undefined) throw new ConnectorError("not_found", "operation not found");
        const recorded =
          operation.agentId !== null &&
          (await store.findOwnedAgent(identity, operation.agentId)) !== undefined;
        return {
          type: "operation",
          operation: {
            operationId: operation.id,
            kind: operation.kind,
            state: operation.state,
            errorCode: operation.errorCode,
            agentId: recorded ? operation.agentId : null,
          },
        };
      }
      const owned = await requireOwnedAgent(store, identity, input.agent_id);
      const daemon = live(identity);
      const limit = Math.min(
        AGENT_TIMELINE_MAX_LIMIT,
        Math.max(1, input.limit ?? AGENT_TIMELINE_DEFAULT_LIMIT),
      );
      const page = await daemon.agents
        .timeline(owned.agentId, {
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          direction: input.direction ?? (input.cursor === undefined ? "tail" : "after"),
          limit,
        })
        .catch((error: unknown) => {
          throw classifyDaemonFailure(error, owned.agentId);
        });
      if (page.agent === null) throw sessionGone(owned.agentId);
      return {
        type: "agent",
        agent: agentStateView(owned, page.agent),
        timeline: {
          epoch: page.epoch,
          entries: page.entries.map(entryView),
          startCursor: page.startCursor,
          endCursor: page.endCursor,
          hasOlder: page.hasOlder,
          hasNewer: page.hasNewer,
          reset: page.reset,
          staleCursor: page.staleCursor,
          gap: page.gap,
        },
      };
    },

    async sendAgentMessage(principal, raw) {
      const input = SendAgentMessageInput.parse(raw);
      const authorized = await authorizeConnectorRequest(database, principal, "paseo:run");
      const identity = identityOf(authorized);
      const owned = await requireOwnedAgent(store, identity, input.agent_id);
      const fingerprint = fingerprintOf({
        kind: "message",
        agentId: owned.agentId,
        text: input.text,
      });
      const existing = await store.findOperationByRequestKey(identity, input.request_key);
      if (existing !== undefined) {
        if (existing.kind !== "message" || existing.requestFingerprint !== fingerprint)
          throw new ConnectorError("request_conflict");
        return resultForExistingOperation(existing);
      }
      const daemon = live(identity);
      const id = newId();
      const operation = await store.beginOperation({
        ...identity,
        id,
        kind: "message",
        requestKey: input.request_key,
        requestFingerprint: fingerprint,
        creationKey: null,
        messageId: newId(),
        agentId: owned.agentId,
        workspaceId: null,
        state: "creating",
        errorCode: null,
      });
      if (operation.id !== id) return resultForExistingOperation(operation);
      const settle = settler(store, identity, operation.id, report);
      try {
        await daemon.agents.send(owned.agentId, operation.messageId, input.text);
      } catch (error) {
        throw await promptFailure(error, operation, owned.agentId, "failed", settle);
      }
      await recordAccepted(identity, operation.id);
      return {
        operationId: operation.id,
        state: "accepted",
        agentId: owned.agentId,
        workspaceId: null,
      };
    },

    async cancelAgent(principal, raw) {
      const input = CancelAgentInput.parse(raw);
      const authorized = await authorizeConnectorRequest(database, principal, "paseo:cancel");
      const identity = identityOf(authorized);
      const owned = await requireOwnedAgent(store, identity, input.agent_id);
      const daemon = live(identity);
      try {
        // Interrupt only: the session is kept, and the caller can never choose archive.
        await daemon.agents.control(owned.agentId, owned.workspaceId, "interrupt");
      } catch (error) {
        // Refused before anything was sent: the registry had no live socket.
        if (error instanceof Error && error.message === "daemon_not_connected")
          throw new ConnectorError("machine_offline", "machine is offline");
        if (isDaemonOutcomeUnknown(error) || !(error instanceof DaemonAgentError)) {
          throw new ConnectorError(
            "outcome_unknown",
            "the machine did not confirm the cancellation; inspect the agent",
            { agentId: owned.agentId },
          );
        }
        throw classifyDaemonFailure(error, owned.agentId);
      }
      return { agentId: owned.agentId, cancelRequested: true };
    },
  };
}

/**
 * The full scoped ownership lookup every agent-naming call makes before contacting a daemon.
 * A missing agent and another identity's agent are the same not_found.
 */
export async function requireOwnedAgent(
  store: ConnectorStore,
  identity: Identity,
  agentId: string,
): Promise<OwnedAgent> {
  const owned = await store.findOwnedAgent(identity, agentId);
  if (owned === undefined) throw new ConnectorError("not_found", "agent not found");
  return owned;
}

/**
 * The recorded disposition of an operation a request key already named. Never sends anything:
 * accepted and still-unresolved operations return, every other disposition throws its error with
 * the caller's own operation identity.
 */
export function resultForExistingOperation(operation: ConnectorOperation): OperationResult {
  const details: ConnectorErrorDetails = {
    operationId: operation.id,
    state: operation.state,
    ...(operation.agentId === null ? {} : { agentId: operation.agentId }),
  };
  // Pending: still in flight in another caller, or stopped before the daemon's acknowledgement was
  // recorded. Either way the ids are returned and nothing is sent again.
  if (
    operation.state === "accepted" ||
    operation.state === "creating" ||
    (operation.state === "created" && operation.errorCode === null)
  ) {
    return {
      operationId: operation.id,
      state: operation.state,
      agentId: operation.agentId,
      workspaceId: operation.workspaceId,
    };
  }
  // A recorded launch agent whose task was rejected before the daemon took it.
  if (
    operation.state === "created" &&
    (operation.errorCode === "prompt_rejected" || operation.errorCode === "machine_incompatible")
  )
    throw new ConnectorError(operation.errorCode, "the task was not accepted", details);
  if (operation.state === "failed")
    throw new ConnectorError(failureCode(operation), "the operation failed", details);
  // outcome_unknown, or "created" with a reason this service does not record.
  throw new ConnectorError("outcome_unknown", "the operation's outcome is unconfirmed", details);
}

function failureCode(operation: ConnectorOperation) {
  if (operation.errorCode === "machine_incompatible") return "machine_incompatible";
  return operation.kind === "launch" ? "create_rejected" : "prompt_rejected";
}

type Settle = (state: OperationState, errorCode: string) => Promise<void>;

/**
 * Records a disposition best-effort: the error being raised matters more than its record. On a
 * failed write the operation keeps its earlier, more conservative state and the failure is reported.
 */
function settler(
  store: ConnectorStore,
  identity: Identity,
  operationId: string,
  report: FailureReporter,
): Settle {
  return async (state, errorCode) => {
    try {
      await store.setOperationState(identity, operationId, state, errorCode);
    } catch (error) {
      report(error, "paseo_connector.operation.record_failure", { operationId });
    }
  };
}

async function createFailure(
  error: unknown,
  operationId: string,
  settle: Settle,
): Promise<ConnectorError> {
  if (error instanceof DaemonUnsupportedError) {
    await settle("failed", "machine_incompatible");
    return new ConnectorError("machine_incompatible", "the machine's Paseo is too old", {
      operationId,
      state: "failed",
    });
  }
  if (error instanceof DaemonAgentError && !isDaemonOutcomeUnknown(error)) {
    await settle("failed", "create_rejected");
    return new ConnectorError(
      "create_rejected",
      `the machine rejected the agent: ${cap(error.message, 500)}`,
      {
        operationId,
        state: "failed",
      },
    );
  }
  // A lost acknowledgement, an explicit unknown outcome, or a response the adapter could not read:
  // none proves that no agent exists.
  await settle("outcome_unknown", "create_outcome_unknown");
  return new ConnectorError("outcome_unknown", "the machine did not confirm the agent's creation", {
    operationId,
    state: "outcome_unknown",
  });
}

async function promptFailure(
  error: unknown,
  operation: ConnectorOperation,
  agentId: string,
  rejectedState: "created" | "failed",
  settle: Settle,
): Promise<ConnectorError> {
  if (error instanceof DaemonAgentError && !isDaemonOutcomeUnknown(error)) {
    const code =
      error instanceof DaemonUnsupportedError ? "machine_incompatible" : "prompt_rejected";
    await settle(rejectedState, code);
    return new ConnectorError(
      code,
      code === "machine_incompatible"
        ? "the machine's Paseo is too old"
        : `the machine rejected the message: ${cap(error.message, 500)}`,
      { operationId: operation.id, agentId, state: rejectedState },
    );
  }
  await settle("outcome_unknown", "prompt_outcome_unknown");
  return new ConnectorError("outcome_unknown", "the machine did not confirm the message", {
    operationId: operation.id,
    agentId,
    state: "outcome_unknown",
  });
}

/**
 * Maps a failed daemon read, or a refused cancellation, to a connector error; never passes a raw
 * error through. Only an old daemon is machine_incompatible.
 */
function classifyDaemonFailure(error: unknown, agentId?: string): ConnectorError {
  if (error instanceof ConnectorError) return error;
  if (error instanceof DaemonUnsupportedError) return tooOld();
  if (error instanceof DaemonResponseLostError)
    return new ConnectorError("machine_offline", "the machine did not answer");
  if (error instanceof DaemonAgentError) {
    if (agentId !== undefined && AGENT_NOT_FOUND.test(error.message)) return sessionGone(agentId);
    return new ConnectorError("daemon_rejected", `the machine refused: ${cap(error.message, 500)}`);
  }
  if (error instanceof Error && OFFLINE_MESSAGES.has(error.message))
    return new ConnectorError("machine_offline", "machine is offline");
  if (error instanceof Error && error.message === "daemon_provider_snapshot_unsupported")
    return tooOld();
  return new ConnectorError("daemon_rejected", "the machine's answer could not be read");
}

function tooOld() {
  return new ConnectorError("machine_incompatible", "the machine's Paseo is too old");
}

function sessionGone(agentId: string) {
  return new ConnectorError("not_found", "the agent's session no longer exists on the machine", {
    agentId,
  });
}

async function readSnapshot(daemon: DaemonConnection, cwd: string): Promise<HubProviderSnapshot> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      daemon.getProviderSnapshot({ cwd }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DaemonResponseLostError()), SNAPSHOT_DEADLINE_MS);
      }),
    ]);
  } catch (error) {
    throw classifyDaemonFailure(error);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Checks the requested runtime against the machine's live catalog for the bound directory and
 * returns the daemon's own model id (an alias resolves to it) and mode.
 */
async function requireRuntime(
  daemon: DaemonConnection,
  cwd: string,
  input: { provider: string; model?: string | undefined; mode?: string | undefined },
): Promise<Pick<DaemonCreateAgentOptions, "model" | "mode">> {
  const snapshot = await readSnapshot(daemon, cwd);
  const entry = snapshot.entries.find((candidate) => candidate.provider === input.provider);
  if (entry === undefined || entry.status !== "ready" || !entry.enabled)
    throw new ConnectorError("runtime_unavailable", `${input.provider} is not available`);
  const runtime: Pick<DaemonCreateAgentOptions, "model" | "mode"> = {};
  if (input.model !== undefined) {
    const requested = input.model;
    const model = (entry.models ?? []).find(
      (candidate) =>
        candidate.isSelectable !== false &&
        (candidate.id === requested || candidate.aliases?.includes(requested) === true),
    );
    if (model === undefined)
      throw new ConnectorError("runtime_unavailable", `model ${requested} is not available`);
    runtime.model = model.id;
  }
  if (input.mode !== undefined) {
    const requested = input.mode;
    if (!(entry.modes ?? []).some((mode) => mode.id === requested))
      throw new ConnectorError("runtime_unavailable", `mode ${requested} is not available`);
    runtime.mode = requested;
  }
  return runtime;
}

function identityOf(authorized: AuthorizedConnection): Identity {
  return {
    connectionId: authorized.connectionId,
    ownerUserId: authorized.ownerUserId,
    organizationId: authorized.organizationId,
    daemonId: authorized.daemonId,
  };
}

/** sha256 of the arguments, serialized in the fixed key order the callers construct. */
function fingerprintOf(value: Record<string, string | null>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function ownedView(agent: OwnedAgent) {
  return {
    agentId: agent.agentId,
    workspaceId: agent.workspaceId,
    launchOperationId: agent.launchOperationId,
    createdAt: agent.createdAt.toISOString(),
  };
}

function agentStateView(owned: OwnedAgent, snapshot: AgentSnapshot): AgentStateView {
  const permissions = snapshot.pendingPermissions ?? [];
  return {
    ...ownedView(owned),
    status: snapshot.status,
    requiresAttention: snapshot.requiresAttention === true,
    attentionReason:
      snapshot.attentionReason == null ? null : cap(snapshot.attentionReason, LABEL_LIMIT),
    lastError: snapshot.lastError === undefined ? null : cap(snapshot.lastError, TEXT_LIMIT),
    pendingPermissionCount: permissions.length,
    pendingPermissions: permissions.slice(0, PERMISSION_LIMIT).map((permission) => ({
      id: labelOrNull(permission["id"]),
      kind: labelOrNull(permission["kind"]),
      name: labelOrNull(permission["name"]),
      title: labelOrNull(permission["title"]),
    })),
  };
}

function entryView(entry: AgentTimelineEntry): TimelineEntryView {
  const { item } = entry;
  const view: TimelineEntryView = {
    seqStart: entry.seqStart,
    seqEnd: entry.seqEnd,
    timestamp: entry.timestamp,
    turnId: entry.turnId ?? null,
    type: item.type,
  };
  let text: string | undefined;
  switch (item.type) {
    case "user_message":
    case "assistant_message":
      text = stringOrNull(item["text"]) ?? undefined;
      break;
    case "error":
    case "notification":
      text = stringOrNull(item["message"]) ?? undefined;
      break;
    case "todo":
      text = todoText(item["items"]);
      break;
    case "tool_call": {
      const name = stringOrNull(item["name"]);
      const status = stringOrNull(item["status"]);
      if (name !== null) view.toolName = name;
      if (status !== null) view.toolStatus = status;
      const error = item["error"];
      if (error !== null && error !== undefined) {
        const message = typeof error === "string" ? error : JSON.stringify(error);
        view.toolError = cap(message, TEXT_LIMIT);
        if (message.length > TEXT_LIMIT) view.truncated = true;
      }
      break;
    }
  }
  if (text !== undefined) {
    view.text = cap(text, TEXT_LIMIT);
    if (text.length > TEXT_LIMIT) view.truncated = true;
  }
  return view;
}

const TodoItems = z.array(z.object({ text: z.string(), completed: z.boolean() }));

function todoText(items: unknown): string | undefined {
  const parsed = TodoItems.safeParse(items);
  if (!parsed.success) return undefined;
  return parsed.data.map((todo) => `- [${todo.completed ? "x" : " "}] ${todo.text}`).join("\n");
}

function labelOrNull(value: unknown): string | null {
  return typeof value === "string" ? cap(value, LABEL_LIMIT) : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function cap(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}
