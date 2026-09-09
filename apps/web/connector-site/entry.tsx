import { Suspense, lazy, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { ShieldCheck } from "lucide-react";
import { ConnectorOnboarding } from "../src/components/connector-onboarding";
import { databaseLaunch } from "../src/lib/databases";
import "../src/styles/mini-app.css";

// The databases stack is only needed on a databases launch; keep it out of the
// connections bundle that every mini app open downloads.
const DatabaseWorkspace = lazy(() =>
  import("../src/components/database-workspace").then((m) => ({
    default: m.DatabaseWorkspace,
  })),
);

type TelegramAppearance = {
  initData?: string;
  colorScheme?: string;
  ready?: () => void;
  onEvent?: (event: string, callback: () => void) => void;
  offEvent?: (event: string, callback: () => void) => void;
};
function MiniApp() {
  useEffect(() => {
    let app: TelegramAppearance | undefined;
    const update = () => {
      if (
        app?.initData &&
        (app.colorScheme === "dark" || app.colorScheme === "light")
      )
        document.documentElement.dataset.telegramTheme = app.colorScheme;
    };
    const attach = () => {
      app = (window as Window & { Telegram?: { WebApp?: TelegramAppearance } })
        .Telegram?.WebApp;
      update();
      app?.onEvent?.("themeChanged", update);
      app?.ready?.();
    };
    if (document.readyState === "complete") attach();
    else window.addEventListener("load", attach, { once: true });
    return () => {
      window.removeEventListener("load", attach);
      app?.offEvent?.("themeChanged", update);
      delete document.documentElement.dataset.telegramTheme;
    };
  }, []);
  return (
    <main className="mini-app">
      <header className="mini-brand">
        <span className="mini-app-icon" aria-hidden="true">
          a
        </span>
        <h1>Aiko</h1>
        <span className="mini-privacy">
          <ShieldCheck size={16} aria-hidden="true" /> Your access, your choice
        </span>
      </header>
      {databaseLaunch(window.location.search) ? (
        <Suspense fallback={<p role="status">Loading your databases…</p>}>
          <DatabaseWorkspace search={window.location.search} />
        </Suspense>
      ) : <><ConnectorOnboarding /><a href="/connect?screen=databases">Open databases</a></>}
      <footer className="mini-footer">A little more connected.</footer>
    </main>
  );
}
// The mini app is served at exactly one URL (/connect), so a router would only
// add bundle weight; the component reads window.location.search directly.
createRoot(document.getElementById("root")!).render(<MiniApp />);
