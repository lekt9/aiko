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

export type ManagerKind =
  | "bitwarden"
  | "remote-mcp"
  | "onepassword"
  | "onepassword-connect"
  | "keeper"
  | "hashicorp-vault"
  | "doppler";
export type ManagerEntry = {
  reference: string;
  label: string;
  website?: string;
};
export type ManagerProvider = { id: string; name: string; kind: ManagerKind };
export type PasswordManager = {
  providerId?: string;
  status: "connected" | "authorization_required";
  id: string;
  kind: ManagerKind;
  name: string;
  entries: ManagerEntry[];
  createdAt: number;
};
export const managerKindLabels: Record<ManagerKind, string> = {
  bitwarden: "Bitwarden",
  "remote-mcp": "Password manager",
  onepassword: "1Password",
  "onepassword-connect": "1Password Connect",
  keeper: "Keeper",
  "hashicorp-vault": "HashiCorp Vault",
  doppler: "Doppler",
};
export const managerKindHints: Record<ManagerKind, string> = {
  onepassword: "Use a saved login reference such as op://Vault/Item/password.",
  "onepassword-connect": "Use a reference supported by your connected vault.",
  bitwarden: "Use the saved item's identifier from your connected vault.",
  "remote-mcp": "Use a reference supported by your connected password manager.",
  keeper: "Use the saved record's reference from your connected vault.",
  "hashicorp-vault": "Use a reference supported by your connected vault.",
  doppler: "Use a reference supported by your connected vault.",
};

/** Launch data selects a screen, never an account or an authorization grant. */
export function loginConnectionId(search: string): string | undefined {
  const ids = new URLSearchParams(search).getAll("connection");
  if (ids.length !== 1) return;
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
    ids[0]!,
  )
    ? ids[0]
    : undefined;
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

export class MiniAppAuthenticationError extends Error {}
const reopenMessage =
  "Your Telegram session expired. Close this mini app and reopen it from Aiko’s chat menu, then try again.";
let miniAppSession: { initData: string; token: Promise<string> } | undefined;
export function clearMiniAppSession() {
  miniAppSession = undefined;
}
async function sessionFor(initData: string) {
  if (miniAppSession?.initData === initData) return miniAppSession.token;
  const token = (async () => {
    const response = await fetch("/api/connectors/session", {
      method: "POST",
      headers: {
        "x-telegram-init-data": initData,
        "Content-Type": "application/json",
      },
      body: "{}",
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 || response.status === 403)
      throw new MiniAppAuthenticationError(reopenMessage);
    if (!response.ok)
      throw new Error("Could not open your Telegram session. Try again.");
    const value = (await response.json()) as { token?: string };
    if (!value.token)
      throw new Error("Could not open your Telegram session. Try again.");
    return value.token;
  })();
  miniAppSession = { initData, token };
  try {
    return await token;
  } catch (error) {
    if (miniAppSession?.token === token) miniAppSession = undefined;
    throw error;
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
    headers.Authorization = `tms ${await sessionFor(telegram.initData)}`;
  signal?.throwIfAborted();
  if (body) headers["Content-Type"] = "application/json";
  // Requests always settle: a stalled server surfaces as a retryable error,
  // never an indefinite spinner.
  const privateSignIn = [
    "/native",
    "/browser",
    "/password-managers/fill",
  ].includes(path);
  const timeout = AbortSignal.timeout(privateSignIn ? 120_000 : 20_000);
  const settled = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(
    path.startsWith("/secretary") || path.startsWith("/approvals")
      ? `/api${path}`
      : `/api/connectors${path}`,
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
    if (response.status === 401 || response.status === 403) {
      clearMiniAppSession();
      throw new MiniAppAuthenticationError(reopenMessage);
    }
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
    if (path.startsWith("/approvals"))
      throw new Error(
        response.status === 404
          ? "This approval expired or was already handled. Refresh the queue."
          : "Could not update approvals. Please retry.",
      );
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
