import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondOk, type Result } from "../contract/respond.js";
import { respondWithFailure, type FailureKind } from "../failures/index.js";
import { getApplication } from "../server/runtime.js";
import { CONNECTOR_PRODUCT_NAME, ConnectorError, RESTART_FROM_CLIENT } from "./contracts.js";
import {
  ConnectorFlowError,
  type ConnectorConnectionSummary,
  type ConnectorConsentSummary,
  type ConnectorMachine,
  type ConnectorOAuthService,
  type ConnectorRedirect,
} from "./flow.js";

const selectMachineSchema = z.object({
  oauthQuery: z.string().min(1),
  daemonId: z.string().uuid(),
  workingDirectory: z.string().min(1),
});
const consentSchema = z.object({
  oauthQuery: z.string().min(1),
  flowId: z.string().uuid(),
  accept: z.boolean(),
});
const describeConsentSchema = z.object({
  oauthQuery: z.string().min(1),
  flowId: z.string().uuid(),
});
const connectionIdSchema = z.object({ connectionId: z.string().uuid() });

/** A connection as the browser sees it: dates are ISO strings. */
export interface ConnectorConnectionView extends Omit<
  ConnectorConnectionSummary,
  "createdAt" | "activatedAt" | "revokedAt"
> {
  createdAt: string;
  activatedAt: string;
  revokedAt: string | null;
}

export const listPaseoConnectorMachines = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<readonly ConnectorMachine[]>> => {
    try {
      const connector = await enabledConnector();
      return respondOk(await connector.listMachines(getRequest().headers));
    } catch (error) {
      return connectorFailure(error, "paseo_connector.list_machines");
    }
  },
);

export const selectPaseoConnectorMachine = createServerFn({ method: "POST" })
  .validator(selectMachineSchema)
  .handler(async ({ data }): Promise<Result<ConnectorRedirect>> => {
    try {
      const connector = await enabledConnector();
      return respondOk(await connector.selectMachine(data, getRequest().headers));
    } catch (error) {
      return connectorFailure(error, "paseo_connector.select_machine");
    }
  });

export const decidePaseoConnectorConsent = createServerFn({ method: "POST" })
  .validator(consentSchema)
  .handler(async ({ data }): Promise<Result<ConnectorRedirect>> => {
    try {
      const connector = await enabledConnector();
      return respondOk(await connector.decideConsent(data, getRequest().headers));
    } catch (error) {
      return connectorFailure(error, "paseo_connector.decide_consent");
    }
  });

/** POST so the signed query never lands in a request URL or an access log. A read: session only. */
export const describePaseoConnectorConsent = createServerFn({ method: "POST" })
  .validator(describeConsentSchema)
  .handler(async ({ data }): Promise<Result<ConnectorConsentSummary>> => {
    try {
      const connector = await enabledConnector();
      return respondOk(await connector.describeConsent(data, getRequest().headers));
    } catch (error) {
      return connectorFailure(error, "paseo_connector.describe_consent");
    }
  });

export const listPaseoConnectorConnections = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<readonly ConnectorConnectionView[]>> => {
    try {
      const connector = await enabledConnector();
      const connections = await connector.listConnections(getRequest().headers);
      return respondOk(connections.map(connectionView));
    } catch (error) {
      return connectorFailure(error, "paseo_connector.list_connections");
    }
  },
);

export const revokePaseoConnectorConnection = createServerFn({ method: "POST" })
  .validator(connectionIdSchema)
  .handler(async ({ data }): Promise<Result<{ revoked: boolean }>> => {
    try {
      const connector = await enabledConnector();
      return respondOk(await connector.revokeConnection(data, getRequest().headers));
    } catch (error) {
      return connectorFailure(error, "paseo_connector.revoke_connection");
    }
  });

function connectionView(connection: ConnectorConnectionSummary): ConnectorConnectionView {
  return {
    connectionId: connection.connectionId,
    clientName: connection.clientName,
    organizationId: connection.organizationId,
    daemonId: connection.daemonId,
    machineName: connection.machineName,
    workingDirectory: connection.workingDirectory,
    scopes: connection.scopes,
    createdAt: connection.createdAt.toISOString(),
    activatedAt: connection.activatedAt.toISOString(),
    revokedAt: connection.revokedAt?.toISOString() ?? null,
  };
}

class ConnectorUnavailableError extends Error {
  constructor(readonly status: "database_unavailable" | "disabled") {
    super(`${CONNECTOR_PRODUCT_NAME} ${status}`);
    this.name = "ConnectorUnavailableError";
  }
}

async function enabledConnector(): Promise<ConnectorOAuthService> {
  const connector = (await getApplication()).paseoConnector;
  if (connector.status !== "enabled") throw new ConnectorUnavailableError(connector.status);
  return connector.oauth;
}

function connectorFailure(error: unknown, operation: string) {
  const [kind, message] = failureMessage(error);
  return respondWithFailure(
    error,
    { operation, component: "paseo_connector" },
    { fallback: message },
    { kind },
  );
}

function failureMessage(error: unknown): [FailureKind, string] {
  if (error instanceof ConnectorUnavailableError) {
    return error.status === "disabled"
      ? ["notFound", `The ${CONNECTOR_PRODUCT_NAME} is not enabled on this Hub.`]
      : ["upstreamUnavailable", "Hub's database is unavailable. Try again shortly."];
  }
  if (error instanceof ConnectorFlowError) {
    switch (error.code) {
      case "unauthenticated":
        return ["authentication", "Sign in to Hub to continue."];
      case "password_change_required":
        return ["forbidden", "Replace your temporary Hub password before connecting an app."];
      case "invalid_request":
        return ["validation", `${error.message}.`];
      case "flow_not_found":
        return ["notFound", `This authorization is no longer pending. ${RESTART_FROM_CLIENT}`];
      case "authorization_failed":
        return ["validation", `Hub couldn't continue this authorization. ${RESTART_FROM_CLIENT}`];
    }
  }
  if (error instanceof ConnectorError) {
    switch (error.code) {
      case "connection_revoked":
        return ["forbidden", "You are no longer an owner or admin of that machine's organization."];
      case "machine_incompatible":
        return [
          "forbidden",
          "That machine was revoked or enrolled without permission to run Hub work.",
        ];
      default:
        return ["notFound", "That machine is no longer available."];
    }
  }
  if (error instanceof Error && error.message === "invalid origin") {
    return ["validation", "This request did not come from Hub."];
  }
  return ["internal", "Hub couldn't complete this connector request."];
}
