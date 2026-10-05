import { createFileRoute } from "@tanstack/react-router";
import { getApplication } from "../../../../server/runtime.js";
import { connectorUnavailableResponse } from "../../../../paseo-connector/oauth.js";

export const Route = createFileRoute("/.well-known/oauth-protected-resource/mcp/paseo")({
  server: {
    handlers: {
      GET: async () => {
        const connector = (await getApplication()).paseoConnector;
        return connector.status === "enabled"
          ? connector.oauth.protectedResourceMetadata()
          : connectorUnavailableResponse(connector.status);
      },
    },
  },
});
