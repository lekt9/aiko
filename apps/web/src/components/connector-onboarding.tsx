import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Search, ShieldCheck } from "lucide-react";
import { AIKO_TELEGRAM_URL } from "../lib/telegram";
import {
  connectorRequest,
  safeAuthorizationUrl,
  type Connector,
  type ConnectorSearch,
  type ConnectorConnection,
  type ConnectorConnect,
} from "../lib/connectors";

export function ConnectorOnboarding() {
  const credential = useRef("");
  const credentialInput = useRef<HTMLInputElement>(null);
  const telegramEnabled = useRef(true);
  const accountRequests = useRef<AbortController | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<ConnectorSearch>();
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [authorization, setAuthorization] = useState<string>();
  const [connections, setConnections] = useState<ConnectorConnection[]>();
  const search = useRef<AbortController | null>(null);
  const version = useRef(0);
  useEffect(
    () => () => {
      credential.current = "";
      search.current?.abort();
      accountRequests.current?.abort();
    },
    [],
  );

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
      bearer: credential.current || undefined,
      telegram: telegramEnabled.current,
    });
    combined.throwIfAborted();
    return response;
  }
  function clearAccount() {
    credential.current = "";
    if (credentialInput.current) credentialInput.current.value = "";
    search.current?.abort();
    accountRequests.current?.abort();
    accountRequests.current = null;
    version.current++;
    telegramEnabled.current = false;
    setSignedIn(false);
    setSignedOut(true);
    setSearching(false);
    setConnections(undefined);
    setResult(undefined);
    setAuthorization(undefined);
    setNotice("");
    setError("");
  }
  async function signIn() {
    const value = credentialInput.current?.value.trim() ?? "";
    if (!value || /\s/.test(value)) {
      if (credentialInput.current) credentialInput.current.value = "";
      setError(
        "Enter the Aiko account credential only, without a Bearer prefix or spaces.",
      );
      return;
    }
    clearAccount();
    credential.current = value;
    setPending(true);
    try {
      await refresh();
      setSignedIn(true);
      setSignedOut(false);
      setNotice(
        "Signed in for this tab. Your credential clears on sign-out, disconnect or reload.",
      );
    } catch (failure) {
      clearAccount();
      reportError(failure);
    } finally {
      setPending(false);
    }
  }

  async function find() {
    search.current?.abort();
    const controller = new AbortController();
    search.current = controller;
    const current = ++version.current;
    setSearching(true);
    setResult(undefined);
    setError("");
    setNotice("");
    setAuthorization(undefined);
    try {
      const found = await request<ConnectorSearch>(
        `?query=${encodeURIComponent(query.trim())}`,
        undefined,
        controller.signal,
      );
      if (current === version.current) setResult(found);
    } catch (failure) {
      if (current === version.current && !controller.signal.aborted)
        reportError(failure);
    } finally {
      if (current === version.current) setSearching(false);
    }
  }
  async function refresh() {
    const result = await request<{
      connections: ConnectorConnection[];
    }>("/connections");
    setConnections(result.connections);
  }
  async function connect(connector: Connector) {
    setPending(true);
    setError("");
    setAuthorization(undefined);
    setNotice("");
    try {
      const response = await request<ConnectorConnect>("/connect", {
        connectorId: connector.id,
      });
      const url = safeAuthorizationUrl(response.authorizationUrl);
      if (response.authorizationUrl && !url)
        throw new Error(
          "The authorization link is invalid. Try connecting again.",
        );
      setAuthorization(url);
      setNotice(
        url
          ? "Continue in the secure authorization page, then refresh your connections."
          : response.status === "connected"
            ? "Connected. Refresh your connections to see access."
            : response.status === "pending"
              ? "Authorization is pending. Refresh your connections to check its status."
              : "Connection was not completed. Try connecting again.",
      );
    } catch (failure) {
      reportError(failure);
    } finally {
      setPending(false);
    }
  }
  async function requestWebsite(browser = false) {
    if (result?.status !== "absent" || !result.fallbackAllowed) return;
    setPending(true);
    setError("");
    setAuthorization(undefined);
    setNotice("");
    try {
      const response = await request<{
        status: string;
        authorizationUrl?: string;
        search?: ConnectorSearch;
      }>(browser ? "/browser" : "/discover", { domain: query.trim() });
      if (!browser && ["arcade", "unavailable"].includes(response.status)) {
        setResult(response.search);
        setNotice(
          response.status === "arcade"
            ? "An Arcade provider is now available. Use its first-party authorization to connect."
            : "The catalog could not be checked. Discovery is paused; retry the search.",
        );
        return;
      }
      const url = safeAuthorizationUrl(response.authorizationUrl);
      if (browser && !url)
        throw new Error(
          "Secure browser sign-in is not available for this website yet.",
        );
      setAuthorization(url);
      setNotice(
        browser
          ? "Continue in the secure browser. Enter any password there, never in chat."
          : response.status === "discovered"
            ? "A candidate connector was found. It needs review before it can run."
            : "Discovery requested. This website is not connected; more evidence or a connector build may be needed.",
      );
    } catch (failure) {
      reportError(failure);
    } finally {
      setPending(false);
    }
  }
  async function checkAuthorization(connectionId: string) {
    setPending(true);
    setError("");
    try {
      const connection = await request<ConnectorConnection>("/complete", {
        connectionId,
      });
      if (connection.status === "connected") setAuthorization(undefined);
      await refresh();
    } catch (failure) {
      reportError(failure);
    } finally {
      setPending(false);
    }
  }
  async function manage(connectionId?: string) {
    setPending(true);
    setError("");
    try {
      if (connectionId) {
        await request("/disconnect", { connectionId });
        if (credential.current) {
          clearAccount();
          setNotice(
            "Aiko access disconnected. Your account credential was cleared from this tab. Sign in again to view connections.",
          );
          return;
        }
        setAuthorization(undefined);
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
  return (
    <section className="connector-onboarding" aria-labelledby="connector-title">
      <div className="connector-heading">
        <div>
          <p className="aiko-eyebrow">YOUR APPS. YOUR SAY.</p>
          <h2 id="connector-title">What would you like Aiko to connect?</h2>
        </div>
        <ShieldCheck size={26} aria-hidden="true" />
      </div>
      <p>
        Search for an app or any website. Available providers use first-party
        authorization through Arcade where supported. Other websites may need
        discovery or a connector built first.
      </p>
      <div className="connector-account" aria-label="Account sign-in">
        <div className="app-section-heading">
          <h3>
            {signedIn
              ? "Account connected for this tab"
              : "Use your Aiko account"}
          </h3>
          <button
            type="button"
            className="text-button"
            disabled={pending}
            onClick={() => {
              clearAccount();
              setNotice(
                "Signed out of this tab. Your account credential and connection details were cleared.",
              );
            }}
          >
            Sign out
          </button>
        </div>
        {!signedIn && (
          <form
            className="connector-credential-form"
            onSubmit={(event) => {
              event.preventDefault();
              void signIn();
            }}
          >
            <label htmlFor="aiko-account-credential">
              Aiko account credential (optional outside Telegram)
            </label>
            <div className="connector-search">
              <input
                id="aiko-account-credential"
                ref={credentialInput}
                type="password"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="none"
                maxLength={4096}
                disabled={pending}
                aria-describedby="credential-help"
              />
              <button className="button" disabled={pending}>
                {pending ? "Signing in…" : "Sign in to Aiko"}
              </button>
            </div>
            <p id="credential-help" className="aiko-fineprint">
              Use the account credential issued by your Aiko operator, not a
              website password or provider API key. It stays in this tab’s
              memory and clears on sign-out, disconnect or reload. Never send it
              in chat.
            </p>
          </form>
        )}
        {signedOut && !signedIn && (
          <p className="aiko-fineprint">
            Signed out. Enter an account credential, or reopen the app from
            Telegram to use Telegram sign-in.
          </p>
        )}
      </div>
      <form
        className="connector-search"
        onSubmit={(event) => {
          event.preventDefault();
          void find();
        }}
      >
        <label className="login-search app-search">
          <Search size={19} aria-hidden="true" />
          <input
            type="search"
            disabled={pending}
            aria-label="Search any app or website"
            placeholder="App name or website, e.g. github.com"
            maxLength={200}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              search.current?.abort();
              version.current++;
              setSearching(false);
              setResult(undefined);
              setAuthorization(undefined);
              setNotice("");
              setError("");
            }}
          />
        </label>
        <button
          className="button primary"
          disabled={searching || pending || !query.trim()}
        >
          {searching ? "Searching…" : "Find app"}
        </button>
      </form>
      <p className="aiko-fineprint">
        Never send passwords or API keys in chat. Browser sign-in is offered
        only after a provider is confirmed absent from the catalog.
      </p>
      {error && (
        <div role="alert" className="connector-feedback">
          <p>{error}</p>
          <a href={AIKO_TELEGRAM_URL} className="text-button">
            Open Aiko in Telegram <ArrowUpRight size={15} />
          </a>
        </div>
      )}
      <div aria-live="polite" aria-busy={searching}>
        {result && (
          <>
            {!result.connectors.length && (
              <div className="connector-feedback">
                <h3>
                  {result.status === "absent" && result.fallbackAllowed
                    ? "Needs discovery or a connector built"
                    : "No confirmed match yet"}
                </h3>
                <p>
                  {result.status === "absent" && result.fallbackAllowed
                    ? "This website is not in the checked catalog. Request discovery below. Access is not connected yet."
                    : "Catalog absence has not been confirmed. Try another name or retry later; browser sign-in is not available yet."}
                </p>
              </div>
            )}
            {result.status === "absent" && result.fallbackAllowed && (
              <div className="connector-actions">
                <button
                  className="button"
                  disabled={pending}
                  onClick={() => void requestWebsite()}
                >
                  Request website discovery
                </button>
                <button
                  className="button"
                  disabled={pending}
                  onClick={() => void requestWebsite(true)}
                >
                  Start secure browser sign-in
                </button>
                <p className="aiko-fineprint">
                  Sign-in needs a configured secure browser. It does not make an
                  unbuilt integration available.
                </p>
              </div>
            )}
            <div className="connector-results">
              {result.connectors.map((connector) => (
                <article className="connector-result" key={connector.id}>
                  <div>
                    <span
                      className={`connector-state ${result.status === "available" ? "is-available" : ""}`}
                    >
                      {result.status === "available"
                        ? "Available"
                        : "Availability unconfirmed"}
                    </span>
                    <h3>{connector.name}</h3>
                    {connector.description && <p>{connector.description}</p>}
                    <small>
                      {result.status === "available"
                        ? "Review and authorize access to continue."
                        : "Not connected. Availability still needs verification."}
                    </small>
                  </div>
                  <button
                    className="button"
                    disabled={pending || result.status !== "available"}
                    onClick={() => void connect(connector)}
                  >
                    {result.status === "available"
                      ? `Connect ${connector.name}`
                      : "Request discovery"}
                  </button>
                </article>
              ))}
            </div>
          </>
        )}
        {notice && (
          <p className="connector-feedback" role="status">
            {notice}
          </p>
        )}
        {authorization && (
          <a
            href={authorization}
            target="_blank"
            rel="noopener noreferrer"
            className="button primary"
          >
            Continue securely <ArrowUpRight size={17} />
          </a>
        )}
      </div>
      <div className="connector-connections">
        <div className="app-section-heading">
          <h3>Your connections</h3>
          <button
            className="text-button"
            disabled={pending}
            onClick={() => void manage()}
          >
            {pending ? "Checking…" : "Refresh connections"}
          </button>
        </div>
        {connections === undefined ? (
          <p>
            Sign in above or open from Telegram to view your account’s
            connections.
          </p>
        ) : connections.length === 0 ? (
          <p>No connected apps yet. Search above to get started.</p>
        ) : (
          connections.map((connection) => (
            <div className="connector-result" key={connection.id}>
              <div>
                <strong>{connection.connectorId}</strong>
                <p>{connection.status}</p>
              </div>
              {connection.status === "pending" &&
                safeAuthorizationUrl(connection.authorizationUrl) && (
                  <a
                    className="button"
                    href={safeAuthorizationUrl(connection.authorizationUrl)}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Resume authorization for ${connection.connectorId}`}
                  >
                    Resume authorization
                  </a>
                )}
              {connection.status === "pending" &&
                !safeAuthorizationUrl(connection.authorizationUrl) && (
                  <p className="aiko-fineprint">
                    Authorization link expired or unavailable. Check status, or
                    search for the app to connect again.
                  </p>
                )}
              {connection.status === "pending" && (
                <button
                  className="button"
                  disabled={pending}
                  onClick={() => void checkAuthorization(connection.id)}
                >
                  Check authorization
                </button>
              )}
              <button
                className="button"
                disabled={pending || connection.status === "disconnected"}
                onClick={() => void manage(connection.id)}
              >
                Disconnect {connection.connectorId}
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
