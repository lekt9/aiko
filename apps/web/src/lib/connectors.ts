/** Account-scoped connector API. Credentials remain in the authenticated runtime. */
export type Connector = {
  id: string;
  name: string;
  description: string;
  provider: "arcade";
  toolName: string;
  domains: string[];
};
export type ConnectorSearch = {
  status: "available" | "absent" | "unavailable";
  connectors: Connector[];
  fallbackAllowed: boolean;
  message: string;
};
export type ConnectorConnection = {
  id: string;
  connectorId: string;
  provider: "arcade" | "browser";
  status: "pending" | "connected" | "disconnected" | "failed";
  appName?: string;
  toolIds?: string[];
  authorizationUrl?: string;
  /** Staged from a password manager CSV export; prefills the private sign-in. */
  importedUsername?: string;
};
export type ConnectorConnect = ConnectorConnection;

export type ManagerKind = "onepassword" | "keeper" | "hashicorp-vault" | "doppler";
export type ManagerEntry = { reference: string; label: string; website?: string };
export type PasswordManager = {
  id: string;
  kind: ManagerKind;
  name: string;
  entries: ManagerEntry[];
  createdAt: number;
};
export const managerKindLabels: Record<ManagerKind, string> = {
  onepassword: "1Password",
  keeper: "Keeper",
  "hashicorp-vault": "HashiCorp Vault",
  doppler: "Doppler",
};
export const managerKindHints: Record<ManagerKind, string> = {
  onepassword: "Service account token · references like op://Vault/Item/password",
  keeper: "One-line config · references like keeper://RECORD_UID/field/password",
  "hashicorp-vault": "Service token · references like vault://secret/data/app/token#value",
  doppler: "Service token · references like doppler://API_KEY",
};

/** Launch data selects a screen, never an account or an authorization grant. */
export function loginConnectionId(search: string): string | undefined {
  const ids = new URLSearchParams(search).getAll("connection");
  if (ids.length !== 1) return;
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(ids[0]!) ? ids[0] : undefined;
}

/** Normalize an explicit website address. Never guess a domain from an app name. */
export function websiteDomain(value: string): string | undefined {
  try {
    const input = value.trim();
    const url = new URL(input.includes("://") ? input : `https://${input}`);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !url.hostname.includes(".") ||
      /\s/.test(input)
    )
      return;
    return url.hostname;
  } catch {
    return;
  }
}

export function safeAuthorizationUrl(value?: string): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password)
      return url.href;
  } catch {
    /* Invalid authorization destinations are never rendered. */
  }
}

export async function connectorRequest<T>(
  path: string,
  body?: object,
  signal?: AbortSignal,
  authentication?: { bearer?: string; telegram?: boolean },
): Promise<T> {
  const telegram = (
    window as Window & {
      Telegram?: { WebApp?: { initData?: string } };
    }
  ).Telegram?.WebApp;
  const headers: Record<string, string> = {};
  if (authentication?.bearer)
    headers.Authorization = `Bearer ${authentication.bearer}`;
  else if (authentication?.telegram !== false && telegram?.initData)
    headers["x-telegram-init-data"] = telegram.initData;
  if (body) headers["Content-Type"] = "application/json";
  // Requests always settle: a stalled server surfaces as a retryable error,
  // never an indefinite spinner.
  const timeout = AbortSignal.timeout(20_000);
  const settled = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(
    (path.startsWith("/secretary") || path.startsWith("/approvals")) ? `/api${path}` : `/api/connectors${path}`,
    {
      method: body ? "POST" : "GET",
      headers,
      credentials: "same-origin",
      cache: "no-store",
      signal: settled,
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      throw new Error(
        "This Telegram identity was not accepted. Reopen Aiko from the Connect apps menu and try again.",
      );
    if (path.startsWith("/password-managers") || path.startsWith("/imports")) {
      const detail = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      if (detail.message) throw new Error(detail.message);
      throw new Error(
        path.startsWith("/password-managers")
          ? "Password managers are unavailable right now. Try again."
          : "The import could not be completed. Try again.",
      );
    }
    if (path.startsWith("/secretary")) {
      const detail = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      const messages: Record<string, string> = {
        invalid_request:
          "Check that the JSON export is for this private chat, with at most 2,000 messages and valid sender IDs.",
        reply_permission_required:
          "Enable Telegram reply permission before turning on automatic replies.",
        contact_not_observed:
          "Wait for a message from this contact, then refresh.",
        connection_not_found:
          "This Telegram connection is no longer available. Refresh and reconnect.",
        group_account_replies_not_supported:
          "Telegram does not support account-level group replies.",
      };
      throw new Error(
        messages[detail.error ?? ""] ??
          "Secretary Mode is unavailable. Refresh and try again.",
      );
    }
    if (path.startsWith("/approvals")) throw new Error(response.status === 404 ? "This approval expired or was already handled. Refresh the queue." : "Could not update approvals. Please retry.");
    if (path === "/browser")
      throw new Error(
        "Password sign-in is unavailable. No credentials were collected.",
      );
    throw new Error(
      "Connector service is unavailable. Try again; catalog absence has not been confirmed.",
    );
  }
  return response.json() as Promise<T>;
}
