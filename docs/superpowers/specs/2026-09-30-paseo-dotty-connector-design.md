# Self-hosted Paseo Agent Connector

Date: 2026-09-30
Status: Design record, revised 2026-10-01 to a provider-neutral contract.

> **Revision 2026-10-01.** The product is renamed the **Paseo Agent Connector**. Its contract is
> provider-neutral: any standards-compatible remote MCP client that implements MCP OAuth (dynamic client
> registration, authorization code with PKCE `S256`, resource indicators) can link and use it, and nothing in
> Hub depends on the calling client's vendor. "Dotty" is the user's own nickname for one OpenAI Dots client;
> it remains the first planned live test, not a requirement. Requirements below that named Dotty or ChatGPT
> now name a hosted MCP client, and hosted-client verification is a separate live gate for each client. The
> specification and implementation plan record the design. Their original filenames are retained for
> historical continuity.
>
> Behaviour decided after approval, during implementation review. Token audience binding is unchanged: every
> token is bound to the one connector resource. Token-endpoint `resource` matching was relaxed to the RFC 8707
> default (an absent `resource` means the single connector resource) plus canonical equality:
>
> - Only a user who is currently an `owner` or `admin` of the machine's organization can select a machine,
>   approve a link, or use or refresh a connection.
> - The connector is opt-in: off unless `PASEO_HUB_PASEO_CONNECTOR=enabled`, and served only on an HTTPS
>   (or loopback HTTP) public origin. Disabled, every connector route answers 404.
> - At the token endpoint, a code or refresh grant with no `resource` is given the connector's one canonical
>   resource; a supplied `resource` must canonically equal it (scheme/host case, default port, one trailing
>   slash), else `invalid_target`. Every token's audience is still that one resource.
> - Denying consent is final: the pending connection and flow are discarded, and the client must start again.
> - Refresh grants are checked against the connection before the refresh token is rotated; Hub's own
>   infrastructure failures answer `503`, not a re-link error.
> - A revoked or deleted connection answers `401` with `error="invalid_token"` and the resource-metadata
>   challenge, so clients re-link.
> - Connected apps lists each connection by its client's registered (unverified) name, so a user switching
>   clients can revoke a specific one.
> - A launch interrupted by a Hub restart is reported as pending with its IDs; there is no automatic
>   reconciliation.

## Goal and approved decisions

Provide an account-linked Paseo Agent Connector that a hosted MCP client (for example OpenAI Dots, Claude or Grok) can call from anywhere, like a Gmail connector. An operator connects a machine running Paseo once. The client can launch agents on that machine, retrieve progress and results, send follow-ups, and cancel work without using the operator's own computer or installing a CLI in the client's environment. Switching to another compatible client means linking that client, not changing Hub.

Approved decisions:

- Extend self-hosted Paseo Hub, rather than depend on changes to hosted Hub.
- Restrict the connector to agents created through that connector. Existing unrelated Paseo sessions are inaccessible.
- Reuse the daemon's existing outbound Hub relationship. Do not enroll a parallel Hub for the connector.
- Use an OAuth-authenticated remote MCP interface, not a publicly exposed daemon or CLI wrapper.

The product is implemented in Paseo Hub and uses the daemon's existing Hub relationship.

## Evidence and compatibility gate

### Verified from source and documentation

- Daemon enrollment creates a durable identity and credential and returns an outbound WebSocket address. The daemon reconnects using that relationship.
- Hub's `DaemonAgents` abstraction uses ordinary daemon session operations to create, inspect, message, watch, cancel, and archive work.
- The daemon's `hub.execute` permission permits ordinary agent control, but is daemon-wide. It does not distinguish the user behind the calling MCP client or enforce connector ownership.
- Hub's existing public API and API-key scopes do not expose general interactive agent management. A hosted Hub API-key wrapper is not sufficient.
- A daemon has one Hub relationship. The connector must share the selected self-hosted Hub with other Hub workflows.
- Hosted clients decide for themselves which custom MCP servers their agents may call. For example, Dots shares supported plugin connections and permissions with ChatGPT, Work, and Codex. This does not prove that every privately developed MCP app is Dot-callable, and the same caution applies to every client.

### Observed on the signed-in OpenAI account

Read-only browser inspection of the user's OpenAI account on 2026-09-30 established:

- A Dots client (the user's "Dotty") is available in the account.
- Installed Google connections are visible in Plugins.
- The Personal plugin directory is present and currently shows no plugins.
- Add offers Create plugin, Upload plugin archive, and Create MCP App.
- Create MCP App opens a New Plugin form with Server URL or Tunnel, OAuth authentication, advanced OAuth settings, and a custom-server trust acknowledgement.

The form was closed without submitting, accepting the trust acknowledgement, connecting a server, or changing permissions. No prompt was sent to the Dot and no agent was launched. No private conversation contents or credentials belong in this specification.

### Unverified acceptance gate (per hosted client)

No hosted MCP client has yet invoked the connector. Each hosted client (for example OpenAI Dots, claude.ai, Claude Code, Grok) is its own live gate, needing a real reachable MCP endpoint and that client's authenticated account. Linking a client, its setup form, or a tool call from a different surface of the same vendor is not evidence for the client being tested: for example, ordinary ChatGPT setup or an ordinary-chat tool call is not evidence for Dots. Record, per client, whether it can invoke read and write tools and retrieve results; do not assume availability from setup UI or documentation.

If a client cannot access a personal custom MCP server, stop relying on that client and report the precise platform restriction. Do not substitute computer control, a CLI workaround, or another surface for the requested client experience.

## Architecture

```text
Hosted MCP client (e.g. OpenAI Dots, Claude, Grok)
    | HTTPS MCP with OAuth access token
    v
Self-hosted Hub connector
    | Resolve authorized connection, enrolled daemon, and owned agent
    v
Hub's existing authenticated outbound daemon session
    v
Paseo daemon -> coding agents and local working directory
```

Hub is the public service. The daemon needs outbound connectivity to Hub, not an inbound public listener. Paseo relay pairing, Secure MCP Tunnel, and the local `/mcp/agents` endpoint are not the machine-routing layer.

For this design, one OAuth connection is bound to one enrolled daemon and one operator-selected working directory. This is a conservative product choice, not a client or Hub requirement. Several separately authorized connections may target different machines. A multi-machine inventory under one OAuth connection is outside this design.

The daemon UUID is stable during a relationship, including reconnects and restarts. Revocation and re-enrollment establish a new identity and require fresh authorization; machine hostname or slug is display metadata, not authority.

## Components and boundaries

### 1. OAuth and connection authorization

Add standards-based OAuth 2.1 authorization (the MCP authorization profile) to Hub using its existing user login and organization membership as the human identity source. Support authorization-code flow with PKCE S256, resource discovery, resource/audience-bound tokens, and dynamic client registration that any client can use. No client, vendor, domain or callback allowlist. Existing organization API keys, CLI login credentials, and enrollment tokens are not connector account-link tokens.

During consent, the user selects an enrolled daemon they are authorized to connect and a configured absolute working directory. Persist a connector connection containing its stable ID, owner user ID, organization ID, daemon UUID, working directory, granted connector scopes, and revocation state. The directory must be explicit; never use the daemon process working directory by default.

Proposed connector scopes are `paseo:read`, `paseo:run`, and `paseo:cancel`. Every call validates token issuer, resource audience, expiration, scope, current connection state, and organization membership. Token refresh and reconnection retain the same connection identity; they do not widen permissions. Revoking a connection prevents new reads and actions, but does not silently stop agents already running.

Keep daemon credentials and OAuth secrets server-side. Neither tool results nor prompts contain them. Operator account management remains in Hub, not in connector tools.

### 2. Durable agent ownership

Add a connector-owned operation/agent record scoped to connection ID, owner user ID, organization ID, and daemon UUID. It records the connector launch operation ID, creation key, resolved daemon agent ID and workspace ID, and launch disposition.

The record is the authorization source. Agent names, labels, parent metadata, arbitrary caller IDs, and knowledge of an agent UUID are not authority. For list, status/results, follow-up, and cancel, join through this ownership record before contacting the daemon. Requests for missing or foreign agents return a non-disclosing not-found result.

Only agents directly created and recorded by this connector are addressable. Do not automatically claim existing agents, Hub-trigger agents, or other agent descendants. The parent agent may manage its own delegated work through its provider, but connector access to those children requires an explicit future ownership design.

Ownership survives Hub and daemon restarts. No generic RPC-forwarding tool may bypass this check.

### 3. Remote MCP tool surface

Expose a Streamable HTTP MCP endpoint on Hub's stable public HTTPS origin. Define new connector-specific schemas and annotations instead of forwarding the daemon MCP catalog unchanged.

| Tool                 | Behavior                                                                                    | Required scope | Annotation                    |
| -------------------- | ------------------------------------------------------------------------------------------- | -------------- | ----------------------------- |
| `get_connection`     | Selected machine label, availability, directory, and connector access; no credentials       | `paseo:read`   | Read-only                     |
| `list_runtimes`      | Discover available configured agent runtimes on the bound daemon                            | `paseo:read`   | Read-only                     |
| `start_agent`        | Create an owned agent and send the requested task; return agent/operation identity promptly | `paseo:run`    | Write                         |
| `list_agents`        | List agents recorded for this authorized connection only                                    | `paseo:read`   | Read-only                     |
| `get_agent`          | Owned-agent state and bounded, cursor-based timeline/results                                | `paseo:read`   | Read-only                     |
| `send_agent_message` | Send a follow-up to an owned agent                                                          | `paseo:run`    | Write                         |
| `cancel_agent`       | Cancel the owned agent's current run, retaining its session                                 | `paseo:cancel` | Write; not permanent deletion |

Runtime selection uses actual daemon discovery and compatible settings. Do not expose arbitrary environment variables, additional MCP servers, raw daemon messages, terminal commands, or security-policy overrides through tool arguments.

There are no archive, kill, permission-approval, terminal, browser, schedule, daemon-admin, or unrelated-session tools. Cancellation does not undo completed effects and does not delete the session. A client's pause action and MCP request cancellation are not agent cancellation.

### 4. Hub-to-daemon adapter

Reuse the live connection from `ActiveDaemonRegistry` and the ordinary session operations used by `DaemonAgents`. Extend the existing adapter narrowly where needed for authorized list/runtime/timeline retrieval; do not build on manual workflow dispatch or legacy execution-control namespaces.

Check daemon support for `hubAgentRpc` and `agentRequestReceipts` before a launch. Fail explicitly on incompatible versions or missing `hub.execute` authorization.

Creation and prompting are separate:

1. Persist the launch operation and its stable creation key.
2. Send idempotent `create_agent_request` without `initialPrompt`.
3. On a successful creation response, persist the agent/workspace ownership binding.
4. Only after ownership is durable, send the task using a stable `messageId`.
5. Return acceptance and agent identity, not a claim that the coding task has completed.

A failed creation never triggers a prompt. If creation succeeds but prompting fails, retain the owned session and report that the task was not confirmed accepted. Do not hide partial disposition or launch a replacement agent.

Lost acknowledgements and `agent_request_outcome_unknown` are not proof of failure. Surface the unresolved operation and reconcile against existing state/receipts where supported. Do not automatically repeat uncertain prompts, mint a new message ID for the same attempt, or silently duplicate a launch.

### 5. Results and availability

Long-running work outlives its MCP request. Subsequent `get_agent` calls fetch the current daemon state/timeline and return bounded results with continuation cursors. Reuse daemon timeline snapshots/subscriptions rather than treating Hub's agent-to-Hub `finish_execution` MCP endpoint as a caller-facing API.

If the machine is offline, expose that condition explicitly. Do not hold calls indefinitely or queue new work. `list_agents` may enumerate durable owned identities, clearly marking live state unavailable; status/result retrieval must not present cached state as current. A Hub restart must not lose the ownership mapping or grant access to foreign sessions.

## Deployment

Use a dedicated self-hosted Hub deployment with a stable HTTPS origin reachable by the MCP client and enrolled daemons. Configure `PASEO_HUB_APP_URL` for that origin and use Hub's supported database mode: embedded PGlite for a single-process personal deployment, or PostgreSQL where the deployment requires it. Persist the database and authentication secret.

The operator authorizes any change to an existing daemon's Hub relationship separately. Do not disconnect a machine from another Hub without approval. A machine already enrolled in the chosen Hub requires no second relationship.

Public plugin-directory distribution is not required for the initial private account connection. It is a separate distribution decision. Secure MCP Tunnel may be evaluated for private transport testing, but is not required by this HTTPS deployment or treated as proof of any client's compatibility.

No deployment origin, DNS/TLS setup, daemon enrollment, or login credentials have been selected or changed during research.

## Verification and acceptance

The complete deliverable must demonstrate these real behaviors:

1. OAuth account linking succeeds for the intended user and selected machine, with correct resource audience and scope checks.
2. A hosted MCP client (e.g. OpenAI Dots, Claude, Grok) itself discovers the connector and calls `get_connection` and `list_runtimes` using the linked identity.
3. That client launches a real coding agent in the selected directory; the session appears in Paseo on the intended machine.
4. That client retrieves meaningful progress and the final answer through separate requests and can send a follow-up to that same session.
5. That client explicitly cancels an active run and observes the cancellation while the agent session remains available.
6. Another user, connection, organization, or unrelated agent ID cannot access or mutate the session. Unrelated Paseo sessions do not appear in connector lists or results.
7. Agent ownership remains valid after restarting Hub. Revocation prevents further access; daemon re-enrollment does not reuse the old authorization.
8. Offline or incompatible machines produce explicit errors without claiming launch success. Failed or uncertain creation does not send an unintended prompt or duplicate work.
9. Read tools are annotated read-only; write tools are annotated so a client can apply its own confirmation and safety boundaries, and scopes are enforced by the server regardless. Read-only access cannot launch agents.
10. The runtime that runs the agent is chosen from `list_runtimes` by the caller and never derived from the calling client's identity; two independently registered clients get the same catalog and isolated connections.

Keep deterministic regression tests for authorization boundaries, ownership, launch transitions, revocation, and unresolved acknowledgements. Supplement tests with a live Hub/daemon exercise and, per hosted client, an actual conversation in that client. Acceptance items 2-5 are met per client, only for clients that pass that live gate. Do not claim end-to-end success from mocked forwarding, source inspection, or a client's setup UI alone.

## Implementation scope and next gate

Implementation is new OAuth/connection persistence, ownership persistence, a scoped MCP server, narrow extensions to Hub's daemon adapter, and operator-facing connection/consent support in the Hub repository. Reuse the existing Hub login, tenant conventions, database/migrations, daemon transport, and provider execution.

The written specification must be reviewed before an implementation plan is finalized. Once an endpoint exists, each hosted client's live compatibility gate is actionable in that client's authenticated session (the OpenAI Dots gate first). Public deployment and account connection must not be silently substituted for or inferred from local tests.

## Primary references

- [Paseo Hub](https://paseo.sh/docs/hub)
- [Self-hosting Hub](https://paseo.sh/docs/hub/self-hosting)
- [Hub public API](https://paseo.sh/docs/hub/api)
- [Hub daemon registry](https://github.com/getpaseo/hub/blob/main/src/daemons/registry.ts)
- [Hub DaemonAgents](https://github.com/getpaseo/hub/blob/main/src/daemons/agents/index.ts)
- [Hub organization policy](https://github.com/getpaseo/hub/blob/main/src/auth/organization-policy.ts)
- [Daemon relationship remote](https://github.com/getpaseo/paseo/blob/main/packages/server/src/server/hub/relationship-remote.ts)
- [Daemon operation permissions](https://github.com/getpaseo/paseo/blob/main/packages/server/src/server/authorization/operation-permissions.ts)
- [Dots plugin permissions](https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs)
- [Dots computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps)
- [ChatGPT MCP server guide](https://developers.openai.com/plugins/build/mcp-server)
- [ChatGPT connector authentication](https://developers.openai.com/plugins/build/auth)
- [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [Claude connector authentication](https://claude.com/docs/connectors/building/authentication)
- [Grok connectors](https://docs.x.ai/grok/connectors)
