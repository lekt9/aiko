import { createContext, useContext, useState, type ReactNode } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useWorkspace } from "./workspace";

export interface VaultSearch {
  view?: "accounts";
  app?: string;
  profile?: string;
  login?: string;
  q?: string;
  favorites?: boolean;
}
export function validateVaultSearch(
  input: Record<string, unknown>,
): VaultSearch {
  const text = (key: string) =>
    typeof input[key] === "string"
      ? (input[key] as string).slice(0, 200) || undefined
      : undefined;
  return {
    ...(input.view === "accounts" ? { view: "accounts" as const } : {}),
    ...(text("app") ? { app: text("app") } : {}),
    profile: text("profile"),
    login: text("login"),
    q: text("q"),
    favorites:
      input.favorites === true || input.favorites === "true" ? true : undefined,
  };
}
export type VaultDialog =
  | { kind: "csv" }
  | { kind: "add"; mode?: "import" | "reference" }
  | { kind: "existing" }
  | { kind: "profile"; id?: string }
  | { kind: "access" | "edit" | "delete" | "remove" | "reconnect"; id: string };
function useVaultState() {
  const data = useWorkspace();
  const search = useSearch({ strict: false }) as VaultSearch;
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<VaultDialog | null>(null);
  const profile = data.profiles.find((p) => p.id === search.profile);
  const invalidProfile = !!search.profile && !profile;
  const items = data.connections.filter((c) => c.status !== "revoked");
  const inProfile = items.filter(
    (c) => !search.profile || !!profile?.connectionIds.includes(c.id),
  );
  const visible = inProfile
    .filter(
      (c) =>
        (!search.favorites || c.favorite) &&
        `${c.name} ${c.identity}`
          .toLowerCase()
          .includes((search.q ?? "").toLowerCase()),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const selected = search.login
    ? visible.find((c) => c.id === search.login)
    : visible[0];
  const update = (patch: Partial<VaultSearch>, replace = false) =>
    navigate({ to: "/", search: { ...search, ...patch }, replace });
  const switchProfile = (id?: string) => {
    setDialog(null);
    void navigate({ to: "/", search: id ? { profile: id } : {} });
  };
  return {
    search,
    profile,
    invalidProfile,
    items,
    inProfile,
    visible,
    selected,
    update,
    switchProfile,
    dialog,
    setDialog,
  };
}
const Context = createContext<ReturnType<typeof useVaultState> | null>(null);
export function VaultProvider({ children }: { children: ReactNode }) {
  const value = useVaultState();
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useVault() {
  const value = useContext(Context);
  if (!value) throw new Error("Vault provider is missing");
  return value;
}
export const DEMO_PASSWORD = "demo-password-only";
