import { createFileRoute } from "@tanstack/react-router";
import { getApplication } from "../../server/runtime.js";
import { connectorUnavailableResponse } from "../../paseo-connector/oauth.js";

export const Route = createFileRoute("/.well-known/oauth-authorization-server")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const connector = (await getApplication()).paseoConnector;
        return connector.status === "enabled"
          ? connector.oauth.authorizationServerMetadata(request)
          : connectorUnavailableResponse(connector.status);
      },
    },
  },
});
