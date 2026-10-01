import type { QueryHandle, QueryRow, DatabaseRuntime } from "../../db/runtime/index.js";
import {
  ConnectorError,
  type ConnectorConnection,
  type ConnectorOperation,
  type ConnectorScope,
  type ConnectorStore,
  type ConsentFlow,
  type Identity,
  type OperationState,
  type OwnedAgent,
} from "../contracts.js";

interface ConnectionRow extends QueryRow {
  id: string;
  owner_user_id: string;
  organization_id: string;
  daemon_id: string;
  working_directory: string;
  scopes: ConnectorScope[];
  created_at: Date;
  activated_at: Date | null;
  revoked_at: Date | null;
}

interface FlowRow extends QueryRow {
  id: string;
  session_id: string;
  owner_user_id: string;
  authorization_fingerprint: string;
  connection_id: string;
  expires_at: Date;
  consumed_at: Date | null;
}

interface OperationRow extends QueryRow {
  id: string;
  connection_id: string;
  owner_user_id: string;
  organization_id: string;
  daemon_id: string;
  kind: ConnectorOperation["kind"];
  request_key: string;
  request_fingerprint: string;
  creation_key: string | null;
  message_id: string;
  agent_id: string | null;
  workspace_id: string | null;
  state: OperationState;
  error_code: string | null;
}

interface AgentRow extends QueryRow {
  connection_id: string;
  owner_user_id: string;
  organization_id: string;
  daemon_id: string;
  agent_id: string;
  workspace_id: string;
  launch_operation_id: string;
  created_at: Date;
}

const CONNECTION_COLUMNS =
  "id, owner_user_id, organization_id, daemon_id, working_directory, scopes, created_at, activated_at, revoked_at";
const OPERATION_COLUMNS =
  "id, connection_id, owner_user_id, organization_id, daemon_id, kind, request_key, request_fingerprint, creation_key, message_id, agent_id, workspace_id, state, error_code";
const AGENT_COLUMNS =
  "connection_id, owner_user_id, organization_id, daemon_id, agent_id, workspace_id, launch_operation_id, created_at";

/** SQL for "this row carries exactly the identity in $first..$first+3". Compares all four columns. */
function identityMatch(alias: string, first: number): string {
  return `${alias}.connection_id = $${first} and ${alias}.owner_user_id = $${first + 1} and ${alias}.organization_id = $${first + 2} and ${alias}.daemon_id = $${first + 3}`;
}

function identityParams(identity: Identity): [string, string, string, string] {
  return [identity.connectionId, identity.ownerUserId, identity.organizationId, identity.daemonId];
}

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

function hasPgCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

export class ConnectorRepository implements ConnectorStore {
  constructor(private readonly runtime: DatabaseRuntime) {}

  async createConnection(input: ConnectorConnection): Promise<ConnectorConnection> {
    const result = await this.runtime.query<ConnectionRow>(
      `insert into connector_connections
        (id, owner_user_id, organization_id, daemon_id, working_directory, scopes, created_at)
       values ($1, $2, $3, $4, $5, $6::text[], $7)
       returning ${CONNECTION_COLUMNS}`,
      [
        input.connectionId,
        input.ownerUserId,
        input.organizationId,
        input.daemonId,
        input.workingDirectory,
        [...input.scopes],
        input.createdAt,
      ],
    );
    return toConnection(result.rows[0]!);
  }

  async findConnection(ownerUserId: string, id: string) {
    const result = await this.runtime.query<ConnectionRow>(
      `select ${CONNECTION_COLUMNS} from connector_connections where id = $1 and owner_user_id = $2`,
      [id, ownerUserId],
    );
    return result.rows[0] === undefined ? undefined : toConnection(result.rows[0]);
  }

  async listConnections(ownerUserId: string) {
    const result = await this.runtime.query<ConnectionRow>(
      `select ${CONNECTION_COLUMNS} from connector_connections
       where owner_user_id = $1 and activated_at is not null
       order by activated_at desc, id`,
      [ownerUserId],
    );
    return result.rows.map(toConnection);
  }

  async revokeConnection(ownerUserId: string, id: string, now: Date) {
    const result = await this.runtime.query(
      `update connector_connections set revoked_at = $3
       where id = $1 and owner_user_id = $2 and revoked_at is null`,
      [id, ownerUserId, now],
    );
    return result.rowCount > 0;
  }

  async discardPendingConnection(ownerUserId: string, id: string) {
    // Flows go with it through their cascading foreign key.
    const result = await this.runtime.query(
      `delete from connector_connections
       where id = $1 and owner_user_id = $2 and activated_at is null`,
      [id, ownerUserId],
    );
    return result.rowCount > 0;
  }

  async createFlow(input: ConsentFlow) {
    await this.runtime.query(
      `insert into connector_consent_flows
        (id, session_id, owner_user_id, authorization_fingerprint, connection_id, expires_at, consumed_at)
       values ($1, $2, $3, $4, $5, $6, null)`,
      [
        input.id,
        input.sessionId,
        input.ownerUserId,
        input.authorizationFingerprint,
        input.connectionId,
        input.expiresAt,
      ],
    );
  }

  async findFlow(ownerUserId: string, sessionId: string, id: string) {
    const result = await this.runtime.query<FlowRow>(
      `select id, session_id, owner_user_id, authorization_fingerprint, connection_id, expires_at, consumed_at
       from connector_consent_flows where id = $1 and owner_user_id = $2 and session_id = $3`,
      [id, ownerUserId, sessionId],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : {
          id: row.id,
          sessionId: row.session_id,
          ownerUserId: row.owner_user_id,
          authorizationFingerprint: row.authorization_fingerprint,
          connectionId: row.connection_id,
          expiresAt: row.expires_at,
          consumedAt: row.consumed_at,
        };
  }

  async consumeFlow(ownerUserId: string, sessionId: string, id: string, now: Date) {
    // One statement, so consuming the flow and activating its connection are atomic. A flow whose
    // connection is revoked is left unconsumed and activates nothing.
    const result = await this.runtime.query(
      `with consumed as (
         update connector_consent_flows f set consumed_at = $4
         where f.id = $1 and f.owner_user_id = $2 and f.session_id = $3
           and f.consumed_at is null and f.expires_at > $4
           and exists (
             select 1 from connector_connections c
             where c.id = f.connection_id and c.owner_user_id = f.owner_user_id and c.revoked_at is null
           )
         returning f.connection_id, f.owner_user_id
       )
       update connector_connections c set activated_at = coalesce(c.activated_at, $4)
       from consumed
       where c.id = consumed.connection_id and c.owner_user_id = consumed.owner_user_id`,
      [id, ownerUserId, sessionId, now],
    );
    return result.rowCount > 0;
  }

  async beginOperation(input: ConnectorOperation): Promise<ConnectorOperation> {
    const inserted = await this.insertOperation(input);
    if (inserted.rows[0] !== undefined) return toOperation(inserted.rows[0]);
    // The key already exists. Only the same identity may read it back, and only for the same work.
    const existing = await this.runtime.query<OperationRow>(
      `select ${OPERATION_COLUMNS} from connector_operations o
       where ${identityMatch("o", 1)} and o.request_key = $5`,
      [...identityParams(input), input.requestKey],
    );
    const row = existing.rows[0];
    if (row === undefined) throw new ConnectorError("not_found");
    if (row.request_fingerprint !== input.requestFingerprint || row.kind !== input.kind)
      throw new ConnectorError("request_conflict");
    return toOperation(row);
  }

  private async insertOperation(input: ConnectorOperation) {
    try {
      return await this.runtime.query<OperationRow>(
        `insert into connector_operations
          (id, connection_id, owner_user_id, organization_id, daemon_id, kind, request_key,
           request_fingerprint, creation_key, message_id, agent_id, workspace_id, state, error_code)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         on conflict (connection_id, request_key) do nothing
         returning ${OPERATION_COLUMNS}`,
        [
          input.id,
          input.connectionId,
          input.ownerUserId,
          input.organizationId,
          input.daemonId,
          input.kind,
          input.requestKey,
          input.requestFingerprint,
          input.creationKey,
          input.messageId,
          // A new operation always starts unresolved. Only a message names its (owned) agent up
          // front; a launch learns its agent and workspace through bindCreatedAgent.
          input.kind === "message" ? input.agentId : null,
          null,
          "creating",
          null,
        ],
      );
    } catch (error) {
      // No connection carries exactly this identity (the composite foreign key rejected the row).
      if (hasPgCode(error, FOREIGN_KEY_VIOLATION)) throw new ConnectorError("not_found");
      throw error;
    }
  }

  async findOperation(identity: Identity, id: string) {
    const result = await this.runtime.query<OperationRow>(
      `select ${OPERATION_COLUMNS} from connector_operations o
       where ${identityMatch("o", 1)} and o.id = $5`,
      [...identityParams(identity), id],
    );
    return result.rows[0] === undefined ? undefined : toOperation(result.rows[0]);
  }

  async bindCreatedAgent(
    identity: Identity,
    operationId: string,
    agentId: string,
    workspaceId: string,
    now: Date,
  ): Promise<OwnedAgent> {
    try {
      return await this.runtime.transaction((transaction) =>
        bind(transaction, identity, operationId, agentId, workspaceId, now),
      );
    } catch (error) {
      // The daemon agent already belongs to a connection. The transaction rolled back, so the
      // operation is untouched and still "creating".
      if (hasPgCode(error, UNIQUE_VIOLATION)) throw new ConnectorError("request_conflict");
      throw error;
    }
  }

  async setOperationState(
    identity: Identity,
    operationId: string,
    state: OperationState,
    errorCode: string | null,
  ) {
    // An accepted operation is final. A launch whose owned-agent row exists keeps an agent: it may
    // be marked accepted, created (e.g. prompt rejected) or outcome_unknown, never creating/failed.
    // Without that row, "created" is reachable only through bindCreatedAgent.
    const result = await this.runtime.query(
      `update connector_operations o set state = $6::text, error_code = $7
       where ${identityMatch("o", 1)} and o.id = $5
         and (o.state <> 'accepted' or $6::text = 'accepted')
         and case
           when exists (
             select 1 from connector_agents a
             where ${identityMatch("a", 1)} and a.launch_operation_id = o.id
           ) then $6::text not in ('creating', 'failed')
           else $6::text <> 'created'
         end`,
      [...identityParams(identity), operationId, state, errorCode],
    );
    if (result.rowCount > 0) return;
    const present = await this.findOperation(identity, operationId);
    throw new ConnectorError(present === undefined ? "not_found" : "request_conflict");
  }

  async findOwnedAgent(identity: Identity, agentId: string) {
    const result = await this.runtime.query<AgentRow>(
      `select ${AGENT_COLUMNS} from connector_agents a
       where ${identityMatch("a", 1)} and a.agent_id = $5`,
      [...identityParams(identity), agentId],
    );
    return result.rows[0] === undefined ? undefined : toAgent(result.rows[0]);
  }

  async listOwnedAgents(identity: Identity) {
    const result = await this.runtime.query<AgentRow>(
      `select ${AGENT_COLUMNS} from connector_agents a
       where ${identityMatch("a", 1)} order by a.created_at desc, a.agent_id`,
      [...identityParams(identity)],
    );
    return result.rows.map(toAgent);
  }
}

async function bind(
  transaction: QueryHandle,
  identity: Identity,
  operationId: string,
  agentId: string,
  workspaceId: string,
  now: Date,
): Promise<OwnedAgent> {
  const updated = await transaction.query(
    `update connector_operations o set agent_id = $6, workspace_id = $7, state = 'created', error_code = null
     where ${identityMatch("o", 1)} and o.id = $5 and o.kind = 'launch' and o.state = 'creating'`,
    [...identityParams(identity), operationId, agentId, workspaceId],
  );
  if (updated.rowCount === 0) {
    const present = await transaction.query(
      `select 1 from connector_operations o where ${identityMatch("o", 1)} and o.id = $5`,
      [...identityParams(identity), operationId],
    );
    throw new ConnectorError(present.rowCount > 0 ? "request_conflict" : "not_found");
  }
  const inserted = await transaction.query<AgentRow>(
    `insert into connector_agents
      (connection_id, owner_user_id, organization_id, daemon_id, agent_id, workspace_id, launch_operation_id, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning ${AGENT_COLUMNS}`,
    [...identityParams(identity), agentId, workspaceId, operationId, now],
  );
  return toAgent(inserted.rows[0]!);
}

function toConnection(row: ConnectionRow): ConnectorConnection {
  return {
    connectionId: row.id,
    ownerUserId: row.owner_user_id,
    organizationId: row.organization_id,
    daemonId: row.daemon_id,
    workingDirectory: row.working_directory,
    scopes: row.scopes,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    revokedAt: row.revoked_at,
  };
}

function toOperation(row: OperationRow): ConnectorOperation {
  return {
    id: row.id,
    connectionId: row.connection_id,
    ownerUserId: row.owner_user_id,
    organizationId: row.organization_id,
    daemonId: row.daemon_id,
    kind: row.kind,
    requestKey: row.request_key,
    requestFingerprint: row.request_fingerprint,
    creationKey: row.creation_key,
    messageId: row.message_id,
    agentId: row.agent_id,
    workspaceId: row.workspace_id,
    state: row.state,
    errorCode: row.error_code,
  };
}

function toAgent(row: AgentRow): OwnedAgent {
  return {
    connectionId: row.connection_id,
    ownerUserId: row.owner_user_id,
    organizationId: row.organization_id,
    daemonId: row.daemon_id,
    agentId: row.agent_id,
    workspaceId: row.workspace_id,
    launchOperationId: row.launch_operation_id,
    createdAt: row.created_at,
  };
}
