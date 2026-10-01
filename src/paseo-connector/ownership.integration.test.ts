import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../db/pg.js";
import {
  embeddedDatabaseRuntime,
  postgresDatabaseRuntime,
  type DatabaseRuntimeBundle,
} from "../db/runtime/index.js";
import type { Database } from "../db/types.js";
import { ConnectorError } from "./contracts.js";
import {
  T0,
  connectionWithScopes,
  agentSessionFor,
  connectionFor,
  describeConnectorStoreContract,
  identityOf,
  operationFor,
  type ConnectorStoreFixture,
} from "./internal/store-contract.js";

let postgres: StartedPostgreSqlContainer;
beforeAll(async () => {
  postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
}, 120_000);
afterAll(async () => {
  await postgres?.stop();
});

type Kind = "embedded" | "postgres";

interface Harness {
  open(): Promise<DatabaseRuntimeBundle>;
  cleanup(): Promise<void>;
}

function harness(kind: Kind): Harness {
  const rootPromise = mkdtemp(join(tmpdir(), "hub-connector-"));
  // The container only exists once beforeAll has run, so the database URL is built on first open.
  let connectionString: URL | undefined;
  return {
    async open() {
      if (kind === "embedded") return embeddedDatabaseRuntime(join(await rootPromise, "database"));
      if (connectionString === undefined) {
        connectionString = new URL(postgres.getConnectionUri());
        connectionString.pathname = `/connector_${randomUUID().replaceAll("-", "")}`;
      }
      return postgresDatabaseRuntime(connectionString.href);
    },
    async cleanup() {
      await rm(await rootPromise, { recursive: true, force: true });
    },
  };
}

/** Real user, organization, member, machine and daemon rows; nothing is a mock. */
async function seed(bundle: DatabaseRuntimeBundle, database: Database) {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const organizationId = `org-${suffix}`;
  const otherOrganizationId = `other-org-${suffix}`;
  const users = { alice: `alice-${suffix}`, bob: `bob-${suffix}` };
  const run = (sql: string, params: unknown[]) => bundle.runtime.query(sql, params);
  for (const id of [organizationId, otherOrganizationId])
    await run("insert into organization (id, name, slug) values ($1, $1, $1)", [id]);
  for (const id of Object.values(users)) {
    await run(`insert into "user" (id, name, email) values ($1, $1, $1 || '@example.test')`, [id]);
    await run(
      `insert into member (id, organization_id, user_id, role) values ('member-' || $1, $2, $1, 'member')`,
      [id, organizationId],
    );
  }
  const enroll = async (slug: string) => {
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
      suggestedSlug: `${slug}-${suffix}`,
      tokenVerifier: verifier,
      serverId: randomUUID(),
      daemonPublicKey: "public",
      credentialVerifier: "credential",
      permissions: ["hub.execute"],
      now: new Date(),
    });
    return daemonId;
  };
  return {
    organizationId,
    otherOrganizationId,
    aliceUserId: users.alice,
    bobUserId: users.bob,
    daemonId: await enroll("devbox"),
    otherDaemonId: await enroll("buildbox"),
  };
}

describe.each(["embedded", "postgres"] as const)("connector ownership on %s", (kind) => {
  const target = harness(kind);
  let bundle: DatabaseRuntimeBundle;
  let database: Database;

  beforeAll(async () => {
    bundle = await target.open();
    await bundle.runtime.migrate();
    database = createDatabase(bundle.runtime, bundle.locks);
  }, 120_000);
  afterAll(async () => {
    await bundle?.runtime.close();
    await target.cleanup();
  });

  async function openFixture(): Promise<ConnectorStoreFixture & { otherOrganizationId: string }> {
    const ids = await seed(bundle, database);
    return {
      ...ids,
      store: database.connector,
      async seedUnrelatedSession(daemonId, agentId) {
        const project = await database.createProject({
          organizationId: ids.organizationId,
          name: "Unrelated",
          slug: `unrelated-${randomUUID().slice(0, 8)}`,
          createdByUserId: ids.aliceUserId,
        });
        await database.saveAgentSession(
          agentSessionFor(ids.organizationId, project.id, daemonId, agentId),
        );
      },
      async close() {},
    };
  }

  const count = async (table: string, where = "true", params: unknown[] = []) =>
    (
      await bundle.runtime.query<{ count: number }>(
        `select count(*)::integer as count from ${table} where ${where}`,
        params,
      )
    ).rows[0]!.count;

  describeConnectorStoreContract(openFixture);

  it("is built on real membership and daemon rows", async () => {
    const fixture = await openFixture();
    expect(await database.isOrganizationMember(fixture.aliceUserId, fixture.organizationId)).toBe(
      true,
    );
    expect(await database.isOrganizationMember(fixture.bobUserId, fixture.organizationId)).toBe(
      true,
    );
    expect(
      await database.isOrganizationMember(fixture.aliceUserId, fixture.otherOrganizationId),
    ).toBe(false);
    expect(
      (await database.findDaemonForOrganization(fixture.organizationId, fixture.daemonId))?.id,
    ).toBe(fixture.daemonId);
  });

  it("rejects connections to an unknown daemon, a daemon of another organization, or unknown scopes", async () => {
    const fixture = await openFixture();
    await expect(
      fixture.store.createConnection(
        connectionFor(fixture, fixture.aliceUserId, { daemonId: randomUUID() }),
      ),
    ).rejects.toThrow();
    await expect(
      fixture.store.createConnection(
        connectionFor(fixture, fixture.aliceUserId, {
          organizationId: fixture.otherOrganizationId,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      fixture.store.createConnection(
        connectionWithScopes(fixture, fixture.aliceUserId, ["paseo:admin"]),
      ),
    ).rejects.toThrow();
    await expect(
      fixture.store.createConnection(connectionFor(fixture, fixture.aliceUserId, { scopes: [] })),
    ).rejects.toThrow();
  });

  it("enforces ownership in the schema itself, below the repository", async () => {
    const fixture = await openFixture();
    const alice = identityOf(
      await fixture.store.createConnection(connectionFor(fixture, fixture.aliceUserId)),
    );
    const bob = identityOf(
      await fixture.store.createConnection(connectionFor(fixture, fixture.bobUserId)),
    );
    const aliceOperation = await fixture.store.beginOperation(operationFor(alice));
    const bobOperation = await fixture.store.beginOperation(operationFor(bob));
    await fixture.store.bindCreatedAgent(alice, aliceOperation.id, "agent-a", "ws", T0);
    const insertOperation = (identity: typeof alice) =>
      bundle.runtime.query(
        `insert into connector_operations (id, connection_id, owner_user_id, organization_id, daemon_id,
           kind, request_key, request_fingerprint, message_id, state)
         values ($1, $2, $3, $4, $5, 'launch', $6, 'f', $7, 'creating')`,
        [
          randomUUID(),
          identity.connectionId,
          identity.ownerUserId,
          identity.organizationId,
          identity.daemonId,
          randomUUID(),
          randomUUID(),
        ],
      );
    // An operation cannot claim a connection while naming a different owner, organization or daemon.
    await expect(insertOperation({ ...alice, ownerUserId: fixture.bobUserId })).rejects.toThrow();
    await expect(insertOperation({ ...alice, daemonId: fixture.otherDaemonId })).rejects.toThrow();
    await expect(
      insertOperation({ ...alice, organizationId: fixture.otherOrganizationId }),
    ).rejects.toThrow();
    const insertAgent = (identity: typeof alice, operationId: string, agentId: string) =>
      bundle.runtime.query(
        `insert into connector_agents (connection_id, owner_user_id, organization_id, daemon_id,
           agent_id, workspace_id, launch_operation_id, created_at)
         values ($1, $2, $3, $4, $5, 'ws', $6, now())`,
        [
          identity.connectionId,
          identity.ownerUserId,
          identity.organizationId,
          identity.daemonId,
          agentId,
          operationId,
        ],
      );
    // A second owner cannot claim a daemon agent, and an agent cannot cite another owner's operation.
    await expect(insertAgent(bob, bobOperation.id, "agent-a")).rejects.toThrow();
    await expect(insertAgent(bob, aliceOperation.id, "agent-new")).rejects.toThrow();
    expect(await count("connector_agents", "owner_user_id = $1", [fixture.bobUserId])).toBe(0);
  });

  it("deletes authorization records with their user, organization or connection and nothing else", async () => {
    const fixture = await openFixture();
    const connectionsOf = async (userId: string) => {
      const identity = identityOf(
        await fixture.store.createConnection(connectionFor(fixture, userId)),
      );
      const operation = await fixture.store.beginOperation(operationFor(identity));
      await fixture.store.bindCreatedAgent(
        identity,
        operation.id,
        `agent-${randomUUID()}`,
        "ws",
        T0,
      );
      return identity;
    };
    const alice = await connectionsOf(fixture.aliceUserId);
    const bob = await connectionsOf(fixture.bobUserId);
    const bobSecond = await connectionsOf(fixture.bobUserId);
    const rowsFor = (userId: string) =>
      Promise.all(
        ["connector_connections", "connector_operations", "connector_agents"].map((table) =>
          count(table, "owner_user_id = $1", [userId]),
        ),
      );
    await bundle.runtime.query("delete from connector_connections where id = $1", [
      bobSecond.connectionId,
    ]);
    expect(await rowsFor(fixture.bobUserId)).toEqual([1, 1, 1]);
    await bundle.runtime.query('delete from "user" where id = $1', [fixture.bobUserId]);
    expect(await rowsFor(fixture.bobUserId)).toEqual([0, 0, 0]);
    expect(await rowsFor(fixture.aliceUserId)).toEqual([1, 1, 1]);
    await bundle.runtime.query("delete from organization where id = $1", [fixture.organizationId]);
    expect(await rowsFor(fixture.aliceUserId)).toEqual([0, 0, 0]);
    expect(bob.connectionId).not.toBe(alice.connectionId);
  });

  it("does not treat an unrelated Hub session as ownership at any layer", async () => {
    const fixture = await openFixture();
    const alice = identityOf(
      await fixture.store.createConnection(connectionFor(fixture, fixture.aliceUserId)),
    );
    await fixture.seedUnrelatedSession(fixture.daemonId, "agent-from-session");
    expect(await count("agent_sessions", "organization_id = $1", [fixture.organizationId])).toBe(1);
    expect(await fixture.store.findOwnedAgent(alice, "agent-from-session")).toBeUndefined();
    expect(await count("connector_agents", "daemon_id = $1", [fixture.daemonId])).toBe(0);
    // The session's agent is still free to be claimed by a connector launch; it was never owned.
    const launch = await fixture.store.beginOperation(operationFor(alice));
    await expect(
      fixture.store.bindCreatedAgent(alice, launch.id, "agent-from-session", "ws", T0),
    ).resolves.toMatchObject({ agentId: "agent-from-session" });
  });

  it("raises ConnectorError, not a database error, when an identity is wrong", async () => {
    const fixture = await openFixture();
    const alice = identityOf(
      await fixture.store.createConnection(connectionFor(fixture, fixture.aliceUserId)),
    );
    const error = await fixture.store
      .beginOperation(operationFor({ ...alice, ownerUserId: fixture.bobUserId }))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectorError);
  });
});

describe.each(["embedded", "postgres"] as const)("connector ownership restart on %s", (kind) => {
  it("keeps the same scoped rows after the runtime is closed and reopened", async () => {
    const target = harness(kind);
    let bundle = await target.open();
    try {
      await bundle.runtime.migrate();
      let database = createDatabase(bundle.runtime, bundle.locks);
      const fixture = await seed(bundle, database);
      const alice = await database.connector.createConnection(
        connectionFor(fixture, fixture.aliceUserId),
      );
      const flow = {
        id: randomUUID(),
        sessionId: "session-restart",
        ownerUserId: fixture.aliceUserId,
        authorizationFingerprint: "fp",
        connectionId: alice.connectionId,
        expiresAt: new Date(T0.getTime() + 600_000),
        consumedAt: null,
      };
      await database.connector.createFlow(flow);
      expect(
        await database.connector.consumeFlow(fixture.aliceUserId, flow.sessionId, flow.id, T0),
      ).toBe(true);
      const identity = identityOf(alice);
      const operation = await database.connector.beginOperation(
        operationFor(identity, { requestKey: "restart-key" }),
      );
      const owned = await database.connector.bindCreatedAgent(
        identity,
        operation.id,
        "agent-durable",
        "workspace-durable",
        T0,
      );

      await bundle.runtime.close();
      bundle = await target.open();
      await bundle.runtime.migrate();
      database = createDatabase(bundle.runtime, bundle.locks);

      expect(await database.connector.findOwnedAgent(identity, "agent-durable")).toEqual(owned);
      expect(
        await database.connector.findOwnedAgent(
          { ...identity, ownerUserId: fixture.bobUserId },
          "agent-durable",
        ),
      ).toBeUndefined();
      expect(await database.connector.findOwnedAgent(identity, "missing-agent")).toBeUndefined();
      expect(await database.connector.findOperation(identity, operation.id)).toMatchObject({
        state: "created",
        agentId: "agent-durable",
      });
      expect(
        await database.connector.beginOperation(
          operationFor(identity, { requestKey: "restart-key", id: randomUUID() }),
        ),
      ).toMatchObject({ id: operation.id });
      expect(
        (await database.connector.listConnections(fixture.aliceUserId)).map(
          ({ connectionId, activatedAt }) => ({ connectionId, activatedAt }),
        ),
      ).toEqual([{ connectionId: alice.connectionId, activatedAt: T0 }]);
      expect(await database.connector.listOwnedAgents(identity)).toEqual([owned]);
    } finally {
      await bundle.runtime.close();
      await target.cleanup();
    }
  }, 120_000);
});
