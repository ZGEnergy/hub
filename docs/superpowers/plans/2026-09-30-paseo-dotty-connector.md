# Self-hosted Paseo Dotty Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a privately connected, OAuth-authenticated Paseo MCP connector that Dotty can use from anywhere to manage only connector-created agents on an enrolled machine.

**Architecture:** Extend self-hosted `getpaseo/hub`, reusing its existing login, database, daemon enrollment, and outbound session connection. Add flow-bound account linking, durable connection/agent ownership, a narrow agent service, and a remote MCP endpoint. Neither a CLI wrapper nor the daemon's local MCP endpoint is the connector.

**Tech Stack:** Hub 0.10.0 baseline; TypeScript, TanStack Start, Better Auth 1.6.23, `@better-auth/oauth-provider` 1.6.23, Drizzle 0.45.2, PostgreSQL/PGlite, Zod 4, existing MCP SDK 1.30.x, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-30-paseo-dotty-connector-design.md` in dev-tools, approved in chat and committed as `1a461e4f`. Read the specification and this plan together. Product files below are relative to the **Hub checkout**, not this dev-tools checkout.

## Global Constraints

- Extend self-hosted Paseo Hub, rather than depend on changes to hosted Hub.
- Restrict the connector to agents created through that connector. Existing unrelated Paseo sessions are inaccessible.
- Reuse the daemon's existing outbound Hub relationship. Do not enroll a parallel Dots Hub.
- Use an OAuth-authenticated remote MCP interface, not a publicly exposed daemon or CLI wrapper.
- One OAuth connection is bound to one enrolled daemon and one operator-selected working directory.
- Every resource call verifies current connection authorization and durable ownership; labels are not authority.
- Creation and prompting are separate; persist ownership before sending a task.
- No archive, kill, permission-approval, terminal, browser, schedule, daemon-admin, or unrelated-session tools.
- Offline machines return explicit errors; no work queue or silent automatic retries.
- A real Dotty tool invocation is an acceptance gate. Ordinary ChatGPT setup is not proof.
- No passwords, OAuth tokens, daemon credentials, or private conversation contents in docs, tool results, or logs.

## Source Baseline and Execution Rules

Source mapping used `getpaseo/hub` commit `28f6c78833065fd282f9064f92a9aa61875dd359` (Hub 0.10.0). Acquire an isolated Hub worktree before implementation, using the using-git-worktrees skill. Do not implement Hub inside this dev-tools repository or edit the user's existing Paseo checkout. If the execution baseline differs, resolve changed interfaces before editing rather than copying stale line numbers.

The Hub checkout has one schema file, `src/db/schema.ts`. A GitHub read truncated its middle; the complete source includes `daemons`, `agentSessions`, users, and organizations. New migrations belong in `drizzle/`, not legacy `src/db/migrations/`. Generate them using `npm run db:generate`; do not invent a migration index or hand-edit the journal.

Task owners write the named regression tests and implementation without running build/lint/tests/formatters mid-flight. The integration owner runs the affected tests and repository checks once after integration, then runs the real Hub/daemon/browser scenarios. Expected outcomes below are acceptance criteria, not claims that checks have run.

## File and Responsibility Map

Existing files to extend:

- `package.json` and the existing npm lockfile: pin the OAuth-provider package to `1.6.23`, matching `better-auth` exactly.
- `src/db/schema.ts`, `src/db/types.ts`, `src/db/pg.ts`, `src/db/memory.ts`: connector tables and a nested `Database.connector` store.
- `src/auth/server.ts`: provider configuration, auth-schema map, and narrowly allowed OAuth/JWKS routing. Keep existing organization endpoint restrictions.
- `src/auth/account-app.tsx`: preserve the OAuth continuation when login is necessary; do not create a second sign-in system.
- `src/app.ts`, `src/application-runtime.ts`: inject the connector service and expose its operations alongside existing Hub services.
- `src/daemons/agents/index.ts`: read-only timeline retrieval using its existing request machinery; reuse `create`, `get`, `send`, and fixed `control(..., "interrupt")`.
- `src/daemons/protocol.ts`: extend `AgentConnection` with the new read contract.
- `src/routeTree.gen.ts`: regenerate through TanStack tooling, never hand-edit.

New files, all proposed by this plan:

- `src/paseo-connector/contracts.ts`: shared scopes, records, service inputs/results, and concealed error codes.
- `src/paseo-connector/internal/repository.ts`: SQL-backed ownership and flow store.
- `src/paseo-connector/internal/memory-store.ts`: deterministic store parity, not a production persistence fallback.
- `src/paseo-connector/authorization.ts`: live user/org/connection/daemon authorization and ownership checks.
- `src/paseo-connector/oauth.ts`: OAuth configuration, discovery, token claims, and request-local consent-flow binding.
- `src/paseo-connector/functions.ts`: server functions for select-machine, consent, and connection revocation.
- `src/paseo-connector/service.ts`: launch/message/cancel state transitions and bounded result retrieval.
- `src/paseo-connector/server.ts`: MCP definitions, resource authentication, and response lifecycle.
- `src/paseo-connector/consent.tsx`: machine/directory selection and confirmation UI using Hub's existing account and UI conventions.
- `src/routes/mcp/paseo.ts`: public MCP resource route.
- `src/routes/[.]well-known/oauth-protected-resource/mcp/paseo.ts`: protected-resource discovery.
- `src/routes/[.]well-known/oauth-authorization-server.ts`: authorization-server discovery; escaped literal dot follows TanStack file routing.
- `src/routes/_shell/oauth/connect.tsx`, `src/routes/_shell/oauth/consent.tsx`: authenticated product screens, with the externally visible `/oauth/connect` and `/oauth/consent` paths.
- `src/paseo-connector/ownership.test.ts`, `ownership.integration.test.ts`, `oauth.integration.test.ts`, `service.test.ts`, `server.integration.test.ts`: behavioral regression coverage.
- `src/e2e/hub-paseo-connector.e2e.test.ts`: real Hub/daemon acceptance scenario, guarded like existing real-agent E2E tests.
- `docs/paseo-connector.md`: operator setup, scopes, ownership, offline/cancellation semantics, and the recorded compatibility result.

### Shared Contracts

Define these names in `contracts.ts` before dependent tasks. Existing user/org IDs are text; daemon and connector IDs are UUIDs; daemon agent IDs are strings.

```ts
export const CONNECTOR_SCOPES = ["paseo:read", "paseo:run", "paseo:cancel"] as const;
export type ConnectorScope = (typeof CONNECTOR_SCOPES)[number];
export type Identity = {
  connectionId: string;
  ownerUserId: string;
  organizationId: string;
  daemonId: string;
};
export type ConnectorConnection = Identity & {
  workingDirectory: string;
  scopes: readonly ConnectorScope[];
  createdAt: Date;
  revokedAt: Date | null;
};
export type ConsentFlow = {
  id: string;
  sessionId: string;
  ownerUserId: string;
  authorizationFingerprint: string;
  connectionId: string;
  expiresAt: Date;
  consumedAt: Date | null;
};
export type OperationState = "creating" | "created" | "accepted" | "failed" | "outcome_unknown";
export type ConnectorOperation = Identity & {
  id: string;
  kind: "launch" | "message";
  requestKey: string;
  requestFingerprint: string;
  creationKey: string | null;
  messageId: string;
  agentId: string | null;
  workspaceId: string | null;
  state: OperationState;
  errorCode: string | null;
};
export type OwnedAgent = Identity & {
  agentId: string;
  workspaceId: string;
  launchOperationId: string;
  createdAt: Date;
};
export type TimelineCursor = { epoch: string; seq: number };
export type ConnectorErrorCode =
  | "not_found"
  | "insufficient_scope"
  | "connection_revoked"
  | "machine_offline"
  | "machine_incompatible"
  | "runtime_unavailable"
  | "request_conflict"
  | "create_rejected"
  | "prompt_rejected"
  | "outcome_unknown"
  | "invalid_cursor";

export class ConnectorError extends Error {
  constructor(
    readonly code: ConnectorErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}
```

Expose a `ConnectorStore` interface with these methods (async in both implementations):

```ts
export interface ConnectorStore {
  createConnection(input: ConnectorConnection): Promise<ConnectorConnection>;
  findConnection(ownerUserId: string, id: string): Promise<ConnectorConnection | undefined>;
  revokeConnection(ownerUserId: string, id: string, now: Date): Promise<boolean>;
  createFlow(input: ConsentFlow): Promise<void>;
  findFlow(ownerUserId: string, sessionId: string, id: string): Promise<ConsentFlow | undefined>;
  consumeFlow(ownerUserId: string, sessionId: string, id: string, now: Date): Promise<boolean>;
  beginOperation(input: ConnectorOperation): Promise<ConnectorOperation>;
  findOperation(identity: Identity, id: string): Promise<ConnectorOperation | undefined>;
  bindCreatedAgent(
    identity: Identity,
    operationId: string,
    agentId: string,
    workspaceId: string,
    now: Date,
  ): Promise<OwnedAgent>;
  setOperationState(
    identity: Identity,
    operationId: string,
    state: OperationState,
    errorCode: string | null,
  ): Promise<void>;
  findOwnedAgent(identity: Identity, agentId: string): Promise<OwnedAgent | undefined>;
  listOwnedAgents(identity: Identity): Promise<readonly OwnedAgent[]>;
}
```

`beginOperation` atomically returns the existing same-fingerprint operation for a repeated request key, or throws `request_conflict` for different arguments. `bindCreatedAgent` is a transaction updating the operation and inserting the authoritative owned-agent row. A scoped lookup compares **all** identity columns. Never query ownership by agent ID alone.

## Task 1: Durable Connection, Consent Flow, and Agent Ownership

**Files:** contracts and repository/memory-store files above; modify the four DB files; create ownership tests; generate Drizzle migration files.

**Consumes:** existing `Database`, `PgDatabase`, `MemoryDatabase`, `users`, `organizations`, and `daemons`.

**Produces:** `Database.connector: ConnectorStore`, backed by durable SQL in production, plus the shared types above.

- [ ] Add four tables to the existing schema: `connector_connections`, `connector_consent_flows`, `connector_operations`, and `connector_agents`. Use text user/org FKs, UUID connection/daemon/operation keys, explicit scope arrays, timestamps, and indexed identity columns. Use `(daemon_id, organization_id)` against the existing daemon composite key. User/org/connection deletion cascades authorization records; it never sends daemon cancellation.
- [ ] Give operations a unique `(connection_id, request_key)` constraint and agents a unique `(daemon_id, agent_id)` binding. Prevent a second owner claiming a daemon agent; include composite FKs/transactional checks for matching connection identity. Store a canonical request fingerprint rather than accepting a reused key for different work.
- [ ] Implement the nested store using the existing database pool and transactions. `PgDatabase` creates the repository; `MemoryDatabase` implements the same interface. Do not open another database or reuse provider connections, API-key scopes, or `agent_sessions` as ownership.
- [ ] Write tests that create two owners/connections and assert foreign and missing agents are indistinguishable:

```ts
const owned = await store.bindCreatedAgent(alice, launch.id, "agent-a", "workspace-a", now);
expect(await store.findOwnedAgent(alice, owned.agentId)).toEqual(owned);
expect(await store.findOwnedAgent(bob, owned.agentId)).toBeUndefined();
expect(await store.findOwnedAgent(bob, "missing-agent")).toBeUndefined();
expect(await store.listOwnedAgents(bob)).toEqual([]);
```

Also test same-key/different-task conflict, atomic bind failure, revocation, expired/consumed flow rejection, and scope-column mismatches. Seed an unrelated Hub session and prove it cannot become connector ownership.

- [ ] Add a PGlite disk restart test using `src/db/runtime/embedded-persistence.integration.test.ts` as the fixture: create runtime in a temporary directory, migrate, create user/org/daemon plus connection/operation/ownership, close, reopen and migrate, then prove the same scoped row remains. In-memory object recreation is not restart proof. Use real membership rows for integration tests; current MemoryDatabase membership checking is not a valid authentication fixture.
- [ ] Generate with `npm run db:generate` and preserve all generated SQL, snapshot, and journal changes. The baseline's latest migration is `0048_execution_authority`; use the generated successor rather than guessing its filename.

**Integration-owner verification:** `npx vitest run src/paseo-connector/ownership.test.ts src/paseo-connector/ownership.integration.test.ts` and `npm run db:check`. Expected: isolation/restart tests pass and generation/check is stable. Do not repair unrelated historical migration artifacts opportunistically.

**Commit scope:** only the connector persistence files and generated migrations; message `feat: persist scoped Paseo connector ownership`.

## Task 2: Bounded Results on the Existing Daemon Session Adapter

**Files:** modify `src/daemons/agents/index.ts`, `src/daemons/protocol.ts`; extend `src/daemons/agents/index.test.ts`.

**Consumes:** existing `DaemonAgents.request`, `SnapshotSchema`, `AgentConnection`, and `ActiveDaemonRegistry.connection()`.

**Produces:**

```ts
export type AgentTimelinePage = {
  agent: AgentSnapshot | null;
  epoch: string;
  reset: boolean;
  staleCursor: boolean;
  gap: boolean;
  startCursor: TimelineCursor | null;
  endCursor: TimelineCursor | null;
  hasOlder: boolean;
  hasNewer: boolean;
  entries: readonly Record<string, unknown>[];
};
// Add to AgentConnection and DaemonAgents:
timeline(agentId: string, input: {
  cursor?: TimelineCursor;
  direction: "tail" | "before" | "after";
  limit: number;
}): Promise<AgentTimelinePage>;
```

- [ ] Add a Zod response schema matching the ordinary timeline payload, including error, epoch/reset/stale-cursor/gap and paging fields. Preserve each entry's provider, item, timestamp, sequence ranges, and turn identity. Use existing shared schemas where available; do not silently drop the final assistant text.
- [ ] Implement via the existing request method:

```ts
const result = await this.request({
  type: "fetch_agent_timeline_request",
  agentId,
  direction: input.direction,
  cursor: input.cursor,
  limit: input.limit,
  projection: "canonical",
});
const page = TimelineResponseSchema.parse(result);
if (page.error !== null) throw new DaemonAgentError(page.error);
return page;
```

`TimelineResponseSchema` is the new schema defined in this task, not an undeclared external helper. Keep existing `hubAgentRpc`/`agentRequestReceipts` feature checks. Do not add `wait_for_finish_request`, which is outside `hub.execute`.

- [ ] Add protocol-driven behavior tests for a returned final assistant answer, a cursor from a previous epoch (`staleCursor`/`reset` preserved), missing agent, rejected request, and lost acknowledgement. Assertions cover the interpreted results/errors, not incidental JSON copies or method forwarding.
- [ ] Use `getProviderSnapshot({cwd})` already on `DaemonConnection` for runtime discovery. Do not add another RPC for it. The returned `entries` include provider availability, modes, and models.

**Integration-owner verification:** affected adapter tests plus the real timeline retrieval in Task 6.

**Commit:** `feat: read bounded agent timelines over Hub sessions`.

## Task 3: OAuth Account Linking and Flow-Bound Consent

**Files:** add OAuth/functions/consent files and file routes; modify auth/server, account-app, schema map and application runtime; add `oauth.integration.test.ts`; add the pinned dependency and generated migration models.

**Consumes:** `Database.connector`, existing user login, tenant access, `findDaemonForOrganization`, and Hub's configured public origin.

**Produces:** `createConnectorOAuth`, signed JWTs carrying an immutable connection reference, `authorizeConnectorRequest`, authorization/resource discovery, and selected-machine consent/revocation UI.

- [ ] Add `@better-auth/oauth-provider@1.6.23` exactly. Do not upgrade all of Better Auth or claim CIMD/private-key-JWT support: those are not in this pin. Use supported public-client dynamic registration with PKCE, or a predefined ChatGPT client if the actual account setup requires it.
- [ ] Inspect the **installed pinned plugin schema** and add its five models (`oauthClient`, `oauthRefreshToken`, `oauthAccessToken`, `oauthConsent`, `jwks`) to `src/db/schema.ts` and the existing Drizzle auth-schema map, mapping fields without inventing storage types. A booted client/consent/token round-trip on PGlite and PostgreSQL is the schema contract check; generate migrations through the existing tooling.
- [ ] Derive exactly one resource and issuer from configured origin. Use `resource = new URL("/mcp/paseo", publicOrigin).href` and `issuer = new URL(publicOrigin).origin`, with HTTPS required outside loopback. Configure the JWT plugin with this explicit issuer. Configure OAuth along these lines:

```ts
jwt({ jwt: { issuer } });
oauthProvider({
  loginPage: "/",
  consentPage: "/oauth/consent",
  scopes: [...CONNECTOR_SCOPES, "offline_access"],
  grantTypes: ["authorization_code", "refresh_token"],
  validAudiences: [resource],
  allowDynamicClientRegistration: true,
  allowUnauthenticatedClientRegistration: true,
  postLogin: {
    page: "/oauth/connect",
    shouldRedirect: ({ session }) => needsConnectorSelection(session.id),
    consentReferenceId: ({ user, session }) => currentConsentConnection(user.id, session.id),
  },
  customAccessTokenClaims: async ({ user, referenceId, resource: requested, scopes }) => {
    if (!user || !referenceId || requested !== resource) throw new Error("invalid_connector_grant");
    await assertGrantCurrent(user.id, referenceId, scopes);
    return { [connectionClaim]: referenceId };
  },
});
```

Set `connectionClaim` to `issuer + "/claims/paseo-connection"`. Define these helpers in this task: `needsConnectorSelection(sessionId: string): Promise<boolean>`, `currentConsentConnection(userId: string, sessionId: string): Promise<string>`, and `assertGrantCurrent(userId: string, connectionId: string, requestedScopes: readonly string[]): Promise<void>`. The grant check permits `offline_access` only as an OAuth lifecycle scope; all action scopes must be a subset of the connection's stored connector scopes, and no other scope is accepted.

- [ ] Implement those helpers using a request-local `AsyncLocalStorage<ConsentFlow>` context, **not** an active-machine field on the user/session. `withConsentFlow<T>(flow, action: () => Promise<T>): Promise<T>` wraps the server's continue/consent calls. The callback fails closed without a matching flow/session/owner. Initial authorization has no selected flow and redirects to selection.
- [ ] The selection form receives the library's signed `oauth_query`. Bind the flow to a fingerprint of client ID, redirect URI, state, PKCE challenge, requested scopes, and resource from that authorization. Preserve the query unchanged when calling the library, which verifies its signature. Before continue/consent, require the authenticated session, matching fingerprint, unexpired flow, membership-visible active daemon, and explicit absolute directory. A changed or tampered authorization cannot borrow another flow. A second browser tab cannot replace the first tab's selected machine.
- [ ] Continue through the library with `postLogin: true`; consent accepts only requested/permitted scopes. Use the library's server API/handler with the signed query, not a fabricated callback URL. Consume a flow once consent finishes successfully; re-authorizing creates a new flow/connection, while refresh retains the existing connection reference. Preserve OAuth continuation through Hub's existing sign-in screen.
- [ ] Extend the auth allowlist narrowly for `/api/auth/oauth2/*` and `/api/auth/jwks`, enforcing existing cookie-origin/CSRF protection on browser continue/consent. Those consent paths require the flow-aware product wrapper, not arbitrary cookie-authorized machine selection. Keep `/api/auth/token` and restricted organization routes closed. Token/register/revoke calls must work for OAuth clients without being mistaken for cookie-authenticated UI mutations.
- [ ] Use `oauthProviderAuthServerMetadata(auth)` for authorization-server discovery. Serve protected resource metadata at `/.well-known/oauth-protected-resource/mcp/paseo`, with the exact resource and issuer. On unauthenticated MCP access, return 401 with `WWW-Authenticate: Bearer resource_metadata="<that HTTPS URL>"`.
- [ ] Verify tokens using the pinned package's resource verification support with explicit issuer, audience, expiration and signature validation. Read the namespaced connection claim, then call `authorizeConnectorRequest`: reload current connection, check current membership, active bound daemon, scope subset, and revocation. Never accept API keys, CLI credentials, enrollment tokens, missing audience, client-credentials grants, or another resource's token.
- [ ] Add behavioral OAuth tests for missing/plain PKCE, invalid resource, disabled grant, consent without a selection, changed signed query, two simultaneous selection flows, refresh scope widening, same-reference refresh, connection revocation, removed membership, and daemon re-enrollment. Keep existing auth restriction tests passing. Do not claim endpoint availability from configuration object inspection.

**Integration-owner verification:** auth and connector OAuth integration tests, then a real authorization-code/PKCE round-trip against the booted app. Capture metadata issuer, redirect `iss`, JWT audience/reference, and refresh reference without printing tokens. If the installed library differs from the documented callback/schema contract, resolve that discrepancy here before registering an app.

**Commit:** `feat: authorize scoped Paseo connector connections with OAuth`.

## Task 4: Owned-Agent Service and Launch State Transitions

**Files:** contracts/authorization/service; add `service.test.ts`; wire service construction in `src/app.ts` and `src/application-runtime.ts`.

**Consumes:** `ConnectorStore`, current authorized identity, `ActiveDaemonRegistry.connection`, `AgentConnection`, and provider snapshot.

**Produces:** `createConnectorService({database, connectionForDaemon, now})` with the seven methods in Task 5. `connectionForDaemon` uses the existing app resolver, including its test injection; do not create another WebSocket client.

- [ ] Implement `requireOwnedAgent(identity, agentId)` as a full scoped ownership lookup before any daemon request. Resolve current authorization for **every** call, including reads. Missing and foreign IDs both become `not_found`. `list_agents` queries ownership only, never daemon-wide lists.
- [ ] Validate launch runtime against the live provider catalog for the bound directory: provider ready/enabled, selectable model, valid mode. Do not accept env, additional MCP servers, permission overrides, arbitrary cwd, or raw daemon messages from MCP arguments. Agent options use the stored cwd, `env: {}`, and `toolPolicy: {preapproved: []}`; preserve normal provider approval behavior.
- [ ] Implement the state transition in this exact order:

```ts
const operation = await store.beginOperation(launchOperation);
if (operation.state !== "creating") return resultForExistingOperation(operation);
const created = await daemon.agents.create(operation.creationKey!, options);
await store.bindCreatedAgent(identity, operation.id, created.id, created.workspaceId, now());
await daemon.agents.send(created.id, operation.messageId, input.task);
await store.setOperationState(identity, operation.id, "accepted", null);
return { operationId: operation.id, agentId: created.id, accepted: true };
```

Define `resultForExistingOperation(operation)` in `service.ts`: accepted returns the same IDs; failed/unknown return their recorded disposition; a still-creating operation reports pending without sending another create/prompt. Add per-operation exclusion using the existing database/lock conventions so concurrent same-key calls cannot both execute this sequence. Bind commits before `send`; rejection/persistence failure never falls through to `send`.

- [ ] Classify known create rejection as `failed/create_rejected`; known prompt rejection retains `created/prompt_rejected` and the agent identity. `DaemonResponseLostError` or explicit unknown-outcome response becomes `outcome_unknown`. Do not catch every error as a retryable failure. No automatic new request key, message ID, prompt retry, or replacement launch.
- [ ] Persist follow-up operations and their message IDs using the same request-key/fingerprint rule; a replay cannot send twice. Cancel uses only `daemon.agents.control(owned.agentId, owned.workspaceId, "interrupt")`; the caller cannot choose archive. Return the daemon's acceptance, then let `get_agent` establish the observed state.
- [ ] `get_agent` accepts either an owned agent ID or a scoped operation ID. An unresolved launch returns its stored disposition without inventing an agent ID. An owned agent fetches snapshot plus bounded timeline. Preserve cursor reset/gap signals and actual status; idle alone is not proof of successful completion.
- [ ] When no live permitted connection exists, return `machine_offline` without creating an operation that claims daemon acceptance. `list_agents` may return durable owned identities with `liveStateAvailable: false`; do not present cached status as current. Revocation prevents new service calls but does not cancel already-running work.
- [ ] Use deterministic test doubles only for uncertain state transitions and DB failure boundaries. Include concrete failure-before-send tests:

```ts
await expect(service.startAgent(identity, request)).rejects.toMatchObject({
  code: "create_rejected",
});
expect(sendTask).not.toHaveBeenCalled();
expect(await store.listOwnedAgents(identity)).toEqual([]);
```

The fixture's `create` rejects a real daemon rejection, not a bare not-throw mock echo. Also test binding persistence failure, accepted creation followed by rejected/lost prompt acknowledgement, concurrent same-key calls, different-fingerprint conflict, foreign message/cancel, unrelated list rows, removed membership, and restart lookup against the real store.

**Integration-owner verification:** ownership/service tests and real agent start/follow-up/cancel in Task 6. Existing provider behavior must not be bypassed to make the smoke pass.

**Commit:** `feat: manage only connector-owned Paseo agents`.

## Task 5: MCP Server, Product Routes, and Private Account Setup

**Files:** `server.ts`, route files, application injection, connector integration tests, and `docs/paseo-connector.md`.

**Consumes:** OAuth token verifier/authorization, connector service, existing `Server`, `WebStandardStreamableHTTPServerTransport`, and `registerResponseLifecycle`.

**Produces:** authenticated Streamable HTTP at `/mcp/paseo`, seven tool schemas, useful structured results/errors, and operator setup docs.

Freeze the exact MCP-to-service mapping below. Define the input schemas in `contracts.ts` so `service.ts` and `server.ts` share them without importing server code into the service.

| MCP tool             | Service method                      | Input        | Required scope | Read-only |
| -------------------- | ----------------------------------- | ------------ | -------------- | --------- |
| `get_connection`     | `getConnection(identity)`           | Empty object | `paseo:read`   | Yes       |
| `list_runtimes`      | `listRuntimes(identity)`            | Empty object | `paseo:read`   | Yes       |
| `start_agent`        | `startAgent(identity, input)`       | `Start`      | `paseo:run`    | No        |
| `list_agents`        | `listAgents(identity)`              | Empty object | `paseo:read`   | Yes       |
| `get_agent`          | `getAgent(identity, input)`         | `Get`        | `paseo:read`   | Yes       |
| `send_agent_message` | `sendAgentMessage(identity, input)` | `Message`    | `paseo:run`    | No        |
| `cancel_agent`       | `cancelAgent(identity, input)`      | `Cancel`     | `paseo:cancel` | No        |

The service returns connection metadata, a filtered live runtime catalog, durable owned identities, launch/message acceptance with operation identity, paged agent results, or cancellation acceptance respectively. It throws the shared `ConnectorError` for the dispositions defined in the contracts; the MCP layer does not manufacture successful results.

- [ ] Define the tool input contracts with Zod. Read tools require `paseo:read`; launch/message require `paseo:run`; cancel requires `paseo:cancel`. Mark the four discovery/list/read tools read-only. Mark launch/message/cancel write; cancel is not permanent deletion. No tool exposes a chosen machine/cwd outside the authorization binding.

```ts
const Cursor = z.object({ epoch: z.string(), seq: z.number().int().nonnegative() });
const Start = z.object({
  request_key: z.uuid(),
  task: z.string().min(1),
  title: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1).optional(),
  mode: z.string().min(1).optional(),
});
const Get = z.union([
  z.object({
    agent_id: z.string().min(1),
    cursor: Cursor.optional(),
    direction: z.enum(["tail", "before", "after"]).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  z.object({ operation_id: z.uuid() }),
]);
const Message = z.object({
  request_key: z.uuid(),
  agent_id: z.string().min(1),
  text: z.string().min(1),
});
const Cancel = z.object({ agent_id: z.string().min(1) });
```

Document request-key reuse only for the same intended operation. Changed arguments with the same key fail, and unresolved acknowledgement requires inspection rather than a new key.

- [ ] Use the existing execution-capabilities server as the HTTP lifecycle pattern, **not** its completion-token auth. Authenticate the request first, then create a fresh stateless MCP server for that request and dispatch through the scoped service. Close server/transport on response finish or abort; do not cancel agents on HTTP abort.
- [ ] Return meaningful `structuredContent` plus readable text. Tool execution errors use one shared `isError` payload with `code`, message and relevant owned operation identity; foreign/missing IDs reveal no target details. Authentication remains HTTP 401 with resource discovery; scope failure is explicit, not an empty success.
- [ ] Render bounded timeline content with cursors instead of dumping unlimited transcripts. Keep final assistant text, errors and approval-required state visible. Do not disclose secrets through connection metadata. Treat tool output as data, not instructions to alter the connector's authority.
- [ ] Add route handlers through existing application composition and regenerate the route tree. Existing app instances with no database return 503 rather than an in-memory fallback. Leave execution-capability MCP, CLI auth, triggers and daemon enrollment behavior intact.
- [ ] Add integration tests using the real MCP transport and OAuth-issued token. Verify unauthenticated challenge, wrong audience, read token denied launch, unrelated agent concealment, real owned timeline text, page-boundary/cursor reset, revoked token denied, and explicit offline error. Test consumer behavior, not a copied tool list or source-text inspection.
- [ ] Update operator docs with public origin/resource/discovery URLs, exact scopes, selected machine/directory consent, token/connection revocation, request-key semantics, cancellation semantics, and how to register this private MCP app from Add -> Create MCP App. Do not state Dot support until Task 6 observes it.

**Integration-owner verification:** `npx vitest run src/paseo-connector/server.integration.test.ts` plus MCP Inspector against the booted app, exercising actual authorization and representative operations.

**Commit:** `feat: expose the OAuth-linked Paseo MCP connector`.

## Task 6: Integrated Checks, Real Machine, and Dotty Acceptance

**Files:** real-agent E2E test and connector operator docs; update Hub self-hosting documentation where it introduces the new endpoint. No permanent fake agent or mock cloud service.

**Consumes:** fully implemented Tasks 1-5, isolated test directory, an operator-authorized live daemon, stable HTTPS Hub origin, and the signed-in Dotty account.

**Produces:** recorded real acceptance evidence or an exact platform/deployment blocker. No incomplete connector is described as working.

- [ ] Integration owner runs affected tests, `npm run db:check`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`, and `npm run build` after all slices are integrated. Fix product failures; do not alter unrelated user code or re-pin incidental implementation tests.
- [ ] Boot the actual self-hosted app with persisted data, inspect both well-known endpoints, complete a real OAuth flow, and use MCP Inspector to call the endpoint. Confirm the generated route filenames resolve to the intended public URLs; adjust routing before deployment if TanStack's escaping differs.
- [ ] Exercise against a real enrolled daemon: list runtimes, launch in the approved test directory, fetch progress/final answer, send a follow-up, then cancel a separate long-running task and verify the session remains. Inspect Paseo itself to confirm the machine/workspace/agent identities. Keep unrelated sessions running and prove the connector cannot list, read, message, or cancel them.
- [ ] Restart Hub and demonstrate owned session access persists. Disconnect/reconnect the test daemon and observe explicit offline/current-state behavior. Test connector revocation while a task is running: connector calls fail, but the existing task is not silently stopped. Do not revoke/re-enroll the user's production daemon to exercise a fixture.
- [ ] Use the configured stable public HTTPS origin for private ChatGPT connection. If there is no deployment origin or the chosen machine belongs to another Hub, obtain the operator's decision before DNS/TLS/enrollment changes. Do not expose the daemon port or put credentials in chat. Public directory submission is not required for this private setup.
- [ ] In the signed-in account, select Add -> Create MCP App, enter the actual endpoint and OAuth, and review the trust acknowledgement with the user before creating/authorizing the app. The earlier browser permission was read-only inspection; it does not authorize installing the connector.
- [ ] First prove ordinary ChatGPT account linking and tool calls. Then ask **Dotty itself** to use the connector for `get_connection`, `list_runtimes`, and the real launch/results/follow-up/cancel sequence. Record whether the personal custom app is visible and callable by Dotty. Test read/write confirmation without broadening account permissions to force success.
- [ ] If ordinary ChatGPT succeeds but Dotty cannot see/call the app, report those two results separately and the exact observed limitation. Stop rollout rather than substitute a standard chat, cloud shell, local computer, tunnel, or CLI. Mobile/Slack invocation is only claimed if independently exercised.
- [ ] Record only nonsecret evidence in `docs/paseo-connector.md`: tested Hub/daemon versions, transport, account surface, observed tool results, ownership rejection, persistence, and remaining platform limits. Remove throwaway probes and test workspaces after explicit cancellation/cleanup of the test agents.

**Commit:** `test: verify the real Paseo connector lifecycle and document Dotty compatibility` only after exercised evidence exists.

## Dependency and Review Checkpoints

```text
Task 1 (durable authority) -> Task 3 (OAuth) ---------+
             |                                     |
             +-> Task 4 (owned service) -> Task 5 (MCP) -> Task 6 (live proof)
Task 2 (daemon reads) --------> Task 4 --------------+
```

Task 2 is independent of Task 1 and may run in parallel. Task 3 and Task 4 can run in parallel after shared contracts/storage exist, with one integration owner for shared schema/app files. Do not fan out tasks sharing those files without explicit ownership. Review authority and consent-flow boundaries before attaching external credentials or enabling writes.

## Spec Coverage and Known External Gates

| Spec requirement                                                          | Implemented/verified by                        |
| ------------------------------------------------------------------------- | ---------------------------------------------- |
| Self-hosted, connect once, no Mac/CLI dependency                          | Tasks 2, 5, 6                                  |
| OAuth identity and selected machine/directory                             | Tasks 1, 3                                     |
| Connector-created agents only                                             | Tasks 1, 4, 5; foreign-session live check in 6 |
| Discovery, launch, results, follow-up, cancel                             | Tasks 2, 4, 5, 6                               |
| Creation separate from prompt, durable ownership, unknown acknowledgement | Tasks 1, 4                                     |
| Restart, revocation, re-enrollment identity                               | Tasks 1, 3, 6                                  |
| Offline and incompatible machines, no queue                               | Tasks 2, 4, 5, 6                               |
| Read/write annotations and applicable approvals                           | Tasks 3, 5, 6                                  |
| Actual Dotty compatibility, not ordinary-chat proxy                       | Task 6                                         |
| Setup/security/cancellation documentation                                 | Tasks 5, 6                                     |

External gates are an authorized HTTPS deployment and a live Dotty invocation. Neither is proven by this plan. The signed-in UI confirms private MCP creation with OAuth is available, not that the final connector is installed or works.

## Research References

- `getpaseo/hub` pinned source: https://github.com/getpaseo/hub/tree/28f6c78833065fd282f9064f92a9aa61875dd359
- Existing agent adapter: https://github.com/getpaseo/hub/blob/main/src/daemons/agents/index.ts
- Existing HTTP MCP lifecycle: https://github.com/getpaseo/hub/blob/main/src/execution-capabilities/server.ts
- Existing authentication restrictions: https://github.com/getpaseo/hub/blob/main/src/auth/server.ts
- OAuth 1.6 documentation: https://better-auth.com/docs/1.6/plugins/oauth-provider
- Pinned package metadata: https://registry.npmjs.org/@better-auth/oauth-provider/1.6.23
- ChatGPT connector auth: https://developers.openai.com/plugins/build/auth
- Self-hosting Hub: https://paseo.sh/docs/hub/self-hosting
