import {
  CONNECTOR_SCOPES,
  ConnectorError,
  type ConnectorConnection,
  type ConnectorOperation,
  type ConnectorStore,
  type ConsentFlow,
  type Identity,
  type OperationState,
  type OwnedAgent,
} from "../contracts.js";

function sameIdentity(a: Identity, b: Identity): boolean {
  return (
    a.connectionId === b.connectionId &&
    a.ownerUserId === b.ownerUserId &&
    a.organizationId === b.organizationId &&
    a.daemonId === b.daemonId
  );
}

/**
 * Deterministic parity with ConnectorRepository for MemoryDatabase tests. It is not a production
 * fallback: it does not model users, organizations or daemons, only the connector's own rules.
 */
export class MemoryConnectorStore implements ConnectorStore {
  private readonly connections = new Map<string, ConnectorConnection>();
  private readonly flows = new Map<string, ConsentFlow>();
  private readonly operations = new Map<string, ConnectorOperation>();
  private readonly agents: OwnedAgent[] = [];

  async createConnection(input: ConnectorConnection) {
    if (
      input.scopes.length === 0 ||
      !input.scopes.every((scope) => CONNECTOR_SCOPES.includes(scope))
    )
      throw new Error("invalid connector scopes");
    if (this.connections.has(input.connectionId)) throw new Error("connection already exists");
    const stored: ConnectorConnection = { ...input, activatedAt: null, revokedAt: null };
    this.connections.set(stored.connectionId, structuredClone(stored));
    return structuredClone(stored);
  }

  async findConnection(ownerUserId: string, id: string) {
    const connection = this.connections.get(id);
    return connection?.ownerUserId === ownerUserId ? structuredClone(connection) : undefined;
  }

  async listConnections(ownerUserId: string) {
    return structuredClone(
      [...this.connections.values()]
        .filter(({ ownerUserId: owner, activatedAt }) => owner === ownerUserId && activatedAt)
        .sort(
          (a, b) =>
            b.activatedAt!.getTime() - a.activatedAt!.getTime() ||
            a.connectionId.localeCompare(b.connectionId),
        ),
    );
  }

  async revokeConnection(ownerUserId: string, id: string, now: Date) {
    const connection = this.connections.get(id);
    if (connection?.ownerUserId !== ownerUserId || connection.revokedAt !== null) return false;
    connection.revokedAt = new Date(now);
    return true;
  }

  async discardPendingConnection(ownerUserId: string, id: string) {
    const connection = this.connections.get(id);
    if (connection?.ownerUserId !== ownerUserId || connection.activatedAt !== null) return false;
    this.connections.delete(id);
    for (const [flowId, flow] of this.flows) {
      if (flow.connectionId === id) this.flows.delete(flowId);
    }
    return true;
  }

  async createFlow(input: ConsentFlow) {
    const connection = this.connections.get(input.connectionId);
    if (connection?.ownerUserId !== input.ownerUserId) throw new Error("unknown connection");
    if (this.flows.has(input.id)) throw new Error("flow already exists");
    this.flows.set(input.id, structuredClone({ ...input, consumedAt: null }));
  }

  async findFlow(ownerUserId: string, sessionId: string, id: string) {
    const flow = this.flows.get(id);
    return flow?.ownerUserId === ownerUserId && flow.sessionId === sessionId
      ? structuredClone(flow)
      : undefined;
  }

  async consumeFlow(ownerUserId: string, sessionId: string, id: string, now: Date) {
    const flow = this.flows.get(id);
    if (
      flow === undefined ||
      flow.ownerUserId !== ownerUserId ||
      flow.sessionId !== sessionId ||
      flow.consumedAt !== null ||
      flow.expiresAt.getTime() <= now.getTime()
    )
      return false;
    const connection = this.connections.get(flow.connectionId);
    if (connection?.ownerUserId !== ownerUserId || connection.revokedAt !== null) return false;
    flow.consumedAt = new Date(now);
    connection.activatedAt ??= new Date(now);
    return true;
  }

  async beginOperation(input: ConnectorOperation) {
    const connection = this.connections.get(input.connectionId);
    if (connection === undefined || !sameIdentity(connection, input))
      throw new ConnectorError("not_found");
    const existing = [...this.operations.values()].find(
      ({ connectionId, requestKey }) =>
        connectionId === input.connectionId && requestKey === input.requestKey,
    );
    if (existing !== undefined) {
      if (existing.requestFingerprint !== input.requestFingerprint || existing.kind !== input.kind)
        throw new ConnectorError("request_conflict");
      return structuredClone(existing);
    }
    if (this.operations.has(input.id)) throw new Error("operation already exists");
    this.operations.set(input.id, structuredClone(input));
    return structuredClone(input);
  }

  async findOperation(identity: Identity, id: string) {
    const operation = this.operations.get(id);
    return operation !== undefined && sameIdentity(operation, identity)
      ? structuredClone(operation)
      : undefined;
  }

  async bindCreatedAgent(
    identity: Identity,
    operationId: string,
    agentId: string,
    workspaceId: string,
    now: Date,
  ) {
    const operation = this.operations.get(operationId);
    if (operation === undefined || !sameIdentity(operation, identity))
      throw new ConnectorError("not_found");
    if (operation.kind !== "launch" || operation.state !== "creating")
      throw new ConnectorError("request_conflict");
    // Validate everything before mutating anything, so a failure leaves no partial state.
    if (
      this.agents.some((agent) => agent.daemonId === identity.daemonId && agent.agentId === agentId)
    )
      throw new ConnectorError("request_conflict");
    const owned: OwnedAgent = {
      connectionId: identity.connectionId,
      ownerUserId: identity.ownerUserId,
      organizationId: identity.organizationId,
      daemonId: identity.daemonId,
      agentId,
      workspaceId,
      launchOperationId: operationId,
      createdAt: new Date(now),
    };
    Object.assign(operation, { agentId, workspaceId, state: "created", errorCode: null });
    this.agents.push(owned);
    return structuredClone(owned);
  }

  async setOperationState(
    identity: Identity,
    operationId: string,
    state: OperationState,
    errorCode: string | null,
  ) {
    if (state === "created") throw new ConnectorError("request_conflict");
    const operation = this.operations.get(operationId);
    if (operation === undefined || !sameIdentity(operation, identity))
      throw new ConnectorError("not_found");
    Object.assign(operation, { state, errorCode });
  }

  async findOwnedAgent(identity: Identity, agentId: string) {
    const agent = this.agents.find(
      (candidate) => sameIdentity(candidate, identity) && candidate.agentId === agentId,
    );
    return structuredClone(agent);
  }

  async listOwnedAgents(identity: Identity) {
    return structuredClone(
      this.agents
        .filter((agent) => sameIdentity(agent, identity))
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() || a.agentId.localeCompare(b.agentId),
        ),
    );
  }
}
