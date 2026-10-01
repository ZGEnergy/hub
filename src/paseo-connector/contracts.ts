/** Shared connector contracts. Existing user/org ids are text; daemon and connector ids are UUIDs. */
export const CONNECTOR_SCOPES = ["paseo:read", "paseo:run", "paseo:cancel"] as const;
export type ConnectorScope = (typeof CONNECTOR_SCOPES)[number];

/** The browser carries the flow id beside, never inside, the library's signed query. */
export const CONNECTOR_FLOW_PARAM = "connector_flow";

/** The four columns that together prove who may touch a connector resource. */
export interface Identity {
  connectionId: string;
  ownerUserId: string;
  organizationId: string;
  daemonId: string;
}

export interface ConnectorConnection extends Identity {
  workingDirectory: string;
  scopes: readonly ConnectorScope[];
  createdAt: Date;
  /** Set when the consent flow completes; null until then. Authorization requires non-null. */
  activatedAt: Date | null;
  revokedAt: Date | null;
}

export interface ConsentFlow {
  id: string;
  sessionId: string;
  ownerUserId: string;
  authorizationFingerprint: string;
  connectionId: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export type OperationState = "creating" | "created" | "accepted" | "failed" | "outcome_unknown";

export interface ConnectorOperation extends Identity {
  id: string;
  kind: "launch" | "message";
  requestKey: string;
  requestFingerprint: string;
  creationKey: string | null;
  messageId: string;
  agentId: string | null;
  workspaceId: string | null;
  state: OperationState;
  errorCode: string | null;
}

export interface OwnedAgent extends Identity {
  agentId: string;
  workspaceId: string;
  launchOperationId: string;
  createdAt: Date;
}

export interface TimelineCursor {
  epoch: string;
  seq: number;
}

export type ConnectorErrorCode =
  | "not_found"
  | "insufficient_scope"
  | "connection_revoked"
  | "machine_offline"
  | "machine_incompatible"
  | "runtime_unavailable"
  | "request_conflict"
  | "create_rejected"
  | "prompt_rejected"
  | "outcome_unknown"
  | "invalid_cursor";

export class ConnectorError extends Error {
  constructor(
    readonly code: ConnectorErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

export interface ConnectorStore {
  /** Stores the connection unactivated (activatedAt and revokedAt are always null on creation). */
  createConnection(input: ConnectorConnection): Promise<ConnectorConnection>;
  findConnection(ownerUserId: string, id: string): Promise<ConnectorConnection | undefined>;
  /** Activated connections, newest first. Revoked ones stay listed, carrying revokedAt. */
  listConnections(ownerUserId: string): Promise<readonly ConnectorConnection[]>;
  /** Never contacts the daemon. False when missing, foreign, or already revoked. */
  revokeConnection(ownerUserId: string, id: string, now: Date): Promise<boolean>;
  /**
   * Deletes a connection that never completed consent, with its flows. False, with nothing
   * changed, when it is missing, foreign, or already activated.
   */
  discardPendingConnection(ownerUserId: string, id: string): Promise<boolean>;
  createFlow(input: ConsentFlow): Promise<void>;
  findFlow(ownerUserId: string, sessionId: string, id: string): Promise<ConsentFlow | undefined>;
  /**
   * Atomically consumes an unexpired, unconsumed flow and activates its (unrevoked) connection.
   * False, with nothing changed, otherwise.
   */
  consumeFlow(ownerUserId: string, sessionId: string, id: string, now: Date): Promise<boolean>;
  /**
   * Atomic insert-or-return on (connectionId, requestKey). The same fingerprint returns the
   * existing row unchanged; a different fingerprint throws request_conflict.
   */
  beginOperation(input: ConnectorOperation): Promise<ConnectorOperation>;
  findOperation(identity: Identity, id: string): Promise<ConnectorOperation | undefined>;
  /**
   * One transaction: marks a "creating" launch operation "created" with its agent and workspace and
   * inserts the owned-agent row. Either both persist or neither does.
   */
  bindCreatedAgent(
    identity: Identity,
    operationId: string,
    agentId: string,
    workspaceId: string,
    now: Date,
  ): Promise<OwnedAgent>;
  setOperationState(
    identity: Identity,
    operationId: string,
    state: OperationState,
    errorCode: string | null,
  ): Promise<void>;
  findOwnedAgent(identity: Identity, agentId: string): Promise<OwnedAgent | undefined>;
  listOwnedAgents(identity: Identity): Promise<readonly OwnedAgent[]>;
}
