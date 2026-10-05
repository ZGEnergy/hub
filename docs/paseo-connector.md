# Paseo Agent Connector (remote MCP)

**ChatGPT and OpenAI Dots: user-reported live tool evidence.** A ChatGPT agent on a MacBook exercised
launch, result retrieval, idempotency, follow-up, cancellation and ownership isolation over public HTTPS.
The operator's OpenAI Dots agent ("Dotty") subsequently launched a real coding agent and retrieved its
file-read result through the installed plugin. Revocation, refresh and other clients remain unverified.
See [Evidence](#evidence) for the exact scope and provenance.

## What it is

The Paseo Agent Connector is a standard remote MCP server, protected by OAuth 2.1, that lets an MCP client
start and follow coding agents on one machine already enrolled in this Hub. It speaks MCP Streamable HTTP:
POST requests with JSON responses. GET and DELETE answer `405`; there is no server-sent event stream.

Each OAuth connection is bound to one enrolled daemon and one working directory, both chosen by the user
during linking. The connector only sees agents it started itself through that connection. Other Paseo
sessions on the machine never appear in it and cannot be addressed.

Nothing in the connector depends on which vendor's client is calling. Any client that implements the
capabilities in [Client requirements](#client-requirements) takes the same path. The calling client and the
coding-agent runtime are independent: the client picks a provider, model and mode from `list_runtimes`,
which reports what the daemon has configured, and Hub never derives a runtime from the client's identity.

## Enabling it

- **An explicit opt-in.** Set `PASEO_HUB_PASEO_CONNECTOR=enabled`. The connector is off by default: unset,
  blank or `disabled` installs no OAuth provider and opens no client registration, and every connector route
  (the OAuth endpoints, both well-known documents, `/mcp/paseo`, and the linking screens' server functions)
  answers 404. Any other value stops Hub at startup. Hub's own sign-in, daemons and triggers are unchanged
  either way.
- **A public origin.** Set `PASEO_HUB_APP_URL` to the origin that your MCP client and your daemons both reach.
  Even when opted in, the connector is enabled only when that origin is `https:`, or plain `http:` on
  `localhost`, `127.0.0.1` or `[::1]` (for local testing). On any other origin every connector route answers 404. A hosted client can only reach a public HTTPS origin.
- **An owner or admin.** Only a user whose current role in the machine's organization is `owner` or `admin`
  (the roles that manage the organization's resources) can see machines, select one, approve the link, or
  use or refresh a connection. A view-only `member` sees no machines.
- **A completed password change.** A bootstrap owner must replace their temporary Hub password before
  selecting a machine or approving connector consent. Direct browser calls enforce the same gate.
- **A database.** Use embedded PGlite (the default, stored in `PASEO_HUB_DATA_DIR`) or `DATABASE_URL`. Without
  one, connector routes answer 503.
- **A stable `PASEO_HUB_AUTH_SECRET`** (or the generated one kept in the data directory). Hub's token
  signing keys are stored encrypted with it.
- **An enrolled machine.** The daemon must be active and enrolled with the `hub.execute` permission. A machine
  without that permission is listed but cannot be selected.

## Endpoints

With `<origin>` standing for `PASEO_HUB_APP_URL`:

| Purpose                                  | URL                                                               |
| ---------------------------------------- | ----------------------------------------------------------------- |
| MCP server (the OAuth resource)          | `<origin>/mcp/paseo` (POST only; GET and DELETE answer 405)       |
| Protected-resource metadata (RFC 9728)   | `<origin>/.well-known/oauth-protected-resource/mcp/paseo`         |
| Authorization-server metadata (RFC 8414) | `<origin>/.well-known/oauth-authorization-server`                 |
| Authorization endpoint                   | `<origin>/api/auth/oauth2/authorize`                              |
| Token endpoint                           | `<origin>/api/auth/oauth2/token`                                  |
| Dynamic client registration (RFC 7591)   | `<origin>/api/auth/oauth2/register`                               |
| Token revocation (RFC 7009)              | `<origin>/api/auth/oauth2/revoke`                                 |
| Signing keys (JWKS)                      | `<origin>/api/auth/jwks`                                          |
| Machine and directory selection          | `<origin>/oauth/connect` (reached through the authorization flow) |
| Connected apps and revocation            | `<origin>/oauth/connections`                                      |

The protected-resource metadata names the resource `<origin>/mcp/paseo`, the display name
`Paseo Agent Connector`, the one authorization server `<origin>`, the scopes `paseo:read`,
`paseo:run`, `paseo:cancel` and `offline_access`, and header-only bearer tokens. Advertising persistent
access here lets clients derive refresh-capable authorization from resource discovery. It is served only
at the path-suffixed URL above; the root `/.well-known/oauth-protected-resource` is not served, and
neither is `/.well-known/openid-configuration`.

The authorization-server metadata lists only the endpoints in the table above (the library's introspection
endpoint is not served and not advertised), `scopes_supported` of `paseo:read`, `paseo:run`, `paseo:cancel`
and `offline_access`, the grants `authorization_code` and `refresh_token`, response type `code` in `query` mode,
PKCE method `S256` only, and `authorization_response_iss_parameter_supported: true`.

### Discovery and token errors

A request to `/mcp/paseo` without a bearer token gets `401` with
`WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp/paseo"`. Clients
use that header to discover the authorization server. A bearer token that is malformed, expired, signed by
someone else or issued for another resource, or whose connection was revoked or no longer exists, gets the
same header with `error="invalid_token"` added (RFC 6750). A token carrying no connector scope gets `403` with
`error="insufficient_scope"`. When Hub cannot read its own signing keys or the connection (a database
outage, say), the answer is `503` `temporarily_unavailable`, never a `401`, so a client does not re-link over
Hub's own failure.

## Client requirements

A client must implement the MCP authorization flow with these specifics. A client that cannot do one of
them cannot link.

- **Dynamic client registration (RFC 7591).** Registration is open and unauthenticated, and is the only way
  to obtain a client ID: Hub has no pre-registered clients and does not support Client ID Metadata Documents.
  Every dynamically registered client becomes a public client (`token_endpoint_auth_method` `none`, no
  secret), whatever method it asks for. A registration that asks for the `client_credentials` grant, omits
  redirect URIs, or sets `require_pkce` to false is refused. A successful registration answers `201` with
  `Cache-Control: no-store`. A registration without `scope` gets all four scopes.
- **Refresh-capable registration.** Register both `authorization_code` and `refresh_token` in `grant_types`
  for persistent access. The authorization request must also include `offline_access`; neither condition
  alone is enough to receive a refresh token.
- **Authorization code with PKCE `S256`.** `plain` and missing challenges are refused.
- **Redirect URIs.** `https:` URIs; `http:` only on loopback hosts (`127.0.0.0/8`, `[::1]`, `localhost`,
  `*.localhost`); and custom schemes such as `myapp://callback`. `javascript:`, `data:` and `vbscript:`
  schemes and URIs with a fragment are refused. The redirect URI at authorization must equal a registered
  one, with one exception from RFC 8252 §7.3: when the registered URI is a loopback IP literal
  (`127.0.0.1`, `[::1]`), the port may differ as long as scheme, host, path and query match. A registered
  `localhost` URI must be used with exactly its registered port.
- **A browser.** The user signs in to Hub, picks the machine and directory, and approves in a browser. The
  authorization request must be a top-level browser navigation; a non-navigation request (for example a
  script `fetch`) gets a JSON answer instead of the redirect to the sign-in page.
- **`iss` in the authorization response (RFC 9207).** Hub adds `iss=<origin>` to the redirect back to the
  client, and advertises it in the metadata. Clients that check it should compare it with the metadata
  `issuer`.
- **Resource indicators (RFC 8707).** At the token endpoint, a code or refresh grant that names no
  `resource` is given the connector's resource. A grant that names one must name exactly one value that
  canonically equals `<origin>/mcp/paseo`: scheme and host case, the default port and one trailing slash are
  ignored, and a query, fragment or credentials never match. Anything else is refused with `invalid_target`.
  The `resource` sent at authorization is not checked there; it is only bound into the linking flow. Every
  access token's audience is the canonical `<origin>/mcp/paseo`.
- **Scopes.** Request at least one connector scope (`paseo:read`, `paseo:run`, `paseo:cancel`), and
  `offline_access` to receive a refresh token, explicitly in `scope` at authorization (least privilege). See
  [Scopes](#scopes).
  - A registration whose `scope` names anything outside those four is refused with `invalid_scope`.
  - An authorization whose `scope` names anything outside the client's registered scopes is redirected
    back to the client with `error=invalid_scope`.
  - An authorization that omits `scope` gets the client's registered scopes (all four if the registration
    also omitted it). The pinned library writes that default into the signed request Hub binds the link
    to, so the consent screen shows, and the user approves, exactly those scopes. Linking is refused at
    machine selection only when they contain no connector scope.
- **Discovery from the `401`.** Read `resource_metadata` from the `WWW-Authenticate` challenge, fetch the
  protected-resource metadata, then the authorization-server metadata. Treat `error="invalid_token"` as
  "link again".
- **Bearer tokens in the `Authorization` header.** Query-string and body tokens are not accepted.

### Tokens

Access tokens are JWTs signed by Hub (EdDSA), with the issuer `<origin>` and the audience `<origin>/mcp/paseo`.
They last one hour. Refresh tokens last 30 days and rotate on every use. An authorization code or refresh
token works only for the client that obtained it: another client presenting it gets `invalid_client`. A
code presented by the wrong client is spent anyway, so the rightful client's exchange then fails with
`invalid_grant`; a refresh token presented by the wrong client is not spent. Revoking a refresh token needs only the owning client's `client_id`; a revocation sent by another client is
answered `200` and does nothing.

A refresh-token request is checked against the connection before the refresh token is rotated: the
connection must be active and not revoked, the user must still be an owner or admin of its organization, the
machine must still be active with `hub.execute`, and the stored scopes must still be within the connection's.
If that check fails the answer is `400` `invalid_grant` and the presented refresh token is left untouched. If
Hub cannot read the grant at all the answer is `503` `temporarily_unavailable`, and the same refresh token
stays usable for a retry. In the bounded case where the grant changes or a database fault occurs after Hub's
pre-check passes but while the OAuth library is issuing tokens, the library has already rotated the refresh
token, the client gets a server error, and the user may need to re-link.

## Scopes

| Scope            | Allows                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `paseo:read`     | `get_connection`, `list_runtimes`, `list_agents`, `get_agent`                                 |
| `paseo:run`      | `start_agent`, `send_agent_message`: run agents that can change files in the linked directory |
| `paseo:cancel`   | `cancel_agent`: interrupt an agent's current turn                                             |
| `offline_access` | A refresh token, so the client can stay linked past one hour                                  |

The connection stores the connector scopes the client requested and the user approved. A token can never
carry more than those, and refreshing a token never widens them. A tool called without its scope fails with
`insufficient_scope`. It never returns an empty success.

## Connecting a client

The same steps apply to every client. Client-specific notes are under
[Client-specific examples](#client-specific-examples).

1. Enable the connector as above and confirm that
   `<origin>/.well-known/oauth-protected-resource/mcp/paseo` returns JSON.
2. Add `<origin>/mcp/paseo` to the client as a remote MCP server with OAuth.
3. The client calls the endpoint, gets the `401` challenge, reads both metadata documents and registers
   itself. For persistent access, its registration allows `authorization_code` and `refresh_token`, and its
   authorization requests `offline_access` alongside the connector permissions it needs.
4. The client opens Hub's authorization page in a browser. A signed-out user sees Hub's normal sign-in form
   at `/oauth/connect`.
5. The user picks an enrolled machine from an organization where they are an owner or admin, then types an
   absolute working directory, such as `/srv/work/project`. Hub never falls back to the daemon's own
   working directory.
6. The consent page shows the app name the client registered (labelled as provided by the app itself, not
   verified by Hub; "No name given" when it sent none), where it will return to, the machine, the directory and the scopes. Approving activates
   the connection. Denying discards it; the client must start again.
7. The client exchanges the code and calls the tools.

For full agent access that survives access-token expiry, the OAuth scope string is:

```text
paseo:read paseo:run paseo:cancel offline_access
```

The consent page must say access lasts until revoked, not only until the current access token expires.
After code exchange, the client must retain the refresh token, use the newest token returned on each
refresh, and continue sending the refreshed access token to MCP. `get_connection` reports the three
connector permissions, not `offline_access`, which is an OAuth renewal scope rather than a tool permission.

A client reporting `oauth_refresh_token_missing` cannot renew access: its original authorization may
have omitted `offline_access`, its registration may have omitted the refresh grant, or it may not have
retained the returned refresh token. Correct that setup and start a fresh authorization. Refresh tokens
cannot be added retroactively to an existing access-only grant. If the client caches discovery or its
registration, recreate the app connection so it registers and authorizes with persistent access.

Every MCP request checks the connection again. It must still be active and not revoked, the user must still
be an owner or admin of the organization, and the machine must still be active with `hub.execute`.

Each approval creates a separate connection, even for the same machine and directory, and each connection
only sees its own agents. Switching to another client means linking that client; the old connection keeps
its agents until revoked.

## Revoking

Revoke a connection at `<origin>/oauth/connections` (**Connected apps**). Each row names the app by the name
its client registered (again unverified; "No name given" when it sent none), with the machine, the
directory, the permissions, when it connected and whether it is active or revoked. Removing the user from the organization, or demoting them to `member`, has the
same effect for as long as they stay removed or demoted.

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

`start_agent` takes the `provider`, and optionally the `model` and `mode`, from `list_runtimes`. Hub checks
them against the machine's live catalog and refuses anything else with `runtime_unavailable`.

The four read tools are annotated read-only. `start_agent` and `send_agent_message` are annotated as
destructive and open-world, because the agent they start can change files. `cancel_agent` is a write, but it
deletes nothing. These annotations are hints: whether a client asks the user to confirm a call depends on
that client and its settings, and the server enforces scopes regardless.

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

## Known limitations

- **No Client ID Metadata Documents.** The pinned OAuth library has no CIMD support and the metadata does not
  advertise `client_id_metadata_document_supported`. Clients must use dynamic registration.
- **No static API key.** Every token comes from the OAuth flow above. A client that only accepts a
  caller-supplied bearer token and runs no OAuth flow itself (the Claude API MCP connector, xAI API Remote
  MCP Tools) needs its operator to obtain a connector token with some other OAuth-capable client and keep
  refreshing it; access tokens last one hour and are bound to one connection.
- **`localhost` redirects keep their port.** Only loopback IP literals may change port between registration
  and authorization. A client that registers `http://localhost/...` and then listens on a different port is
  refused with `invalid_redirect`; the same client using `127.0.0.1` is not.
- **One discovery location.** Protected-resource metadata is served only at the path-suffixed URL, and the
  `401` challenge points to it. A client that only probes the root `/.well-known/oauth-protected-resource`
  and ignores the challenge finds nothing.
- **No event stream.** POST with JSON responses only. GET and DELETE answer `405`, which the MCP Streamable
  HTTP specification allows. The connector sends no server-initiated notifications; clients poll with
  `get_agent`.
- **Metadata understates or overstates some auth methods.** `revocation_endpoint_auth_methods_supported`
  lists only `client_secret_basic` and `client_secret_post`, although a public client can revoke with its
  `client_id` alone. `token_endpoint_auth_methods_supported` lists `none` alongside the two secret methods,
  although every dynamically registered client is public. Both lists are fixed by the pinned library.
- **Registration growth.** Registration is unauthenticated, and Hub never deletes registered clients. Some
  clients register a new client on every fresh connection.
- **Registration rate limiting is weak (operator hardening).** The pinned library's only limit on
  registration is 5 requests per 60 seconds, and it applies only when `NODE_ENV=production`: Hub sets no
  rate-limit option of its own, and the Dockerfile, `compose.yml` and `npm start` do not set
  `NODE_ENV=production` (`fly.toml` does). The counters live in process memory, so a restart clears them.
  They are keyed on `x-forwarded-for`, or on the header named by `PASEO_HUB_TRUSTED_CLIENT_IP_HEADER` when
  set, so unless a trusted proxy overwrites that header a caller can vary it to get fresh buckets. With no
  client-IP header at all, every caller shares one bucket: anyone can exhaust it and block new links for
  everyone, and a client that registers on every fresh connection spends it quickly. Put Hub behind a proxy
  that sets a trustworthy client-IP header, and name that header in `PASEO_HUB_TRUSTED_CLIENT_IP_HEADER`.
- **No automatic reconciliation** of a launch interrupted by a Hub restart (see [Request keys](#request-keys)).

## Evidence

Three kinds of evidence, which say different things:

1. **Generic MCP and OAuth interoperability: deterministic tests.**
   `src/paseo-connector/interoperability.integration.test.ts` (embedded PGlite and PostgreSQL) runs Hub's real
   auth handler, MCP route and well-known routes on a loopback origin and links two independently registered
   clients, one with an HTTPS redirect and one with a loopback redirect, each through the full challenge,
   discovery, registration, browser sign-in, machine selection, consent, PKCE exchange and official MCP SDK
   client. It shows that the two clients see the same tools and runtime catalog, that each one's provider
   choice is honoured independently of the client, that their connections and agents are isolated from
   each other (one user and two users), that codes, refresh tokens and revocations are bound to their own
   client, that `127.0.0.1` redirects may change port while `localhost` may not, that Connected apps
   names each client, and that an authorization without `scope` links with the client's registered scopes
   shown at consent (or is refused at machine selection when they hold no connector scope). `src/paseo-connector/oauth.integration.test.ts` covers the resource rules.
2. **Real local protocol and lifecycle: the connector E2E.** A real Hub production build, a source-built Paseo
   daemon, a real Claude Code coding-agent runtime on that daemon, Hub's screens in Chromium, and the
   official MCP TypeScript SDK as the client. See [Local verification](#local-verification). The Claude
   Code there is the daemon-side coding agent that `start_agent` launched, not a hosted MCP client calling
   the connector.
3. **Actual ChatGPT and OpenAI Dots clients: user-reported execution.** The operator supplied an MCP
   transcript from a ChatGPT agent on a MacBook using the public HTTPS test deployment at commit
   `df5fcd9`, followed by a Dotty-specific probe. See [ChatGPT client smoke](#chatgpt-client-smoke) and
   [OpenAI Dots probe](#openai-dots-probe). These reports do not prove other clients or every lifecycle
   behavior.

### ChatGPT client smoke

On 2026-10-03, the operator reported the following results from the installed ChatGPT connector. These
are user-supplied execution evidence, not a separately rerun controller test. No enrollment, permission,
connection or file changes were reported during the smoke; revocation was not run and the connection
remained usable.

| Check                   | Reported result      | Evidence and boundary                                                                                                                                                                                                                                           |
| ----------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection and runtimes | Partial verification | `lightning` online, selected directory and read/run/cancel scopes matched, Claude/Haiku 4.5 ready, initial agent list empty. Daemon-ID matching was not verifiable: `get_connection` returns only machine name and online state, not the daemon ID.             |
| Launch and result       | Pass                 | Real Claude/Haiku 4.5 agent in plan mode used `Read` on `probe.txt`, returned the exact probe line and finished idle.                                                                                                                                           |
| Launch idempotency      | Pass                 | Identical request key and arguments returned the same operation and agent; the connection still listed one agent.                                                                                                                                               |
| Follow-up               | Pass                 | The same agent returned exactly `FOLLOWUP_OK`; cursor-based retrieval returned the new timeline entries.                                                                                                                                                        |
| Cancellation            | Pass in follow-up    | A running, partially streamed count was observed at 23. `cancel_agent` returned `cancelRequested: true`; the agent became idle at 380 of 3000 and remained accessible. After about 3 seconds, cursor-based retrieval returned no entries and `hasNewer: false`. |
| Ownership isolation     | Pass                 | An agent created directly on the daemon was absent from `list_agents`; direct `get_agent` returned `not_found` without disclosing a timeline.                                                                                                                   |
| Revocation              | Not run              | The connection was left usable.                                                                                                                                                                                                                                 |

Reported connection ID: `b028cf49-4c38-4d42-953a-a979a1a749ea`; smoke agent:
`34ac2559-028f-4d09-8681-a723efdd9df0`; launch operation:
`37620f06-7678-47d8-9b01-ae678088341e`. The exact file-read result was
`PASEO_CONNECTOR_LIVE_PROBE=machine-read-confirmed`.

The initial sleep-based cancellation attempt was not verified: the runtime blocked standalone
`sleep 30` and the turn finished before observation. In a subsequent user-reported test, the task was
to count from 1 to 3000, one number per line, without tools or file changes. That test directly exercised
`cancel_agent` while the turn was running and passed the interruption, session-accessibility and
no-further-output checks above.

Reported cancellation agent: `4a49b22b-f919-4576-90ef-4ab54d8c85af`; request key:
`d7e9f3e7-73c4-4a60-a6c8-219f4f940a33`; operation:
`db082bf6-54e5-41df-8379-2cb463e4d767`. The runtime was `claude-haiku-4-5` in `plan` mode. The final cursor
was epoch `79396709-aff1-4582-a348-dc289e0bfc88`, sequence 66; the later read after that cursor returned
`entries: []` and `hasNewer: false`.

These ChatGPT reports do not verify refresh-token behavior or revocation through the client. The
separate local E2E evidence below covers server-side revocation; it must not be substituted for the
missing client checks.

### OpenAI Dots probe

Following the Dotty-specific test request, the operator reported successful execution through
**Paseo Agent Connector — Live Test**. This is user-reported evidence from the operator's OpenAI Dots
agent ("Dotty"), not a separately rerun controller test.

The reported calls were:

1. `get_connection`: machine `lightning` online, working directory
   `/home/joe/.local/share/paseo-agent-connector-live/workspace`.
2. `list_runtimes`: Claude ready and enabled.
3. `start_agent`: provider `claude`, model `claude-haiku-4-5`, mode `plan`, title `Read live probe`,
   request key `7be6286d-4bc2-4e15-a713-5ad26b8a749f`; task to read `probe.txt` only, return its exact probe
   line, and make no file or settings changes.
4. `get_agent` twice for agent `c9a50aa3-de32-428d-9bf7-2d78d4e1af1b` with limit 20: first `running`,
   then `idle` with `attentionReason: finished`.

The completed timeline contained one `Read` tool call and no file-write calls. The exact result was
`PASEO_CONNECTOR_LIVE_PROBE=machine-read-confirmed`.

This demonstrates Dotty's access to the installed remote plugin and the real launch/status/result path.
It does not independently verify Dotty-specific follow-up, idempotency, cancellation, isolation,
revocation or refresh behavior. The broader ChatGPT smoke above is distinct evidence, not a substitute
for those unexercised Dotty-specific checks.

### Stable endpoint cutover (2026-10-05)

With operator approval, the existing live-test Hub was migrated from its temporary Cloudflare quick
tunnel to `https://paseo.zgenergy.app`. The MCP URL is `https://paseo.zgenergy.app/mcp/paseo`.
The named Cloudflare Tunnel forwards to the same loopback-only Hub and preserves its embedded database.
The old quick tunnel was stopped after verification. The Hub and named tunnel are persistent processes
on the original machine; this is not a claim of reboot recovery or a separate production hosting service.

The isolated daemon's previous Hub relationship was replaced with enrollment at the stable origin.
Its new daemon ID is `7f51dedf-2f1e-4a78-9c64-86af9a0b88b0`, displayed as `lightning-7f51dedf`.
CLI status reported it connected with `hub.execute` and no error. The normal user daemon was not migrated.

Controller-observed smoke evidence through the public HTTPS hostname:

- Protected-resource and authorization-server discovery advertise the stable resource and issuer;
  JWKS is available and unauthenticated MCP requests receive the correct `401` challenge.
- A fresh dynamically registered public client completed browser consent and authorization-code exchange
  with PKCE. Authenticated MCP initialization, `get_connection` and `list_runtimes` succeeded.
- The read-only smoke connection reported the migrated machine online, the same isolated test directory,
  and Claude ready. It was revoked after the check; its bearer token then received `401 invalid_token`.
  No agents were launched and no project files were changed by this cutover smoke.

The issuer/resource change requires ChatGPT and Dotty to link again at the new URL. The earlier
user-reported lifecycle tests remain evidence for the previous endpoint, not proof of a hosted-client
relink at this one. A new connection does not inherit agents owned by an earlier connection.
Hosted-client relinking and refresh remain unverified. PR integration, CI and dependency-security
release gates are unchanged.

### Persistent-access repair (2026-10-05)

The operator reported `oauth_refresh_token_missing` after a previously working Dotty connection.
The protected-resource metadata advertised only the three tool scopes, although the authorization
server supported `offline_access`. A discovery-driven client could therefore authorize successfully
without receiving a refresh token. Resource discovery now advertises all four supported OAuth scopes;
authorization still requires explicit consent and does not silently add persistent access.

The regression follows real HTTP discovery, registers and authorizes with those discovered scopes,
rotates refresh tokens twice, and uses renewed MCP access with the original connection, directory and
tool permissions. Before the fix it failed on both embedded and PostgreSQL because `refresh_token`
was absent; afterward all 234 connector tests passed. The full suite passed with 1,611 tests and 29
skipped, plus 13 script tests. Typecheck, lint, formatting, schema checks and the production build passed.
Independent security and interoperability reviews found no proven blocker.

After deploying to the stable endpoint, a fresh public OAuth client requested the discovered
`paseo:read` and `offline_access` scopes. Browser consent showed **Until you revoke it**. Code exchange
issued a refresh token with the unchanged 3,600-second access lifetime. Two actual refresh exchanges
rotated refresh tokens, and the renewed bearer successfully read the online machine connection bound
to `/home/joe/code/zge-workspace` with read-only tool permission. The disposable verification connection
was then revoked: its refresh returned `400 invalid_grant` and its bearer returned `401`. The browser
and loopback callback listener were closed; no coding agents were launched by this check.

This proves the deployed server's discovery-to-refresh path, not ChatGPT/Dotty's token retention or
overnight automatic renewal. Existing access-only connections need a fresh authorization; recreate
the client connection if it caches discovery or a registration lacking persistent access. The user's
existing connection was not revoked. Actual hosted-client refresh remains unverified.

## Client-specific examples

These vendor notes were read on 2026-10-01 and describe how documented behavior meets Hub's contract.
The later user-reported ChatGPT and Dotty runs are recorded above; other clients remain unverified.
Linking alone is not proof that a client can call the tools.

### ChatGPT and OpenAI Dots

Status: user-reported ChatGPT client tests passed the core tool path and active-turn cancellation.
A subsequent user-reported Dotty probe passed discovery, runtime selection, real launch and result
retrieval. Revocation and refresh remain unverified through either client.

- **Where.** The observed UI on 2026-10-03 was Plugins, Add, Create custom MCP server, with a Server URL,
  OAuth authentication, advanced OAuth settings and a custom-server trust acknowledgement. Set Server
  URL to `<origin>/mcp/paseo` and choose OAuth.
  OpenAI's docs place developer mode under Settings, Security and login, and say its "availability can
  depend on account and workspace policy"
  ([connect](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt)).
- **Plans.** "Full MCP is only available to Business and Enterprise/Edu users, currently. Pro users can
  connect MCPs with read/fetch permissions in developer mode." On Business, only admins and owners can enable
  developer mode and deploy an app. Apps are web only. "Agent mode will not use custom apps."
  ([help](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt))
- **Registration.** ChatGPT prefers CIMD and "can register dynamically when the plugin builder chooses DCR or
  CIMD is not available"; it runs DCR once per connection
  ([auth](https://developers.openai.com/apps-sdk/build/auth)). Hub has no CIMD, so DCR is the path; leave
  client credentials empty. The auth method ChatGPT asks for in its DCR request is not documented; Hub
  registers it as a public client either way.
- **Callback.** With RFC 9207 support advertised (Hub does) and `iss` returned (Hub does), ChatGPT's docs
  give the stable redirect `https://chatgpt.com/connector_platform_oauth_redirect`; otherwise
  `https://chatgpt.com/connector/oauth/{callback_id}`. Both are HTTPS, which Hub accepts.
  ([auth](https://developers.openai.com/apps-sdk/build/auth))
- **Resource and refresh.** ChatGPT sends the protected-resource metadata `resource` on authorization and token
  requests; its behaviour on refresh is not documented. Hub applies its resource when a refresh names none.
  ChatGPT needs `offline_access` in `scopes_supported` to keep access past expiry
  ([help](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)); Hub lists it.
- **Dots.** Dots "can use supported existing ChatGPT app connections"
  ([dots and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps)). Whether a developer-mode
  custom MCP app counts as supported is not documented. Dots availability: Pro (outside the EEA, UK and
  Switzerland), Business Premium, and Enterprise when an administrator enables it
  ([dots](https://learn.chatgpt.com/docs/dots)). Linking the app in ordinary ChatGPT does not show that a
  Dot can use it.

### Claude (claude.ai and Claude Code)

Status: not verified with this server.

- **Where and plans.** claude.ai custom connectors are added by URL on Free, Pro, Max, Team and Enterprise
  plans; Free allows one custom connector; on Team and Enterprise an Owner adds the connector and members
  connect their own accounts ([add](https://claude.com/docs/connectors/custom/add-unlisted)).
- **Registration.** "Claude selects CIMD only when your authorization server metadata advertises both
  `client_id_metadata_document_supported: true` and `none` ... If either is missing, Claude falls back to
  DCR", registers as a public client, and "DCR causes Claude to register a new client on every fresh
  connection" ([auth](https://claude.com/docs/connectors/building/authentication)). Hub does not advertise
  CIMD, so DCR is the documented path. Connected apps may show several Claude-registered entries over time.
- **Callback.** claude.ai web, Desktop, mobile and Cowork use `https://claude.ai/api/mcp/auth_callback`.
  Claude Code uses an RFC 8252 loopback redirect on an ephemeral port, and Claude's docs ask servers to
  accept both `http://localhost/callback` and `http://127.0.0.1/callback` on any port
  ([auth](https://claude.com/docs/connectors/building/authentication)). Hub, through the pinned library,
  allows a different port only for the loopback IP literals `127.0.0.1` and `::1`. A `localhost` callback on
  an ephemeral port other than the registered one is refused with `invalid_redirect`. Which of the two
  forms Claude Code actually sends is not documented, so whether it can link is not verified.
- **Resource.** Claude sends the canonical server URL as `resource` on authorization and token requests
  ([troubleshooting](https://claude.com/docs/connectors/building/troubleshooting)); Hub accepts canonically
  equal values.
- **Scopes.** Without a `scope` in the `401` challenge (Hub sends none), Claude requests the protected-resource
  `scopes_supported` and appends `offline_access` when the authorization-server metadata lists it (Hub
  does) ([auth](https://claude.com/docs/connectors/building/authentication)).
- **Claude API MCP connector.** Runs no OAuth flow: "API consumers are expected to handle the OAuth flow and
  obtain the access token prior to making the API call, and to refresh the token as needed"
  ([MCP connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector)). See
  [Known limitations](#known-limitations).

### Grok (xAI)

Status: not verified with this server.

- **grok.com.** Custom MCP connectors are added at grok.com/connectors (New Connector, Custom, server URL,
  "complete any required authentication"), and the server must be reachable over the public internet. On
  Grok Business and Enterprise a team admin provisions connectors in the cloud console first
  ([connectors](https://docs.x.ai/grok/connectors)). xAI does not document the OAuth mechanics: registration,
  callback, PKCE, `resource` and scopes are all unspecified.
- **xAI API Remote MCP Tools.** Takes an `authorization` token "set in the Authorization header on requests
  to the MCP server" and runs no OAuth flow ([remote MCP](https://docs.x.ai/developers/tools/remote-mcp)). See
  [Known limitations](#known-limitations).
- **Grok Build CLI.** Documents `grok mcp add --transport http <url>` with OAuth "handled automatically"
  ([CLI MCP](https://docs.x.ai/build/features/mcp-servers)). It is a local client, not a hosted one.

## Local verification

The connector lifecycle was exercised end to end on one machine, with no public origin and no hosted client.
This proves the Hub and daemon side only.

Run it with `PASEO_E2E_WORKTREE=<paseo checkout> npm run test:e2e:hub:connector`
(`src/e2e/hub-paseo-connector.e2e.test.ts`). It needs Docker for PostgreSQL, a current `npm run build`, the
`claude` CLI, and Playwright's Chromium. The harness starts its own PostgreSQL container, the built self-hosted
production runtime behind a local reverse proxy (`http://127.0.0.1:<port>`) with
`PASEO_HUB_PASEO_CONNECTOR=enabled`, and a source-built Paseo daemon with its own `PASEO_HOME` and listen port,
enrolled with `hub.execute`. It never touches another daemon.

The test operator signs up through Hub's own sign-up endpoint, but their membership in the harness's seeded
organization (the one the daemon is enrolled in) is inserted directly into the database, as `admin`. Hub's
invitation flow is not part of this run.

The results below are from commit `e501909`, before the provider-neutral revision.

| Item                   | Tested                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hub                    | 0.10.0, commit `e501909`, PostgreSQL 17                                                                                                                |
| Paseo daemon           | 0.10.0, source commit `2c9b09e4a9`                                                                                                                     |
| Coding-agent runtime   | `claude` (Claude Code 2.1.285), model `claude-haiku-4-5` chosen from `list_runtimes`                                                                   |
| MCP client & transport | `@modelcontextprotocol/sdk` 1.30.0 client, MCP Streamable HTTP, stateless JSON responses                                                               |
| Account linking        | Dynamic registration, Hub sign-in on `/oauth/connect`, machine and directory selection, consent in Chromium, PKCE `S256` code exchange with `resource` |

Every step passed (9 of 9, about 55 s on 2026-09-30):

1. Both well-known documents name the origin and resource. A request without a token gets `401` with the
   `resource_metadata` challenge, and an invalid token gets the same challenge with `error="invalid_token"`.
   `tools/list` returns exactly the seven tools. `get_connection` shows the selected machine online and the
   selected directory; `list_runtimes` shows `claude` ready.
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

Not covered here: a public HTTPS origin, any hosted MCP client, refresh-token exchange, and re-enrolling a
daemon.

### Provider-neutral revision

Local protocol and lifecycle evidence only; it is not evidence that any hosted client works.

- At commit `e3f903a`: `RUN_HUB_CONNECTOR_E2E=1` connector E2E passed 9 of 9 with a neutral dynamically
  registered client ("Example MCP Client", redirect `https://client.example/...`), linked through Hub's real
  screens in Chromium, against a real source-built Paseo 0.10.0 daemon (source commit `2c9b09e`) running a
  real Claude Code coding-agent runtime. The affected suites (`src/paseo-connector`, `src/auth`, the
  typography policy and the route guard) passed: 16 files, 281 tests.
- At commit `7fa6ee9`: `db:check`, `typecheck`, `lint`, `format:check` and `build` were clean, and `npm test`
  passed 186 files and 1,604 tests (29 skipped: the opt-in E2E and real-service suites).
