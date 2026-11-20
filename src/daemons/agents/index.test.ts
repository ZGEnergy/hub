import { z } from "zod";
import { expect, test, vi } from "vitest";
import {
  DaemonAgentError,
  DaemonAgents,
  DaemonUnsupportedError,
  isDaemonOutcomeUnknown,
  type AgentEvent,
} from "./index.js";
import { DaemonResponseLostError, type DaemonCreateAgentOptions } from "../protocol.js";

const prompt = "Full request context. ".repeat(1_000) + "End.";
const options: DaemonCreateAgentOptions = {
  provider: "codex",
  cwd: "/workspace",
  env: { REQUEST_ENV: "configured" },
  providerOptions: { sandbox_mode: "workspace-write" },
};

function connect(
  requests: Record<string, unknown>[],
  titleResponse: (requestId: unknown) => Record<string, unknown> = (requestId) => ({
    type: "workspace.title.set.response",
    payload: { requestId, workspaceId: "workspace", accepted: true, title: "x", error: null },
  }),
  reportFailure?: (error: unknown, operation: string) => void,
): DaemonAgents {
  const agents = new DaemonAgents(
    (frame) => {
      const { message } = z
        .object({ message: z.record(z.string(), z.unknown()) })
        .parse(JSON.parse(frame));
      requests.push(message);
      const requestId = message["requestId"];
      if (message["type"] === "workspace.title.set.request") {
        agents.receive({ type: "session", message: titleResponse(requestId) });
        return;
      }
      agents.receive({
        type: "session",
        message: {
          type:
            message["type"] === "create_agent_request" ? "status" : "send_agent_message_response",
          payload: {
            requestId,
            status: "agent_created",
            accepted: true,
            agent: { id: "agent", workspaceId: "workspace", status: "idle" },
          },
        },
      });
    },
    undefined,
    reportFailure,
  );
  enable(agents);
  return agents;
}

test("ordinary creation keeps prompt delivery separate from creation and preserves provider configuration", async () => {
  const requests: Record<string, unknown>[] = [];
  const agents = connect(requests);
  const created = await agents.create("stable-creation-key", options);
  await agents.send(created.id, "stable-message-key", prompt);
  expect(requests).toHaveLength(2);
  expect(requests[0]).toMatchObject({
    type: "create_agent_request",
    idempotencyKey: "stable-creation-key",
    config: {
      provider: options.provider,
      cwd: options.cwd,
      providerOptions: options.providerOptions,
    },
    env: options.env,
  });
  expect(requests[0]).not.toHaveProperty("initialPrompt");
  expect(requests[0]).not.toHaveProperty("config.title");
  expect(requests[1]).toMatchObject({
    type: "send_agent_message_request",
    agentId: created.id,
    messageId: "stable-message-key",
    text: prompt,
  });
});

test("a titled creation names the agent and then the workspace the daemon created for it", async () => {
  const requests: Record<string, unknown>[] = [];
  const agents = connect(requests);
  const created = await agents.create("key", {
    ...options,
    title: "Hub agent",
    workspaceTitle: "Hub · pr-triage · e6a296d1",
  });
  expect(created.workspaceId).toBe("workspace");
  expect(requests).toHaveLength(2);
  expect(requests[0]).toMatchObject({
    type: "create_agent_request",
    config: { title: "Hub agent" },
  });
  expect(requests[1]).toMatchObject({
    type: "workspace.title.set.request",
    workspaceId: "workspace",
    title: "Hub · pr-triage · e6a296d1",
  });
});

test("a rejected workspace title is reported and leaves the titled agent usable", async () => {
  const requests: Record<string, unknown>[] = [];
  const failures: string[] = [];
  const agents = connect(
    requests,
    (requestId) => ({
      type: "rpc_error",
      payload: { requestId, error: "Workspace not found" },
    }),
    (error, operation) => failures.push(`${operation}: ${String(error)}`),
  );
  const created = await agents.create("key", {
    ...options,
    title: "Hub agent",
    workspaceTitle: "Hub · pr-triage · e6a296d1",
  });
  expect(created.id).toBe("agent");
  expect(requests.map((request) => request["type"])).toEqual([
    "create_agent_request",
    "workspace.title.set.request",
  ]);
  expect(failures).toEqual(["daemon.workspace.title.set: Error: Workspace not found"]);
});

test("requires ordinary agent RPCs and durable receipts instead of falling back to Hub creation", async () => {
  const frames: string[] = [];
  const agents = new DaemonAgents((frame) => frames.push(frame));
  await expect(agents.create("key", options)).rejects.toThrow("Update the Paseo daemon");
  expect(frames).toEqual([]);
});

test("a lost response remains recoverable instead of reporting a rejected creation", async () => {
  const agents = new DaemonAgents(() => {});
  enable(agents);
  const creation = agents.create("key", options);
  agents.close();
  await expect(creation).rejects.toBeInstanceOf(DaemonResponseLostError);
});

function enable(agents: DaemonAgents): void {
  agents.receive({
    type: "session",
    message: {
      type: "server_info",
      payload: { features: { hubAgentRpc: true, agentRequestReceipts: true } },
    },
  });
}

test.each(["create", "restore", "send"] as const)(
  "%s honors the supplied startup wait without changing the RPC",
  async (operation) => {
    vi.useFakeTimers();
    let respond: (() => void) | undefined;
    const agents = new DaemonAgents((frame) => {
      const { message } = z
        .object({ message: z.record(z.string(), z.unknown()) })
        .parse(JSON.parse(frame));
      const reply = () =>
        agents.receive({
          type: "session",
          message: {
            type: "response",
            payload: {
              requestId: message["requestId"],
              state: { kind: "recoverable" },
              accepted: true,
              agent: { id: "agent", workspaceId: "workspace", status: "idle" },
            },
          },
        });
      if (message["type"] === "workspace.recovery.inspect.request") reply();
      else respond = reply;
      expect(message).not.toHaveProperty("timeoutMs");
    });
    try {
      enable(agents);
      const start = () => {
        if (operation === "create") return agents.create("key", options, 180_000);
        if (operation === "restore") return agents.restore("workspace", 180_000);
        return agents.send("agent", "message-key", "hello", 180_000);
      };
      const outcome = start().then(
        () => "accepted",
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(150_000);
      expect(respond).toBeDefined();
      respond!();
      expect(await outcome).toBe("accepted");

      const expired = start().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(await expired).toBeInstanceOf(DaemonResponseLostError);
    } finally {
      agents.close();
      vi.useRealTimers();
    }
  },
);

test.each([true, false])(
  "passes background %s at the create request boundary",
  async (background) => {
    const requests: Record<string, unknown>[] = [];
    const agents = connect(requests);
    agents.receive({
      type: "session",
      message: {
        type: "server_info",
        payload: {
          features: {
            hubAgentRpc: true,
            agentRequestReceipts: true,
            backgroundWorkspaces: true,
          },
        },
      },
    });
    await agents.create("background-key", { ...options, background });
    expect(requests[0]).toMatchObject({ type: "create_agent_request", background });
    expect(requests[0]).not.toHaveProperty("config.background");
  },
);

test.each([undefined, false])(
  "creates and sends the prompt when backgroundWorkspaces is %s",
  async (backgroundWorkspaces) => {
    const requests: Record<string, unknown>[] = [];
    const agents = connect(requests);
    agents.receive({
      type: "session",
      message: {
        type: "server_info",
        payload: {
          features: {
            hubAgentRpc: true,
            agentRequestReceipts: true,
            backgroundWorkspaces,
          },
        },
      },
    });
    const created = await agents.create("key", { ...options, background: true });
    await agents.send(created.id, "message-key", "Run the trigger");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      type: "create_agent_request",
      background: true,
    });
    expect(requests[1]).toMatchObject({
      type: "send_agent_message_request",
      agentId: created.id,
      text: "Run the trigger",
    });
  },
);

test("observes agents without requiring the background-workspace feature", async () => {
  const requests: Record<string, unknown>[] = [];
  const agents = connect(requests);
  const unwatch = await agents.watch("agent", () => {});
  expect(requests[0]).toMatchObject({
    type: "fetch_agents_request",
    includeBackground: true,
    subscribe: { subscriptionId: "hub-continuation" },
  });
  unwatch();
  agents.close();
});

test("every watch reads current state even when the directory subscription already exists", async () => {
  const requests: Record<string, unknown>[] = [];
  const agents = connect(requests);
  const first: AgentEvent[] = [];
  const second: AgentEvent[] = [];
  const unwatchFirst = await agents.watch("agent", (event) => first.push(event));
  const unwatchSecond = await agents.watch("agent", (event) => second.push(event));
  expect(requests.filter((request) => request["type"] === "fetch_agents_request")).toHaveLength(1);
  expect(requests.filter((request) => request["type"] === "fetch_agent_request")).toHaveLength(2);
  const expected = [
    {
      type: "agent_snapshot",
      agent: { id: "agent", workspaceId: "workspace", status: "idle" },
      timestamp: expect.any(String) as unknown,
    },
  ];
  expect(first).toEqual(expected);
  expect(second).toEqual(expected);
  unwatchFirst();
  unwatchSecond();
  agents.close();
});

test.each([
  { name: "missing", payload: {} },
  { name: "null", payload: { agent: null } },
  { name: "invalid", payload: { agent: { id: "agent", status: "unknown" } } },
  {
    name: "other-agent",
    payload: { agent: { id: "other", workspaceId: "workspace", status: "idle" } },
  },
  { name: "rejected", payload: { error: "Unsupported request" } },
])("keeps live observation when the snapshot response is $name", async (response) => {
  const events: AgentEvent[] = [];
  const agents = new DaemonAgents((frame) => {
    const { message } = z
      .object({ message: z.record(z.string(), z.unknown()) })
      .parse(JSON.parse(frame));
    const snapshot = message["type"] === "fetch_agent_request";
    agents.receive({
      type: "session",
      message: {
        type: snapshot && response.name === "rejected" ? "rpc_error" : "response",
        payload: {
          requestId: message["requestId"],
          ...(snapshot ? response.payload : {}),
        },
      },
    });
  });
  enable(agents);
  const unwatch = await agents.watch("agent", (event) => events.push(event));
  expect(events).toEqual([]);
  agents.receive({
    type: "session",
    message: {
      type: "agent_update",
      payload: {
        kind: "upsert",
        agent: { id: "agent", workspaceId: "workspace", status: "idle" },
      },
    },
  });
  expect(events).toMatchObject([{ type: "agent_update", agent: { status: "idle" } }]);
  unwatch();
  agents.close();
});

test("launches arbitrary daemon providers with MCP servers and no Hub tool policy", async () => {
  const requests: Record<string, unknown>[] = [];
  const agents = connect(requests);
  await agents.create("key", {
    ...options,
    provider: "provider-from-daemon",
    mcpServers: { hub: { type: "http", url: "https://hub.test/mcp" } },
  });
  expect(requests[0]).toMatchObject({
    config: {
      provider: "provider-from-daemon",
      mcpServers: { hub: { type: "http", url: "https://hub.test/mcp" } },
    },
  });
  expect(requests[0]).not.toHaveProperty("config.toolPolicy");
  expect(requests[0]).not.toHaveProperty("config.mcpServerRequirements");
});

const launchWithPolicy = {
  ...options,
  provider: "provider-from-daemon",
  toolPolicy: { preapproved: [{ kind: "mcp", server: "hub", tool: "finish_execution" }] },
  mcpServers: { hub: { type: "http", url: "https://hub.test/mcp" } },
} as const;
const unsupportedPolicy =
  "Provider 'provider-from-daemon' cannot preapprove exact MCP tools for unattended execution";
const unsupportedPolicyReply = {
  errorCode: "unknown",
  error: `${unsupportedPolicy}; select Claude, Codex, or OpenCode`,
};

function connectForCreateFailures(
  requests: Record<string, unknown>[],
  ...rejections: { errorCode: string; error: string }[]
): DaemonAgents {
  const agents = new DaemonAgents((frame) => {
    const { message } = z
      .object({ message: z.record(z.string(), z.unknown()) })
      .parse(JSON.parse(frame));
    requests.push(message);
    const rejection = rejections.shift();
    agents.receive({
      type: "session",
      message: {
        type: "status",
        payload: {
          requestId: message["requestId"],
          ...(rejection === undefined
            ? {
                status: "agent_created",
                agent: { id: "agent", workspaceId: "workspace", status: "idle" },
              }
            : { status: "agent_create_failed", ...rejection }),
        },
      },
    });
  });
  enable(agents);
  return agents;
}

test("a provider that accepts exact grants launches on the first request", async () => {
  const requests: Record<string, unknown>[] = [];
  const agents = connect(requests);

  await agents.create("key", launchWithPolicy);

  expect(requests).toHaveLength(1);
  expect(requests[0]).toHaveProperty("config.toolPolicy", launchWithPolicy.toolPolicy);
});

test.each([
  unsupportedPolicyReply,
  { errorCode: "unknown", error: unsupportedPolicy },
  { errorCode: "tool_policy_unsupported", error: "Exact tool policy unsupported" },
])(
  "retries once without grants after the daemon reports unsupported policy ($errorCode: $error)",
  async (rejection) => {
    const requests: Record<string, unknown>[] = [];
    const agents = connectForCreateFailures(requests, rejection);

    await expect(agents.create("key", launchWithPolicy)).resolves.toMatchObject({ id: "agent" });

    expect(requests).toHaveLength(2);
    expect(requests[0]).toHaveProperty("config.toolPolicy", launchWithPolicy.toolPolicy);
    expect(requests[1]).toHaveProperty("idempotencyKey", "key:without-tool-policy");
    expect(requests[1]).not.toHaveProperty("config.toolPolicy");
    expect(requests[1]).toHaveProperty("config.provider", launchWithPolicy.provider);
    expect(requests[1]).toHaveProperty("config.mcpServers", launchWithPolicy.mcpServers);
  },
);

test("propagates unrelated create failures without retrying", async () => {
  const error = "The requested working directory is unavailable";
  const requests: Record<string, unknown>[] = [];
  const agents = connectForCreateFailures(requests, { errorCode: "unknown", error });

  await expect(agents.create("key", launchWithPolicy)).rejects.toThrow(error);
  expect(requests).toHaveLength(1);
});

test("propagates a rejected fallback without a third create request", async () => {
  const requests: Record<string, unknown>[] = [];
  const agents = connectForCreateFailures(requests, unsupportedPolicyReply, unsupportedPolicyReply);

  await expect(agents.create("key", launchWithPolicy)).rejects.toThrow(unsupportedPolicy);
  expect(requests).toHaveLength(2);
});

const CURRENT_EPOCH = "epoch-2";
const entry = (seq: number, item: Record<string, unknown>, turnId = "turn-1") => ({
  provider: "codex",
  item,
  turnId,
  timestamp: `2026-09-30T10:00:0${seq}.000Z`,
  seqStart: seq,
  seqEnd: seq,
  sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
  collapsed: [],
});
const history = [
  entry(1, { type: "user_message", text: "Summarize the repo" }),
  entry(2, { type: "future_item_kind", payload: { anything: true } }),
  entry(3, { type: "assistant_message", text: "The repo has three packages." }),
];

/** A daemon that holds one agent's timeline and answers like the real one, including stale epochs. */
function timelineDaemon(): DaemonAgents {
  const agents = new DaemonAgents((frame) => {
    const { message } = z
      .object({ message: z.record(z.string(), z.unknown()) })
      .parse(JSON.parse(frame));
    const requestId = message["requestId"];
    const reply = (type: string, payload: Record<string, unknown>) =>
      agents.receive({ type: "session", message: { type, payload: { requestId, ...payload } } });
    if (message["type"] === "send_agent_message_request") {
      reply("send_agent_message_response", {
        accepted: false,
        error: message["messageId"] === "pending" ? "agent_request_outcome_unknown" : "conflict",
      });
      return;
    }
    if (message["agentId"] === "rejected") {
      reply("rpc_error", { error: "Permission denied" });
      return;
    }
    const known = message["agentId"] === "agent";
    const cursor = z
      .object({ epoch: z.string(), seq: z.number() })
      .optional()
      .parse(message["cursor"]);
    const stale = cursor !== undefined && cursor.epoch !== CURRENT_EPOCH;
    const entries = known ? history : [];
    reply("fetch_agent_timeline_response", {
      agentId: message["agentId"],
      agent: known
        ? {
            id: "agent",
            workspaceId: "workspace",
            status: "idle",
            requiresAttention: true,
            attentionReason: "finished",
            pendingPermissions: [],
          }
        : null,
      direction: stale ? "tail" : message["direction"],
      projection: "projected",
      epoch: CURRENT_EPOCH,
      reset: stale,
      staleCursor: stale,
      gap: false,
      window: { minSeq: 1, maxSeq: 3, nextSeq: 4 },
      startCursor: entries.length ? { epoch: CURRENT_EPOCH, seq: 1 } : null,
      endCursor: entries.length ? { epoch: CURRENT_EPOCH, seq: 3 } : null,
      hasOlder: false,
      hasNewer: false,
      entries,
      error: known ? null : `Agent not found: ${String(message["agentId"])}`,
    });
  });
  enable(agents);
  return agents;
}

test("a timeline page keeps the final assistant answer, its turn and ranges, and tolerates unknown item kinds", async () => {
  const page = await timelineDaemon().timeline("agent", { direction: "tail", limit: 20 });
  const answer = page.entries.at(-1);
  expect(answer).toMatchObject({
    provider: "codex",
    turnId: "turn-1",
    timestamp: "2026-09-30T10:00:03.000Z",
    seqStart: 3,
    seqEnd: 3,
    sourceSeqRanges: [{ startSeq: 3, endSeq: 3 }],
    item: { type: "assistant_message", text: "The repo has three packages." },
  });
  expect(page.entries[1]?.item).toMatchObject({ type: "future_item_kind" });
  expect(page.endCursor).toEqual({ epoch: CURRENT_EPOCH, seq: 3 });
  expect(page.agent).toMatchObject({
    status: "idle",
    requiresAttention: true,
    attentionReason: "finished",
    pendingPermissions: [],
  });
});

test("a cursor from a previous epoch comes back flagged stale and reset", async () => {
  const page = await timelineDaemon().timeline("agent", {
    direction: "after",
    cursor: { epoch: "epoch-1", seq: 2 },
    limit: 20,
  });
  expect(page).toMatchObject({ staleCursor: true, reset: true, epoch: CURRENT_EPOCH });
  expect(page.entries).toHaveLength(3);
});

test("a cursor from the current epoch is not stale", async () => {
  const page = await timelineDaemon().timeline("agent", {
    direction: "after",
    cursor: { epoch: CURRENT_EPOCH, seq: 2 },
    limit: 20,
  });
  expect(page).toMatchObject({ staleCursor: false, reset: false });
});

test("a missing agent rejects with the daemon's own error", async () => {
  await expect(timelineDaemon().timeline("gone", { direction: "tail", limit: 20 })).rejects.toThrow(
    new DaemonAgentError("Agent not found: gone"),
  );
});

test("a rejected timeline request surfaces the daemon's reason", async () => {
  await expect(
    timelineDaemon().timeline("rejected", { direction: "tail", limit: 20 }),
  ).rejects.toThrow("Permission denied");
});

test("a timeline whose acknowledgement is lost is an unknown outcome, not a rejection", async () => {
  const agents = new DaemonAgents(() => {});
  enable(agents);
  const page = agents.timeline("agent", { direction: "tail", limit: 20 });
  agents.close();
  const error = await page.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(DaemonResponseLostError);
  expect(isDaemonOutcomeUnknown(error)).toBe(true);
});

test("a timeline that times out is lost too", async () => {
  vi.useFakeTimers();
  try {
    const agents = new DaemonAgents(() => {});
    enable(agents);
    const page = agents
      .timeline("agent", { direction: "tail", limit: 20 })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await page).toBeInstanceOf(DaemonResponseLostError);
  } finally {
    vi.useRealTimers();
  }
});

test("a daemon without the agent RPCs is reported as unsupported, and still reads as a daemon error", async () => {
  const agents = new DaemonAgents(() => {});
  const error = await agents
    .timeline("agent", { direction: "tail", limit: 20 })
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(DaemonUnsupportedError);
  expect(error).toBeInstanceOf(DaemonAgentError);
  expect(isDaemonOutcomeUnknown(error)).toBe(false);
});

test("only an unresolved send is classified as an unknown outcome", async () => {
  const agents = timelineDaemon();
  const unresolved = await agents
    .send("agent", "pending", "hello")
    .catch((caught: unknown) => caught);
  const conflict = await agents.send("agent", "other", "hello").catch((caught: unknown) => caught);
  expect(isDaemonOutcomeUnknown(unresolved)).toBe(true);
  expect(isDaemonOutcomeUnknown(conflict)).toBe(false);
  expect(isDaemonOutcomeUnknown(new DaemonAgentError("create_request_outcome_unknown"))).toBe(true);
  expect(isDaemonOutcomeUnknown(new Error("agent_request_outcome_unknown"))).toBe(false);
});
