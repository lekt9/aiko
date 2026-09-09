import { useEffect, useState } from "react";
import { GMAIL_DOMAIN, isGmailDomain } from "../../../../packages/protocol/src/google-connection";
import { loginAssistanceMessage, type LoginAssistanceMethod, type LoginAssistanceView } from "../../../../packages/protocol/src/login-assistance";
import type { ConnectorConnection } from "../lib/connectors";

export function NativeLoginAssistance({ domain, providers, view, busy, ready, request, start, approve }: {
  domain: string; providers?: ("google")[]; view?: LoginAssistanceView; busy: boolean; ready: boolean;
  request: <T>(path: string, body?: object, signal?: AbortSignal) => Promise<T>;
  start: (method: LoginAssistanceMethod, sourceConnectionId: string) => void;
  approve: () => void;
}) {
  const [gmail, setGmail] = useState<ConnectorConnection[]>();
  useEffect(() => {
    if (isGmailDomain(domain) || view) return;
    const abort = new AbortController();
    request<{ connections: ConnectorConnection[] }>("/connections", undefined, abort.signal)
      .then(result => { if (!abort.signal.aborted) setGmail(result.connections.filter(c => c.provider === "browser" && c.connectorId === `browser:${GMAIL_DOMAIN}` && c.status === "connected")); })
      .catch(() => { if (!abort.signal.aborted) setGmail(undefined); });
    return () => abort.abort();
  }, [domain, request, !!view]);
  if (view) return <section aria-label="Private sign-in assistance">
    <p role="status">{loginAssistanceMessage[view.status]}</p>
    {view.status === "approval_required" && <button type="button" className="button primary" disabled={busy} onClick={approve}>Approve Google sign-in to {domain}</button>}
    <p className="aiko-fineprint">This permission is only for this sign-in. Use Cancel connection to stop this attempt. Aiko will not send messages or approve other actions.</p>
  </section>;
  if (!gmail?.length || isGmailDomain(domain)) return null;
  if (gmail.length !== 1) return <p className="aiko-fineprint">More than one Gmail connection is active. Disconnect the duplicate before using Gmail for sign-in.</p>;
  const googleOffered = Array.isArray(providers) && providers.includes("google");
  return <div>
    {googleOffered && <button type="button" className="button" disabled={busy || !ready} onClick={() => start("google", gmail[0]!.id)}>Continue with Google</button>}
    <details className="manager-fill">
    <summary>Use connected Gmail</summary>
    <p>Use your Google account on this website, or let Aiko privately read its new sign-in email. Choose a method this website offers.</p>
    <div className="connector-actions">
      {([['google', 'Continue with Google'], ['email_code', 'Use emailed code'], ['email_link', 'Use emailed sign-in link']] as const).filter(([method]) => method !== "google" || !googleOffered).map(([method, label]) =>
        <button type="button" className="button" key={method} disabled={busy || !ready} onClick={() => start(method, gmail[0]!.id)}>{label}</button>)}
    </div>
    <p className="aiko-fineprint">Only new emails addressed to your connected account and signed by {domain} can be used. Codes and links never appear in chat.</p>
  </details>
  </div>;
}
