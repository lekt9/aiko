import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from "@tanstack/react-router";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { WorkspaceProvider } from "../lib/workspace";
import { Shell } from "../components/shell";
import css from "../styles/vault.css?url";
import appsCss from "../styles/apps.css?url";
import gatewayCss from "../styles/gateway.css?url";
import { DEMO_WORKSPACE } from "../lib/app-mode";
import { GatewayPage } from "../components/gateway-page";
import { VaultProvider, validateVaultSearch } from "../lib/vault";
export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
  {
    validateSearch: validateVaultSearch,
    head: () => ({
      meta: [
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { title: "Aiko by Unbrowse — a conversation to come back to" },
        {
          name: "description",
          content:
            "Talk to Aiko in Telegram. Ask questions, keep cited memory, and read public pages you share. Each account has its own conversation.",
        },
        { name: "robots", content: "noindex, nofollow" },
      ],
      links: [
        { rel: "stylesheet", href: css },
        { rel: "stylesheet", href: appsCss },
        { rel: "stylesheet", href: gatewayCss },
      ],
    }),
    shellComponent: Document,
    component: Root,
    notFoundComponent: () => (
      <div className="empty">
        <h1>Page not found</h1>
        <p>That page is not part of this workspace.</p>
        <Link to="/" className="button primary">
          Back to my vault
        </Link>
      </div>
    ),
    errorComponent: ({ reset }) => (
      <div className="empty">
        <h1>Something went wrong</h1>
        <p>
          Try loading this page again. No secret values are shown in errors.
        </p>
        <button className="button primary" onClick={reset}>
          Try again
        </button>
      </div>
    ),
  },
);
function Root() {
  const { queryClient } = Route.useRouteContext();
  if (!DEMO_WORKSPACE) return <GatewayPage />;
  return (
    <QueryClientProvider client={queryClient}>
      <WorkspaceProvider>
        <VaultProvider>
          <Shell>
            <Outlet />
          </Shell>
        </VaultProvider>
      </WorkspaceProvider>
    </QueryClientProvider>
  );
}
function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        <script src="https://telegram.org/js/telegram-web-app.js" async />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
