import { createFileRoute } from "@tanstack/react-router";
import { handlePaseoConnectorMcp } from "../../paseo-connector/server.js";
import { getApplication } from "../../server/runtime.js";

export const Route = createFileRoute("/mcp/paseo")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        handlePaseoConnectorMcp((await getApplication()).paseoConnector, request),
      // Stateless JSON-response MCP: there is no SSE stream to open (GET) and no session to end
      // (DELETE), and the Streamable HTTP spec requires 405 for both rather than the SPA render.
      GET: methodNotAllowed,
      DELETE: methodNotAllowed,
    },
  },
});

function methodNotAllowed(): Response {
  return Response.json(
    { error: "method_not_allowed" },
    { status: 405, headers: { Allow: "POST" } },
  );
}
