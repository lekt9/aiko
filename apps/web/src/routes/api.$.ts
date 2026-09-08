import { createFileRoute } from "@tanstack/react-router";
import { DEMO_WORKSPACE } from "../lib/app-mode";
async function handle(request: Request) {
  const path = new URL(request.url).pathname;
  if (
    path === "/api/databases" || path.startsWith("/api/databases/") || path === "/api/observed-actions/approval" || path === "/api/messages" ||
    path === "/api/approvals" ||
    path === "/api/connectors" ||
    path.startsWith("/api/connectors/") ||
    path === "/api/secretary" ||
    path.startsWith("/api/secretary/")
  ) {
    const { handleConnectorRequest } =
      await import("../server/connector-proxy");
    return handleConnectorRequest(request);
  }
  if (!DEMO_WORKSPACE)
    return Response.json(
      {
        error: "demo_disabled",
        message:
          "Conversations are in Telegram. No vault is connected to this site.",
      },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  const { handleDemoRequest } = await import("../server/demo");
  return handleDemoRequest(request);
}
export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      POST: ({ request }) => handle(request),
      PATCH: ({ request }) => handle(request),
      PUT: ({ request }) => handle(request),
    },
  },
});
