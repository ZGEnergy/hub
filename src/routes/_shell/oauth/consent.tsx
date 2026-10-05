import { createFileRoute } from "@tanstack/react-router";
import { ConnectorConsent } from "../../../paseo-connector/consent.js";

export const Route = createFileRoute("/_shell/oauth/consent")({
  staticData: { breadcrumb: "Approve access" },
  component: ConnectorConsent,
});
