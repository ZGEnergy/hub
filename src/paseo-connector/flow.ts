import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { Database } from "../db/types.js";
import type { DatabaseRuntime } from "../db/runtime/index.js";
import {
  CONNECTOR_MANAGER_ROLES,
  isConnectorScope,
  requireConnectableDaemon,
  type ConnectorPrincipal,
} from "./authorization.js";
import {
  CONNECTOR_FLOW_PARAM,
  ConnectorError,
  type ConnectorScope,
  type ConsentFlow,
} from "./contracts.js";
import {
  CONNECTOR_CONSENT_PAGE,
  OFFLINE_ACCESS_SCOPE,
  authorizationFingerprint,
  withConsentFlow,
  type ConnectorOAuthEndpoints,
} from "./oauth.js";

export { CONNECTOR_FLOW_PARAM };
const FLOW_LIFETIME_MS = 10 * 60_000;
const MAX_WORKING_DIRECTORY_LENGTH = 4096;

export type ConnectorFlowErrorCode =
  | "unauthenticated"
  | "invalid_request"
  | "flow_not_found"
  | "authorization_failed";

export class ConnectorFlowError extends Error {
  constructor(
    readonly code: ConnectorFlowErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "ConnectorFlowError";
  }
}

/** A machine the signed-in user may bind a connection to. */
export interface ConnectorMachine {
  daemonId: string;
  name: string;
  organizationId: string;
  organizationName: string;
  presence: "offline" | "connected";
  /** False when the daemon was enrolled without `hub.execute`; such a machine cannot be selected. */
  canRunHubWork: boolean;
}

export interface ConnectorConnectionSummary {
  connectionId: string;
  organizationId: string;
  daemonId: string;
  /** The machine's current name, or null once its daemon record is gone. */
  machineName: string | null;
  workingDirectory: string;
  scopes: readonly ConnectorScope[];
  createdAt: Date;
  activatedAt: Date;
  revokedAt: Date | null;
}

export interface SelectConnectorMachineInput {
  /** The query string of the connect page exactly as the authorization server signed it. */
  oauthQuery: string;
  daemonId: string;
  workingDirectory: string;
}

export interface ConnectorConsentInput {
  /** The query string of the consent page exactly as the authorization server signed it. */
  oauthQuery: string;
  flowId: string;
  accept: boolean;
}

export interface DescribeConnectorConsentInput {
  /** The query string of the consent page exactly as the authorization server signed it. */
  oauthQuery: string;
  flowId: string;
}

/** What the consent page shows about this session's pending flow. Display data only. */
export interface ConnectorConsentSummary {
  /** The name the OAuth client registered for itself, unverified; null when it gave none. */
  clientName: string | null;
  /** Where the browser and the code go after the decision, from the signed `redirect_uri`. */
  redirectTarget: string | null;
  machineName: string;
  organizationName: string;
  workingDirectory: string;
  scopes: readonly ConnectorScope[];
  /** The client asked for `offline_access`: it may stay connected until revoked. */
  staysConnected: boolean;
}

/** Where the browser goes next: the consent page, or the OAuth client's redirect URI. */
export interface ConnectorRedirect {
  redirectTo: string;
}

/** One signed-in browser request's view of the connector flow. */
export interface ConnectorFlowContext {
  database: Database;
  account: { userId: string; sessionId: string };
  listMemberDaemons(userId: string): Promise<readonly ConnectorMachine[]>;
  /** Calls the OAuth library's continue or consent endpoint as this browser; returns its URL. */
  authorize(path: "continue" | "consent", body: Record<string, unknown>): Promise<string>;
  /** The registered `client_name` of an OAuth client, or null. */
  oauthClientName(clientId: string): Promise<string | null>;
  now(): Date;
}

export function listConnectorMachines(
  context: ConnectorFlowContext,
): Promise<readonly ConnectorMachine[]> {
  return context.listMemberDaemons(context.account.userId);
}

/**
 * Binds the user's chosen machine and directory to this one authorization request, then continues
 * it through the library, which verifies the signed query and redirects to consent.
 */
export async function selectConnectorMachine(
  context: ConnectorFlowContext,
  input: SelectConnectorMachineInput,
): Promise<ConnectorRedirect> {
  const { userId, sessionId } = context.account;
  const oauthQuery = librarySignedQuery(input.oauthQuery);
  const params = new URLSearchParams(oauthQuery);
  const workingDirectory = explicitWorkingDirectory(input.workingDirectory);
  const scopes = requestedConnectorScopes(params);
  if (scopes.length === 0) {
    throw new ConnectorFlowError("invalid_request", "no connector scope was requested");
  }
  const now = context.now();
  const signedExpiry = Number(params.get("exp")) * 1000;
  if (!Number.isFinite(signedExpiry) || signedExpiry <= now.getTime()) {
    throw new ConnectorFlowError("invalid_request", "the authorization request expired");
  }
  const machine = (await context.listMemberDaemons(userId)).find(
    ({ daemonId }) => daemonId === input.daemonId,
  );
  if (machine === undefined) throw new ConnectorFlowError("invalid_request", "unknown machine");
  await requireConnectableDaemon(
    context.database,
    userId,
    machine.organizationId,
    machine.daemonId,
  );

  const connectionId = randomUUID();
  await context.database.connector.createConnection({
    connectionId,
    ownerUserId: userId,
    organizationId: machine.organizationId,
    daemonId: machine.daemonId,
    workingDirectory,
    scopes,
    createdAt: now,
    activatedAt: null,
    revokedAt: null,
  });
  const flow: ConsentFlow = {
    id: randomUUID(),
    sessionId,
    ownerUserId: userId,
    authorizationFingerprint: authorizationFingerprint(params),
    connectionId,
    expiresAt: new Date(Math.min(signedExpiry, now.getTime() + FLOW_LIFETIME_MS)),
    consumedAt: null,
  };
  try {
    await context.database.connector.createFlow(flow);
    const next = await withConsentFlow(flow, () =>
      context.authorize("continue", { postLogin: true, oauth_query: oauthQuery }),
    );
    const consent = new URL(next, "http://hub.invalid");
    if (consent.origin !== "http://hub.invalid" || consent.pathname !== CONNECTOR_CONSENT_PAGE) {
      throw new ConnectorFlowError("authorization_failed", "authorization did not reach consent");
    }
    consent.searchParams.set(CONNECTOR_FLOW_PARAM, flow.id);
    return { redirectTo: `${consent.pathname}${consent.search}` };
  } catch (error) {
    // A rejected signature or any other continue failure leaves nothing pending behind.
    await context.database.connector.discardPendingConnection(userId, connectionId);
    throw error;
  }
}

/**
 * Records the user's consent decision for the flow they selected in this session. Approval issues
 * the authorization code and activates the connection in the same step that consumes the flow;
 * denial returns the library's access_denied redirect and discards the never-activated connection.
 */
export async function decideConnectorConsent(
  context: ConnectorFlowContext,
  input: ConnectorConsentInput,
): Promise<ConnectorRedirect> {
  const { userId, sessionId } = context.account;
  const { flow, oauthQuery, now } = await pendingFlow(context, input);
  if (!input.accept) {
    const denied = await withConsentFlow(flow, () =>
      context.authorize("consent", { accept: false, oauth_query: oauthQuery }),
    );
    // Denial is final: the pending connection and its flow are gone, so nothing can accept later.
    await context.database.connector.discardPendingConnection(userId, flow.connectionId);
    return { redirectTo: denied };
  }
  const connection = await context.database.connector.findConnection(userId, flow.connectionId);
  if (
    connection === undefined ||
    connection.revokedAt !== null ||
    connection.activatedAt !== null
  ) {
    throw new ConnectorFlowError("flow_not_found", "this authorization is no longer pending");
  }
  await requireConnectableDaemon(
    context.database,
    userId,
    connection.organizationId,
    connection.daemonId,
  );
  const requested = new URLSearchParams(oauthQuery).get("scope")?.split(" ") ?? [];
  const scope = [
    ...connection.scopes,
    ...(requested.includes(OFFLINE_ACCESS_SCOPE) ? [OFFLINE_ACCESS_SCOPE] : []),
  ].join(" ");
  const redirectTo = await withConsentFlow(flow, () =>
    context.authorize("consent", { accept: true, scope, oauth_query: oauthQuery }),
  );
  // Only a code redirect completes the flow; an error redirect goes back to the client unconsumed.
  if (!new URL(redirectTo, "http://hub.invalid").searchParams.has("code")) return { redirectTo };
  if (!(await context.database.connector.consumeFlow(userId, sessionId, flow.id, now))) {
    throw new ConnectorFlowError("flow_not_found", "this authorization is no longer pending");
  }
  return { redirectTo };
}

/**
 * The consent page's view of the flow this session selected, under the same session, owner,
 * flow-id, fingerprint and expiry checks as the decision. The client id and redirect URI come from
 * the signed query, which the fingerprint ties to the selection the library already verified.
 */
export async function describeConnectorConsent(
  context: ConnectorFlowContext,
  input: DescribeConnectorConsentInput,
): Promise<ConnectorConsentSummary> {
  const { userId } = context.account;
  const { flow, oauthQuery } = await pendingFlow(context, input);
  const connection = await context.database.connector.findConnection(userId, flow.connectionId);
  if (
    connection === undefined ||
    connection.revokedAt !== null ||
    connection.activatedAt !== null
  ) {
    throw new ConnectorFlowError("flow_not_found", "this authorization is no longer pending");
  }
  const machine = (await context.listMemberDaemons(userId)).find(
    ({ daemonId, organizationId }) =>
      daemonId === connection.daemonId && organizationId === connection.organizationId,
  );
  if (machine === undefined) throw new ConnectorError("not_found");
  const params = new URLSearchParams(oauthQuery);
  const clientId = params.get("client_id");
  return {
    clientName: clientId === null ? null : await context.oauthClientName(clientId),
    redirectTarget: redirectDestination(params.get("redirect_uri")),
    machineName: machine.name,
    organizationName: machine.organizationName,
    workingDirectory: connection.workingDirectory,
    scopes: connection.scopes,
    staysConnected: (params.get("scope") ?? "").split(" ").includes(OFFLINE_ACCESS_SCOPE),
  };
}

/** This session's unconsumed, unexpired flow whose fingerprint matches the signed query. */
async function pendingFlow(
  context: ConnectorFlowContext,
  input: { oauthQuery: string; flowId: string },
): Promise<{ flow: ConsentFlow; oauthQuery: string; now: Date }> {
  const { userId, sessionId } = context.account;
  const oauthQuery = librarySignedQuery(input.oauthQuery);
  const now = context.now();
  const flow = await context.database.connector.findFlow(userId, sessionId, input.flowId);
  if (
    flow === undefined ||
    flow.consumedAt !== null ||
    flow.expiresAt.getTime() <= now.getTime() ||
    authorizationFingerprint(oauthQuery) !== flow.authorizationFingerprint
  ) {
    throw new ConnectorFlowError("flow_not_found", "this authorization is no longer pending");
  }
  return { flow, oauthQuery, now };
}

/**
 * Where a redirect URI sends the browser, for display: its origin, or for a custom scheme (whose
 * URL origin is the opaque string "null") its scheme and host, or the scheme alone.
 */
export function redirectDestination(value: string | null): string | null {
  if (value === null || !URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.origin !== "null") return url.origin;
  return url.host === "" ? url.protocol : `${url.protocol}//${url.host}`;
}

export async function listConnectorConnections(
  context: ConnectorFlowContext,
): Promise<readonly ConnectorConnectionSummary[]> {
  const connections = await context.database.connector.listConnections(context.account.userId);
  return Promise.all(
    connections.map(async (connection) => ({
      connectionId: connection.connectionId,
      organizationId: connection.organizationId,
      daemonId: connection.daemonId,
      machineName:
        (
          await context.database.findDaemonForOrganization(
            connection.organizationId,
            connection.daemonId,
          )
        )?.slug ?? null,
      workingDirectory: connection.workingDirectory,
      scopes: connection.scopes,
      createdAt: connection.createdAt,
      // listConnections returns activated connections only.
      activatedAt: connection.activatedAt ?? connection.createdAt,
      revokedAt: connection.revokedAt,
    })),
  );
}

/** Stops the connection authorizing anything. Never contacts the daemon. */
export async function revokeConnectorConnection(
  context: ConnectorFlowContext,
  input: { connectionId: string },
): Promise<{ revoked: boolean }> {
  return {
    revoked: await context.database.connector.revokeConnection(
      context.account.userId,
      input.connectionId,
      context.now(),
    ),
  };
}

/**
 * Active daemons in every organization where the user's current role may manage resources (owner
 * or admin). A view-only member sees none.
 */
export async function listMemberDaemons(
  runtime: DatabaseRuntime,
  userId: string,
): Promise<readonly ConnectorMachine[]> {
  const result = await runtime.query<{
    id: string;
    slug: string;
    presence: "offline" | "connected";
    permissions: string[];
    organization_id: string;
    organization_name: string;
  }>(
    `select daemons.id, daemons.slug, daemons.presence, daemons.scopes as permissions,
            organization.id as organization_id, organization.name as organization_name
     from member
     join organization on organization.id = member.organization_id
     join machines on machines.org_id = member.organization_id
     join daemons on daemons.machine_id = machines.id
     where member.user_id = $1 and member.role = any($2::text[]) and daemons.status = 'active'
     order by organization.name, daemons.slug`,
    [userId, [...CONNECTOR_MANAGER_ROLES]],
  );
  return result.rows.map((row) => ({
    daemonId: row.id,
    name: row.slug,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    presence: row.presence,
    canRunHubWork: row.permissions.includes("hub.execute"),
  }));
}

/** The `client_name` an OAuth client registered for itself, if any. */
export async function oauthClientName(
  runtime: DatabaseRuntime,
  clientId: string,
): Promise<string | null> {
  const result = await runtime.query<{ name: string | null }>(
    "select name from oauth_client where client_id = $1",
    [clientId],
  );
  const name = result.rows[0]?.name?.trim();
  return name === undefined || name === "" ? null : name;
}

/** The signed query as the library issued it, minus Hub's own flow parameter. */
function librarySignedQuery(query: string): string {
  const params = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
  params.delete(CONNECTOR_FLOW_PARAM);
  return params.toString();
}

function requestedConnectorScopes(params: URLSearchParams): ConnectorScope[] {
  const requested = (params.get("scope") ?? "").split(" ");
  return [...new Set(requested.filter(isConnectorScope))];
}

function explicitWorkingDirectory(value: string): string {
  if (
    !value.startsWith("/") ||
    // oxlint-disable-next-line no-control-regex -- control characters are exactly what is rejected
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.length > MAX_WORKING_DIRECTORY_LENGTH ||
    value.split("/").includes("..")
  ) {
    throw new ConnectorFlowError(
      "invalid_request",
      "the working directory must be an absolute path without '..' or control characters",
    );
  }
  const normalized = posix.normalize(value);
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

/**
 * The connector's OAuth surface as the auth server exposes it. Browser operations read the Hub
 * session from the request headers; mutations also require Hub's own browser origin.
 */
export interface ConnectorOAuthService {
  readonly endpoints: ConnectorOAuthEndpoints;
  /** `GET /.well-known/oauth-authorization-server`. */
  authorizationServerMetadata(request: Request): Promise<Response>;
  /** `GET /.well-known/oauth-protected-resource/mcp/paseo`. */
  protectedResourceMetadata(): Response;
  /** A verified connector token's principal, or null. Run `authorizeConnectorRequest` next. */
  verifyAccessToken(token: string): Promise<ConnectorPrincipal | null>;
  listMachines(headers: Headers): Promise<readonly ConnectorMachine[]>;
  selectMachine(input: SelectConnectorMachineInput, headers: Headers): Promise<ConnectorRedirect>;
  decideConsent(input: ConnectorConsentInput, headers: Headers): Promise<ConnectorRedirect>;
  describeConsent(
    input: DescribeConnectorConsentInput,
    headers: Headers,
  ): Promise<ConnectorConsentSummary>;
  listConnections(headers: Headers): Promise<readonly ConnectorConnectionSummary[]>;
  revokeConnection(
    input: { connectionId: string },
    headers: Headers,
  ): Promise<{ revoked: boolean }>;
}
