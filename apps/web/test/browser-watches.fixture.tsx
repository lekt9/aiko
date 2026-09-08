import { createRoot } from "react-dom/client";
import { ConnectorOnboarding } from "../src/components/connector-onboarding";
import { BrowserWatchesPanel } from "../src/components/browser-watches-panel";
import "../src/styles/mini-app.css";
async function request<T>(
  path: string,
  body?: object,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch("/api" + path, {
    method: body ? "POST" : "GET",
    signal,
    headers: {
      authorization: "Bearer watch-preview-only",
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok)
    throw Error(
      response.status === 503
        ? "Browser watches are unavailable for this account right now."
        : "The watch changed or its update could not be confirmed. Refresh its status before trying again.",
    );
  return result;
}
function Preview() {
  return (
    <main
      style={{
        maxWidth: 620,
        margin: "24px auto",
        padding: 20,
        background: "var(--surface)",
        borderRadius: 18,
      }}
    >
      <h1>App details</h1>
      <h2>Example Mail</h2>
      <p>
        Local preview · synthetic events and simulated actions. No messages are
        sent.
      </p>
      <BrowserWatchesPanel
        connectionId="site-fixture"
        siteName="Example Mail"
        request={request}
      />
      <details>
        <summary>Preview controls</summary>
        {[
          ["example", "Show captured example"],
          ["gap", "Report missed events"],
          ["unknown", "Make action uncertain"],
          ["stale", "Change watch elsewhere"],
          ["unavailable", "Toggle unavailable service"],
        ].map(([operation, label]) => (
          <button
            key={operation}
            type="button"
            onClick={() =>
              void fetch(`/preview/${operation}`, { method: "POST" })
            }
          >
            {label}
          </button>
        ))}
      </details>
    </main>
  );
}
const connectionPreview = window.location.pathname === "/connection";
if (connectionPreview)
  (window as any).Telegram = { WebApp: { initData: "watch-fixture-init" } };
createRoot(document.getElementById("root")!).render(
  connectionPreview ? (
    <main style={{ maxWidth: 760, margin: "24px auto", padding: 20 }}>
      <h1>Connected-site fixture</h1>
      <p>Local preview. No real account or actions.</p>
      <ConnectorOnboarding />
    </main>
  ) : (
    <Preview />
  ),
);
