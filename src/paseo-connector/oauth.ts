import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { getOAuthProviderState, oauthProvider } from "@better-auth/oauth-provider";
import { APIError } from "better-auth/api";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import { jwt } from "better-auth/plugins";
import type { DatabaseRuntime } from "../db/runtime/index.js";
import type { Database } from "../db/types.js";
import { loadCurrentConnection, type ConnectorPrincipal } from "./authorization.js";
import {
  CONNECTOR_PRODUCT_NAME,
  CONNECTOR_SCOPES,
  ConnectorError,
  type ConsentFlow,
} from "./contracts.js";

export const CONNECTOR_RESOURCE_PATH = "/mcp/paseo";
export const CONNECTOR_CONNECT_PAGE = "/oauth/connect";
export const CONNECTOR_CONSENT_PAGE = "/oauth/consent";
/** The only scope a connector token may carry beyond the connection's own connector scopes. */
export const OFFLINE_ACCESS_SCOPE = "offline_access";
export const CONNECTOR_OAUTH_SCOPES = [...CONNECTOR_SCOPES, OFFLINE_ACCESS_SCOPE] as const;

/** The one issuer and one resource a Hub instance's connector speaks for. */
export interface ConnectorOAuthEndpoints {
  issuer: string;
  resource: string;
  /** RFC 9728 metadata location for `resource`. */
  resourceMetadataUrl: string;
  /** The namespaced access-token claim carrying the immutable connection reference. */
  connectionClaim: string;
}

/** The operator's explicit switch for the connector. Off unless set to `enabled`. */
export const PASEO_CONNECTOR_ENVIRONMENT = "PASEO_HUB_PASEO_CONNECTOR";
const PASEO_CONNECTOR_MODES = ["enabled", "disabled"] as const;

/**
 * Whether the operator opted in to the connector. Unset or blank means disabled; any value other
 * than `enabled` or `disabled` is a startup error, like Hub's other mode settings.
 */
export function readPaseoConnectorEnabled(
  environment: Record<string, string | undefined>,
): boolean {
  const value = environment[PASEO_CONNECTOR_ENVIRONMENT]?.trim() ?? "";
  if (value === "" || value === "disabled") return false;
  if (value === "enabled") return true;
  throw new Error(
    `${PASEO_CONNECTOR_ENVIRONMENT} must be one of: ${PASEO_CONNECTOR_MODES.join(", ")}`,
  );
}

/**
 * Derives the connector's issuer and resource from Hub's public origin, or undefined when the
 * connector must stay disabled: OAuth tokens are only issued over HTTPS, or plain HTTP on loopback.
 * The operator's opt-in (`readPaseoConnectorEnabled`) is checked separately, before this.
 */
export function connectorOAuthEndpoints(publicOrigin: string): ConnectorOAuthEndpoints | undefined {
  const url = new URL(publicOrigin);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return undefined;
  const issuer = url.origin;
  const resource = new URL(CONNECTOR_RESOURCE_PATH, issuer).href;
  return {
    issuer,
    resource,
    resourceMetadataUrl: new URL(
      `/.well-known/oauth-protected-resource${CONNECTOR_RESOURCE_PATH}`,
      issuer,
    ).href,
    connectionClaim: `${issuer}/claims/paseo-connection`,
  };
}

/** Reads Hub's own JSON Web Key Set in process. */
export type ConnectorJwksSource = Exclude<
  Parameters<typeof verifyJwsAccessToken>[1]["jwksFetch"],
  string
>;

const consentFlows = new AsyncLocalStorage<ConsentFlow>();

/**
 * Runs one continue/consent call of the OAuth library with the selected flow bound to this request
 * only. The library's callbacks read it back; nothing is stored on the user or the session, so two
 * tabs of one session can never see each other's selection.
 */
export function withConsentFlow<T>(flow: ConsentFlow, action: () => Promise<T>): Promise<T> {
  return consentFlows.run(flow, action);
}

/**
 * Binds a flow to one authorization request: client, redirect, state, PKCE challenge, scopes and
 * resource. The signature, expiry and prompt bookkeeping parameters are deliberately left out, so
 * the library's re-signed consent query fingerprints the same as the selection query.
 */
export function authorizationFingerprint(query: URLSearchParams | string): string {
  const params = typeof query === "string" ? new URLSearchParams(query) : query;
  const scope = [...new Set((params.get("scope") ?? "").split(" ").filter(Boolean))].sort();
  const canonical = {
    client_id: params.get("client_id"),
    redirect_uri: params.get("redirect_uri"),
    state: params.get("state"),
    code_challenge: params.get("code_challenge"),
    code_challenge_method: params.get("code_challenge_method"),
    scope,
    resource: params.getAll("resource").sort(),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** The request-local flow, only when it belongs to this session and this authorization request. */
async function matchingFlow(sessionId: string, userId?: string): Promise<ConsentFlow | undefined> {
  const flow = consentFlows.getStore();
  if (flow === undefined || flow.sessionId !== sessionId) return undefined;
  if (userId !== undefined && flow.ownerUserId !== userId) return undefined;
  if (flow.consumedAt !== null || flow.expiresAt.getTime() <= Date.now()) return undefined;
  const state = await getOAuthProviderState().catch(() => null);
  if (state?.query === undefined) return undefined;
  return authorizationFingerprint(state.query) === flow.authorizationFingerprint ? flow : undefined;
}

/** `postLogin.shouldRedirect`: every authorization goes to machine selection unless a flow is bound. */
export async function needsConnectorSelection(sessionId: string): Promise<boolean> {
  return (await matchingFlow(sessionId)) === undefined;
}

/** `postLogin.consentReferenceId`: the selected connection, or a hard failure without one. */
export async function currentConsentConnection(userId: string, sessionId: string): Promise<string> {
  const flow = await matchingFlow(sessionId, userId);
  if (flow === undefined) {
    throw new APIError("BAD_REQUEST", {
      error: "invalid_request",
      error_description: "select a machine before consenting",
    });
  }
  return flow.connectionId;
}

/**
 * Proves a token grant is still current when the library mints an access token (code exchange and
 * every refresh): the connection is live and every requested scope is either one of the
 * connection's stored connector scopes or `offline_access`.
 */
export async function assertGrantCurrent(
  database: Database,
  userId: string,
  connectionId: string,
  requestedScopes: readonly string[],
): Promise<void> {
  const { connection } = await loadCurrentConnection(database, userId, connectionId);
  const granted = new Set<string>([...connection.scopes, OFFLINE_ACCESS_SCOPE]);
  const widened = requestedScopes.filter((scope) => !granted.has(scope));
  if (widened.length > 0) {
    throw new ConnectorError(
      "insufficient_scope",
      `scopes exceed the connection: ${widened.join(" ")}`,
    );
  }
}

/** A stored refresh token row, as far as the connector's grant check needs it. */
export interface StoredRefreshGrant {
  userId: string;
  referenceId: string | null;
  scopes: readonly string[];
  revoked: Date | null;
  expiresAt: Date;
}

/**
 * Finds the refresh token a client presented the way the pinned OAuth provider stores it: no
 * prefix and no custom format are configured, and `storeTokens` defaults to "hashed", which is
 * unpadded base64url SHA-256 of the token (`defaultHasher`/`getStoredToken` in
 * node_modules/@better-auth/oauth-provider/dist/utils-*.mjs; lookup in `handleRefreshTokenGrant`).
 */
export async function findRefreshGrant(
  runtime: DatabaseRuntime,
  presentedToken: string,
): Promise<StoredRefreshGrant | undefined> {
  const stored = createHash("sha256").update(presentedToken).digest("base64url");
  const result = await runtime.query<{
    user_id: string;
    reference_id: string | null;
    scopes: string[];
    revoked: Date | null;
    expires_at: Date;
  }>(
    `select user_id, reference_id, scopes, revoked, expires_at
     from oauth_refresh_token where token = $1`,
    [stored],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  return {
    userId: row.user_id,
    referenceId: row.reference_id,
    scopes: row.scopes,
    revoked: row.revoked === null ? null : new Date(row.revoked),
    expiresAt: new Date(row.expires_at),
  };
}

/**
 * Proves a presented refresh token's connection grant is still current BEFORE the library sees the
 * request. The library rotates (revokes) the old refresh token in parallel with minting the access
 * token, so a check that fails only inside `customAccessTokenClaims` would already have spent the
 * token. Unknown, expired and already-rotated tokens pass through: the library refuses those
 * itself, and its reuse detection stays the library's. Throws ConnectorError when the grant is
 * dead; any other error is an infrastructure failure.
 */
export async function assertRefreshGrantCurrent(
  runtime: DatabaseRuntime,
  database: Database,
  presentedToken: string,
  now: Date,
): Promise<void> {
  const grant = await findRefreshGrant(runtime, presentedToken);
  if (grant === undefined || grant.revoked !== null || grant.expiresAt <= now) return;
  if (grant.referenceId === null) throw new ConnectorError("not_found", "not a connector grant");
  await assertGrantCurrent(database, grant.userId, grant.referenceId, grant.scopes);
}

/** The Better Auth plugins that make Hub the connector's authorization server. */
export function connectorOAuthPlugins(endpoints: ConnectorOAuthEndpoints, database: Database) {
  return [
    jwt({ jwt: { issuer: endpoints.issuer }, disableSettingJwtHeader: true }),
    oauthProvider({
      // Hub's sign-in form renders on the connect page itself, so a signed-out visitor signs in and
      // lands on machine selection with the signed authorization query intact.
      loginPage: CONNECTOR_CONNECT_PAGE,
      consentPage: CONNECTOR_CONSENT_PAGE,
      scopes: [...CONNECTOR_OAUTH_SCOPES],
      grantTypes: ["authorization_code", "refresh_token"],
      validAudiences: [endpoints.resource],
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      silenceWarnings: { oauthAuthServerConfig: true },
      postLogin: {
        page: CONNECTOR_CONNECT_PAGE,
        shouldRedirect: ({ session }) => needsConnectorSelection(session.id),
        consentReferenceId: ({ user, session }) => currentConsentConnection(user.id, session.id),
      },
      customAccessTokenClaims: async ({ user, referenceId, resource, scopes }) => {
        try {
          if (!user || !referenceId || resource !== endpoints.resource) {
            throw new ConnectorError("not_found", "not a connector grant");
          }
          await assertGrantCurrent(database, user.id, referenceId, scopes);
        } catch (error) {
          // A dead grant is the client's to re-link. Anything else (the database, say) is Hub's
          // failure and must surface as a server error, never as invalid_grant.
          if (!(error instanceof ConnectorError)) throw error;
          throw new APIError("BAD_REQUEST", {
            error: "invalid_grant",
            error_description: "the connector connection is no longer authorized",
          });
        }
        return { [endpoints.connectionClaim]: referenceId };
      },
    }),
  ];
}

/** RFC 9728 protected-resource metadata for the connector MCP endpoint. */
export function protectedResourceMetadata(endpoints: ConnectorOAuthEndpoints) {
  return {
    resource: endpoints.resource,
    resource_name: CONNECTOR_PRODUCT_NAME,
    authorization_servers: [endpoints.issuer],
    scopes_supported: [...CONNECTOR_SCOPES],
    bearer_methods_supported: ["header"],
  };
}

/**
 * The `WWW-Authenticate` value a refused connector MCP request is answered with. RFC 6750 §3.1: a
 * request that presented no token gets no error code; a presented token that failed gets one.
 */
export function connectorChallenge(
  endpoints: ConnectorOAuthEndpoints,
  error?: "invalid_token" | "insufficient_scope",
): string {
  const challenge = `Bearer resource_metadata="${endpoints.resourceMetadataUrl}"`;
  return error === undefined ? challenge : `${challenge}, error="${error}"`;
}

/** 401 for a missing token, or for a presented one that is invalid, expired or foreign. */
export function unauthorizedConnectorResponse(
  endpoints: ConnectorOAuthEndpoints,
  tokenPresented: boolean,
): Response {
  return Response.json(
    { error: "invalid_token" },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": connectorChallenge(
          endpoints,
          tokenPresented ? "invalid_token" : undefined,
        ),
      },
    },
  );
}

/** Hub could not read what it needs to judge a token: not the token's fault, so never a 401. */
export class ConnectorUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConnectorUnavailableError";
  }
}

/**
 * Verifies a bearer token as a connector access token in process: an EdDSA JWS from this Hub's own
 * JWKS with exactly this issuer, this resource as audience, an unexpired `exp`, a subject, and the
 * connection claim. Anything else (opaque OAuth tokens, API keys, CLI credentials, enrollment
 * tokens, another resource's token) is null. Callers still run `authorizeConnectorRequest`.
 * Throws ConnectorUnavailableError when Hub's own signing keys cannot be read.
 */
export async function verifyConnectorAccessToken(
  token: string,
  endpoints: ConnectorOAuthEndpoints,
  jwks: ConnectorJwksSource,
): Promise<ConnectorPrincipal | null> {
  let jwksFailure: { error: unknown } | undefined;
  const jwksFetch: ConnectorJwksSource = async () => {
    try {
      return await jwks();
    } catch (error) {
      jwksFailure = { error };
      throw error;
    }
  };
  let payload: Record<string, unknown>;
  try {
    payload = await verifyJwsAccessToken(token, {
      jwksFetch,
      verifyOptions: {
        issuer: endpoints.issuer,
        audience: endpoints.resource,
        algorithms: ["EdDSA"],
        requiredClaims: ["exp", "sub", "aud", "iss"],
      },
    });
  } catch {
    if (jwksFailure !== undefined) {
      throw new ConnectorUnavailableError("signing keys could not be read", {
        cause: jwksFailure.error,
      });
    }
    return null;
  }
  const connectionId = payload[endpoints.connectionClaim];
  const userId = payload["sub"];
  const scope = payload["scope"];
  if (typeof connectionId !== "string" || connectionId.length === 0) return null;
  if (typeof userId !== "string" || userId.length === 0) return null;
  return {
    userId,
    connectionId,
    scopes: typeof scope === "string" ? scope.split(" ").filter(Boolean) : [],
  };
}

/** What connector routes answer when the connector cannot serve: 503 without a database, else 404. */
export function connectorUnavailableResponse(
  status: "database_unavailable" | "disabled",
): Response {
  return status === "database_unavailable"
    ? Response.json({ error: "database_unavailable" }, { status: 503 })
    : Response.json({ error: "not_found" }, { status: 404 });
}
