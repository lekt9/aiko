/**
 * React bindings for sessionShellStore (focused session + liveHost).
 */

import { useCallback, useSyncExternalStore } from "react";
import {
  sessionShellStore,
  type SessionShellMeta,
} from "@/lib/sessionShellStore";
import type { SessionSnapshot } from "@/lib/session";

/** Full focused session — composer / main chrome that need all fields. */
export function useFocusedSession(): SessionSnapshot {
  return useSyncExternalStore(
    sessionShellStore.subscribeSession,
    sessionShellStore.getSessionSnapshot,
    sessionShellStore.getSessionSnapshot,
  );
}

/** Structural session fields only (id / state / error) — fewer re-renders. */
export function useSessionShellMeta(): SessionShellMeta {
  return useSyncExternalStore(
    sessionShellStore.subscribeMeta,
    sessionShellStore.getMetaSnapshot,
    sessionShellStore.getMetaSnapshot,
  );
}

export function useLiveHost(): SessionSnapshot {
  return useSyncExternalStore(
    sessionShellStore.subscribeLiveHost,
    sessionShellStore.getLiveHostSnapshot,
    sessionShellStore.getLiveHostSnapshot,
  );
}

export function useSessionShellActions() {
  const setSession = useCallback(
    (
      next:
        | SessionSnapshot
        | ((prev: SessionSnapshot) => SessionSnapshot),
    ) => {
      sessionShellStore.setSession(next);
    },
    [],
  );
  const setLiveHost = useCallback(
    (
      next:
        | SessionSnapshot
        | ((prev: SessionSnapshot) => SessionSnapshot),
    ) => {
      sessionShellStore.setLiveHost(next);
    },
    [],
  );
  return { setSession, setLiveHost };
}
