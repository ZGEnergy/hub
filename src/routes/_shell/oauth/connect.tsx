import { createFileRoute } from "@tanstack/react-router";
import { ConnectorConnect } from "../../../paseo-connector/consent.js";

/** The connector's login and post-login page: signed out, the shell shows Hub's own sign-in here. */
export const Route = createFileRoute("/_shell/oauth/connect")({
  staticData: { breadcrumb: "Connect a machine" },
  component: ConnectorConnect,
});
