import { ORGANIZATION_ROLES } from "../auth/organization-contract.js";
import { capabilitiesFor, parseOrganizationRole } from "../auth/organization-policy.js";
import type { DaemonRecord, Database } from "../db/types.js";
import {
  CONNECTOR_SCOPES,
  ConnectorError,
  type ConnectorConnection,
  type ConnectorScope,
  type Identity,
} from "./contracts.js";

/** The verified claims of a connector access token. Built only by `verifyConnectorAccessToken`. */
export interface ConnectorPrincipal {
  userId: string;
  connectionId: string;
  scopes: readonly string[];
}

export interface AuthorizedConnection extends Identity {
  workingDirectory: string;
  /** Connector scopes both carried by the token and granted to the connection. */
  scopes: readonly ConnectorScope[];
  createdAt: Date;
  daemon: DaemonRecord;
}

/**
 * Re-proves, on every call, that a token principal may still act through its connection: the
 * connection exists for that owner, completed consent, is not revoked, its owner still manages
 * resources in the connection's organization (owner or admin), and the bound daemon is active in
 * that organization with `hub.execute`. Then requires `requiredScope` and that the token never
 * exceeds the connection.
 */
export async function authorizeConnectorRequest(
  database: Database,
  principal: ConnectorPrincipal,
  requiredScope: ConnectorScope,
): Promise<AuthorizedConnection> {
  const { connection, daemon } = await loadCurrentConnection(
    database,
    principal.userId,
    principal.connectionId,
  );
  const tokenScopes = principal.scopes.filter(isConnectorScope);
  if (!tokenScopes.every((scope) => connection.scopes.includes(scope))) {
    throw new ConnectorError("insufficient_scope", "token scopes exceed the connection");
  }
  if (!tokenScopes.includes(requiredScope)) {
    throw new ConnectorError("insufficient_scope", `${requiredScope} is required`);
  }
  return {
    connectionId: connection.connectionId,
    ownerUserId: connection.ownerUserId,
    organizationId: connection.organizationId,
    daemonId: connection.daemonId,
    workingDirectory: connection.workingDirectory,
    scopes: tokenScopes,
    createdAt: connection.createdAt,
    daemon,
  };
}

/** The live connection checks shared by request authorization and token minting. */
export async function loadCurrentConnection(
  database: Database,
  userId: string,
  connectionId: string,
): Promise<{ connection: ConnectorConnection; daemon: DaemonRecord }> {
  const connection = await database.connector.findConnection(userId, connectionId);
  if (connection === undefined || connection.activatedAt === null) {
    throw new ConnectorError("not_found", "connection not found");
  }
  if (connection.revokedAt !== null) {
    throw new ConnectorError("connection_revoked", "connection was revoked");
  }
  const daemon = await requireConnectableDaemon(
    database,
    userId,
    connection.organizationId,
    connection.daemonId,
  );
  return { connection, daemon };
}

/**
 * The organization roles allowed to link and drive machines: those that may manage the
 * organization's resources, as Hub's CLI-login approval already requires.
 */
export const CONNECTOR_MANAGER_ROLES: readonly string[] = ORGANIZATION_ROLES.filter(
  (role) => capabilitiesFor(role).manageResources,
);

/**
 * The machine checks a selection, a consent decision, and every authorized call share: the user's
 * current role in the organization may manage its resources, and the daemon is active there with
 * `hub.execute`. A member demoted below that loses access exactly like a removed one.
 */
export async function requireConnectableDaemon(
  database: Database,
  userId: string,
  organizationId: string,
  daemonId: string,
): Promise<DaemonRecord> {
  const role = parseOrganizationRole(
    (await database.organizationMemberRole(userId, organizationId)) ?? "",
  );
  if (role === undefined || !capabilitiesFor(role).manageResources) {
    throw new ConnectorError(
      "connection_revoked",
      "organization membership ended or no longer manages machines",
    );
  }
  const daemon = await database.findDaemonForOrganization(organizationId, daemonId);
  if (daemon === undefined) throw new ConnectorError("not_found", "machine not found");
  if (daemon.status !== "active" || !daemon.permissions.includes("hub.execute")) {
    throw new ConnectorError("machine_incompatible", "machine is revoked or cannot run Hub work");
  }
  return daemon;
}

export function isConnectorScope(scope: string): scope is ConnectorScope {
  return (CONNECTOR_SCOPES as readonly string[]).includes(scope);
}
