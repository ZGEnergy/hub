import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { z } from "zod";
import * as schema from "../db/schema.js";
import type { DatabaseRuntime } from "../db/runtime/index.js";
import type { Locks } from "../db/runtime/locks/index.js";
import { OrganizationApiKeys } from "./api-keys.js";
import { OrganizationCliCredentials } from "./cli-credentials.js";
import { PublicCredentialAuthenticator } from "./public-credentials.js";
import {
  InstanceSetup,
  type InitialOperator,
  type InstanceClaim,
} from "../instance-setup/index.js";
import {
  defaultInstanceAuthPolicy,
  PASSWORD_MIN_LENGTH,
  type InstanceAuthPolicy,
} from "./instance-policy.js";
import { RegistrationAdmission, RegistrationAdmissionError } from "./registration-admission.js";
import type {
  OrganizationResourceReader,
  OrganizationResources,
} from "../organizations/resources.js";
import {
  OrganizationAccess,
  type AccountAccessValue,
  type AccountSession,
  type OrganizationAccessValue,
} from "./organization-access.js";
import { paseoOrganizationPlugin } from "./organization-policy.js";
import type { EntitlementsService } from "../entitlements/service.js";
import {
  UNLIMITED_PROVISIONING,
  type ProvisioningEntitlementResolver,
} from "../organizations/provisioning.js";
import { InstanceAppOnboarding } from "../instance-setup/app-onboarding.js";
import { TRUSTED_REQUEST_ORIGIN_HEADER } from "../http/request-origin.js";
import type { InvitationMailer } from "../invitations/index.js";
import type { AccountMailer } from "./account-emails.js";
import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { createDatabase } from "../db/pg.js";
import {
  assertRefreshGrantCurrent,
  canonicalTokenResource,
  connectorOAuthEndpoints,
  connectorOAuthPlugins,
  protectedResourceMetadata,
  verifyConnectorAccessToken,
} from "../paseo-connector/oauth.js";
import { CONNECTOR_PRODUCT_NAME, ConnectorError } from "../paseo-connector/contracts.js";
import { reportFailure } from "../failures/index.js";
import {
  ConnectorFlowError,
  connectionClientName,
  decideConnectorConsent,
  describeConnectorConsent,
  listConnectorConnections,
  listConnectorMachines,
  listMemberDaemons,
  oauthClientName,
  revokeConnectorConnection,
  selectConnectorMachine,
  type ConnectorFlowContext,
  type ConnectorOAuthService,
} from "../paseo-connector/flow.js";

export interface AccountAuthentication {
  state: "complete" | "verificationRequired";
  /** The provider's re-signed continuation URL, only when authenticating a connector request. */
  redirectTo?: string;
}

export interface AuthServer {
  handle(request: Request): Promise<Response>;
  browserAccount?(request: Request): Promise<Response>;
  signInEmail?(
    data: { email: string; password: string; oauthQuery?: string | undefined },
    headers: Headers,
  ): Promise<AccountAuthentication>;
  signUpEmail?(
    data: { name: string; email: string; password: string; oauthQuery?: string | undefined },
    headers: Headers,
    invitationId?: string,
  ): Promise<AccountAuthentication>;
  sendVerificationEmail?(
    email: string,
    headers: Headers,
    invitationId?: string,
    oauthQuery?: string,
  ): Promise<void>;
  requestPasswordReset?(email: string, headers: Headers): Promise<void>;
  resetPassword?(data: { token: string; newPassword: string }, headers: Headers): Promise<void>;
  signOut?(headers: Headers): Promise<void>;
  changePassword?(
    data: { currentPassword: string; newPassword: string },
    headers: Headers,
  ): Promise<void>;
  /** Creates the first operator on a pristine instance and signs the browser in. */
  claimInstance?(operator: InitialOperator, headers: Headers): Promise<InstanceClaim>;
  completeAppOnboarding?(request: Request): Promise<void>;
  resources(
    request: Request,
    organizations: OrganizationResources,
  ): Promise<OrganizationResourceReader>;
  resolveOrganizationAccess(request: Request): Promise<OrganizationAccessValue>;
  resolveAccount(request: Request): Promise<AccountAccessValue>;
  rejectCookieMutation(request: Request): Response | undefined;
  initialize?(): Promise<void>;
  apiKeys?: OrganizationApiKeys;
  cliCredentials?: OrganizationCliCredentials;
  publicCredentials?: PublicCredentialAuthenticator;
  /**
   * The Paseo Agent Connector's OAuth surface; absent unless the operator enabled it and the public
   * origin is HTTPS or loopback.
   */
  connector?: ConnectorOAuthService;
  close(): Promise<void>;
}

export interface AuthServerOptions {
  database: DatabaseRuntime;
  locks: Locks;
  /** Owned by the composition root, injected here — auth consumes entitlements, never owns them. */
  entitlements: EntitlementsService;
  secret: string;
  baseURL: string;
  policy?: InstanceAuthPolicy;
  trustedClientIpHeader?: string;
  /** How a new organization is provisioned. Defaults to unlimited (self-hosted); the composition
   * root passes a billing-backed resolver when Stripe is configured. */
  provisioningEntitlements?: ProvisioningEntitlementResolver;
  /** Post-commit hook awaited after organization creation. Integration failures must never fail
   * or roll back the successfully created organization. Undefined self-hosted. */
  /** Post-commit hook fired when a membership change alters an organization's seat count. The
   * composition root wires billing's seat-quantity reporter here; undefined self-hosted. */
  onMembershipChanged?: (organizationId: string) => Promise<void>;
  /** Optional post-commit delivery for organization invitations. */
  invitationMailer?: InvitationMailer;
  /** Optional account email delivery. Configured public instances require verification. */
  accountMailer?: AccountMailer;
  /**
   * The operator's explicit opt-in to the Paseo Agent Connector (`PASEO_HUB_PASEO_CONNECTOR=enabled`).
   * Off by default: no OAuth provider, no client registration, no connector routes.
   */
  paseoConnector?: boolean;
}

const sessionSchema = z.object({
  session: z
    .object({
      id: z.string(),
      userId: z.string(),
      activeOrganizationId: z.string().nullable().optional(),
    })
    .passthrough(),
  user: z
    .object({
      id: z.string(),
      name: z.string(),
      email: z.string(),
      mustChangePassword: z.boolean().optional(),
      isInstanceOperator: z.boolean().optional(),
    })
    .passthrough(),
});

const RAW_PRODUCT_PATHS = new Set([
  "/api/auth/get-session",
  "/api/auth/sign-up/email",
  "/api/auth/sign-in/email",
  "/api/auth/sign-out",
  "/api/auth/change-password",
  "/api/auth/verify-email",
]);

/**
 * The OAuth provider endpoints an OAuth client reaches directly, when the connector is enabled.
 * Continue and consent stay closed: only the flow-aware connector functions drive them.
 */
const CONNECTOR_OAUTH_PATHS = new Map([
  ["/api/auth/oauth2/authorize", "GET"],
  ["/api/auth/oauth2/token", "POST"],
  ["/api/auth/oauth2/register", "POST"],
  ["/api/auth/oauth2/revoke", "POST"],
  ["/api/auth/jwks", "GET"],
]);

const FORM_MEDIA_TYPE = "application/x-www-form-urlencoded";

function tokenRequestError(error: string, description: string, status = 400): Response {
  return Response.json(
    { error, error_description: description },
    { status, headers: { "cache-control": "no-store" } },
  );
}

/** Authorization-server metadata members naming an endpoint, checked against what Hub serves. */
const METADATA_ENDPOINT_MEMBER = /^(?<name>.+)_endpoint$|^jwks_uri$/u;

export function createAuthServer(options: AuthServerOptions): AuthServer {
  const database = options.database.drizzle();
  const policy = options.policy ?? defaultInstanceAuthPolicy();
  const provisioningEntitlements =
    options.provisioningEntitlements ?? (() => Promise.resolve(UNLIMITED_PROVISIONING));
  const apiKeys = new OrganizationApiKeys(options.database, options.locks);
  const cliCredentials = new OrganizationCliCredentials(options.database);
  const publicCredentials = new PublicCredentialAuthenticator(apiKeys, cliCredentials);
  const registration = new RegistrationAdmission(options.database, options.locks, policy);
  const instanceSetup = new InstanceSetup({
    database: options.database,
    policy,
    provisioningEntitlements,
  });
  const appOnboarding = new InstanceAppOnboarding(options.database);
  const accountMailer = options.accountMailer;
  const authSchema = {
    user: schema.users,
    session: schema.sessions,
    account: schema.accounts,
    verification: schema.verifications,
    organization: schema.organizations,
    member: schema.members,
    invitation: schema.invitations,
    oauthClient: schema.oauthClients,
    oauthRefreshToken: schema.oauthRefreshTokens,
    oauthAccessToken: schema.oauthAccessTokens,
    oauthConsent: schema.oauthConsents,
    jwks: schema.jwks,
  };
  const connectorEndpoints =
    options.paseoConnector === true ? connectorOAuthEndpoints(options.baseURL) : undefined;
  const connectorDatabase =
    connectorEndpoints === undefined ? undefined : createDatabase(options.database, options.locks);
  const auth = betterAuth({
    baseURL: options.baseURL,
    secret: options.secret,
    ...(options.trustedClientIpHeader === undefined
      ? {}
      : {
          advanced: {
            ipAddress: {
              ipAddressHeaders: [options.trustedClientIpHeader],
            },
          },
        }),
    database: drizzleAdapter(database, { provider: "pg", schema: authSchema }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      requireEmailVerification: accountMailer !== undefined,
      revokeSessionsOnPasswordReset: true,
      ...(accountMailer === undefined
        ? {}
        : { sendResetPassword: (email) => accountMailer.sendPasswordReset(email) }),
    },
    ...(accountMailer === undefined
      ? {}
      : {
          emailVerification: {
            autoSignInAfterVerification: true,
            sendVerificationEmail: (email: Parameters<AccountMailer["sendVerificationEmail"]>[0]) =>
              accountMailer.sendVerificationEmail(email),
          },
        }),
    user: {
      additionalFields: {
        mustChangePassword: {
          type: "boolean",
          defaultValue: false,
          input: false,
          returned: true,
        },
        // The instance operator flag: read into the session so cross-org operator authorization
        // resolves from it. Granted only by instance setup or SQL — never client input — so
        // `input: false` keeps it off every sign-up/update body. Threaded like mustChangePassword.
        isInstanceOperator: {
          type: "boolean",
          defaultValue: false,
          input: false,
          returned: true,
        },
      },
    },
    plugins: [
      paseoOrganizationPlugin(),
      ...(connectorEndpoints === undefined || connectorDatabase === undefined
        ? []
        : connectorOAuthPlugins(connectorEndpoints, connectorDatabase)),
      tanstackStartCookies(),
    ],
  });
  const sessions = {
    async read(headers: Headers): Promise<AccountSession | undefined> {
      const value = await auth.api.getSession({ headers });
      const parsed = sessionSchema.safeParse(value);
      if (!parsed.success) return undefined;
      return {
        sessionId: parsed.data.session.id,
        userId: parsed.data.user.id,
        name: parsed.data.user.name,
        email: parsed.data.user.email,
        activeOrganizationId: parsed.data.session.activeOrganizationId ?? null,
        mustChangePassword: parsed.data.user.mustChangePassword ?? false,
        isInstanceOperator: parsed.data.user.isInstanceOperator ?? false,
      };
    },
  };
  const access = new OrganizationAccess({
    pool: options.database,
    locks: options.locks,
    sessions,
    baseURL: options.baseURL,
    policy,
    apiKeys,
    cliCredentials,
    entitlements: options.entitlements,
    instanceSetup,
    appOnboarding,
    provisioningEntitlements,
    ...(options.onMembershipChanged === undefined
      ? {}
      : { onMembershipChanged: options.onMembershipChanged }),
    ...(options.invitationMailer === undefined
      ? {}
      : { invitationMailer: options.invitationMailer }),
  });
  const browserOrigin = new URL(options.baseURL).origin;
  const connector = connectorService();

  return {
    async handle(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      if (connector !== undefined && CONNECTOR_OAUTH_PATHS.has(path)) {
        return connectorOAuthRequest(request, path);
      }
      if (path.startsWith("/api/auth/paseo/")) {
        const rejected = rejectCrossOriginCookieMutation(
          request,
          requestBrowserOrigin(request, browserOrigin),
        );
        if (rejected !== undefined) return Promise.resolve(rejected);
        return access.handle(request);
      }
      if (path === "/api/auth/sign-up/email") {
        return registration
          .handleSignUp(request, (admittedRequest) => signupAsBrowser(admittedRequest, request))
          .catch((error: unknown) => {
            if (error instanceof RegistrationAdmissionError) {
              return Response.json({ error: "registration_closed" }, { status: 403 });
            }
            throw error;
          });
      }
      if (path === "/api/auth/verify-email") {
        const response = await auth.handler(request);
        return continueVerifiedSignup(response, request.headers);
      }
      if (path === "/api/auth/change-password") {
        const rejected = rejectCrossOriginCookieMutation(
          request,
          requestBrowserOrigin(request, browserOrigin),
        );
        if (rejected !== undefined) return Promise.resolve(rejected);
        return changePassword(request);
      }
      if (!RAW_PRODUCT_PATHS.has(path) && !path.startsWith("/api/auth/reset-password/")) {
        return Promise.resolve(Response.json({ error: "not_found" }, { status: 404 }));
      }
      return auth.handler(request);
    },
    browserAccount: (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/auth/change-password") {
        const rejected = rejectCrossOriginCookieMutation(
          request,
          requestBrowserOrigin(request, browserOrigin),
        );
        return rejected === undefined ? changePassword(request) : Promise.resolve(rejected);
      }
      return access.handle(request);
    },
    async signInEmail(data, headers) {
      requireBrowserOrigin(headers, headersBrowserOrigin(headers, browserOrigin));
      const { oauthQuery, ...credentials } = data;
      const body = {
        ...credentials,
        ...(oauthQuery === undefined ? {} : { oauth_query: oauthQuery }),
      };
      const result = await auth.api.signInEmail({
        body,
        headers,
        // Provider authorization hooks read the browser request, including its headers.
        request: new Request(new URL("/api/auth/sign-in/email", options.baseURL), {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
        asResponse: false,
      });
      return authenticationResult(result, oauthQuery, "complete");
    },
    async signUpEmail(data, headers, invitationId) {
      requireBrowserOrigin(headers, headersBrowserOrigin(headers, browserOrigin));
      const { oauthQuery, ...credentials } = data;
      const body = {
        ...credentials,
        callbackURL: signupCallback(oauthQuery, invitationId),
        ...(oauthQuery === undefined ? {} : { oauth_query: oauthQuery }),
      };
      const result = await registration.withAdmission(data.email, invitationId, () =>
        auth.api.signUpEmail({
          body,
          headers,
          request: new Request(new URL("/api/auth/sign-up/email", options.baseURL), {
            method: "POST",
            headers,
            body: JSON.stringify(body),
          }),
          asResponse: false,
          returnHeaders: true,
        }),
      );
      const state = accountMailer === undefined ? "complete" : "verificationRequired";
      if (oauthQuery === undefined || state === "verificationRequired") return { state };
      const redirectTo = await continueCreatedAccount(
        result.response,
        result.headers,
        headers,
        invitationId,
      );
      return { state, redirectTo };
    },
    async sendVerificationEmail(email, headers, invitationId, oauthQuery) {
      requireBrowserOrigin(headers, headersBrowserOrigin(headers, browserOrigin));
      await auth.api.sendVerificationEmail({
        body: { email, callbackURL: signupCallback(oauthQuery, invitationId) },
        headers,
      });
    },
    async requestPasswordReset(email, headers) {
      requireBrowserOrigin(headers, headersBrowserOrigin(headers, browserOrigin));
      await auth.api.requestPasswordReset({
        body: { email, redirectTo: passwordResetCallback(options.baseURL) },
        headers,
      });
    },
    async resetPassword(data, headers) {
      requireBrowserOrigin(headers, headersBrowserOrigin(headers, browserOrigin));
      await auth.api.resetPassword({ body: data, headers });
    },
    async claimInstance(operator, headers) {
      requireBrowserOrigin(headers, headersBrowserOrigin(headers, browserOrigin));
      const claim = await instanceSetup.claim(operator);
      if (claim.status !== "claimed") return claim;
      // The account exists and owns the instance the moment the claim commits; signing in here
      // is what turns that into the operator's browser session. A failure past this point costs
      // them a sign-in, never the claim.
      await auth.api.signInEmail({
        body: { email: operator.email, password: operator.password },
        headers,
      });
      return claim;
    },
    async completeAppOnboarding(request) {
      const rejected = rejectCrossOriginCookieMutation(
        request,
        requestBrowserOrigin(request, browserOrigin),
      );
      if (rejected !== undefined) throw new Error("invalid origin");
      const account = await access.account(request);
      if (!account.isInstanceOperator) throw new Error("forbidden");
      await appOnboarding.complete();
    },
    async signOut(headers) {
      requireBrowserOrigin(headers, headersBrowserOrigin(headers, browserOrigin));
      await auth.api.signOut({ headers });
    },
    async changePassword(data, headers) {
      requireBrowserOrigin(headers, headersBrowserOrigin(headers, browserOrigin));
      const session = await sessions.read(headers);
      if (session === undefined) throw new Error("unauthenticated");
      await auth.api.changePassword({
        body: { ...data, revokeOtherSessions: true },
        headers,
      });
      await options.database.query(
        `update "user" set must_change_password = false, updated_at = now() where id = $1`,
        [session.userId],
      );
    },
    async resources(request, organizations) {
      return access.resources(request, organizations);
    },
    resolveOrganizationAccess: (request) => access.resolve(request),
    resolveAccount: (request) => access.account(request),
    rejectCookieMutation: (request) =>
      rejectCrossOriginCookieMutation(request, requestBrowserOrigin(request, browserOrigin)),
    initialize: () => instanceSetup.initializeFromPolicy(),
    apiKeys,
    cliCredentials,
    publicCredentials,
    ...(connector === undefined ? {} : { connector }),
    close: () => Promise.resolve(),
  };

  function connectorService(): ConnectorOAuthService | undefined {
    if (connectorEndpoints === undefined || connectorDatabase === undefined) return undefined;
    const endpoints = connectorEndpoints;
    const store = connectorDatabase;
    const libraryMetadata = oauthProviderAuthServerMetadata(auth);
    // Advertise only endpoints Hub actually serves: the library also lists introspection (and,
    // with openid, userinfo and end-session), which stay closed.
    const authorizationServerMetadata = async (request: Request): Promise<Response> => {
      const response = await libraryMetadata(request);
      if (!response.ok) return response;
      const metadata = z.record(z.string(), z.unknown()).parse(await response.json());
      for (const [member, value] of Object.entries(metadata)) {
        const match = METADATA_ENDPOINT_MEMBER.exec(member);
        if (match === null || typeof value !== "string") continue;
        if (CONNECTOR_OAUTH_PATHS.has(new URL(value).pathname)) continue;
        delete metadata[member];
        const name = match.groups?.["name"];
        if (name !== undefined) delete metadata[`${name}_endpoint_auth_methods_supported`];
      }
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(JSON.stringify(metadata), { status: response.status, headers });
    };
    const flow = async (headers: Headers): Promise<ConnectorFlowContext> => {
      const session = await sessions.read(headers);
      if (session === undefined) throw new ConnectorFlowError("unauthenticated");
      if (session.mustChangePassword) throw new ConnectorFlowError("password_change_required");
      return {
        database: store,
        account: { userId: session.userId, sessionId: session.sessionId },
        listMemberDaemons: (userId) => listMemberDaemons(options.database, userId),
        authorize: (path, body) => authorizeAsBrowser(path, body, headers),
        oauthClientName: (clientId) => oauthClientName(options.database, clientId),
        connectionClientName: (userId, connectionId) =>
          connectionClientName(options.database, userId, connectionId),
        now: () => new Date(),
      };
    };
    const mutation = async (headers: Headers): Promise<ConnectorFlowContext> => {
      requireBrowserOrigin(headers, headersBrowserOrigin(headers, browserOrigin));
      return flow(headers);
    };
    return {
      endpoints,
      authorizationServerMetadata,
      protectedResourceMetadata: () => Response.json(protectedResourceMetadata(endpoints)),
      verifyAccessToken: (token) =>
        verifyConnectorAccessToken(token, endpoints, () => auth.api.getJwks()),
      listMachines: async (headers) => listConnectorMachines(await flow(headers)),
      selectMachine: async (input, headers) =>
        selectConnectorMachine(await mutation(headers), input),
      decideConsent: async (input, headers) =>
        decideConnectorConsent(await mutation(headers), input),
      describeConsent: async (input, headers) =>
        describeConnectorConsent(await flow(headers), input),
      listConnections: async (headers) => listConnectorConnections(await flow(headers)),
      revokeConnection: async (input, headers) =>
        revokeConnectorConnection(await mutation(headers), input),
    };
  }

  function authenticationResult(
    result: unknown,
    oauthQuery: string | undefined,
    state: AccountAuthentication["state"],
  ): AccountAuthentication {
    if (oauthQuery === undefined) return { state };
    return { state, redirectTo: authenticationRedirect(result) };
  }

  /** Accept only the provider's signed Hub continuation, never a client-controlled redirect. */
  function authenticationRedirect(result: unknown): string {
    const parsed = z.object({ url: z.string() }).safeParse(result);
    if (!parsed.success) throw new ConnectorFlowError("authorization_failed");
    const url = new URL(parsed.data.url, browserOrigin);
    if (
      url.origin !== browserOrigin ||
      url.pathname !== "/oauth/connect" ||
      !url.searchParams.has("sig")
    ) {
      throw new ConnectorFlowError("authorization_failed");
    }
    return `${url.pathname}${url.search}`;
  }

  /** Invitation context is a browser fragment, never an edit to the provider's signed query. */
  function connectorInvitationRedirect(redirectTo: string, invitationId?: string): string {
    if (invitationId === undefined) return redirectTo;
    const url = new URL(redirectTo, browserOrigin);
    url.hash = new URLSearchParams({ invitation: invitationId }).toString();
    return `${url.pathname}${url.search}${url.hash}`;
  }

  function signupCallback(oauthQuery: string | undefined, invitationId?: string): string {
    if (connector === undefined || oauthQuery === undefined) {
      return accountCallback(options.baseURL, invitationId);
    }
    const query = oauthQuery.startsWith("?") ? oauthQuery : `?${oauthQuery}`;
    return new URL(
      connectorInvitationRedirect(`/oauth/connect${query}`, invitationId),
      browserOrigin,
    ).href;
  }

  /** Continue with the session the authentication endpoint just issued, not the previous account. */
  function authenticatedHeaders(responseHeaders: Headers, browserHeaders: Headers): Headers {
    const headers = new Headers(browserHeaders);
    headers.set(
      "cookie",
      responseHeaders
        .getSetCookie()
        .map((value) => value.split(";", 1)[0])
        .join("; "),
    );
    return headers;
  }

  async function continueCreatedAccount(
    result: unknown,
    responseHeaders: Headers,
    browserHeaders: Headers,
    invitationId?: string,
  ): Promise<string> {
    const next = authenticationRedirect(result);
    const url = new URL(next, browserOrigin);
    const redirectTo = await authorizeAsBrowser(
      "continue",
      { created: true, oauth_query: url.search },
      authenticatedHeaders(responseHeaders, browserHeaders),
    );
    return connectorInvitationRedirect(authenticationRedirect({ url: redirectTo }), invitationId);
  }

  async function signupAsBrowser(request: Request, originalRequest: Request): Promise<Response> {
    const body = z.record(z.string(), z.unknown()).parse(await request.clone().json());
    const oauthQuery = typeof body["oauth_query"] === "string" ? body["oauth_query"] : undefined;
    if (connector === undefined || oauthQuery === undefined) return auth.handler(request);
    const originalBody = z
      .record(z.string(), z.unknown())
      .parse(await originalRequest.clone().json());
    const invitationId =
      new URL(request.url).searchParams.get("invitation") ??
      (typeof originalBody["invitation"] === "string" ? originalBody["invitation"] : undefined);
    const response = await auth.handler(
      new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify({ ...body, callbackURL: signupCallback(oauthQuery, invitationId) }),
      }),
    );
    if (!response.ok || accountMailer !== undefined) return response;
    const redirectTo = await continueCreatedAccount(
      await response.clone().json(),
      response.headers,
      request.headers,
      invitationId,
    );
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return Response.json({ url: redirectTo, redirect: true }, { headers });
  }

  async function continueVerifiedSignup(
    response: Response,
    browserHeaders: Headers,
  ): Promise<Response> {
    if (connector === undefined || response.status !== 302) return response;
    const location = response.headers.get("location");
    if (location === null) return response;
    const callback = new URL(location, browserOrigin);
    if (
      callback.origin !== browserOrigin ||
      callback.pathname !== "/oauth/connect" ||
      !callback.searchParams.has("sig") ||
      !(callback.searchParams.get("prompt") ?? "").split(" ").includes("create")
    )
      return response;
    const headers = authenticatedHeaders(response.headers, browserHeaders);
    const session = await sessions.read(headers);
    if (session === undefined || session.mustChangePassword) return response;
    const user = await options.database.query<{ created_at: Date }>(
      'select created_at from "user" where id = $1',
      [session.userId],
    );
    const issuedAt = Number(callback.searchParams.get("ba_iat"));
    // Verification of an older account is not creation for this authorization request.
    if (
      !Number.isFinite(issuedAt) ||
      issuedAt <= 0 ||
      user.rows[0] === undefined ||
      new Date(user.rows[0].created_at).getTime() < issuedAt
    )
      return response;
    const next = await authorizeAsBrowser(
      "continue",
      { created: true, oauth_query: callback.search },
      headers,
    );
    const continued = new Headers(response.headers);
    const invitationId = new URLSearchParams(callback.hash.slice(1)).get("invitation") ?? undefined;
    continued.set(
      "location",
      connectorInvitationRedirect(authenticationRedirect({ url: next }), invitationId),
    );
    return new Response(response.body, { status: response.status, headers: continued });
  }

  /** Drives the library's continue/consent endpoint as the signed-in browser, cookie and all. */
  async function authorizeAsBrowser(
    path: "continue" | "consent",
    body: Record<string, unknown>,
    browserHeaders: Headers,
  ): Promise<string> {
    const response = await auth.handler(
      new Request(new URL(`/api/auth/oauth2/${path}`, options.baseURL), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          origin: browserOrigin,
          cookie: browserHeaders.get("cookie") ?? "",
        },
        body: JSON.stringify(body),
      }),
    );
    const result = z
      .object({ url: z.string().min(1), error: z.string().optional() })
      .partial()
      .safeParse(await response.json().catch(() => undefined));
    if (!response.ok || !result.success || result.data.url === undefined) {
      const reason = result.success ? (result.data.error ?? "") : "";
      throw new ConnectorFlowError(
        "authorization_failed",
        `oauth2/${path} returned HTTP ${response.status} ${reason}`.trim(),
      );
    }
    return result.data.url;
  }

  async function connectorOAuthRequest(request: Request, path: string): Promise<Response> {
    if (request.method !== CONNECTOR_OAUTH_PATHS.get(path)) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    if (request.method === "GET") return auth.handler(request);
    // Token, registration and revocation are OAuth client calls. Whatever cookie a browser
    // attaches, they are never cookie-authenticated.
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    if (path === "/api/auth/oauth2/token") {
      return connectorTokenRequest(request, headers);
    }
    const response = await auth.handler(
      new Request(request.url, { method: "POST", headers, body: await request.text() }),
    );
    if (path !== "/api/auth/oauth2/register" || response.status !== 200) return response;
    // RFC 7591 §3.2.1: a registered client is 201 Created and never cached. The pinned library
    // answers 200 and drops its own no-store header.
    const registered = new Headers(response.headers);
    registered.set("cache-control", "no-store");
    registered.set("pragma", "no-cache");
    return new Response(response.body, { status: 201, headers: registered });
  }

  /**
   * Admits a token request only as a plain form naming the connector as its one resource (or, for
   * a code or refresh grant, naming none: Hub applies its only resource), and hands the library
   * that form re-encoded with the canonical resource, so Hub and the library read the same fields.
   * The library never sees a request without the resource, which would mint an opaque token
   * outside the connector's claim checks; every token Hub issues is a connector JWT for exactly
   * this resource.
   */
  async function connectorTokenRequest(request: Request, headers: Headers): Promise<Response> {
    const mediaType = (request.headers.get("content-type") ?? "").split(";", 1)[0]!.trim();
    if (mediaType.toLowerCase() !== FORM_MEDIA_TYPE) {
      return tokenRequestError("invalid_request", "the token request must be a form");
    }
    const form = new URLSearchParams(await request.text());
    const resource =
      connectorEndpoints === undefined
        ? undefined
        : canonicalTokenResource(
            connectorEndpoints,
            form.get("grant_type"),
            form.getAll("resource"),
          );
    if (resource === undefined) {
      return tokenRequestError(
        "invalid_target",
        `resource must be the ${CONNECTOR_PRODUCT_NAME} MCP endpoint`,
      );
    }
    form.set("resource", resource);
    if (form.get("grant_type") === "refresh_token") {
      const refused = await refreshGrantRefusal(form.get("refresh_token"));
      if (refused !== undefined) return refused;
    }
    headers.set("content-type", FORM_MEDIA_TYPE);
    headers.delete("content-length");
    return auth.handler(
      new Request(request.url, { method: "POST", headers, body: form.toString() }),
    );
  }

  /**
   * Refuses a refresh whose connection grant is no longer current before the library rotates the
   * presented refresh token, so a refusal (or Hub's own outage) never spends it. A dead grant is
   * invalid_grant; failing to read the grant is 503, never invalid_grant.
   */
  async function refreshGrantRefusal(presented: string | null): Promise<Response | undefined> {
    if (presented === null || presented === "" || connectorDatabase === undefined) return undefined;
    try {
      await assertRefreshGrantCurrent(options.database, connectorDatabase, presented, new Date());
      return undefined;
    } catch (error) {
      if (error instanceof ConnectorError) {
        return tokenRequestError(
          "invalid_grant",
          "the connector connection is no longer authorized",
        );
      }
      reportFailure(error, {
        operation: "paseo_connector.token.refresh_grant",
        component: "paseo_connector",
      });
      return tokenRequestError(
        "temporarily_unavailable",
        "the authorization server could not check this grant; retry later",
        503,
      );
    }
  }

  async function changePassword(request: Request): Promise<Response> {
    const session = await sessions.read(request.headers);
    const body = await request
      .clone()
      .json()
      .then((value: unknown) => value)
      .catch(() => undefined);
    const response =
      typeof body === "object" && body !== null
        ? await auth.handler(
            new Request(request.url, {
              method: "POST",
              headers: request.headers,
              body: JSON.stringify({ ...body, revokeOtherSessions: true }),
            }),
          )
        : await auth.handler(request);
    if (response.ok && session !== undefined) {
      await options.database.query(`update "user" set must_change_password = false where id = $1`, [
        session.userId,
      ]);
    }
    return response;
  }
}

function requestBrowserOrigin(request: Request, fallback: string): string {
  return headersBrowserOrigin(request.headers, fallback);
}

function accountCallback(baseURL: string, invitationId?: string): string {
  const callback = new URL("/", baseURL);
  callback.searchParams.set("auth", "email-verification");
  if (invitationId !== undefined) callback.searchParams.set("invitation", invitationId);
  return callback.toString();
}

function passwordResetCallback(baseURL: string): string {
  const callback = new URL("/", baseURL);
  callback.searchParams.set("auth", "password-reset");
  return callback.toString();
}

function headersBrowserOrigin(headers: Headers, fallback: string): string {
  const trusted = headers.get(TRUSTED_REQUEST_ORIGIN_HEADER);
  if (trusted === null) return fallback;
  const url = new URL(trusted);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("invalid trusted request origin");
  }
  return url.origin;
}

function requireBrowserOrigin(headers: Headers, browserOrigin: string): void {
  const suppliedOrigin = headers.get("origin") ?? headers.get("referer");
  if (suppliedOrigin === null || suppliedOrigin === "null") throw new Error("invalid origin");
  try {
    if (new URL(suppliedOrigin).origin === browserOrigin) return;
  } catch {
    // Invalid browser origins are rejected below.
  }
  throw new Error("invalid origin");
}

function rejectCrossOriginCookieMutation(
  request: Request,
  browserOrigin: string,
): Response | undefined {
  if (request.method !== "POST" || !request.headers.has("cookie")) return undefined;
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return authBoundaryError(
      "Cross-site navigation login blocked. This request appears to be a CSRF attack.",
      "CROSS_SITE_NAVIGATION_LOGIN_BLOCKED",
    );
  }
  const suppliedOrigin = request.headers.get("origin") ?? request.headers.get("referer");
  if (suppliedOrigin === null || suppliedOrigin === "null") {
    return authBoundaryError("Missing or null Origin", "MISSING_OR_NULL_ORIGIN");
  }
  try {
    if (new URL(suppliedOrigin).origin === browserOrigin) return undefined;
  } catch {
    // Invalid browser origins fail through the same public boundary as hostile origins.
  }
  return authBoundaryError("Invalid origin", "INVALID_ORIGIN");
}

function authBoundaryError(message: string, code: string): Response {
  return Response.json({ message, code }, { status: 403 });
}
