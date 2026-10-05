import { createFileRoute } from "@tanstack/react-router";
import { ConnectorConnections } from "../../../paseo-connector/consent.js";

export const Route = createFileRoute("/_shell/oauth/connections")({
  staticData: { breadcrumb: "Connected apps" },
  component: ConnectorConnections,
});
