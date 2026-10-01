import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { AgentSessionRecord } from "../../agent-sessions/index.js";
import {
  ConnectorError,
  type ConnectorConnection,
  type ConnectorOperation,
  type ConnectorStore,
  type Identity,
} from "../contracts.js";

/** What a backing store must provide so the same behavioural contract runs against every store. */
export interface ConnectorStoreFixture {
  store: ConnectorStore;
  organizationId: string;
  aliceUserId: string;
  bobUserId: string;
  /** Two enrolled daemons in `organizationId`. */
  daemonId: string;
  otherDaemonId: string;
  /** Records a Hub agent session that points at a daemon agent, as the existing Hub would. */
  seedUnrelatedSession(daemonId: string, agentId: string): Promise<void>;
  close(): Promise<void>;
}

export const T0 = new Date("2026-03-01T00:00:00.000Z");
const minutes = (count: number) => new Date(T0.getTime() + count * 60_000);

export function connectionFor(
  fixture: Pick<ConnectorStoreFixture, "organizationId" | "daemonId">,
  ownerUserId: string,
  overrides: Partial<ConnectorConnection> = {},
): ConnectorConnection {
  return {
    connectionId: randomUUID(),
    ownerUserId,
    organizationId: fixture.organizationId,
    daemonId: fixture.daemonId,
    workingDirectory: "/work/project",
    scopes: ["paseo:read", "paseo:run"],
    createdAt: T0,
    activatedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

export function identityOf(connection: ConnectorConnection): Identity {
  return {
    connectionId: connection.connectionId,
    ownerUserId: connection.ownerUserId,
    organizationId: connection.organizationId,
    daemonId: connection.daemonId,
  };
}

export function operationFor(
  identity: Identity,
  overrides: Partial<ConnectorOperation> = {},
): ConnectorOperation {
  return {
    ...identity,
    id: randomUUID(),
    kind: "launch",
    requestKey: `key-${randomUUID()}`,
    requestFingerprint: "fingerprint-a",
    creationKey: `creation-${randomUUID()}`,
    messageId: randomUUID(),
    agentId: null,
    workspaceId: null,
    state: "creating",
    errorCode: null,
    ...overrides,
  };
}

/** A Hub agent session as the existing session machinery stores it; it must never count as ownership. */
export function agentSessionFor(
  organizationId: string,
  projectId: string,
  daemonId: string,
  agentId: string,
): AgentSessionRecord {
  return {
    id: randomUUID(),
    organizationId,
    projectId,
    continuationKey: null,
    daemonId,
    agentId,
    workspaceId: "workspace-from-session",
    compatibility: "compat",
    creationOptions: { provider: "claude", toolPolicy: { preapproved: [] }, cwd: "/", env: {} },
    capabilityTokenHash: "hash",
    tools: [],
  };
}

/** A connection whose scopes fall outside the connector's vocabulary, which the types would refuse. */
export function connectionWithScopes(
  fixture: Pick<ConnectorStoreFixture, "organizationId" | "daemonId">,
  ownerUserId: string,
  scopes: readonly string[],
): ConnectorConnection {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the point is an out-of-vocabulary scope the types refuse
  return { ...connectionFor(fixture, ownerUserId), scopes } as ConnectorConnection;
}

async function rejectsWith(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ConnectorError);
  expect(error).toMatchObject({ code });
}

async function activated(fixture: ConnectorStoreFixture, userId: string, at = T0) {
  const connection = await fixture.store.createConnection(connectionFor(fixture, userId));
  const flow = {
    id: randomUUID(),
    sessionId: `session-${userId}`,
    ownerUserId: userId,
    authorizationFingerprint: "fp",
    connectionId: connection.connectionId,
    expiresAt: new Date(at.getTime() + 600_000),
    consumedAt: null,
  };
  await fixture.store.createFlow(flow);
  expect(await fixture.store.consumeFlow(userId, flow.sessionId, flow.id, at)).toBe(true);
  return identityOf(connection);
}

/** The ownership, flow and operation behaviour every ConnectorStore must have. */
export function describeConnectorStoreContract(open: () => Promise<ConnectorStoreFixture>) {
  let current: ConnectorStoreFixture | undefined;
  beforeEach(async () => {
    current = await open();
  });
  afterEach(async () => {
    await current?.close();
    current = undefined;
  });
  const fixtureOf = () => {
    if (current === undefined) throw new Error("fixture is only available inside a test");
    return current;
  };

  it("stores a new connection unactivated and unrevoked even if the input claims otherwise", async () => {
    const fixture = fixtureOf();
    const input = connectionFor(fixture, fixture.aliceUserId, {
      activatedAt: T0,
      revokedAt: T0,
    });
    const created = await fixture.store.createConnection(input);
    expect(created).toMatchObject({ activatedAt: null, revokedAt: null });
    expect(await fixture.store.findConnection(fixture.aliceUserId, input.connectionId)).toEqual(
      created,
    );
    expect(await fixture.store.listConnections(fixture.aliceUserId)).toEqual([]);
  });

  it("finds a connection only for its owner", async () => {
    const fixture = fixtureOf();
    const created = await fixture.store.createConnection(
      connectionFor(fixture, fixture.aliceUserId),
    );
    expect(await fixture.store.findConnection(fixture.bobUserId, created.connectionId)).toBe(
      undefined,
    );
    expect(await fixture.store.findConnection(fixture.aliceUserId, randomUUID())).toBe(undefined);
  });

  it("lists only the owner's activated connections, newest first", async () => {
    const fixture = fixtureOf();
    const older = await activated(fixture, fixture.aliceUserId, minutes(1));
    const newer = await activated(fixture, fixture.aliceUserId, minutes(5));
    await fixture.store.createConnection(connectionFor(fixture, fixture.aliceUserId));
    await activated(fixture, fixture.bobUserId, minutes(3));
    const listed = await fixture.store.listConnections(fixture.aliceUserId);
    expect(listed.map((connection) => connection.connectionId)).toEqual([
      newer.connectionId,
      older.connectionId,
    ]);
    expect(listed[0]!.activatedAt).toEqual(minutes(5));
  });

  it("revokes only for the owner, once, and keeps the durable records", async () => {
    const fixture = fixtureOf();
    const alice = await activated(fixture, fixture.aliceUserId);
    const operation = await fixture.store.beginOperation(operationFor(alice));
    await fixture.store.bindCreatedAgent(alice, operation.id, "agent-a", "workspace-a", T0);
    expect(await fixture.store.revokeConnection(fixture.bobUserId, alice.connectionId, T0)).toBe(
      false,
    );
    expect(
      (await fixture.store.findConnection(fixture.aliceUserId, alice.connectionId))?.revokedAt,
    ).toBe(null);
    expect(
      await fixture.store.revokeConnection(fixture.aliceUserId, alice.connectionId, minutes(2)),
    ).toBe(true);
    expect(
      (await fixture.store.findConnection(fixture.aliceUserId, alice.connectionId))?.revokedAt,
    ).toEqual(minutes(2));
    expect(
      await fixture.store.revokeConnection(fixture.aliceUserId, alice.connectionId, minutes(3)),
    ).toBe(false);
    expect(await fixture.store.revokeConnection(fixture.aliceUserId, randomUUID(), T0)).toBe(false);
    expect(await fixture.store.findOwnedAgent(alice, "agent-a")).toMatchObject({
      agentId: "agent-a",
    });
  });

  async function flowFor(fixture: ConnectorStoreFixture, expiresAt = minutes(10)) {
    const connection = await fixture.store.createConnection(
      connectionFor(fixture, fixture.aliceUserId),
    );
    const flow = {
      id: randomUUID(),
      sessionId: "session-1",
      ownerUserId: fixture.aliceUserId,
      authorizationFingerprint: "fingerprint-1",
      connectionId: connection.connectionId,
      expiresAt,
      consumedAt: null,
    };
    await fixture.store.createFlow(flow);
    return { connection, flow };
  }

  it("finds a flow only for its owner and session", async () => {
    const fixture = fixtureOf();
    const { flow } = await flowFor(fixture);
    expect(await fixture.store.findFlow(fixture.aliceUserId, "session-1", flow.id)).toEqual(flow);
    expect(await fixture.store.findFlow(fixture.bobUserId, "session-1", flow.id)).toBe(undefined);
    expect(await fixture.store.findFlow(fixture.aliceUserId, "session-2", flow.id)).toBe(undefined);
  });

  it("consuming a flow activates its connection in the same step, exactly once", async () => {
    const fixture = fixtureOf();
    const { connection, flow } = await flowFor(fixture);
    expect(
      (await fixture.store.findConnection(fixture.aliceUserId, connection.connectionId))
        ?.activatedAt,
    ).toBe(null);
    expect(await fixture.store.consumeFlow(fixture.aliceUserId, "session-1", flow.id, T0)).toBe(
      true,
    );
    expect(
      (await fixture.store.findConnection(fixture.aliceUserId, connection.connectionId))
        ?.activatedAt,
    ).toEqual(T0);
    expect(
      (await fixture.store.findFlow(fixture.aliceUserId, "session-1", flow.id))?.consumedAt,
    ).toEqual(T0);
    expect(
      await fixture.store.consumeFlow(fixture.aliceUserId, "session-1", flow.id, minutes(1)),
    ).toBe(false);
    expect(
      (await fixture.store.findConnection(fixture.aliceUserId, connection.connectionId))
        ?.activatedAt,
    ).toEqual(T0);
  });

  it("lets only one of several concurrent consumers win", async () => {
    const fixture = fixtureOf();
    const { flow } = await flowFor(fixture);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        fixture.store.consumeFlow(fixture.aliceUserId, "session-1", flow.id, T0),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("rejects an expired flow without activating the connection", async () => {
    const fixture = fixtureOf();
    const { connection, flow } = await flowFor(fixture, minutes(10));
    expect(
      await fixture.store.consumeFlow(fixture.aliceUserId, "session-1", flow.id, minutes(10)),
    ).toBe(false);
    expect(
      await fixture.store.consumeFlow(fixture.aliceUserId, "session-1", flow.id, minutes(11)),
    ).toBe(false);
    expect(
      (await fixture.store.findConnection(fixture.aliceUserId, connection.connectionId))
        ?.activatedAt,
    ).toBe(null);
    expect(
      (await fixture.store.findFlow(fixture.aliceUserId, "session-1", flow.id))?.consumedAt,
    ).toBe(null);
  });

  it("rejects another owner or session without consuming the flow", async () => {
    const fixture = fixtureOf();
    const { connection, flow } = await flowFor(fixture);
    expect(await fixture.store.consumeFlow(fixture.bobUserId, "session-1", flow.id, T0)).toBe(
      false,
    );
    expect(await fixture.store.consumeFlow(fixture.aliceUserId, "session-2", flow.id, T0)).toBe(
      false,
    );
    expect(
      (await fixture.store.findConnection(fixture.aliceUserId, connection.connectionId))
        ?.activatedAt,
    ).toBe(null);
    expect(await fixture.store.consumeFlow(fixture.aliceUserId, "session-1", flow.id, T0)).toBe(
      true,
    );
  });

  it("does not activate a connection that was revoked before consent completed", async () => {
    const fixture = fixtureOf();
    const { connection, flow } = await flowFor(fixture);
    await fixture.store.revokeConnection(fixture.aliceUserId, connection.connectionId, T0);
    expect(
      await fixture.store.consumeFlow(fixture.aliceUserId, "session-1", flow.id, minutes(1)),
    ).toBe(false);
    expect(
      (await fixture.store.findConnection(fixture.aliceUserId, connection.connectionId))
        ?.activatedAt,
    ).toBe(null);
    expect(
      (await fixture.store.findFlow(fixture.aliceUserId, "session-1", flow.id))?.consumedAt,
    ).toBe(null);
  });

  it("returns the existing operation for a repeated key with the same fingerprint", async () => {
    const fixture = fixtureOf();
    const alice = await activated(fixture, fixture.aliceUserId);
    const first = await fixture.store.beginOperation(operationFor(alice, { requestKey: "k" }));
    const again = await fixture.store.beginOperation(
      operationFor(alice, { requestKey: "k", messageId: randomUUID() }),
    );
    expect(again).toEqual(first);
    expect(await fixture.store.findOperation(alice, first.id)).toEqual(first);
  });

  it("returns the same single operation to concurrent callers sharing a key", async () => {
    const fixture = fixtureOf();
    const alice = await activated(fixture, fixture.aliceUserId);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        fixture.store.beginOperation(operationFor(alice, { requestKey: "racing" })),
      ),
    );
    expect(new Set(results.map((operation) => operation.id)).size).toBe(1);
  });

  it("rejects a reused key for different work and keeps the original operation", async () => {
    const fixture = fixtureOf();
    const alice = await activated(fixture, fixture.aliceUserId);
    const first = await fixture.store.beginOperation(operationFor(alice, { requestKey: "k" }));
    const conflicting = operationFor(alice, {
      requestKey: "k",
      requestFingerprint: "fingerprint-b",
    });
    await rejectsWith(fixture.store.beginOperation(conflicting), "request_conflict");
    expect(await fixture.store.findOperation(alice, conflicting.id)).toBe(undefined);
    expect(await fixture.store.findOperation(alice, first.id)).toEqual(first);
    await rejectsWith(
      fixture.store.beginOperation(operationFor(alice, { requestKey: "k", kind: "message" })),
      "request_conflict",
    );
  });

  it("scopes request keys to a connection", async () => {
    const fixture = fixtureOf();
    const alice = await activated(fixture, fixture.aliceUserId);
    const bob = await activated(fixture, fixture.bobUserId);
    const forAlice = await fixture.store.beginOperation(operationFor(alice, { requestKey: "k" }));
    const forBob = await fixture.store.beginOperation(
      operationFor(bob, { requestKey: "k", requestFingerprint: "something-else" }),
    );
    expect(forBob.id).not.toBe(forAlice.id);
    expect(forBob.connectionId).toBe(bob.connectionId);
  });

  it("refuses an operation whose identity differs from its connection in any column", async () => {
    const fixture = fixtureOf();
    const alice = await activated(fixture, fixture.aliceUserId);
    const existing = await fixture.store.beginOperation(operationFor(alice, { requestKey: "k" }));
    const mismatches: Identity[] = [
      { ...alice, ownerUserId: fixture.bobUserId },
      { ...alice, daemonId: fixture.otherDaemonId },
      { ...alice, organizationId: `other-${fixture.organizationId}` },
      { ...alice, connectionId: randomUUID() },
    ];
    for (const identity of mismatches) {
      await rejectsWith(fixture.store.beginOperation(operationFor(identity)), "not_found");
      // Not even an existing key can be read back through a mismatched identity.
      await rejectsWith(
        fixture.store.beginOperation({ ...existing, ...identity, id: randomUUID() }),
        "not_found",
      );
      expect(await fixture.store.findOperation(identity, existing.id)).toBe(undefined);
    }
  });

  it("changes operation state only for the owning identity and never to created", async () => {
    const fixture = fixtureOf();
    const alice = await activated(fixture, fixture.aliceUserId);
    const operation = await fixture.store.beginOperation(operationFor(alice));
    await fixture.store.setOperationState(alice, operation.id, "outcome_unknown", "lost");
    expect(await fixture.store.findOperation(alice, operation.id)).toMatchObject({
      state: "outcome_unknown",
      errorCode: "lost",
    });
    await rejectsWith(
      fixture.store.setOperationState(
        { ...alice, ownerUserId: fixture.bobUserId },
        operation.id,
        "failed",
        null,
      ),
      "not_found",
    );
    await rejectsWith(
      fixture.store.setOperationState(alice, operation.id, "created", null),
      "request_conflict",
    );
    expect(await fixture.store.findOperation(alice, operation.id)).toMatchObject({
      state: "outcome_unknown",
    });
  });

  it("hides one owner's agents from every other identity, as if they did not exist", async () => {
    const fixture = fixtureOf();
    const alice = await activated(fixture, fixture.aliceUserId);
    const bob = await activated(fixture, fixture.bobUserId);
    const launch = await fixture.store.beginOperation(operationFor(alice));
    const owned = await fixture.store.bindCreatedAgent(
      alice,
      launch.id,
      "agent-a",
      "workspace-a",
      T0,
    );
    expect(owned).toEqual({
      ...alice,
      agentId: "agent-a",
      workspaceId: "workspace-a",
      launchOperationId: launch.id,
      createdAt: T0,
    });
    expect(await fixture.store.findOwnedAgent(alice, owned.agentId)).toEqual(owned);
    expect(await fixture.store.listOwnedAgents(alice)).toEqual([owned]);
    expect(await fixture.store.findOwnedAgent(bob, owned.agentId)).toBeUndefined();
    expect(await fixture.store.findOwnedAgent(bob, "missing-agent")).toBeUndefined();
    expect(await fixture.store.listOwnedAgents(bob)).toEqual([]);
    expect(await fixture.store.findOperation(bob, launch.id)).toBeUndefined();
    // Each identity column alone is enough to hide the row.
    const secondConnection = await activated(fixture, fixture.aliceUserId);
    for (const identity of [
      { ...alice, ownerUserId: fixture.bobUserId },
      { ...alice, organizationId: `other-${fixture.organizationId}` },
      { ...alice, daemonId: fixture.otherDaemonId },
      { ...alice, connectionId: secondConnection.connectionId },
    ]) {
      expect(await fixture.store.findOwnedAgent(identity, owned.agentId)).toBeUndefined();
      expect(await fixture.store.listOwnedAgents(identity)).toEqual([]);
    }
  });

  it("lists a connection's agents newest first", async () => {
    const fixture = fixtureOf();
    const alice = await activated(fixture, fixture.aliceUserId);
    for (const [index, agentId] of ["agent-1", "agent-2", "agent-3"].entries()) {
      const operation = await fixture.store.beginOperation(operationFor(alice));
      await fixture.store.bindCreatedAgent(alice, operation.id, agentId, "ws", minutes(index));
    }
    expect((await fixture.store.listOwnedAgents(alice)).map((agent) => agent.agentId)).toEqual([
      "agent-3",
      "agent-2",
      "agent-1",
    ]);
  });

  it("marks the operation created and records ownership together", async () => {
    const fixture = fixtureOf();
    const alice = await activated(fixture, fixture.aliceUserId);
    const launch = await fixture.store.beginOperation(operationFor(alice));
    await fixture.store.bindCreatedAgent(alice, launch.id, "agent-a", "workspace-a", T0);
    expect(await fixture.store.findOperation(alice, launch.id)).toMatchObject({
      state: "created",
      agentId: "agent-a",
      workspaceId: "workspace-a",
    });
  });

  it("leaves no partial state when another connection already owns the daemon agent", async () => {
    const fixture = fixtureOf();
    const alice = await activated(fixture, fixture.aliceUserId);
    const bob = await activated(fixture, fixture.bobUserId);
    const aliceLaunch = await fixture.store.beginOperation(operationFor(alice));
    const aliceOwned = await fixture.store.bindCreatedAgent(
      alice,
      aliceLaunch.id,
      "agent-shared",
      "workspace-a",
      T0,
    );
    const bobLaunch = await fixture.store.beginOperation(operationFor(bob));
    await rejectsWith(
      fixture.store.bindCreatedAgent(bob, bobLaunch.id, "agent-shared", "workspace-b", T0),
      "request_conflict",
    );
    expect(await fixture.store.findOperation(bob, bobLaunch.id)).toMatchObject({
      state: "creating",
      agentId: null,
      workspaceId: null,
    });
    expect(await fixture.store.listOwnedAgents(bob)).toEqual([]);
    expect(await fixture.store.findOwnedAgent(alice, "agent-shared")).toEqual(aliceOwned);
    // The failed bind did not poison the operation: it can still bind a different agent.
    await fixture.store.bindCreatedAgent(bob, bobLaunch.id, "agent-b", "workspace-b", T0);
    expect(await fixture.store.listOwnedAgents(bob)).toHaveLength(1);
  });

  it("allows the same agent id on a different daemon", async () => {
    const fixture = fixtureOf();
    const alice = await activated(fixture, fixture.aliceUserId);
    const otherDaemon = await fixture.store.createConnection(
      connectionFor(fixture, fixture.aliceUserId, { daemonId: fixture.otherDaemonId }),
    );
    const a = await fixture.store.beginOperation(operationFor(alice));
    const b = await fixture.store.beginOperation(operationFor(identityOf(otherDaemon)));
    await fixture.store.bindCreatedAgent(alice, a.id, "agent-x", "ws", T0);
    await fixture.store.bindCreatedAgent(identityOf(otherDaemon), b.id, "agent-x", "ws", T0);
  });

  it("refuses to bind an operation that is not creating, not a launch, or not the caller's", async () => {
    const fixture = fixtureOf();
    const alice = await activated(fixture, fixture.aliceUserId);
    const launch = await fixture.store.beginOperation(operationFor(alice));
    await fixture.store.bindCreatedAgent(alice, launch.id, "agent-a", "ws", T0);
    await rejectsWith(
      fixture.store.bindCreatedAgent(alice, launch.id, "agent-other", "ws", T0),
      "request_conflict",
    );
    const message = await fixture.store.beginOperation(operationFor(alice, { kind: "message" }));
    await rejectsWith(
      fixture.store.bindCreatedAgent(alice, message.id, "agent-m", "ws", T0),
      "request_conflict",
    );
    const failed = await fixture.store.beginOperation(operationFor(alice));
    await fixture.store.setOperationState(alice, failed.id, "failed", "create_rejected");
    await rejectsWith(
      fixture.store.bindCreatedAgent(alice, failed.id, "agent-f", "ws", T0),
      "request_conflict",
    );
    const fresh = await fixture.store.beginOperation(operationFor(alice));
    await rejectsWith(
      fixture.store.bindCreatedAgent(
        { ...alice, ownerUserId: fixture.bobUserId },
        fresh.id,
        "agent-z",
        "ws",
        T0,
      ),
      "not_found",
    );
    await rejectsWith(
      fixture.store.bindCreatedAgent(alice, randomUUID(), "agent-q", "ws", T0),
      "not_found",
    );
    expect(await fixture.store.findOperation(alice, fresh.id)).toMatchObject({
      state: "creating",
      agentId: null,
    });
    expect((await fixture.store.listOwnedAgents(alice)).map((agent) => agent.agentId)).toEqual([
      "agent-a",
    ]);
  });

  it("does not treat an unrelated Hub agent session as ownership", async () => {
    const fixture = fixtureOf();
    const alice = await activated(fixture, fixture.aliceUserId);
    await fixture.seedUnrelatedSession(fixture.daemonId, "agent-from-session");
    expect(await fixture.store.findOwnedAgent(alice, "agent-from-session")).toBeUndefined();
    expect(await fixture.store.listOwnedAgents(alice)).toEqual([]);
  });
}
