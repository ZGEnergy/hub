import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect } from "vitest";
import { z } from "zod";
import type { AuthServer } from "../auth/server.js";
import {
  DaemonAgentError,
  type AgentConnection,
  type AgentSnapshot,
  type AgentTimelineCursor,
  type AgentTimelineEntry,
  type AgentTimelinePage,
} from "../daemons/agents/index.js";
import type { DaemonConnection, DaemonCreateAgentOptions } from "../daemons/protocol.js";
import type { Database } from "../db/types.js";

/** Shared fixtures for the connector's MCP-level integration suites. */

export const ErrorContent = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    operationId: z.string().optional(),
    agentId: z.string().optional(),
    state: z.string().optional(),
  }),
});
export const OperationContent = z.object({
  operationId: z.string(),
  state: z.string(),
  agentId: z.string().nullable(),
});
export const AgentsContent = z.object({ agents: z.array(z.object({ agentId: z.string() })) });
const TextContent = z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1);

interface FakeAgent {
  snapshot: AgentSnapshot;
  epoch: string;
  entries: AgentTimelineEntry[];
}

/**
 * The daemon side, as the daemon behaves: keyed creation, message receipts per (agent, messageId),
 * "Agent not found" for unknown ids, interrupt keeps the session, and epoch/sequence paging that
 * answers a stale cursor with a reset tail page. Records every call so tests can prove what never
 * reached the machine.
 */
export class FakeDaemon implements AgentConnection {
  readonly calls: { method: string; agentId?: string }[] = [];
  /** The options of every create request, in order: what the machine was asked to run. */
  readonly createOptions: DaemonCreateAgentOptions[] = [];
  readonly agents = new Map<string, FakeAgent>();
  beforeSend: (() => Promise<void>) | undefined;
  private readonly creations = new Map<string, string>();
  private readonly receipts = new Set<string>();

  seed(agentId: string): void {
    this.agents.set(agentId, {
      snapshot: { id: agentId, workspaceId: `workspace-${agentId}`, status: "idle" },
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
      timestamp: new Date(Date.UTC(2026, 8, 30, 12, 0, seq)).toISOString(),
      seqStart: seq,
      seqEnd: seq,
      sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
    });
  }

  /** The daemon rewrote the timeline: earlier cursors are stale. */
  rewrite(agentId: string): void {
    this.require(agentId).epoch = "epoch-2";
  }

  async create(key: string, options: DaemonCreateAgentOptions): Promise<AgentSnapshot> {
    this.calls.push({ method: "create" });
    this.createOptions.push(options);
    const prior = this.creations.get(key);
    const agentId = prior ?? `agent-${randomUUID()}`;
    if (prior === undefined) {
      this.seed(agentId);
      this.creations.set(key, agentId);
    }
    return { ...this.require(agentId).snapshot };
  }

  async get(agentId: string): Promise<AgentSnapshot> {
    this.calls.push({ method: "get", agentId });
    return { ...this.require(agentId).snapshot };
  }

  async send(agentId: string, messageId: string, text: string): Promise<void> {
    this.calls.push({ method: "send", agentId });
    await this.beforeSend?.();
    const agent = this.require(agentId);
    if (this.receipts.has(`${agentId}:${messageId}`)) return;
    this.receipts.add(`${agentId}:${messageId}`);
    agent.snapshot.status = "running";
    this.append(agentId, { type: "user_message", text });
  }

  async restore(): Promise<boolean> {
    throw new Error("the connector never restores workspaces");
  }

  async control(agentId: string, _workspaceId: string, action: "interrupt" | "archive") {
    this.calls.push({ method: `control:${action}`, agentId });
    this.require(agentId).snapshot.status = "idle";
  }

  async watch(): Promise<() => void> {
    throw new Error("the connector never watches agents");
  }

  async timeline(
    agentId: string,
    input: { cursor?: AgentTimelineCursor; direction: "tail" | "before" | "after"; limit: number },
  ): Promise<AgentTimelinePage> {
    this.calls.push({ method: "timeline", agentId });
    const agent = this.require(agentId);
    const stale = input.cursor !== undefined && input.cursor.epoch !== agent.epoch;
    const direction = stale ? "tail" : input.direction;
    const seq = input.cursor?.seq ?? 0;
    const all = agent.entries;
    let page = all.slice(-input.limit);
    if (direction === "after")
      page = all.filter((entry) => entry.seqStart > seq).slice(0, input.limit);
    if (direction === "before")
      page = all.filter((entry) => entry.seqEnd < seq).slice(-input.limit);
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

  private require(agentId: string): FakeAgent {
    const agent = this.agents.get(agentId);
    if (agent === undefined) throw new DaemonAgentError(`Agent not found: ${agentId}`);
    return agent;
  }
}

/** A connected machine whose provider catalog is two ready runtimes, Claude and Codex. */
export function daemonConnection(daemon: FakeDaemon): DaemonConnection {
  return {
    agents: daemon,
    async getProviderSnapshot({ cwd }) {
      return {
        requestId: randomUUID(),
        ...(cwd === undefined ? {} : { cwd }),
        entries: [
          {
            provider: "claude",
            status: "ready",
            enabled: true,
            label: "Claude",
            models: [{ provider: "claude", id: "opus", label: "Opus", isDefault: true }],
            modes: [{ id: "default", label: "Default" }],
            defaultModeId: "default",
          },
          {
            provider: "codex",
            status: "ready",
            enabled: true,
            label: "Codex",
            models: [
              { provider: "codex", id: "codex-large", label: "Codex large", isDefault: true },
              { provider: "codex", id: "codex-small", label: "Codex small" },
            ],
            modes: [{ id: "auto", label: "Auto" }],
            defaultModeId: "auto",
          },
        ],
        generatedAt: new Date().toISOString(),
      };
    },
    refreshProviderSnapshot: () => Promise.reject(new Error("not used")),
    validateAgentConfiguration: () => Promise.reject(new Error("not used")),
  };
}

/** Enrolls an active machine allowed to run Hub work in the organization; returns its id. */
export async function enrollConnectorDaemon(
  database: Database,
  organizationId: string,
): Promise<string> {
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
    suggestedSlug: `devbox-${daemonId.slice(0, 8)}`,
    tokenVerifier: verifier,
    serverId: randomUUID(),
    daemonPublicKey: "public",
    credentialVerifier: "credential",
    permissions: ["hub.execute"],
    now: new Date(),
  });
  return daemonId;
}

/** The official MCP SDK client, connected to the connector endpoint with a bearer token. */
export async function connectMcp(
  endpoint: string,
  token: string,
  clientName = "example-mcp-client",
): Promise<Client> {
  const client = new Client({ name: clientName, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  // The SDK's getter is typed `string | undefined` while its Transport interface uses an
  // exact-optional `sessionId?: string`; the runtime class is the SDK's official transport.
  // @ts-expect-error upstream SDK exactOptionalPropertyTypes mismatch
  await client.connect(transport);
  return client;
}

export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return {
    isError: result.isError === true,
    structured: result.structuredContent,
    text: TextContent.parse(result.content)
      .map((part) => part.text)
      .join("\n"),
  };
}

export async function toolError(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await callTool(client, name, args);
  expect(result.isError).toBe(true);
  return { ...ErrorContent.parse(result.structured).error, text: result.text };
}

/** A Hub user's browser session, driving Hub's own auth endpoints in process. */
export class Browser {
  private cookie = "";

  constructor(
    private readonly auth: AuthServer,
    private readonly origin: string,
    readonly email = `operator-${randomUUID()}@example.com`,
  ) {}

  async signUp(): Promise<void> {
    const response = await this.auth.handle(
      this.post("/api/auth/sign-up/email", {
        name: "Operator",
        email: this.email,
        password: "account-password",
      }),
    );
    expect(response.status).toBe(200);
    this.rememberCookie(response);
  }

  async signIn(): Promise<void> {
    const response = await this.auth.handle(
      this.post("/api/auth/sign-in/email", { email: this.email, password: "account-password" }),
    );
    expect(response.status).toBe(200);
    this.rememberCookie(response);
  }

  async createOrganization(): Promise<string> {
    const response = await this.auth.browserAccount!(
      this.post("/api/auth/paseo/create-organization", { name: "Acme" }),
    );
    expect(response.status).toBe(201);
    return z.object({ organizationId: z.string() }).parse(await response.json()).organizationId;
  }

  get(path: string): Promise<Response> {
    return this.auth.handle(
      new Request(`${this.origin}${path}`, { headers: { cookie: this.cookie } }),
    );
  }

  /** The headers a same-origin Hub server function call carries. */
  headers(): Headers {
    return new Headers({ cookie: this.cookie, origin: this.origin });
  }

  private rememberCookie(response: Response): void {
    this.cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
  }

  private post(path: string, body: unknown): Request {
    return new Request(`${this.origin}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: this.origin,
        "sec-fetch-site": "same-origin",
        ...(this.cookie.length === 0 ? {} : { cookie: this.cookie }),
      },
      body: JSON.stringify(body),
    });
  }
}

export function jwtClaims(token: string): Record<string, unknown> {
  return z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")));
}
