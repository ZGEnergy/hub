import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import {
  connectionWithScopes,
  agentSessionFor,
  connectionFor,
  describeConnectorStoreContract,
  type ConnectorStoreFixture,
} from "./internal/store-contract.js";

async function openMemoryFixture(): Promise<ConnectorStoreFixture> {
  const database = createMemoryDatabase();
  const organizationId = `org-${randomUUID()}`;
  return {
    store: database.connector,
    organizationId,
    aliceUserId: `alice-${randomUUID()}`,
    bobUserId: `bob-${randomUUID()}`,
    daemonId: randomUUID(),
    otherDaemonId: randomUUID(),
    async seedUnrelatedSession(daemonId, agentId) {
      await database.saveAgentSession(
        agentSessionFor(organizationId, randomUUID(), daemonId, agentId),
      );
    },
    async close() {},
  };
}

describe("connector ownership (memory store)", () => {
  describeConnectorStoreContract(openMemoryFixture);

  it("is exposed as Database.connector and does not share state between databases", async () => {
    const first = await openMemoryFixture();
    const second = await openMemoryFixture();
    const connection = await first.store.createConnection(connectionFor(first, first.aliceUserId));
    expect(await second.store.findConnection(first.aliceUserId, connection.connectionId)).toBe(
      undefined,
    );
  });

  it("rejects connections with no or unknown scopes", async () => {
    const fixture = await openMemoryFixture();
    await expect(
      fixture.store.createConnection(connectionFor(fixture, fixture.aliceUserId, { scopes: [] })),
    ).rejects.toThrow("invalid connector scopes");
    await expect(
      fixture.store.createConnection(
        connectionWithScopes(fixture, fixture.aliceUserId, ["paseo:admin"]),
      ),
    ).rejects.toThrow("invalid connector scopes");
  });
});
