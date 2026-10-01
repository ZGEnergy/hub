import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
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
import { CONNECTOR_FLOW_PARAM, ConnectorFlowError, type ConnectorOAuthService } from "./flow.js";
import { connectorOAuthEndpoints, verifyConnectorAccessToken } from "./oauth.js";

const ORIGIN = "http://localhost:3000";
const RESOURCE = `${ORIGIN}/mcp/paseo`;
const CONNECTION_CLAIM = `${ORIGIN}/claims/paseo-connection`;
const REDIRECT_URI = "https://chatgpt.example/connector/oauth_callback";
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

describe.each(["embedded", "postgres"] as const)("Paseo connector OAuth on %s", (kind) => {
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

  async function enroll(organizationId: string): Promise<string> {
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

  /** One authorization request from the registered client, as far as the connect page. */
  async function authorization(
    browser: Browser,
    clientId: string,
    scope = "paseo:read paseo:run offline_access",
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

  async function registerClient(): Promise<string> {
    const response = await auth.handle(
      new Request(`${ORIGIN}/api/auth/oauth2/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Dotty",
          redirect_uris: [REDIRECT_URI],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
      }),
    );
    // The pinned library answers a successful registration with 200, not RFC 7591's 201.
    expect(response.status).toBe(200);
    const client = z
      .object({ client_id: z.string(), token_endpoint_auth_method: z.literal("none") })
      .passthrough()
      .parse(await response.json());
    expect(client).not.toHaveProperty("client_secret");
    return client.client_id;
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
    expect(await metadata.json()).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/api/auth/oauth2/authorize`,
      token_endpoint: `${ORIGIN}/api/auth/oauth2/token`,
      registration_endpoint: `${ORIGIN}/api/auth/oauth2/register`,
      jwks_uri: `${ORIGIN}/api/auth/jwks`,
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
    });
    expect(await connector.protectedResourceMetadata().json()).toEqual({
      resource: RESOURCE,
      authorization_servers: [ORIGIN],
      scopes_supported: ["paseo:read", "paseo:run", "paseo:cancel"],
      bearer_methods_supported: ["header"],
    });
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

  it("rejects another resource, a missing resource, and grants the connector does not offer", async () => {
    const { browser, machine } = await operator();
    const clientId = await registerClient();
    const { code, verifier } = await linkMachine(browser, clientId, machine);
    const exchangeWith = (resource?: string) =>
      token({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
        ...(resource === undefined ? {} : { resource }),
      });

    expect(await errorOf(await exchangeWith("https://elsewhere.example/mcp"))).toBe(
      "invalid_target",
    );
    expect(await errorOf(await exchangeWith())).toBe("invalid_target");
    const clientCredentials = await token({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: "anything",
      resource: RESOURCE,
    });
    expect(await errorOf(clientCredentials)).toBe("unsupported_grant_type");
    // The rejected attempts never reached the code: the valid exchange still succeeds.
    expect(jwtClaims((await exchange(clientId, code, verifier)).access_token)["aud"]).toBe(
      RESOURCE,
    );
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

    expect(await errorOf(await refresh(clientId, tokens))).toBe("invalid_grant");
    await expect(
      authorizeConnectorRequest(database, principal, "paseo:read"),
    ).rejects.toMatchObject({ code: "connection_revoked" });
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
  });
});

class Browser {
  private cookie = "";
  readonly email = `operator-${randomUUID()}@example.com`;

  constructor(private readonly auth: AuthServer) {}

  async signUp(): Promise<void> {
    const response = await this.auth.handle(
      this.post("/api/auth/sign-up/email", {
        name: "Operator",
        email: this.email,
        password: "account-password",
      }),
    );
    expect(response.status).toBe(200);
    this.cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
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
      new Request(`${ORIGIN}/api/auth/oauth2/authorize?${new URLSearchParams(query).toString()}`, {
        headers: { cookie: this.cookie },
      }),
    );
  }

  async rawPost(path: string, body: unknown): Promise<number> {
    return (await this.auth.handle(this.post(path, body))).status;
  }

  /** The headers a same-origin Hub server function call carries. */
  headers(): Headers {
    return new Headers({ cookie: this.cookie, origin: ORIGIN });
  }

  private post(path: string, body: unknown): Request {
    return new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
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
