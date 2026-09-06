import { createContext, useContext, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createUnlockClient, type Workspace } from "@unlock/sdk";
export const api = createUnlockClient({ baseUrl: "/api" });
const Context = createContext<Workspace | null>(null);
const Feedback = createContext<(message: string) => void>(() => {});
export function useWorkspace() {
  const data = useContext(Context);
  if (!data) throw new Error("Workspace has not loaded");
  return data;
}
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState("");
  const query = useQuery({
    queryKey: ["workspace"],
    queryFn: ({ signal }) => api.workspace({ signal }),
    enabled: typeof window !== "undefined",
    staleTime: 15_000,
    retry: 1,
  });
  return (
    <Feedback.Provider value={setMessage}>
      {query.isError ? (
        <div className="empty">
          <h1>Workspace unavailable</h1>
          <p>
            The local demo API could not be reached. Your changes were not
            submitted.
          </p>
          <button className="button primary" onClick={() => query.refetch()}>
            Try again
          </button>
        </div>
      ) : !query.data ? (
        <div className="loading" role="status">
          <div className="skeleton" />
          <div className="skeleton wide" />
          <p>Loading your demo workspace…</p>
        </div>
      ) : (
        <Context.Provider value={query.data}>{children}</Context.Provider>
      )}
      {message && (
        <div className="toast" role="status">
          <span>{message}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setMessage("")}
          >
            ×
          </button>
        </div>
      )}
    </Feedback.Provider>
  );
}
export function useAction<T = void, R = unknown>(
  fn: (input: T) => Promise<R>,
  message = "Changes saved",
) {
  const client = useQueryClient();
  const notify = useContext(Feedback);
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["workspace"] });
      notify(message);
    },
    onError: (error) =>
      notify(
        error instanceof Error
          ? error.message
          : "Something went wrong. Try again.",
      ),
  });
}
export function useNotify() {
  return useContext(Feedback);
}
export function time(value: string) {
  return new Date(value).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}
export function date(value: string) {
  return new Date(value).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
