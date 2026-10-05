import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApplicationRuntime } from "../application-runtime.js";
import { composeEntitlements } from "../auth/entitlements.js";
import { createAuthServer, type AuthServer } from "../auth/server.js";
import { createDatabase } from "../db/pg.js";
import {
  embeddedDatabaseRuntime,
  postgresDatabaseRuntime,
  type DatabaseRuntimeBundle,
} from "../db/runtime/index.js";
import type { Database } from "../db/types.js";
import { authorizeConnectorRequest } from "./authorization.js";
import { ConnectorError } from "./contracts.js";
import {
  CONNECTOR_FLOW_PARAM,
  ConnectorFlowError,
  redirectDestination,
  type ConnectorOAuthService,
} from "./flow.js";
import {
  ConnectorUnavailableError,
  connectorOAuthEndpoints,
  findRefreshGrant,
  readPaseoConnectorEnabled,
  verifyConnectorAccessToken,
} from "./oauth.js";
import { startApplication, stopApplication } from "../server/runtime.js";
import { Route as AuthorizationServerRoute } from "../routes/[.]well-known/oauth-authorization-server.js";
import { Route as ProtectedResourceRoute } from "../routes/[.]well-known/oauth-protected-resource/mcp/paseo.js";

const ORIGIN = "http://localhost:3000";
const RESOURCE = `${ORIGIN}/mcp/paseo`;
const CONNECTION_CLAIM = `${ORIGIN}/claims/paseo-connection`;
const CLIENT_NAME = "Example MCP Client";
const REDIRECT_URI = "https://client.example/oauth/callback";
const ENDPOINTS = connectorOAuthEndpoints(ORIGIN)!;

let postgres: StartedPostgreSqlContainer;
beforeAll(async () => {
  postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
}, 120_000);
afterAll(async () => {
  await postgres?.stop();
});

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  scope: z.string(),
  token_type: z.literal("Bearer"),
});
type Tokens = z.infer<typeof tokenResponseSchema>;
const oauthErrorSchema = z.object({ error: z.string() }).passthrough();

describe("consent redirect destination", () => {
  it("never shows a custom scheme's opaque origin", () => {
    expect(redirectDestination("https://client.example/oauth/callback?x=1")).toBe(
      "https://client.example",
    );
    expect(redirectDestination("http://127.0.0.1:43117/callback")).toBe("http://127.0.0.1:43117");
    expect(redirectDestination("myapp://callback/path")).toBe("myapp://callback");
    expect(redirectDestination("com.example.app:/oauth")).toBe("com.example.app:");
    expect(redirectDestination("not a url")).toBeNull();
    expect(redirectDestination(null)).toBeNull();
  });
});

describe.each(["embedded", "postgres"] as const)("Paseo Agent Connector OAuth on %s", (kind) => {
  let root: string;
  let bundle: DatabaseRuntimeBundle;
  let database: Database;
  let auth: AuthServer;
  let connector: ConnectorOAuthService;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "hub-connector-oauth-"));
    if (kind === "embedded") {
      bundle = await embeddedDatabaseRuntime(join(root, "database"));
    } else {
      const url = new URL(postgres.getConnectionUri());
      url.pathname = `/connector_oauth_${randomUUID().replaceAll("-", "")}`;
      bundle = await postgresDatabaseRuntime(url.href);
    }
    await bundle.runtime.migrate();
    database = createDatabase(bundle.runtime, bundle.locks);
    auth = createAuthServer({
      database: bundle.runtime,
      locks: bundle.locks,
      entitlements: composeEntitlements(database, bundle.runtime).service,
      secret: "connector-oauth-test-secret-at-least-32-characters",
      baseURL: ORIGIN,
      policy: { registrationMode: "open", organizationCreation: "open", bootstrap: undefined },
      paseoConnector: true,
    });
    connector = auth.connector!;
  }, 120_000);
  afterAll(async () => {
    await auth?.close();
    await bundle?.runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  /** A signed-in Hub user who belongs to one organization with two enrolled machines. */
  async function operator() {
    const browser = new Browser(auth);
    await browser.signUp();
    const organizationId = await browser.createOrganization();
    const machine = await enroll(organizationId);
    const otherMachine = await enroll(organizationId);
    return { browser, organizationId, machine, otherMachine };
  }

  async function enroll(
    organizationId: string,
    permissions: string[] = ["hub.execute"],
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
      permissions,
      now: new Date(),
    });
    return daemonId;
  }

  /** One authorization request from the registered client, as far as the connect page. */
  async function authorization(
    browser: Browser,
    clientId: string,
    scope = "paseo:read paseo:run offline_access",
    prompt?: "login" | "create",
  ) {
    const pkce = newPkce();
    const state = randomUUID();
    const response = await browser.authorize({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope,
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      resource: RESOURCE,
      ...(prompt === undefined ? {} : { prompt }),
    });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "", ORIGIN);
    expect(location.pathname).toBe("/oauth/connect");
    return { connectQuery: location.search, state, verifier: pkce.verifier };
  }

  /** Selection then approval through the flow-aware connector operations. */
  async function linkMachine(
    browser: Browser,
    clientId: string,
    daemonId: string,
    scope?: string,
  ): Promise<{ code: string; verifier: string }> {
    const request = await authorization(browser, clientId, scope);
    const consent = await select(browser, request.connectQuery, daemonId);
    const approved = await connector.decideConsent(
      { oauthQuery: consent.oauthQuery, flowId: consent.flowId, accept: true },
      browser.headers(),
    );
    const callback = new URL(approved.redirectTo);
    expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI);
    expect(callback.searchParams.get("state")).toBe(request.state);
    expect(callback.searchParams.get("iss")).toBe(ENDPOINTS.issuer);
    return { code: callback.searchParams.get("code") ?? "", verifier: request.verifier };
  }

  async function select(browser: Browser, connectQuery: string, daemonId: string) {
    const selected = await connector.selectMachine(
      { oauthQuery: connectQuery, daemonId, workingDirectory: "/srv/work/project/" },
      browser.headers(),
    );
    const consentUrl = new URL(selected.redirectTo, ORIGIN);
    expect(consentUrl.pathname).toBe("/oauth/consent");
    const flowId = consentUrl.searchParams.get(CONNECTOR_FLOW_PARAM) ?? "";
    consentUrl.searchParams.delete(CONNECTOR_FLOW_PARAM);
    return { flowId, oauthQuery: consentUrl.search };
  }

  async function exchange(clientId: string, code: string, verifier: string): Promise<Tokens> {
    const response = await token({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      resource: RESOURCE,
    });
    expect(response.status).toBe(200);
    return tokenResponseSchema.parse(await response.json());
  }

  function refresh(clientId: string, tokens: Tokens, scope?: string): Promise<Response> {
    return token({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: tokens.refresh_token ?? "",
      resource: RESOURCE,
      ...(scope === undefined ? {} : { scope }),
    });
  }

  function token(form: Record<string, string>): Promise<Response> {
    return auth.handle(
      new Request(`${ORIGIN}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
      }),
    );
  }

  /** A token request carrying `resources` as repeated `resource` fields (none when empty). */
  function tokenWithResources(
    form: Record<string, string>,
    resources: readonly string[],
  ): Promise<Response> {
    const body = new URLSearchParams(form);
    for (const resource of resources) body.append("resource", resource);
    return auth.handle(
      new Request(`${ORIGIN}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
    );
  }

  async function registerClient(): Promise<string> {
    const response = await auth.handle(
      new Request(`${ORIGIN}/api/auth/oauth2/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: CLIENT_NAME,
          redirect_uris: [REDIRECT_URI],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
      }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const client = z
      .object({ client_id: z.string(), token_endpoint_auth_method: z.literal("none") })
      .passthrough()
      .parse(await response.json());
    expect(client).not.toHaveProperty("client_secret");
    return client.client_id;
  }

  /** Connection and flow rows the user owns, whatever their state. */
  async function connectorRows(browser: Browser): Promise<number> {
    const userId = await browser.userId();
    const result = await bundle.runtime.query<{ count: number }>(
      `select (select count(*) from connector_connections where owner_user_id = $1)::integer
            + (select count(*) from connector_consent_flows where owner_user_id = $1)::integer
              as count`,
      [userId],
    );
    return result.rows[0]!.count;
  }

  async function addMember(browser: Browser, organizationId: string, role: string) {
    await bundle.runtime.query(
      `insert into member (id, organization_id, user_id, role, created_at)
       values ($1, $2, $3, $4, now())`,
      [randomUUID(), organizationId, await browser.userId(), role],
    );
  }

  async function setRole(browser: Browser, organizationId: string, role: string) {
    await bundle.runtime.query(
      "update member set role = $3 where user_id = $1 and organization_id = $2",
      [await browser.userId(), organizationId, role],
    );
  }

  it.each([
    ["login", false],
    ["login", true],
    ["create", false],
    ["create", true],
  ] as const)(
    "completes explicit prompt=%s with an existing session=%s only after authentication and consent",
    async (prompt, signedIn) => {
      const existing = await operator();
      const previousUserId = await existing.browser.userId();
      const browser = signedIn ? existing.browser : new Browser(auth, existing.browser.email);
      const clientId = await registerClient();
      const request = await authorization(browser, clientId, undefined, prompt);
      const selection = {
        oauthQuery: request.connectQuery,
        daemonId: existing.machine,
        workingDirectory: "/srv/work/project",
      };
      await expect(connector.selectMachine(selection, browser.headers())).rejects.toMatchObject({
        code: signedIn ? "authorization_failed" : "unauthenticated",
      });
      if (prompt === "login") {
        expect(
          await browser.rawPost("/api/auth/sign-in/email", {
            email: browser.email,
            password: "incorrect-password",
            oauth_query: request.connectQuery,
          }),
        ).toBe(401);
      }
      const connectQuery = await browser.authenticateOAuth(
        prompt,
        request.connectQuery,
        prompt === "create" ? `created-${randomUUID()}@example.com` : browser.email,
      );
      const userId = await browser.userId();
      if (prompt === "login") {
        expect(userId).toBe(previousUserId);
      } else {
        expect(userId).not.toBe(previousUserId);
        expect(await connector.listMachines(browser.headers())).toEqual([]);
      }
      const machine =
        prompt === "login" ? existing.machine : await enroll(await browser.createOrganization());
      const forged = new URLSearchParams(connectQuery);
      forged.set("redirect_uri", "https://attacker.example/callback");
      await expect(
        connector.selectMachine(
          { ...selection, oauthQuery: forged.toString(), daemonId: machine },
          browser.headers(),
        ),
      ).rejects.toBeInstanceOf(ConnectorFlowError);
      expect(await connectorRows(browser)).toBe(0);
      const consent = await select(browser, connectQuery, machine);
      expect(await connector.listConnections(browser.headers())).toEqual([]);
      const approved = await connector.decideConsent(
        { ...consent, accept: true },
        browser.headers(),
      );
      const callback = new URL(approved.redirectTo);
      expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI);
      expect(callback.searchParams.get("state")).toBe(request.state);
      const tokens = await exchange(
        clientId,
        callback.searchParams.get("code") ?? "",
        request.verifier,
      );
      const principal = await principalOf(tokens);
      expect(principal.userId).toBe(userId);
      expect(await authorizeConnectorRequest(database, principal, "paseo:run")).toMatchObject({
        daemonId: machine,
        workingDirectory: "/srv/work/project",
      });
    },
  );

  it("does not let prompt=create bypass closed registration", async () => {
    const { browser } = await operator();
    const closed = createAuthServer({
      database: bundle.runtime,
      locks: bundle.locks,
      entitlements: composeEntitlements(database, bundle.runtime).service,
      secret: "connector-oauth-test-secret-at-least-32-characters",
      baseURL: ORIGIN,
      policy: { registrationMode: "disabled", organizationCreation: "open", bootstrap: undefined },
      paseoConnector: true,
    });
    const request = await authorization(browser, await registerClient(), undefined, "create");
    const newcomer = new Browser(closed);
    expect(
      await newcomer.rawPost("/api/auth/sign-up/email", {
        name: "New operator",
        email: newcomer.email,
        password: "account-password",
        oauth_query: request.connectQuery,
      }),
    ).toBe(403);
    await expect(closed.connector!.listMachines(newcomer.headers())).rejects.toMatchObject({
      code: "unauthenticated",
    });
    await closed.close();
  });

  it("completes explicit prompt=login through Hub's account authentication boundary", async () => {
    const { browser, machine } = await operator();
    const clientId = await registerClient();
    const request = await authorization(browser, clientId, undefined, "login");
    const credentials = {
      email: browser.email,
      password: "account-password",
      oauthQuery: request.connectQuery,
    };
    await expect(
      auth.signInEmail!({ ...credentials, password: "incorrect-password" }, browser.headers()),
    ).rejects.toMatchObject({ body: { code: "INVALID_EMAIL_OR_PASSWORD" } });
    const authenticated = z
      .object({ state: z.literal("complete"), redirectTo: z.string() })
      .parse(await auth.signInEmail!(credentials, browser.headers()));
    const connect = new URL(authenticated.redirectTo, ORIGIN);
    expect(connect.origin).toBe(ORIGIN);
    expect(connect.pathname).toBe("/oauth/connect");
    const consent = await select(browser, connect.search, machine);
    expect(await connector.listConnections(browser.headers())).toEqual([]);
    const approved = await connector.decideConsent({ ...consent, accept: true }, browser.headers());
    const callback = new URL(approved.redirectTo);
    expect(callback.searchParams.get("state")).toBe(request.state);
    const tokens = await exchange(
      clientId,
      callback.searchParams.get("code") ?? "",
      request.verifier,
    );
    expect(
      await authorizeConnectorRequest(database, await principalOf(tokens), "paseo:run"),
    ).toMatchObject({
      ownerUserId: await browser.userId(),
      daemonId: machine,
      workingDirectory: "/srv/work/project",
    });
  });

  it.each(["initial", "resent"] as const)(
    "completes explicit prompt=create with the %s verification email",
    async (verification) => {
      const verifications: { url: string }[] = [];
      const verifiedEntitlements = composeEntitlements(database, bundle.runtime);
      const verifiedAuth = createAuthServer({
        database: bundle.runtime,
        locks: bundle.locks,
        entitlements: verifiedEntitlements.service,
        secret: "connector-oauth-test-secret-at-least-32-characters",
        baseURL: ORIGIN,
        policy: { registrationMode: "open", organizationCreation: "open", bootstrap: undefined },
        accountMailer: {
          sendVerificationEmail: async (email) => {
            verifications.push({ url: email.url });
          },
          sendPasswordReset: () => Promise.resolve(),
        },
        paseoConnector: true,
      });
      const browser = new Browser(verifiedAuth);
      const clientId = await registerClient();
      const request = await authorization(browser, clientId, undefined, "create");
      expect(
        await browser.rawPost("/api/auth/sign-up/email", {
          name: "Verified operator",
          email: browser.email,
          password: "account-password",
          oauth_query: request.connectQuery,
        }),
      ).toBe(200);
      await expect(verifiedAuth.connector!.listMachines(browser.headers())).rejects.toMatchObject({
        code: "unauthenticated",
      });
      expect(
        await browser.rawPost("/api/auth/sign-in/email", {
          email: browser.email,
          password: "account-password",
          oauth_query: request.connectQuery,
        }),
      ).toBe(403);
      expect(verifications).toHaveLength(1);
      if (verification === "resent") {
        const application = await createApplicationRuntime({
          database,
          auth: verifiedAuth,
          entitlements: verifiedEntitlements.service,
          billing: null,
          close: () => Promise.resolve(),
        });
        await application.sendVerificationEmail!(
          browser.email,
          browser.headers(),
          undefined,
          request.connectQuery,
        );
        await application.stop();
      }
      const connectQuery = await browser.verifyOAuth(verifications.at(-1)!.url);
      const machine = await enroll(await browser.createOrganization());
      const consent = await select(browser, connectQuery.search, machine);
      expect(await verifiedAuth.connector!.listConnections(browser.headers())).toEqual([]);
      const approved = await verifiedAuth.connector!.decideConsent(
        { ...consent, accept: true },
        browser.headers(),
      );
      const callback = new URL(approved.redirectTo);
      expect(callback.searchParams.get("state")).toBe(request.state);
      const tokens = await exchange(
        clientId,
        callback.searchParams.get("code") ?? "",
        request.verifier,
      );
      expect(
        await authorizeConnectorRequest(database, await principalOf(tokens), "paseo:run"),
      ).toMatchObject({
        ownerUserId: await browser.userId(),
        daemonId: machine,
      });
      await verifiedAuth.close();
      await verifiedEntitlements.close();
    },
  );

  it("does not let an older account's verification satisfy prompt=create", async () => {
    const verifications: { url: string }[] = [];
    const verifiedAuth = createAuthServer({
      database: bundle.runtime,
      locks: bundle.locks,
      entitlements: composeEntitlements(database, bundle.runtime).service,
      secret: "connector-oauth-test-secret-at-least-32-characters",
      baseURL: ORIGIN,
      policy: { registrationMode: "open", organizationCreation: "open", bootstrap: undefined },
      accountMailer: {
        sendVerificationEmail: async (email) => {
          verifications.push({ url: email.url });
        },
        sendPasswordReset: () => Promise.resolve(),
      },
      paseoConnector: true,
    });
    const browser = new Browser(verifiedAuth);
    await browser.signUp();
    await bundle.runtime.query(
      "update \"user\" set created_at = timestamp '2000-01-01 00:00:00' where email = $1",
      [browser.email],
    );
    const request = await authorization(browser, await registerClient(), undefined, "create");
    const link = new URL(verifications[0]!.url);
    link.searchParams.set("callbackURL", `${ORIGIN}/oauth/connect${request.connectQuery}`);
    const connectQuery = await browser.verifyOAuth(link.href);
    const machine = await enroll(await browser.createOrganization());
    await expect(
      verifiedAuth.connector!.selectMachine(
        {
          oauthQuery: connectQuery.search,
          daemonId: machine,
          workingDirectory: "/srv/work/project",
        },
        browser.headers(),
      ),
    ).rejects.toMatchObject({ code: "authorization_failed" });
    expect(await verifiedAuth.connector!.listConnections(browser.headers())).toEqual([]);
    await verifiedAuth.close();
  });

  it.each([false, true])(
    "preserves explicit invitation acceptance during prompt=create with email verification=%s",
    async (requiresVerification) => {
      const owner = await operator();
      const verifications: { url: string }[] = [];
      const invitedEntitlements = composeEntitlements(database, bundle.runtime);
      const invitedAuth = createAuthServer({
        database: bundle.runtime,
        locks: bundle.locks,
        entitlements: invitedEntitlements.service,
        secret: "connector-oauth-test-secret-at-least-32-characters",
        baseURL: ORIGIN,
        policy: {
          registrationMode: "invite_only",
          organizationCreation: "disabled",
          bootstrap: undefined,
        },
        ...(requiresVerification
          ? {
              accountMailer: {
                sendVerificationEmail: async (email: { url: string }) => {
                  verifications.push({ url: email.url });
                },
                sendPasswordReset: () => Promise.resolve(),
              },
            }
          : {}),
        paseoConnector: true,
      });
      const browser = new Browser(invitedAuth);
      const invitationId = randomUUID();
      await bundle.runtime.query(
        `insert into invitation (id, organization_id, email, role, status, expires_at, inviter_id)
         values ($1, $2, $3, 'admin', 'pending', $4, $5)`,
        [
          invitationId,
          owner.organizationId,
          browser.email,
          new Date(Date.now() + 60_000),
          await owner.browser.userId(),
        ],
      );
      const clientId = await registerClient();
      const request = await authorization(browser, clientId, undefined, "create");
      const signup = await browser.signupWithInvitation(request.connectQuery, invitationId);
      if (requiresVerification) {
        const application = await createApplicationRuntime({
          database,
          auth: invitedAuth,
          entitlements: invitedEntitlements.service,
          billing: null,
          close: () => Promise.resolve(),
        });
        await application.sendVerificationEmail!(
          browser.email,
          browser.headers(),
          invitationId,
          request.connectQuery,
        );
        await application.stop();
      }
      const connect = requiresVerification
        ? await browser.verifyOAuth(verifications.at(-1)!.url)
        : new URL(z.object({ url: z.string() }).parse(await signup.json()).url, ORIGIN);
      expect(await invitedAuth.connector!.listMachines(browser.headers())).toEqual([]);
      const carriedInvitation = new URLSearchParams(connect.hash.slice(1)).get("invitation") ?? "";
      // The callback-derived credential is consumed by the same explicit account action as the UI.
      expect(
        await browser.rawPost("/api/auth/paseo/accept-invitation", {
          invitationId: carriedInvitation,
        }),
      ).toBe(200);
      expect(
        (await invitedAuth.connector!.listMachines(browser.headers()))
          .map((machine) => machine.daemonId)
          .sort(),
      ).toEqual([owner.machine, owner.otherMachine].sort());
      const consent = await select(browser, connect.search, owner.machine);
      expect(await invitedAuth.connector!.listConnections(browser.headers())).toEqual([]);
      const approved = await invitedAuth.connector!.decideConsent(
        { ...consent, accept: true },
        browser.headers(),
      );
      const callback = new URL(approved.redirectTo);
      const tokens = await exchange(
        clientId,
        callback.searchParams.get("code") ?? "",
        request.verifier,
      );
      expect(
        await authorizeConnectorRequest(database, await principalOf(tokens), "paseo:run"),
      ).toMatchObject({
        ownerUserId: await browser.userId(),
        daemonId: owner.machine,
        organizationId: owner.organizationId,
      });
      await invitedAuth.close();
      await invitedEntitlements.close();
    },
  );

  it("requires password rotation before selecting or approving a connector", async () => {
    const { browser, machine } = await operator();
    const clientId = await registerClient();
    const request = await authorization(browser, clientId);
    const consent = await select(browser, request.connectQuery, machine);
    const userId = await browser.userId();
    await bundle.runtime.query('update "user" set must_change_password = true where id = $1', [
      userId,
    ]);
    const approval = { oauthQuery: consent.oauthQuery, flowId: consent.flowId, accept: true };

    await expect(connector.listMachines(browser.headers())).rejects.toMatchObject({
      code: "password_change_required",
    });
    await expect(
      connector.selectMachine(
        { oauthQuery: request.connectQuery, daemonId: machine, workingDirectory: "/srv/work" },
        browser.headers(),
      ),
    ).rejects.toMatchObject({ code: "password_change_required" });
    await expect(connector.decideConsent(approval, browser.headers())).rejects.toMatchObject({
      code: "password_change_required",
    });

    await auth.changePassword!(
      { currentPassword: "account-password", newPassword: "replacement-account-password" },
      browser.headers(),
    );
    await browser.signIn("replacement-account-password");
    await expect(connector.decideConsent(approval, browser.headers())).rejects.toMatchObject({
      code: "flow_not_found",
    });
    const linked = await linkMachine(browser, clientId, machine);
    await exchange(clientId, linked.code, linked.verifier);
  });

  async function refreshGrantOf(tokens: Tokens) {
    const grant = await findRefreshGrant(bundle.runtime, tokens.refresh_token ?? "");
    expect(grant).toBeDefined();
    return grant!;
  }

  async function refreshTokenRows(clientId: string): Promise<number> {
    const result = await bundle.runtime.query<{ count: number }>(
      "select count(*)::integer as count from oauth_refresh_token where client_id = $1",
      [clientId],
    );
    return result.rows[0]!.count;
  }

  async function principalOf(tokens: Tokens) {
    const principal = await connector.verifyAccessToken(tokens.access_token);
    expect(principal).not.toBeNull();
    return principal!;
  }

  it("advertises one issuer and one resource and registers public clients dynamically", async () => {
    const metadata = await connector.authorizationServerMetadata(
      new Request(`${ORIGIN}/.well-known/oauth-authorization-server`),
    );
    expect(metadata.status).toBe(200);
    const served = z.record(z.string(), z.unknown()).parse(await metadata.json());
    expect(served).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/api/auth/oauth2/authorize`,
      token_endpoint: `${ORIGIN}/api/auth/oauth2/token`,
      registration_endpoint: `${ORIGIN}/api/auth/oauth2/register`,
      jwks_uri: `${ORIGIN}/api/auth/jwks`,
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
    });
    expect(served).toMatchObject({ revocation_endpoint: `${ORIGIN}/api/auth/oauth2/revoke` });
    // Every endpoint it names is one Hub serves; introspection and the like stay unadvertised.
    const endpoints = Object.entries(served).filter(
      ([member]) => member.endsWith("_endpoint") || member === "jwks_uri",
    );
    expect(endpoints.map(([, url]) => new URL(String(url)).pathname).sort()).toEqual([
      "/api/auth/jwks",
      "/api/auth/oauth2/authorize",
      "/api/auth/oauth2/register",
      "/api/auth/oauth2/revoke",
      "/api/auth/oauth2/token",
    ]);
    expect(served).not.toHaveProperty("introspection_endpoint");
    expect(served).not.toHaveProperty("introspection_endpoint_auth_methods_supported");
    expect(await registerClient()).toMatch(/\S/);
  });

  it("requires S256 PKCE before any machine selection", async () => {
    const { browser } = await operator();
    const clientId = await registerClient();
    const base = {
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: "paseo:read",
      state: "s",
    };

    const missing = await browser.authorize(base);
    const missingLocation = new URL(missing.headers.get("location") ?? "", ORIGIN);
    expect(`${missingLocation.origin}${missingLocation.pathname}`).toBe(REDIRECT_URI);
    expect(missingLocation.searchParams.get("error")).toBe("invalid_request");

    const plain = await browser.authorize({
      ...base,
      code_challenge: "plain-challenge-value-plain-challenge-value",
      code_challenge_method: "plain",
    });
    const plainLocation = plain.headers.get("location") ?? "";
    expect(plainLocation).not.toContain("/oauth/connect");
    expect(plain.status === 400 || plainLocation.includes("error=invalid_request")).toBe(true);
  });

  it("issues a resource-bound JWT carrying the selected connection", async () => {
    const { browser, machine } = await operator();
    const clientId = await registerClient();
    const { code, verifier } = await linkMachine(browser, clientId, machine);

    const tokens = await exchange(clientId, code, verifier);
    const claims = jwtClaims(tokens.access_token);
    expect(claims["aud"]).toBe(RESOURCE);
    expect(claims["iss"]).toBe(ENDPOINTS.issuer);
    expect(claims["scope"]).toBe("paseo:read paseo:run offline_access");
    expect(typeof claims[CONNECTION_CLAIM]).toBe("string");
    expect(typeof tokens.refresh_token).toBe("string");

    const authorized = await authorizeConnectorRequest(
      database,
      await principalOf(tokens),
      "paseo:run",
    );
    expect(authorized).toMatchObject({
      connectionId: claims[CONNECTION_CLAIM],
      daemonId: machine,
      workingDirectory: "/srv/work/project",
      scopes: ["paseo:read", "paseo:run"],
    });
    await expect(
      authorizeConnectorRequest(database, await principalOf(tokens), "paseo:cancel"),
    ).rejects.toMatchObject({ code: "insufficient_scope" });
    expect((await connector.listConnections(browser.headers())).map((c) => c.daemonId)).toEqual([
      machine,
    ]);
  });

  it("rejects any other resource and grants the connector does not offer, minting nothing", async () => {
    const { browser, machine } = await operator();
    const clientId = await registerClient();
    const { code, verifier } = await linkMachine(browser, clientId, machine);
    const exchangeWith = (resources: readonly string[]) =>
      tokenWithResources(
        {
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: verifier,
          redirect_uri: REDIRECT_URI,
        },
        resources,
      );

    for (const resources of [
      ["https://elsewhere.example/mcp"],
      [`${ORIGIN}/mcp/other`],
      [RESOURCE, RESOURCE],
      [`${RESOURCE}?tenant=1`],
      [`${RESOURCE}#tools`],
      ["not a url"],
    ]) {
      expect(await errorOf(await exchangeWith(resources))).toBe("invalid_target");
    }
    const clientCredentials = await token({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: "anything",
      resource: RESOURCE,
    });
    expect(await errorOf(clientCredentials)).toBe("unsupported_grant_type");
    expect(await refreshTokenRows(clientId)).toBe(0);
    // The rejected attempts never reached the code: the valid exchange still succeeds.
    expect(jwtClaims((await exchange(clientId, code, verifier)).access_token)["aud"]).toBe(
      RESOURCE,
    );
  });

  it("applies the connector resource when a code or refresh grant names none", async () => {
    const { browser, machine } = await operator();
    const clientId = await registerClient();
    const { code, verifier } = await linkMachine(browser, clientId, machine);
    const exchanged = await tokenWithResources(
      {
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      },
      [],
    );
    expect(exchanged.status).toBe(200);
    const tokens = tokenResponseSchema.parse(await exchanged.json());
    expect(jwtClaims(tokens.access_token)["aud"]).toBe(RESOURCE);

    const refreshed = await tokenWithResources(
      {
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: tokens.refresh_token ?? "",
      },
      [],
    );
    expect(refreshed.status).toBe(200);
    expect(jwtClaims(tokenResponseSchema.parse(await refreshed.json()).access_token)["aud"]).toBe(
      RESOURCE,
    );
  });

  it("accepts a canonically equal resource and binds the token to the canonical one", async () => {
    const { browser, machine } = await operator();
    const clientId = await registerClient();
    for (const resource of [`${RESOURCE}/`, "HTTP://LOCALHOST:3000/mcp/paseo"]) {
      const { code, verifier } = await linkMachine(browser, clientId, machine);
      const exchanged = await tokenWithResources(
        {
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: verifier,
          redirect_uri: REDIRECT_URI,
        },
        [resource],
      );
      expect(exchanged.status).toBe(200);
      const tokens = tokenResponseSchema.parse(await exchanged.json());
      expect(jwtClaims(tokens.access_token)["aud"]).toBe(RESOURCE);
      expect((await principalOf(tokens)).userId).toBe(await browser.userId());
    }
  });

  it("never consents without a machine selected for this authorization", async () => {
    const { browser, machine } = await operator();
    const clientId = await registerClient();
    const request = await authorization(browser, clientId);
    const { oauthQuery } = await select(browser, request.connectQuery, machine);

    expect(
      await browser.rawPost("/api/auth/oauth2/consent", { accept: true, oauth_query: oauthQuery }),
    ).toBe(404);
    expect(
      await browser.rawPost("/api/auth/oauth2/continue", {
        postLogin: true,
        oauth_query: oauthQuery,
      }),
    ).toBe(404);
    await expect(
      connector.decideConsent(
        { oauthQuery, flowId: randomUUID(), accept: true },
        browser.headers(),
      ),
    ).rejects.toMatchObject({ code: "flow_not_found" });
    expect(await connector.listConnections(browser.headers())).toEqual([]);
  });

  it("rejects a changed signed query at selection and at consent", async () => {
    const { browser, machine } = await operator();
    const clientId = await registerClient();
    const request = await authorization(browser, clientId);

    const tampered = new URLSearchParams(request.connectQuery);
    tampered.set("redirect_uri", "https://attacker.example/callback");
    await expect(
      connector.selectMachine(
        { oauthQuery: tampered.toString(), daemonId: machine, workingDirectory: "/srv/work" },
        browser.headers(),
      ),
    ).rejects.toBeInstanceOf(ConnectorFlowError);
    // The rejected selection left nothing pending behind.
    expect(await connectorRows(browser)).toBe(0);

    const consent = await select(browser, request.connectQuery, machine);
    const widened = new URLSearchParams(consent.oauthQuery);
    widened.set("scope", "paseo:read paseo:run paseo:cancel offline_access");
    await expect(
      connector.decideConsent(
        { oauthQuery: widened.toString(), flowId: consent.flowId, accept: true },
        browser.headers(),
      ),
    ).rejects.toMatchObject({ code: "flow_not_found" });
    expect(await connector.listConnections(browser.headers())).toEqual([]);
  });

  it("keeps two simultaneous selections in one session bound to their own machines", async () => {
    const { browser, machine, otherMachine } = await operator();
    const clientId = await registerClient();
    const [first, second] = await Promise.all([
      authorization(browser, clientId),
      authorization(browser, clientId),
    ]);
    const [firstConsent, secondConsent] = await Promise.all([
      select(browser, first.connectQuery, machine),
      select(browser, second.connectQuery, otherMachine),
    ]);

    // A flow cannot be borrowed by the other authorization's query.
    await expect(
      connector.decideConsent(
        { oauthQuery: firstConsent.oauthQuery, flowId: secondConsent.flowId, accept: true },
        browser.headers(),
      ),
    ).rejects.toMatchObject({ code: "flow_not_found" });

    const [firstApproval, secondApproval] = await Promise.all(
      [firstConsent, secondConsent].map((consent) =>
        connector.decideConsent({ ...consent, accept: true }, browser.headers()),
      ),
    );
    const codeOf = (url: string) => new URL(url).searchParams.get("code") ?? "";
    const [firstTokens, secondTokens] = await Promise.all([
      exchange(clientId, codeOf(firstApproval!.redirectTo), first.verifier),
      exchange(clientId, codeOf(secondApproval!.redirectTo), second.verifier),
    ]);
    const daemonOf = async (tokens: Tokens) =>
      (await authorizeConnectorRequest(database, await principalOf(tokens), "paseo:read")).daemonId;
    expect(await daemonOf(firstTokens)).toBe(machine);
    expect(await daemonOf(secondTokens)).toBe(otherMachine);
  });

  it("refreshes onto the same connection and never widens its scopes", async () => {
    const { browser, machine } = await operator();
    const clientId = await registerClient();
    const { code, verifier } = await linkMachine(
      browser,
      clientId,
      machine,
      "paseo:read offline_access",
    );
    const tokens = await exchange(clientId, code, verifier);

    expect(await errorOf(await refresh(clientId, tokens, "paseo:read paseo:run"))).toBe(
      "invalid_scope",
    );
    const refreshed = await refresh(clientId, tokens);
    expect(refreshed.status).toBe(200);
    const next = tokenResponseSchema.parse(await refreshed.json());
    expect(jwtClaims(next.access_token)[CONNECTION_CLAIM]).toBe(
      jwtClaims(tokens.access_token)[CONNECTION_CLAIM],
    );
    expect(jwtClaims(next.access_token)["scope"]).toBe("paseo:read offline_access");
  });

  it("stops refresh and every request once the connection is revoked", async () => {
    const { browser, machine } = await operator();
    const clientId = await registerClient();
    const { code, verifier } = await linkMachine(browser, clientId, machine);
    const tokens = await exchange(clientId, code, verifier);
    const principal = await principalOf(tokens);

    expect(
      await connector.revokeConnection({ connectionId: principal.connectionId }, browser.headers()),
    ).toEqual({ revoked: true });

    const refreshRows = await refreshTokenRows(clientId);
    expect(await errorOf(await refresh(clientId, tokens))).toBe("invalid_grant");
    // The refusal came before the library: the presented token was neither rotated nor revoked.
    expect((await refreshGrantOf(tokens)).revoked).toBeNull();
    expect(await refreshTokenRows(clientId)).toBe(refreshRows);
    await expect(
      authorizeConnectorRequest(database, principal, "paseo:read"),
    ).rejects.toMatchObject({ code: "connection_revoked" });
  });

  it("answers a refresh 503 when the grant cannot be read, and leaves the refresh token usable", async () => {
    const { browser, machine } = await operator();
    const clientId = await registerClient();
    const { code, verifier } = await linkMachine(browser, clientId, machine);
    const tokens = await exchange(clientId, code, verifier);
    const refreshRows = await refreshTokenRows(clientId);

    await bundle.runtime.query("alter table connector_connections rename to connector_offline");
    let refused: Response;
    try {
      refused = await refresh(clientId, tokens);
    } finally {
      await bundle.runtime.query("alter table connector_offline rename to connector_connections");
    }
    expect(refused.status).toBe(503);
    expect(oauthErrorSchema.parse(await refused.json()).error).toBe("temporarily_unavailable");
    expect((await refreshGrantOf(tokens)).revoked).toBeNull();
    expect(await refreshTokenRows(clientId)).toBe(refreshRows);

    const refreshed = await refresh(clientId, tokens);
    expect(refreshed.status).toBe(200);
    expect(tokenResponseSchema.parse(await refreshed.json()).refresh_token).not.toBe(
      tokens.refresh_token,
    );
    expect((await refreshGrantOf(tokens)).revoked).not.toBeNull();
  });

  it("stops a connection whose owner left the organization", async () => {
    const { browser, organizationId, machine } = await operator();
    const clientId = await registerClient();
    const { code, verifier } = await linkMachine(browser, clientId, machine);
    const tokens = await exchange(clientId, code, verifier);
    const principal = await principalOf(tokens);

    await bundle.runtime.query(`delete from member where user_id = $1 and organization_id = $2`, [
      principal.userId,
      organizationId,
    ]);

    await expect(
      authorizeConnectorRequest(database, principal, "paseo:read"),
    ).rejects.toBeInstanceOf(ConnectorError);
    expect(await errorOf(await refresh(clientId, tokens))).toBe("invalid_grant");
  });

  it("shows a view-only member no machines and refuses their selection", async () => {
    const { organizationId, machine } = await operator();
    const viewer = new Browser(auth);
    await viewer.signUp();
    await addMember(viewer, organizationId, "member");
    const clientId = await registerClient();
    const request = await authorization(viewer, clientId);

    expect(await connector.listMachines(viewer.headers())).toEqual([]);
    await expect(
      connector.selectMachine(
        { oauthQuery: request.connectQuery, daemonId: machine, workingDirectory: "/srv/work" },
        viewer.headers(),
      ),
    ).rejects.toBeInstanceOf(ConnectorFlowError);
    expect(await connectorRows(viewer)).toBe(0);
  });

  it("refuses consent once the selecting admin is demoted to member", async () => {
    const { organizationId, machine } = await operator();
    const admin = new Browser(auth);
    await admin.signUp();
    await addMember(admin, organizationId, "admin");
    const clientId = await registerClient();
    const consent = await select(
      admin,
      (await authorization(admin, clientId)).connectQuery,
      machine,
    );

    await setRole(admin, organizationId, "member");
    await expect(
      connector.decideConsent({ ...consent, accept: true }, admin.headers()),
    ).rejects.toMatchObject({ code: "connection_revoked" });
    expect(await connector.listConnections(admin.headers())).toEqual([]);
  });

  it("stops an admin's connection once they are demoted to member, without spending its refresh token", async () => {
    const { organizationId, machine } = await operator();
    const admin = new Browser(auth);
    await admin.signUp();
    await addMember(admin, organizationId, "admin");
    const clientId = await registerClient();
    const { code, verifier } = await linkMachine(admin, clientId, machine);
    const tokens = await exchange(clientId, code, verifier);
    const principal = await principalOf(tokens);
    expect((await authorizeConnectorRequest(database, principal, "paseo:read")).daemonId).toBe(
      machine,
    );

    await setRole(admin, organizationId, "member");
    await expect(
      authorizeConnectorRequest(database, principal, "paseo:read"),
    ).rejects.toMatchObject({ code: "connection_revoked" });
    expect(await errorOf(await refresh(clientId, tokens))).toBe("invalid_grant");
    expect((await refreshGrantOf(tokens)).revoked).toBeNull();

    // Promoted back, the very same refresh token still works: the refusal never rotated it.
    await setRole(admin, organizationId, "admin");
    expect((await refresh(clientId, tokens)).status).toBe(200);
  });

  it("stops a connection whose machine was revoked and re-enrolled", async () => {
    const { browser, organizationId, machine } = await operator();
    const clientId = await registerClient();
    const { code, verifier } = await linkMachine(browser, clientId, machine);
    const tokens = await exchange(clientId, code, verifier);
    const principal = await principalOf(tokens);

    expect(await database.revokeDaemon(machine)).toBe(true);
    await enroll(organizationId);

    await expect(
      authorizeConnectorRequest(database, principal, "paseo:read"),
    ).rejects.toMatchObject({ code: "machine_incompatible" });
    expect(await errorOf(await refresh(clientId, tokens))).toBe("invalid_grant");
  });

  it("mints nothing for a token request the library would read differently from Hub", async () => {
    const { browser, machine } = await operator();
    const clientId = await registerClient();
    const { code, verifier } = await linkMachine(browser, clientId, machine);
    const grant = {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    };
    const send = (contentType: string, body: string) =>
      auth.handle(
        new Request(`${ORIGIN}/api/auth/oauth2/token`, {
          method: "POST",
          headers: { "content-type": contentType },
          body,
        }),
      );

    // A JSON body whose raw text also parses as a form carrying the connector resource.
    const smuggled = await send(
      "application/x-www-form-urlencoded+json",
      JSON.stringify({ ...grant, z: `&resource=${RESOURCE}&` }),
    );
    expect(smuggled.status).toBe(400);
    expect("access_token" in z.record(z.string(), z.unknown()).parse(await smuggled.json())).toBe(
      false,
    );
    const json = await send("application/json", JSON.stringify({ ...grant, resource: RESOURCE }));
    expect(await errorOf(json)).toBe("invalid_request");
    expect(
      (
        await bundle.runtime.query<{ count: number }>(
          `select (select count(*) from oauth_access_token)::integer
                + (select count(*) from oauth_refresh_token where client_id = $1)::integer as count`,
          [clientId],
        )
      ).rows[0]!.count,
    ).toBe(0);

    // A form with parameters on its media type is still the same form, and the code was unspent.
    const form = await send(
      "Application/X-WWW-Form-Urlencoded; charset=utf-8",
      new URLSearchParams({ ...grant, resource: RESOURCE }).toString(),
    );
    expect(form.status).toBe(200);
    expect(jwtClaims(tokenResponseSchema.parse(await form.json()).access_token)["aud"]).toBe(
      RESOURCE,
    );
  });

  it("requires Hub's own browser origin for every connector mutation", async () => {
    const { browser, machine } = await operator();
    const clientId = await registerClient();
    const request = await authorization(browser, clientId);
    const input = { oauthQuery: request.connectQuery, daemonId: machine, workingDirectory: "/srv" };

    for (const headers of [browser.headers("https://evil.example"), browser.headers(null)]) {
      await expect(connector.selectMachine(input, headers)).rejects.toThrow("invalid origin");
    }
    expect(await connectorRows(browser)).toBe(0);

    const consent = await select(browser, request.connectQuery, machine);
    await expect(
      connector.decideConsent(
        { ...consent, accept: true },
        browser.headers("https://evil.example"),
      ),
    ).rejects.toThrow("invalid origin");
    await connector.decideConsent({ ...consent, accept: true }, browser.headers());
    const [connection] = await connector.listConnections(browser.headers());

    await expect(
      connector.revokeConnection(
        { connectionId: connection!.connectionId },
        browser.headers("https://evil.example"),
      ),
    ).rejects.toThrow("invalid origin");
    expect((await connector.listConnections(browser.headers()))[0]!.revokedAt).toBeNull();
  });

  it("honours a flow only for its own session and user, once, before it expires", async () => {
    const { browser, machine } = await operator();
    const clientId = await registerClient();
    const sameUserOtherSession = new Browser(auth, browser.email);
    await sameUserOtherSession.signIn();
    const otherUser = new Browser(auth);
    await otherUser.signUp();
    const request = await authorization(browser, clientId);
    const consent = await select(browser, request.connectQuery, machine);

    for (const other of [sameUserOtherSession, otherUser]) {
      await expect(
        connector.decideConsent({ ...consent, accept: true }, other.headers()),
      ).rejects.toMatchObject({ code: "flow_not_found" });
    }
    const approved = await connector.decideConsent({ ...consent, accept: true }, browser.headers());
    expect(new URL(approved.redirectTo).searchParams.has("code")).toBe(true);
    await expect(
      connector.decideConsent({ ...consent, accept: true }, browser.headers()),
    ).rejects.toMatchObject({ code: "flow_not_found" });

    const late = await select(
      browser,
      (await authorization(browser, clientId)).connectQuery,
      machine,
    );
    await bundle.runtime.query(
      `update connector_consent_flows set expires_at = now() - interval '1 minute' where id = $1`,
      [late.flowId],
    );
    await expect(
      connector.decideConsent({ ...late, accept: true }, browser.headers()),
    ).rejects.toMatchObject({ code: "flow_not_found" });
    expect(await connector.listConnections(browser.headers())).toHaveLength(1);
  });

  it("describes a pending flow only to the session that selected it", async () => {
    const { browser, machine } = await operator();
    const clientId = await registerClient();
    const sameUserOtherSession = new Browser(auth, browser.email);
    await sameUserOtherSession.signIn();
    const stranger = await operator();
    const consent = await select(
      browser,
      (await authorization(browser, clientId)).connectQuery,
      machine,
    );
    const foreign = await select(
      stranger.browser,
      (await authorization(stranger.browser, clientId)).connectQuery,
      stranger.machine,
    );

    expect(await connector.describeConsent(consent, browser.headers())).toEqual({
      clientName: CLIENT_NAME,
      redirectTarget: new URL(REDIRECT_URI).origin,
      machineName: `devbox-${machine.slice(0, 8)}`,
      organizationName: "Acme",
      workingDirectory: "/srv/work/project",
      scopes: ["paseo:read", "paseo:run"],
      staysConnected: true,
    });
    const notFound = { code: "flow_not_found" };
    // Another user's flow id, even carried with this user's own signed query.
    await expect(
      connector.describeConsent({ ...consent, flowId: foreign.flowId }, browser.headers()),
    ).rejects.toMatchObject(notFound);
    await expect(
      connector.describeConsent({ ...consent, flowId: randomUUID() }, browser.headers()),
    ).rejects.toMatchObject(notFound);
    for (const other of [sameUserOtherSession, stranger.browser]) {
      await expect(connector.describeConsent(consent, other.headers())).rejects.toMatchObject(
        notFound,
      );
    }
    const widened = new URLSearchParams(consent.oauthQuery);
    widened.set("scope", "paseo:read paseo:run paseo:cancel offline_access");
    await expect(
      connector.describeConsent(
        { oauthQuery: widened.toString(), flowId: consent.flowId },
        browser.headers(),
      ),
    ).rejects.toMatchObject(notFound);

    await connector.decideConsent({ ...consent, accept: true }, browser.headers());
    await expect(connector.describeConsent(consent, browser.headers())).rejects.toMatchObject(
      notFound,
    );
  });

  it("makes a denial final: no code, no connection, no later approval", async () => {
    const { browser, machine } = await operator();
    const clientId = await registerClient();
    const request = await authorization(browser, clientId);
    const consent = await select(browser, request.connectQuery, machine);

    const denied = await connector.decideConsent({ ...consent, accept: false }, browser.headers());
    const callback = new URL(denied.redirectTo);
    expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI);
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("state")).toBe(request.state);
    expect(callback.searchParams.has("code")).toBe(false);

    await expect(
      connector.decideConsent({ ...consent, accept: true }, browser.headers()),
    ).rejects.toMatchObject({ code: "flow_not_found" });
    expect(await connector.listConnections(browser.headers())).toEqual([]);
    expect(await connectorRows(browser)).toBe(0);
  });

  it("rejects unusable directories and machines at selection without leaving rows", async () => {
    const { browser, organizationId, machine } = await operator();
    const withoutExecute = await enroll(organizationId, []);
    const outsider = new Browser(auth);
    await outsider.signUp();
    const foreignMachine = await enroll(await outsider.createOrganization());
    const clientId = await registerClient();
    const request = await authorization(browser, clientId);
    const attempt = (daemonId: string, workingDirectory: string) =>
      connector.selectMachine(
        { oauthQuery: request.connectQuery, daemonId, workingDirectory },
        browser.headers(),
      );

    const machines = await connector.listMachines(browser.headers());
    expect(machines.find(({ daemonId }) => daemonId === withoutExecute)?.canRunHubWork).toBe(false);
    expect(machines.some(({ daemonId }) => daemonId === foreignMachine)).toBe(false);
    for (const directory of [
      "srv/work",
      "/srv/../etc",
      "/srv/work\u0007",
      "/srv/\u007fwork",
      "/srv\n",
    ]) {
      await expect(attempt(machine, directory)).rejects.toMatchObject({ code: "invalid_request" });
    }
    await expect(attempt(withoutExecute, "/srv/work")).rejects.toMatchObject({
      code: "machine_incompatible",
    });
    await expect(attempt(foreignMachine, "/srv/work")).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(await connectorRows(browser)).toBe(0);
    // The same authorization still selects a usable machine afterwards.
    expect((await select(browser, request.connectQuery, machine)).flowId).toMatch(/\S/);
  });

  it("is off unless the operator opts in, and enables on an HTTPS origin when they do", () => {
    expect(readPaseoConnectorEnabled({})).toBe(false);
    expect(readPaseoConnectorEnabled({ PASEO_HUB_PASEO_CONNECTOR: " " })).toBe(false);
    expect(readPaseoConnectorEnabled({ PASEO_HUB_PASEO_CONNECTOR: "disabled" })).toBe(false);
    expect(readPaseoConnectorEnabled({ PASEO_HUB_PASEO_CONNECTOR: "enabled" })).toBe(true);
    expect(() => readPaseoConnectorEnabled({ PASEO_HUB_PASEO_CONNECTOR: "1" })).toThrow(
      "PASEO_HUB_PASEO_CONNECTOR must be one of: enabled, disabled",
    );
    const enabled = createAuthServer({
      database: bundle.runtime,
      locks: bundle.locks,
      entitlements: composeEntitlements(database, bundle.runtime).service,
      secret: "connector-oauth-test-secret-at-least-32-characters",
      baseURL: "https://hub.example.test",
      policy: { registrationMode: "open", organizationCreation: "open", bootstrap: undefined },
      paseoConnector: true,
    });
    expect(enabled.connector?.endpoints.resource).toBe("https://hub.example.test/mcp/paseo");
  });

  it.each([
    { name: "a plain-http public origin", origin: "http://hub.example.test", optIn: true },
    {
      name: "an HTTPS origin without the opt-in",
      origin: "https://hub.example.test",
      optIn: false,
    },
  ])("stays disabled on $name and leaves Hub's own auth unchanged", async ({ origin, optIn }) => {
    const plain = createAuthServer({
      database: bundle.runtime,
      locks: bundle.locks,
      entitlements: composeEntitlements(database, bundle.runtime).service,
      secret: "connector-oauth-test-secret-at-least-32-characters",
      baseURL: origin,
      policy: { registrationMode: "open", organizationCreation: "open", bootstrap: undefined },
      paseoConnector: optIn,
    });
    expect(plain.connector).toBeUndefined();
    const browser = new Browser(plain, undefined, origin);
    await browser.signUp();
    await browser.createOrganization();

    const statuses = await Promise.all(
      [
        new Request(`${origin}/api/auth/oauth2/authorize?response_type=code&client_id=x`),
        new Request(`${origin}/api/auth/jwks`),
        ...["token", "register", "revoke", "continue", "consent"].map(
          (path) => new Request(`${origin}/api/auth/oauth2/${path}`, { method: "POST" }),
        ),
      ].map(async (request) => (await plain.handle(request)).status),
    );
    expect(statuses).toEqual([404, 404, 404, 404, 404, 404, 404]);
    expect((await plain.handle(browser.request("/api/auth/get-session"))).status).toBe(200);

    await startApplication(() =>
      createApplicationRuntime({
        database,
        auth: plain,
        entitlements: composeEntitlements(database, bundle.runtime).service,
        billing: null,
        close: () => Promise.resolve(),
      }),
    );
    try {
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the generated route type cannot express calling one handler directly
      const metadata = AuthorizationServerRoute.options.server?.handlers as unknown as WellKnownGet;
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- as above
      const resource = ProtectedResourceRoute.options.server?.handlers as unknown as WellKnownGet;
      const request = new Request(`${origin}/.well-known/oauth-authorization-server`);
      expect((await metadata.GET({ request })).status).toBe(404);
      expect((await resource.GET({ request })).status).toBe(404);
    } finally {
      await stopApplication();
    }
  });

  it("accepts only unexpired JWTs from this issuer for this resource", async () => {
    const keys = testSigningKeys();
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      sub: "user-1",
      iss: ENDPOINTS.issuer,
      aud: RESOURCE,
      exp: now + 300,
      iat: now,
      scope: "paseo:read",
      [CONNECTION_CLAIM]: randomUUID(),
    };
    const verify = (candidate: string) =>
      verifyConnectorAccessToken(candidate, ENDPOINTS, keys.jwks);

    expect(await verify(keys.sign(claims))).toMatchObject({ userId: "user-1" });
    expect(await verify(keys.sign({ ...claims, aud: `${ORIGIN}/mcp/other` }))).toBeNull();
    expect(await verify(keys.sign({ ...claims, aud: ORIGIN }))).toBeNull();
    expect(await verify(keys.sign({ ...claims, iss: "https://elsewhere.example" }))).toBeNull();
    expect(await verify(keys.sign({ ...claims, exp: now - 60, iat: now - 600 }))).toBeNull();
    expect(await verify(keys.sign({ ...claims, [CONNECTION_CLAIM]: undefined }))).toBeNull();
    expect(await verify("not-a-jwt")).toBeNull();
    expect(await verify(`paseo_${randomBytes(24).toString("base64url")}`)).toBeNull();
    // Hub itself never trusts a token it did not sign, whatever its claims say.
    expect(await connector.verifyAccessToken(keys.sign(claims))).toBeNull();

    // Unreadable signing keys are Hub's failure, not the token's: never a null (401) verdict.
    const unreadable = () => Promise.reject(new Error("database unavailable"));
    await expect(
      verifyConnectorAccessToken(keys.sign(claims), ENDPOINTS, unreadable),
    ).rejects.toBeInstanceOf(ConnectorUnavailableError);
    // A token that is not even a JWT never reaches the keys.
    expect(await verifyConnectorAccessToken("not-a-jwt", ENDPOINTS, unreadable)).toBeNull();
  });
});

/** The two well-known routes' GET handlers, called directly. */
interface WellKnownGet {
  GET(context: { request: Request }): Response | Promise<Response>;
}

class Browser {
  private cookie = "";

  constructor(
    private readonly auth: AuthServer,
    readonly email = `operator-${randomUUID()}@example.com`,
    private readonly origin = ORIGIN,
  ) {}

  async signIn(password = "account-password"): Promise<void> {
    const response = await this.auth.handle(
      this.post("/api/auth/sign-in/email", { email: this.email, password }),
    );
    expect(response.status).toBe(200);
    this.rememberCookie(response);
  }

  async authenticateOAuth(prompt: "login" | "create", oauthQuery: string, email: string) {
    const response = await this.auth.handle(
      this.post(prompt === "login" ? "/api/auth/sign-in/email" : "/api/auth/sign-up/email", {
        email,
        password: "account-password",
        ...(prompt === "create" ? { name: "New operator" } : {}),
        oauth_query: oauthQuery,
      }),
    );
    expect(response.status).toBe(200);
    this.rememberCookie(response);
    const result = z.object({ url: z.string() }).parse(await response.json());
    const connect = new URL(result.url, this.origin);
    expect(connect.origin).toBe(this.origin);
    expect(connect.pathname).toBe("/oauth/connect");
    return connect.search;
  }

  async verifyOAuth(url: string) {
    const response = await this.auth.handle(new Request(url));
    expect(response.status).toBe(302);
    this.rememberCookie(response);
    const connect = new URL(response.headers.get("location") ?? "", this.origin);
    expect(connect.origin).toBe(this.origin);
    expect(connect.pathname).toBe("/oauth/connect");
    return connect;
  }

  async signupWithInvitation(oauthQuery: string, invitationId: string) {
    const response = await this.auth.handle(
      this.post(`/api/auth/sign-up/email?invitation=${encodeURIComponent(invitationId)}`, {
        name: "Invited operator",
        email: this.email,
        password: "account-password",
        oauth_query: oauthQuery,
      }),
    );
    expect(response.status).toBe(200);
    this.rememberCookie(response);
    return response;
  }

  async userId(): Promise<string> {
    const response = await this.auth.handle(this.request("/api/auth/get-session"));
    return z.object({ user: z.object({ id: z.string() }) }).parse(await response.json()).user.id;
  }

  request(path: string): Request {
    return new Request(`${this.origin}${path}`, { headers: { cookie: this.cookie } });
  }

  private rememberCookie(response: Response): void {
    this.cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
  }

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

  async createOrganization(): Promise<string> {
    const response = await this.auth.browserAccount!(
      this.post("/api/auth/paseo/create-organization", { name: "Acme" }),
    );
    expect(response.status).toBe(201);
    return z.object({ organizationId: z.string() }).parse(await response.json()).organizationId;
  }

  authorize(query: Record<string, string>): Promise<Response> {
    return this.auth.handle(
      this.request(`/api/auth/oauth2/authorize?${new URLSearchParams(query).toString()}`),
    );
  }

  async rawPost(path: string, body: unknown): Promise<number> {
    return (await this.auth.handle(this.post(path, body))).status;
  }

  /** The headers a Hub server function call carries: same-origin unless told otherwise. */
  headers(origin: string | null = this.origin): Headers {
    return new Headers({ cookie: this.cookie, ...(origin === null ? {} : { origin }) });
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

function newPkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function jwtClaims(token: string): Record<string, unknown> {
  return z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")));
}

async function errorOf(response: Response): Promise<string> {
  expect(response.status).toBe(400);
  return oauthErrorSchema.parse(await response.json()).error;
}

/** An Ed25519 key the test controls, to exercise the verifier's claim checks directly. */
function testSigningKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const kid = randomUUID();
  const jwk = z
    .object({ kty: z.string(), crv: z.string(), x: z.string() })
    .parse(publicKey.export({ format: "jwk" }));
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return {
    jwks: () => Promise.resolve({ keys: [{ ...jwk, kid, alg: "EdDSA" }] }),
    sign(claims: Record<string, unknown>): string {
      const input = `${encode({ alg: "EdDSA", kid })}.${encode(claims)}`;
      return `${input}.${sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
    },
  };
}
