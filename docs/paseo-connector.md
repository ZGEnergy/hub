# Paseo connector (remote MCP)

**Dotty compatibility: not yet verified.** An OAuth-linked ChatGPT MCP app is expected to reach this
endpoint, but no Dotty (OpenAI Dots) invocation of it has been observed yet. Do not rely on Dotty support
until that check is recorded.

The connector lets a remote MCP client, such as a private ChatGPT MCP app, start and follow coding agents on
one machine that is already enrolled in this Hub. Each OAuth connection is bound to one enrolled daemon and
one working directory, both chosen by the operator during linking. The connector only sees agents it
started itself. Other Paseo sessions on the machine never appear in it and cannot be addressed.

## Requirements

- **An explicit opt-in.** Set `PASEO_HUB_PASEO_CONNECTOR=enabled`. The connector is off by default: unset,
  blank or `disabled` installs no OAuth provider and opens no client registration, and every connector route
  (the OAuth endpoints, both well-known documents, `/mcp/paseo`, and the linking screens' server functions)
  answers 404. Any other value stops Hub at startup. Hub's own sign-in, daemons and triggers are unchanged
  either way.
- **A public origin.** Set `PASEO_HUB_APP_URL` to the origin that ChatGPT and your daemons both reach. Even
  when opted in, the connector is enabled only when that origin is `https:`, or plain `http:` on
  `localhost`, `127.0.0.1` or `[::1]` (for local testing). On any other origin every connector route answers 404.
- **An owner or admin.** Only a user whose current role in the machine's organization is `owner` or `admin`
  (the roles that manage the organization's resources) can see machines, select one, approve the link, or
  use or refresh a connection. A view-only `member` sees no machines.
- **A database.** Use embedded PGlite (the default, stored in `PASEO_HUB_DATA_DIR`) or `DATABASE_URL`. Without
  one, connector routes answer 503.
- **A stable `PASEO_HUB_AUTH_SECRET`** (or the generated one kept in the data directory). Hub's token
  signing keys are stored encrypted with it.
- **An enrolled machine.** The daemon must be active and enrolled with the `hub.execute` permission. A machine
  without that permission is listed but cannot be selected.

## URLs

With `<origin>` standing for `PASEO_HUB_APP_URL`:

| Purpose                                | URL                                                               |
| -------------------------------------- | ----------------------------------------------------------------- |
| MCP server (OAuth resource)            | `<origin>/mcp/paseo` (POST only; GET and DELETE answer 405)       |
| Protected-resource metadata (RFC 9728) | `<origin>/.well-known/oauth-protected-resource/mcp/paseo`         |
| Authorization-server metadata          | `<origin>/.well-known/oauth-authorization-server`                 |
| Authorization endpoint                 | `<origin>/api/auth/oauth2/authorize`                              |
| Token endpoint                         | `<origin>/api/auth/oauth2/token`                                  |
| Dynamic client registration            | `<origin>/api/auth/oauth2/register`                               |
| Token revocation                       | `<origin>/api/auth/oauth2/revoke`                                 |
| Signing keys (JWKS)                    | `<origin>/api/auth/jwks`                                          |
| Machine and directory selection        | `<origin>/oauth/connect` (reached through the authorization flow) |
| Your connections and revocation        | `<origin>/oauth/connections`                                      |

A request to `/mcp/paseo` without a bearer token gets `401` with
`WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp/paseo"`. Clients
use that header to discover the authorization server. A bearer token that is malformed, expired, signed by
someone else or issued for another resource, or whose connection was revoked or no longer exists, gets the
same header with `error="invalid_token"` added (RFC 6750). A token carrying no connector scope gets `403` with
`error="insufficient_scope"`. When Hub cannot read its own signing keys or the connection (a database
outage, say), the answer is `503` `temporarily_unavailable`, never a `401`, so a client does not re-link over
Hub's own failure.

The authorization-server metadata lists only the endpoints in the table above. The library's introspection
endpoint is not served and not advertised.

Access tokens are JWTs signed by Hub, with the issuer `<origin>` and the audience `<origin>/mcp/paseo`. They
last one hour. A token request must name `resource=<origin>/mcp/paseo`; any other resource is refused with
`invalid_target`. Only public clients using PKCE `S256` are supported.

A refresh-token request is checked against the connection before the refresh token is rotated: the
connection must be active and not revoked, the user must still be an owner or admin of its organization, the
machine must still be active with `hub.execute`, and the stored scopes must still be within the connection's.
If that check fails the answer is `400` `invalid_grant` and the presented refresh token is left untouched. If
Hub cannot read the grant at all the answer is `503` `temporarily_unavailable`, and the same refresh token
stays usable for a retry. In the bounded case where the grant changes or a database fault occurs after Hub's pre-check passes but while the OAuth library is issuing tokens, the library has already rotated the refresh token, the client gets a server error, and the user may need to re-link.

## Scopes

| Scope            | Allows                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `paseo:read`     | `get_connection`, `list_runtimes`, `list_agents`, `get_agent`                                 |
| `paseo:run`      | `start_agent`, `send_agent_message`: run agents that can change files in the linked directory |
| `paseo:cancel`   | `cancel_agent`: interrupt an agent's current turn                                             |
| `offline_access` | A refresh token, so the client can stay linked past one hour                                  |

The connection stores the connector scopes the operator approved. A token can never carry more than those,
and refreshing a token never widens them. A tool called without its scope fails with `insufficient_scope`.
It never returns an empty success.

## Linking a machine

1. The client starts authorization. A signed-out user sees Hub's normal sign-in form at `/oauth/connect`.
2. The user picks an enrolled machine from an organization where they are an owner or admin. They then type an
   absolute working directory, such as `/srv/work/project`. Hub never falls back to the daemon's own working
   directory.
3. The consent page shows the client, the machine, the directory and the scopes. Approving it activates the
   connection. Denying it discards the connection.

Every MCP request checks the connection again. It must still be active and not revoked, the user must still
be an owner or admin of the organization, and the machine must still be active with `hub.execute`.

## Revoking

Revoke a connection at `<origin>/oauth/connections`. Removing the user from the organization, or demoting them
to `member`, has the same effect for as long as they stay removed or demoted.

What revocation does:

- It stops new reads and actions at once. The next MCP request using a token for that connection gets `401`
  with `error="invalid_token"`, so the client has to link again.
- It refuses refresh-token exchanges for that connection.

What revocation does not do:

- It does not contact the machine, and it does not stop agents that are already running.
- It does not delete their sessions, which stay visible in Paseo itself.

A new link creates a new connection. Agents started under the revoked connection are not carried over to it.

Re-enrolling a daemon gives it a new identity, so connections to the old identity stop working.

## Tools

| Tool                 | What it does                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `get_connection`     | Machine name, whether it is online, the working directory and the granted scopes. No credentials. |
| `list_runtimes`      | The providers configured on the machine for that directory, with their models and modes.          |
| `list_agents`        | Agents started through this connection, with live status when the machine is online.              |
| `get_agent`          | By `agent_id`: status, pending approvals, and one bounded timeline page with cursors.             |
|                      | By `operation_id`: what happened to a launch or a message.                                        |
| `start_agent`        | Creates an agent in the linked directory and sends it the task.                                   |
| `send_agent_message` | Sends a follow-up message to an agent this connection started.                                    |
| `cancel_agent`       | Interrupts the agent's current turn.                                                              |

The four read tools are annotated read-only. `start_agent` and `send_agent_message` are annotated as
destructive, because the agent they start can change files. That keeps the client's write confirmations in
place. `cancel_agent` is a write, but it deletes nothing.

There are no tools to archive, kill, approve permissions, open terminals or browsers, manage schedules,
administer daemons, or reach other sessions. When an agent is waiting for an approval, `get_agent` reports
it. The user must answer that approval in Paseo, because the connector cannot.

Timelines come in pages of 20 entries by default, and 100 at most. Each text field is capped at 8,000
characters. Use `startCursor` with `direction: "before"` for older entries, and `endCursor` with
`direction: "after"` for newer ones. If a result reports `reset` or `staleCursor`, the machine has rewritten
the timeline: discard the old cursors.

### Request keys

`start_agent` and `send_agent_message` take a `request_key`. It is a UUID that the client generates once for
each intended operation.

- Sending the same key with the same arguments returns the recorded result and never starts the work twice.
- Sending the same key with different arguments fails with `request_conflict`.
- When a result is pending (`state` is `creating` or `created`) or fails with `outcome_unknown`, the machine
  may already have acted. Check it with `get_agent({operation_id})` rather than retrying with a new key.

Acceptance means the machine received the text. It does not mean the task is finished.

**Known limitation: no automatic reconciliation.** If Hub stops (a crash or a restart) while a launch is
between creating the agent and recording the result, the operation stays `creating` or `created`. Hub reports
that state, with the operation's own IDs, on every later look and on a replay of the same key. It never
re-creates, re-sends or resolves it by itself. Inspect the agent in Paseo to see what actually happened.

### Cancellation

`cancel_agent` interrupts the current turn only. The session remains, can receive more messages, and keeps
any changes already made.

Some things look like a cancellation but are not one: a dropped HTTP connection, the client pausing, or an
MCP request cancellation. None of these interrupt an agent.

### Errors

A tool error has `isError: true`, a text line `<code>: <message>`, and
`structuredContent.error = { code, message, operationId?, agentId?, state? }`. Only the caller's own IDs ever
appear in it.

| Code                                 | Meaning                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `not_found`                          | No such agent or operation for this connection. Other users' agents look the same.                           |
| `machine_offline`                    | The machine is not connected to Hub. Nothing is queued; try again later.                                     |
| `machine_incompatible`               | The daemon is too old, revoked, or lacks `hub.execute`.                                                      |
| `runtime_unavailable`                | The provider, model or mode is not available on the machine.                                                 |
| `insufficient_scope`                 | The token lacks the scope the tool needs.                                                                    |
| `request_conflict`                   | The request key was already used with different arguments.                                                   |
| `create_rejected`, `prompt_rejected` | The machine refused to create the agent, or refused the text.                                                |
| `outcome_unknown`                    | The machine may have acted. Inspect the operation; do not retry with a new key.                              |
| `daemon_rejected`                    | The machine refused a read or a cancellation.                                                                |
| `connection_revoked`                 | The connection was revoked, or the account lost organization membership or was demoted below owner or admin. |
| `invalid_input`                      | The arguments are invalid. The message lists the fields.                                                     |
| `internal_error`                     | An unexpected Hub failure. Hub logs it.                                                                      |

## Registering a private MCP app in ChatGPT

1. Deploy Hub on its HTTPS origin, with `PASEO_HUB_APP_URL` set to that origin and
   `PASEO_HUB_PASEO_CONNECTOR=enabled`. Confirm that
   `<origin>/.well-known/oauth-protected-resource/mcp/paseo` returns JSON.
2. In ChatGPT, open **Add**, then **Create MCP App**.
3. Set **Server URL** to `<origin>/mcp/paseo` and choose **OAuth** authentication.
4. Leave the client credentials empty: ChatGPT registers itself as a public client through dynamic client
   registration.
5. Read the custom-server trust notice, accept it if you trust this Hub, and create the app.
6. Connect the app. You are sent to Hub: sign in as an owner or admin of the machine's organization, select
   the machine and working directory, and approve.

Linking the app in ordinary ChatGPT does not show that Dotty can use it. See the status line at the top.

## Local verification

The connector lifecycle was exercised end to end on one machine, with no public origin and no ChatGPT. This
proves the Hub and daemon side only. **Dotty compatibility: not yet verified.**

Run it with `PASEO_E2E_WORKTREE=<paseo checkout> npm run test:e2e:hub:connector`
(`src/e2e/hub-paseo-connector.e2e.test.ts`). It needs Docker for PostgreSQL, a current `npm run build`, the
`claude` CLI, and Playwright's Chromium. The harness starts its own PostgreSQL container, the built self-hosted
production runtime behind a local reverse proxy (`http://127.0.0.1:<port>`) with
`PASEO_HUB_PASEO_CONNECTOR=enabled`, and a source-built Paseo daemon with its own `PASEO_HOME` and listen port,
enrolled with `hub.execute`. It never touches another daemon.

The test operator signs up through Hub's own sign-up endpoint, but their membership in the harness's seeded
organization (the one the daemon is enrolled in) is inserted directly into the database, as `admin`. Hub's
invitation flow is not part of this run.

| Item            | Tested                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hub             | 0.10.0, commit `e501909`, PostgreSQL 17                                                                                                                |
| Paseo daemon    | 0.10.0, source commit `2c9b09e4a9`                                                                                                                     |
| Agent provider  | `claude` (Claude Code 2.1.285), model `claude-haiku-4-5` chosen from `list_runtimes`                                                                   |
| Transport       | MCP Streamable HTTP, stateless JSON responses, `@modelcontextprotocol/sdk` 1.30.0 client                                                               |
| Account linking | Dynamic registration, Hub sign-in on `/oauth/connect`, machine and directory selection, consent in Chromium, PKCE `S256` code exchange with `resource` |

Every step passed (9 of 9, about 55 s on 2026-09-30):

1. Both well-known documents name the origin and resource. A request without a token gets `401` with the
   `resource_metadata` challenge, and an invalid token gets the same challenge with `error="invalid_token"`. `tools/list` returns exactly the seven tools. `get_connection` shows the
   selected machine online and the selected directory; `list_runtimes` shows `claude` ready.
2. `start_agent` was accepted. Paseo itself reports the agent as a `claude` agent whose working directory is the
   linked directory.
3. `get_agent` returned the agent's exact final answer.
4. `send_agent_message` was accepted, and the same session answered it after its first answer.
5. Replaying the launch's request key returned the same operation and agent; Paseo holds exactly one agent from it.
6. `cancel_agent` interrupted a running answer partway (at about 170 of 3,000 lines). The agent went idle, wrote
   nothing more, and its session stayed in Paseo, not archived.
7. An agent started directly on the daemon, in the same directory, never appeared in `list_agents`.
   `get_agent`, `send_agent_message` and `cancel_agent` on it all returned `not_found`, and the refused message
   never reached it.
8. After a Hub restart on the same database, `list_agents` and `get_agent` still resolved the owned agents.
9. Revoking the connection at `/oauth/connections` while an agent was mid-answer made the next MCP request
   fail with `401` `error="invalid_token"`. Paseo still reported the agent running, then and three seconds later.
10. With the daemon's Hub connection cut, `get_connection` reported it offline, `get_agent` and `start_agent`
    failed with `machine_offline`, and no agent was created. It came back online after reconnecting.

The numbers match the test titles. Steps 2 and 3 are one test, and step 10 runs before step 9, because
revocation ends the connection the other steps use.

Not covered here: a public HTTPS origin, ChatGPT or Dotty, refresh-token exchange, and re-enrolling a daemon.
