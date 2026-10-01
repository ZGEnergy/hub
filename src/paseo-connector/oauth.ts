import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { getOAuthProviderState, oauthProvider } from "@better-auth/oauth-provider";
import { APIError } from "better-auth/api";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import { jwt } from "better-auth/plugins";
import type { Database } from "../db/types.js";
import { loadCurrentConnection, type ConnectorPrincipal } from "./authorization.js";
import { CONNECTOR_SCOPES, type ConsentFlow } from "./contracts.js";

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

/**
 * Derives the connector's issuer and resource from Hub's public origin, or undefined when the
 * connector must stay disabled: OAuth tokens are only issued over HTTPS, or plain HTTP on loopback.
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
  if (widened.length > 0) throw new Error(`scopes exceed the connection: ${widened.join(" ")}`);
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
            throw new Error("not a connector grant");
          }
          await assertGrantCurrent(database, user.id, referenceId, scopes);
        } catch {
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
    authorization_servers: [endpoints.issuer],
    scopes_supported: [...CONNECTOR_SCOPES],
    bearer_methods_supported: ["header"],
  };
}

/** The `WWW-Authenticate` value an unauthenticated connector MCP request is answered with. */
export function connectorChallenge(endpoints: ConnectorOAuthEndpoints): string {
  return `Bearer resource_metadata="${endpoints.resourceMetadataUrl}"`;
}

export function unauthorizedConnectorResponse(endpoints: ConnectorOAuthEndpoints): Response {
  return Response.json(
    { error: "invalid_token" },
    { status: 401, headers: { "WWW-Authenticate": connectorChallenge(endpoints) } },
  );
}

/**
 * Verifies a bearer token as a connector access token in process: an EdDSA JWS from this Hub's own
 * JWKS with exactly this issuer, this resource as audience, an unexpired `exp`, a subject, and the
 * connection claim. Anything else (opaque OAuth tokens, API keys, CLI credentials, enrollment
 * tokens, another resource's token) is null. Callers still run `authorizeConnectorRequest`.
 */
export async function verifyConnectorAccessToken(
  token: string,
  endpoints: ConnectorOAuthEndpoints,
  jwks: ConnectorJwksSource,
): Promise<ConnectorPrincipal | null> {
  let payload: Record<string, unknown>;
  try {
    payload = await verifyJwsAccessToken(token, {
      jwksFetch: jwks,
      verifyOptions: {
        issuer: endpoints.issuer,
        audience: endpoints.resource,
        algorithms: ["EdDSA"],
        requiredClaims: ["exp", "sub", "aud", "iss"],
      },
    });
  } catch {
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
