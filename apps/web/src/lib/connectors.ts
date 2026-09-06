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
  authorizationUrl?: string;
};
export type ConnectorConnect = ConnectorConnection;

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
  const response = await fetch(`/api/connectors${path}`, {
    method: body ? "POST" : "GET",
    headers,
    credentials: "same-origin",
    cache: "no-store",
    signal,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      throw new Error(
        "Sign in with an Aiko account credential below, or open Aiko’s app from Telegram.",
      );
    if (path === "/browser")
      throw new Error(
        "Secure browser sign-in is not configured or is unavailable. No credentials were collected.",
      );
    throw new Error(
      "Connector service is unavailable. Try again; catalog absence has not been confirmed.",
    );
  }
  return response.json() as Promise<T>;
}
