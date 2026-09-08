import { NativeLoginPanel } from "./native-login-panel";
import { MiniAppScreen } from "./mini-app-screen";
import { SecretaryPanel } from "./secretary-panel";
import { PasswordManagerPanel } from "./password-manager-panel";
import { ImportLoginsPanel } from "./import-logins-panel";
import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Search,
  ShieldCheck,
  Plus,
  Check,
  FileUp,
  Globe,
  KeyRound,
  RefreshCw,
  LoaderCircle,
  X,
} from "lucide-react";
import { AIKO_TELEGRAM_URL } from "../lib/telegram";
import {
  connectorRequest,
  MiniAppAuthenticationError,
  clearMiniAppSession,
  loginConnectionId,
  safeAuthorizationUrl,
  websiteDomain,
  type ConnectorConnection,
} from "../lib/connectors";

type PendingApproval = {
  id: string;
  name: string;
  args: unknown;
  snapshot: string;
  expires: number;
};
type DrawerApp = { name: string; domain: string };
const suggestedApps: DrawerApp[] = [
  { name: "LinkedIn", domain: "linkedin.com" },
  { name: "Gmail", domain: "gmail.com" },
  { name: "Instagram", domain: "instagram.com" },
  { name: "Notion", domain: "notion.so" },
  { name: "Slack", domain: "slack.com" },
  { name: "Outlook", domain: "outlook.com" },
  { name: "Spotify", domain: "spotify.com" },
  { name: "GitHub", domain: "github.com" },
];
function AppTileIcon({ name, domain }: { name: string; domain?: string }) {
  const color =
    [...name].reduce((sum, letter) => sum + letter.charCodeAt(0), 0) % 6;
  const [broken, setBroken] = useState(false);
  const host = domain ? websiteDomain(domain) : undefined;
  // Favicons come from the app's own site, never a third-party icon proxy that
  // could observe which apps an owner views. Letters remain the fallback.
  const src = host ? `https://${host}/favicon.ico` : undefined;
  return (
    <span className={`drawer-app-icon app-tone-${color}`} aria-hidden="true">
      {!broken && src ? (
        <img
          className="drawer-app-favicon"
          src={src}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
        />
      ) : (
        name.slice(0, 2).toUpperCase()
      )}
    </span>
  );
}
function connectionName(connection: ConnectorConnection) {
  const domain = connection.connectorId.replace(/^arcade:|^browser:/, "");
  return (
    connection.appName ??
    suggestedApps.find((app) => app.domain === domain)?.name ??
    domain
  );
}
/** The site a favicon can be fetched from first-party: browser connections name
 * their website; Arcade app ids do not carry one, so those keep letter tiles. */
function faviconDomainOf(connection: ConnectorConnection) {
  return connection.connectorId.startsWith("browser:")
    ? connection.connectorId.slice("browser:".length)
    : undefined;
}

export function ConnectorOnboarding() {
  const launchConnection = useRef(loginConnectionId(window.location.search));
  const launchOpened = useRef(false);
  const [telegramMiniApp, setTelegramMiniApp] = useState(() =>
    Boolean(
      (window as Window & { Telegram?: { WebApp?: { initData?: string } } })
        .Telegram?.WebApp?.initData,
    ),
  );
  const telegramEnabled = useRef(true);
  const accountRequests = useRef<AbortController | null>(null);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [approvalError, setApprovalError] = useState("");
  const [deciding, setDeciding] = useState(false);
  const [approvalLoading, setApprovalLoading] = useState(true);
  const [signedIn, setSignedIn] = useState(false);
  const [accountVersion, setAccountVersion] = useState(0);
  const [signedOut, setSignedOut] = useState(false);
  const [nativeConnection, setNativeConnection] = useState<string>();
  const [nativeDomain, setNativeDomain] = useState<string>();
  const [nativeUsername, setNativeUsername] = useState<string>();
  const [managersOpen, setManagersOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "connected">("all");
  const [addWebsite, setAddWebsite] = useState(false);
  const [website, setWebsite] = useState("");
  const [selectedConnection, setSelectedConnection] =
    useState<ConnectorConnection>();
  const [openingApp, setOpeningApp] = useState<DrawerApp>();
  const opening = useRef(false);
  const [websiteError, setWebsiteError] = useState("");
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [nativeInline, setNativeInline] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [authorization, setAuthorization] = useState<string>();
  const [connections, setConnections] = useState<ConnectorConnection[]>();
  const signingIn = useRef(false);
  useEffect(
    () => () => {
      accountRequests.current?.abort();
    },
    [],
  );

  async function signInTelegram() {
    if (signingIn.current) return;
    const initData = (
      window as Window & { Telegram?: { WebApp?: { initData?: string } } }
    ).Telegram?.WebApp?.initData;
    if (!initData) {
      setError(
        "Open Aiko’s app from its Telegram chat menu to use your Telegram account.",
      );
      return;
    }
    signingIn.current = true;
    setTelegramMiniApp(true);
    clearAccount();
    telegramEnabled.current = true;
    setPending(true);
    try {
      // A cold account object, or an in-flight automation browser drive, can
      // stall requests for a minute; retry patiently instead of bouncing the
      // owner to an error screen.
      let lastFailure: unknown;
      for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt) setNotice("Still opening your apps…");
        try {
          await refresh();
          lastFailure = undefined;
          break;
        } catch (failure) {
          lastFailure = failure;
          if (failure instanceof MiniAppAuthenticationError) break;
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
      if (lastFailure) throw lastFailure;
      setSignedIn(true);
      setSignedOut(false);
      setNotice("");
    } catch (failure) {
      clearAccount();
      reportError(failure);
    } finally {
      signingIn.current = false;
      setPending(false);
    }
  }
  // Telegram populates initData for the current launch when its web-app script
  // connects; sign in immediately when it is already present, and otherwise
  // retry briefly so a late-connecting client still auto-connects.
  useEffect(() => {
    if (signedIn || signingIn.current) return;
    if (telegramMiniApp) {
      void signInTelegram();
      return;
    }
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (signingIn.current) return;
      if (
        (window as Window & { Telegram?: { WebApp?: { initData?: string } } })
          .Telegram?.WebApp?.initData
      ) {
        window.clearInterval(timer);
        setTelegramMiniApp(true);
        void signInTelegram();
      } else if (Date.now() - started > 10_000) window.clearInterval(timer);
    }, 400);
    return () => window.clearInterval(timer);
  }, [telegramMiniApp, signedIn]);

  function openAuthorization(event: React.MouseEvent<HTMLAnchorElement>) {
    const app = (
      window as Window & {
        Telegram?: { WebApp?: { openLink?: (url: string) => void } };
      }
    ).Telegram?.WebApp;
    if (app?.openLink) {
      event.preventDefault();
      app.openLink(event.currentTarget.href);
    }
  }
  function reportError(failure: unknown) {
    if ((failure as Error).name !== "AbortError")
      setError((failure as Error).message);
  }
  async function request<T>(
    path: string,
    body?: object,
    signal?: AbortSignal,
  ): Promise<T> {
    accountRequests.current ??= new AbortController();
    const accountSignal = accountRequests.current.signal;
    const combined = signal
      ? AbortSignal.any([signal, accountSignal])
      : accountSignal;
    const response = await connectorRequest<T>(path, body, combined, {
      telegram: telegramEnabled.current,
    });
    combined.throwIfAborted();
    return response;
  }
  useEffect(() => {
    if (!signedIn) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refreshQueue = async () => {
      try {
        const queue = await request<{ pending: PendingApproval[] }>(
          "/approvals",
          undefined,
          abort.signal,
        );
        if (!abort.signal.aborted) {
          setApprovals(queue.pending);
          setApprovalLoading(false);
          setApprovalError("");
        }
      } catch (failure) {
        if (!abort.signal.aborted) {
          setApprovalError(
            failure instanceof MiniAppAuthenticationError
              ? failure.message
              : "Could not refresh approvals. Retrying…",
          );
          if (failure instanceof MiniAppAuthenticationError) abort.abort();
        }
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(refreshQueue, 3000);
      }
    };
    void refreshQueue();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [signedIn, accountVersion]);
  async function decideApproval(id: string, approve: boolean) {
    if (deciding) return;
    setDeciding(true);
    setApprovalError("");
    try {
      await request("/approvals", { id, approve });
      const queue = await request<{ pending: PendingApproval[] }>("/approvals");
      setApprovals(queue.pending);
    } catch (failure) {
      setApprovalError(
        failure instanceof Error
          ? failure.message
          : "Could not confirm the decision. Refresh and try again.",
      );
    } finally {
      setDeciding(false);
    }
  }
  function clearAccount() {
    clearMiniAppSession();
    accountRequests.current?.abort();
    accountRequests.current = null;
    setAccountVersion((value) => value + 1);
    telegramEnabled.current = false;
    setSignedIn(false);
    setApprovals([]);
    setApprovalError("");
    setApprovalLoading(true);
    setSignedOut(true);
    setNativeConnection(undefined);
    setNativeUsername(undefined);
    setManagersOpen(false);
    setImportOpen(false);
    setSelectedConnection(undefined);
    setOpeningApp(undefined);
    setAddWebsite(false);
    setAssistantOpen(false);
    setConnections(undefined);
    setAuthorization(undefined);
    setNotice("");
    setError("");
  }
  useEffect(() => {
    const id = launchConnection.current;
    // Wait for server-validated identity and this account's current capabilities.
    if (!id || launchOpened.current || !signedIn || !connections || pending)
      return;
    launchOpened.current = true;
    const connection = connections.find((item) => item.id === id);
    if (!connection) {
      setError(
        "This sign-in is no longer available for your account. Add the app to start again.",
      );
      return;
    }
    if (
      connection.provider === "browser" &&
      connection.status === "pending" &&
      nativeInline
    ) {
      setNativeDomain(connection.connectorId.replace(/^browser:/, ""));
      setNativeUsername(connection.importedUsername);
      setSelectedConnection(undefined);
      setNativeConnection(connection.id);
    } else {
      setSelectedConnection(connection);
    }
  }, [signedIn, connections, pending, nativeInline]);
  async function refresh() {
    const result = await request<{
      connections: ConnectorConnection[];
      nativeInline?: boolean;
    }>("/connections");
    setConnections(result.connections);
    setNativeInline(result.nativeInline === true);
    return result.connections;
  }
  async function openApp(app: DrawerApp, reconnectId?: string) {
    if (opening.current || pending || !signedIn) return;
    opening.current = true;
    setOpeningApp(app);
    setPending(true);
    setError("");
    setAuthorization(undefined);
    setNotice("");
    try {
      if (reconnectId) {
        const cleanup = await request<{ status: string; relayDisconnectStatus?: string }>(
          "/disconnect", { connectionId: reconnectId },
        );
        if (cleanup.status !== "disconnected" || cleanup.relayDisconnectStatus !== "confirmed")
          throw new Error("The previous sign-in could not be closed yet. Try reconnecting again to finish cleanup.");
      }
      // Password-manager flow: every app opens a private login session for its
      // website where the owner signs in with their own credentials. No OAuth
      // handoff, no catalog round-trip before the login screen appears.
      const response = await request<{
        id?: string;
        status: string;
        authorizationUrl?: string;
        nativeInline?: boolean;
      }>("/browser", { domain: app.domain });
      if ((response.nativeInline ?? nativeInline) && response.id) {
        setNativeInline(response.nativeInline ?? nativeInline);
        setNativeDomain(app.domain);
        setNativeConnection(response.id);
        setSelectedConnection(undefined);
        const list = await refresh();
        setNativeUsername(
          list?.find((item) => item.id === response.id)?.importedUsername,
        );
        return;
      }
      const url = safeAuthorizationUrl(response.authorizationUrl);
      if (!url)
        throw new Error(
          "Password sign-in is not available for this website yet.",
        );
      setAuthorization(url);
      setNotice("Continue to the private sign-in page to finish connecting.");
      await refresh();
    } catch (failure) {
      reportError(failure);
    } finally {
      opening.current = false;
      setOpeningApp(undefined);
      setPending(false);
    }
  }
  function submitWebsite() {
    const domain = websiteDomain(website);
    if (!domain) {
      setWebsiteError(
        "Enter a website address, like notion.so. Use its HTTPS address, without login details.",
      );
      return;
    }
    setWebsiteError("");
    setAddWebsite(false);
    void openApp({ name: domain, domain });
  }
  function closeNativeLogin() {
    const connectionId = nativeConnection;
    setNativeConnection(undefined);
    void refresh()
      .catch(reportError)
      .finally(() => {
        requestAnimationFrame(() => {
          // The suggestion is replaced by a connection tile while sign-in runs.
          const tile = Array.from(
            document.querySelectorAll<HTMLButtonElement>(
              "[data-connection-id]",
            ),
          ).find((element) => element.dataset.connectionId === connectionId);
          (
            tile ?? document.querySelector<HTMLButtonElement>(".drawer-add")
          )?.focus();
        });
      });
  }
  async function manage(connectionId?: string) {
    setPending(true);
    setError("");
    try {
      if (connectionId) {
        await request("/disconnect", { connectionId });
        setAuthorization(undefined);
        setSelectedConnection(undefined);
      }
      await refresh();
      if (connectionId)
        setNotice(
          "Aiko access disconnected. You can also revoke provider authorization in the provider’s settings.",
        );
    } catch (failure) {
      reportError(failure);
    } finally {
      setPending(false);
    }
  }
  const activeConnections =
    connections?.filter((c) => c.status !== "disconnected") ?? [];
  const connectedCount = activeConnections.filter(
    (c) => c.status === "connected",
  ).length;
  const matchesQuery = (name: string, domain = "") =>
    `${name} ${domain}`.toLowerCase().includes(query.trim().toLowerCase());
  const visibleConnections = activeConnections.filter((c) =>
    matchesQuery(connectionName(c), c.connectorId),
  );
  const apps = suggestedApps.filter(
    (app) =>
      matchesQuery(app.name, app.domain) &&
      !activeConnections.some(
        (c) =>
          c.connectorId === `browser:${app.domain}` ||
          (c.appName ?? "").toLowerCase() === app.name.toLowerCase(),
      ),
  );
  const selected = activeConnections.find(
    (c) => c.id === selectedConnection?.id,
  );
  const resumeUrl = safeAuthorizationUrl(selected?.authorizationUrl);
  if (signedIn && (approvals.length > 0 || approvalLoading))
    return (
      <section className="approval-screen" aria-labelledby="approval-title">
        <h2 id="approval-title">
          {approvalLoading
            ? "Checking approvals…"
            : `Approvals (${approvals.length})`}
        </h2>
        <p>
          Review what Aiko wants to do. Your apps return when the queue is
          clear.
        </p>
        {approvalError && (
          <p role="alert" className="credential-error">
            {approvalError}
          </p>
        )}
        {approvals.map((item) => (
          <article className="approval-card" key={item.id}>
            <h3>{item.name.replace(/_/g, " ")}</h3>
            <p>
              Expires{" "}
              {new Date(item.expires).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
            <pre aria-label="Requested action">
              {JSON.stringify(item.args, null, 2)}
            </pre>
            <details>
              <summary>Review page context</summary>
              <pre>{item.snapshot}</pre>
            </details>
            <div className="connector-actions">
              <button
                className="button"
                disabled={deciding}
                onClick={() => void decideApproval(item.id, false)}
              >
                Reject
              </button>
              <button
                className="button primary"
                disabled={deciding}
                onClick={() => void decideApproval(item.id, true)}
              >
                Approve
              </button>
            </div>
          </article>
        ))}
      </section>
    );
  return (
    <section
      className="connector-onboarding app-drawer"
      aria-labelledby="connector-title"
    >
      <div className="connector-heading">
        <div>
          <h2 id="connector-title">Your apps</h2>
          <p>Everything you connect, in one place.</p>
        </div>
        <button
          type="button"
          className="drawer-add icon-button"
          aria-label="Add a website"
          disabled={!signedIn || pending}
          onClick={() => {
            setWebsite("");
            setWebsiteError("");
            setAddWebsite(true);
          }}
        >
          <Plus size={24} aria-hidden="true" />
        </button>
      </div>
      {!signedIn && (
        <div className="connector-account" aria-label="Account sign-in">
          <h3>
            {pending ? "Opening your apps…" : "Your apps, connected to Aiko"}
          </h3>
          <p className="aiko-fineprint">
            Open from Telegram to connect your apps privately.
          </p>
          <button
            type="button"
            className="button"
            disabled={pending}
            onClick={() => void signInTelegram()}
          >
            {pending ? "Signing in…" : "Use my Telegram account"}
          </button>
          {!telegramMiniApp && (
            <a
              href={AIKO_TELEGRAM_URL}
              className="button primary"
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Aiko in Telegram <ArrowUpRight size={16} />
            </a>
          )}
          {signedOut && (
            <p className="aiko-fineprint">Reopen Aiko from Telegram.</p>
          )}
        </div>
      )}
      <div className="drawer-search">
        <Search size={20} aria-hidden="true" />
        <input
          type="search"
          aria-label="Search apps or websites"
          placeholder="Search apps or websites"
          maxLength={200}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && (
          <button
            type="button"
            className="icon-button"
            aria-label="Clear search"
            onClick={() => setQuery("")}
          >
            <X size={18} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="drawer-toolbar">
        <div className="drawer-filters" role="group" aria-label="Filter apps">
          <button
            type="button"
            aria-pressed={filter === "all"}
            onClick={() => setFilter("all")}
          >
            All apps
          </button>
          <button
            type="button"
            aria-pressed={filter === "connected"}
            onClick={() => setFilter("connected")}
          >
            Connected <span>{connectedCount}</span>
          </button>
        </div>
        <button
          type="button"
          className="icon-button"
          disabled={!signedIn || pending}
          aria-label="Refresh connections"
          onClick={() => void manage()}
        >
          <RefreshCw size={18} aria-hidden="true" />
        </button>
      </div>
      {signedIn && (
        <div className="drawer-managers">
          <button
            type="button"
            className="text-button"
            onClick={() => setManagersOpen(true)}
          >
            <KeyRound size={15} aria-hidden="true" /> Password managers
          </button>
          <button
            type="button"
            className="text-button"
            onClick={() => setImportOpen(true)}
          >
            <FileUp size={15} aria-hidden="true" /> Import from CSV
          </button>
        </div>
      )}
      {error && (
        <div role="alert" className="connector-feedback">
          <p>{error}</p>
          {!signedIn && (
            <a href={AIKO_TELEGRAM_URL} className="text-button">
              Open Aiko in Telegram <ArrowUpRight size={15} />
            </a>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="connector-feedback">
          {notice}
        </p>
      )}
      {authorization && (
        <a
          href={authorization}
          onClick={openAuthorization}
          target="_blank"
          rel="noopener noreferrer"
          className="button primary drawer-authorization"
        >
          Continue sign-in <ArrowUpRight size={17} aria-hidden="true" />
        </a>
      )}
      {openingApp && (
        <p className="credential-progress drawer-progress" role="status">
          <LoaderCircle size={18} className="app-spinner" aria-hidden="true" />
          Preparing {openingApp.name}…
        </p>
      )}
      {!!visibleConnections.length && (
        <section className="drawer-section" aria-label="Your connections">
          <div className="drawer-section-heading">
            <h3>
              {filter === "all"
                ? "Your connections"
                : "Connected & in progress"}
            </h3>
            <span>{visibleConnections.length}</span>
          </div>
          <div className="drawer-grid">
            {visibleConnections.map((connection) => (
              <button
                type="button"
                key={connection.id}
                data-connection-id={connection.id}
                className="drawer-tile"
                disabled={pending}
                onClick={() => setSelectedConnection(connection)}
                aria-label={`${connectionName(connection)} — ${connection.status === "connected" ? "connected" : connection.status === "pending" ? "finish sign-in" : "needs attention"}. Manage connection`}
              >
                <span className="drawer-icon-wrap">
                  <AppTileIcon
                    name={connectionName(connection)}
                    domain={faviconDomainOf(connection)}
                  />
                  {connection.status === "connected" && (
                    <span className="drawer-connected-badge">
                      <Check size={12} aria-hidden="true" />
                    </span>
                  )}
                </span>
                <span className="drawer-tile-name">
                  {connectionName(connection)}
                </span>
                <span
                  className={`drawer-tile-status ${connection.status === "connected" ? "is-connected" : ""}`}
                >
                  {connection.status === "connected"
                    ? "Connected"
                    : connection.status === "pending"
                      ? "Finish sign-in"
                      : "Needs attention"}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
      {filter === "connected" && !visibleConnections.length && (
        <div className="drawer-empty">
          <span className="credential-symbol">
            <ShieldCheck size={26} aria-hidden="true" />
          </span>
          <h3>
            {query ? "No matching connections" : "Your apps will live here"}
          </h3>
          <p>
            {query
              ? "Try another app name or clear your search."
              : "Pick an app, add your login, and let Aiko help."}
          </p>
          <button
            className="button"
            onClick={() => {
              setQuery("");
              setFilter("all");
            }}
          >
            Browse apps
          </button>
          <button
            className="button"
            disabled={!signedIn}
            onClick={() => setImportOpen(true)}
          >
            <FileUp size={15} aria-hidden="true" /> Import from a CSV export
          </button>
        </div>
      )}
      {filter === "all" && (
        <section className="drawer-section" aria-label="Add apps">
          <div className="drawer-section-heading">
            <h3>
              {query
                ? "Search results"
                : activeConnections.length
                  ? "Add more apps"
                  : "Start with an app"}
            </h3>
          </div>
          <div className="drawer-grid">
            {apps.map((app) => (
              <button
                type="button"
                key={app.domain}
                className="drawer-tile"
                disabled={!signedIn || pending}
                onClick={() => void openApp(app)}
                aria-label={`Connect ${app.name}`}
              >
                <AppTileIcon name={app.name} domain={app.domain} />
                <span className="drawer-tile-name">{app.name}</span>
                <span className="drawer-tile-status">{"Add login"}</span>
              </button>
            ))}
            <button
              type="button"
              className="drawer-tile drawer-custom"
              disabled={!signedIn || pending}
              onClick={() => {
                setWebsite(query.includes(".") ? query : "");
                setWebsiteError("");
                setAddWebsite(true);
              }}
            >
              <span className="drawer-app-icon">
                <Plus size={26} aria-hidden="true" />
              </span>
              <span className="drawer-tile-name">Add website</span>
              <span className="drawer-tile-status">Your choice</span>
            </button>
          </div>
          {!apps.length && (
            <p className="aiko-fineprint">
              Not listed? Add its website address to check sign-in options.
            </p>
          )}
        </section>
      )}
      <p className="drawer-trust">
        <ShieldCheck size={15} aria-hidden="true" />
        You choose the apps. You can disconnect anytime.
      </p>
      {signedIn && (
        <details
          className="drawer-assistant"
          onToggle={(event) => setAssistantOpen(event.currentTarget.open)}
        >
          <summary>Telegram assistant settings</summary>
          {assistantOpen && (
            <SecretaryPanel key={accountVersion} request={request} />
          )}
        </details>
      )}
      {addWebsite && (
        <MiniAppScreen title="Add a website" close={() => setAddWebsite(false)}>
          <div className="credential-identity">
            <span className="credential-symbol">
              <Globe size={26} aria-hidden="true" />
            </span>
            <div>
              <h3>Any website starts here</h3>
              <p>We’ll check its sign-in options.</p>
            </div>
          </div>
          <form
            className="website-form"
            onSubmit={(event) => {
              event.preventDefault();
              submitWebsite();
            }}
          >
            <div className="credential-fields">
              <div className="credential-field">
                <label htmlFor="website-domain">Website address</label>
                <input
                  id="website-domain"
                  name="website"
                  type="text"
                  inputMode="url"
                  autoComplete="url"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="example.com"
                  required
                  maxLength={253}
                  value={website}
                  onChange={(event) => {
                    setWebsite(event.target.value);
                    setWebsiteError("");
                  }}
                  aria-invalid={!!websiteError}
                  aria-describedby={websiteError ? "website-error" : undefined}
                />
              </div>
            </div>
            {websiteError && (
              <p className="credential-error" role="alert" id="website-error">
                {websiteError}
              </p>
            )}
            <button
              type="submit"
              className="button primary credential-submit"
              disabled={pending}
            >
              Continue
            </button>
          </form>
          <p className="aiko-fineprint">
            Only enter a website you trust. Add your login on the next screen,
            never in chat.
          </p>
          <div className="drawer-managers">
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setAddWebsite(false);
                setManagersOpen(true);
              }}
            >
              <KeyRound size={15} aria-hidden="true" /> Use a password manager
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setAddWebsite(false);
                setImportOpen(true);
              }}
            >
              <FileUp size={15} aria-hidden="true" /> Import from a CSV export
            </button>
          </div>
        </MiniAppScreen>
      )}
      {selected && !nativeConnection && (
        <MiniAppScreen
          title="App details"
          close={() => {
            if (!pending) setSelectedConnection(undefined);
          }}
        >
          <div className="credential-identity">
            <AppTileIcon
              name={connectionName(selected)}
              domain={faviconDomainOf(selected)}
            />
            <div>
              <h3>{connectionName(selected)}</h3>
              <p>
                {selected.status === "connected"
                  ? "Connected to Aiko"
                  : selected.status === "pending"
                    ? "Finish connecting this app"
                    : "This connection needs attention"}
              </p>
            </div>
          </div>
          {error && (
            <p className="credential-error" role="alert">
              {error}
            </p>
          )}
          {selected.status === "connected" && (
            <p className="aiko-fineprint">
              Aiko can use this connection for your requests. Disconnect to stop
              Aiko’s access; you can also revoke authorization in the app’s own
              settings.
            </p>
          )}
          {selected.status === "pending" && (
            <div className="connector-actions">
              {selected.provider === "browser" && nativeInline ? (
                <button
                  className="button primary"
                  disabled={pending}
                  onClick={() => {
                    setNativeDomain(
                      selected.connectorId.replace(/^browser:/, ""),
                    );
                    setNativeUsername(selected.importedUsername);
                    setNativeConnection(selected.id);
                    setSelectedConnection(undefined);
                  }}
                >
                  Continue sign-in
                </button>
              ) : resumeUrl ? (
                <a
                  className="button primary"
                  href={resumeUrl}
                  onClick={openAuthorization}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Continue sign-in <ArrowUpRight size={16} />
                </a>
              ) : (
                <p className="aiko-fineprint">
                  This sign-in link is unavailable. Disconnect, then add the app
                  again.
                </p>
              )}
            </div>
          )}
          {selected.status === "failed" && selected.provider === "browser" && nativeInline && (
            <div className="connector-actions">
              <p className="aiko-fineprint">
                Start a new sign-in to reconnect this app. Aiko will close the previous sign-in first.
              </p>
              <button
                className="button primary"
                disabled={pending}
                onClick={() => void openApp({
                  name: connectionName(selected),
                  domain: selected.connectorId.replace(/^browser:/, ""),
                }, selected.id)}
              >
                {pending ? "Reconnecting…" : "Reconnect app"}
              </button>
            </div>
          )}
          <button
            className="button drawer-disconnect"
            disabled={pending}
            onClick={() => void manage(selected.id)}
          >
            {pending
              ? "Updating…"
              : selected.status === "pending"
                ? "Cancel connection"
                : "Disconnect app"}
          </button>
        </MiniAppScreen>
      )}
      {nativeConnection && (
        <NativeLoginPanel
          key={nativeConnection}
          domain={nativeDomain}
          username={nativeUsername}
          connectionId={nativeConnection}
          request={request}
          onClose={closeNativeLogin}
        />
      )}
      {managersOpen && (
        <PasswordManagerPanel
          request={request}
          onClose={() => setManagersOpen(false)}
          onChanged={() => void refresh().catch(reportError)}
        />
      )}
      {importOpen && connections && (
        <ImportLoginsPanel
          request={request}
          connections={connections}
          onClose={() => setImportOpen(false)}
          onImported={() => void refresh().catch(reportError)}
        />
      )}
    </section>
  );
}
