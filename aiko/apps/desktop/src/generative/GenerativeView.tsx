import {
  ActionProvider,
  Renderer,
  StateProvider,
  VisibilityProvider,
  useStateStore,
  useStateValue,
  type Spec,
} from "@json-render/react";
import {
  Component,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { registry } from "./registry";
import { isSpecMountable, sanitizeSpec } from "./sanitizeSpec";

interface GenerativeViewProps {
  spec: Spec;
  initialState?: Record<string, unknown>;
  streaming?: boolean;
}

class RenderErrorBoundary extends Component<
  { children: ReactNode; resetKey: string },
  { error: string | null }
> {
  state: { error: string | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error: error.message || "Failed to render generative UI" };
  }

  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Generative UI render failed", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="gen-surface gen-surface--error" role="alert">
          <strong>Could not render interactive UI</strong>
          <p>{this.state.error}</p>
          <p className="gen-surface__hint">
            Spec must be a flat json-render tree with catalog components.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

function NoticeBanner() {
  const notice = useStateValue<{ message: string; tone?: string } | null>(
    "/notice",
  );
  const store = useStateStore();
  const [visible, setVisible] = useState<typeof notice>(null);

  useEffect(() => {
    if (!notice?.message) return;
    setVisible(notice);
    const timer = window.setTimeout(() => {
      setVisible(null);
      store.set("/notice", null);
    }, 3200);
    return () => window.clearTimeout(timer);
  }, [notice, store]);

  if (!visible?.message) return null;
  return (
    <div
      className={`gen-notice gen-notice--${visible.tone ?? "info"}`}
      role="status"
    >
      {visible.message}
    </div>
  );
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

function elementCount(spec: Spec | null | undefined): number {
  if (!spec || typeof spec !== "object") return 0;
  const elements = (spec as { elements?: unknown }).elements;
  if (!elements || typeof elements !== "object") return 0;
  return Object.keys(elements as object).length;
}

/** Prefer richer (or equal) specs while streaming — never shrink the tree. */
function pickStableSpec(
  next: Spec | null,
  prev: Spec | null,
  streaming: boolean,
): Spec | null {
  if (!streaming) return next;
  if (!next) return prev;
  if (!prev) return next;
  const n = elementCount(next);
  const p = elementCount(prev);
  // Only advance when we have more structure, or same size (prop fill-in).
  if (n >= p) return next;
  return prev;
}

export function GenerativeView({
  spec,
  initialState,
  streaming,
}: GenerativeViewProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const floorHeight = useRef(0);
  const lastGoodRef = useRef<Spec | null>(null);
  const seedLocked = useRef<Record<string, unknown> | null>(null);

  const candidate = useMemo(() => sanitizeSpec(spec), [spec]);
  const safeSpec = useMemo(() => {
    const picked = pickStableSpec(
      candidate,
      lastGoodRef.current,
      Boolean(streaming),
    );
    if (picked && isSpecMountable(picked)) {
      lastGoodRef.current = picked;
    }
    if (!streaming) {
      // Reset floor after stream ends so next surface starts clean.
      if (picked) lastGoodRef.current = picked;
    }
    return picked;
  }, [candidate, streaming]);

  const mountable = isSpecMountable(safeSpec);

  // Lock initial state for the life of a streaming surface so StateProvider
  // does not remount (and jump) on every token of state JSON.
  const seed = useMemo(() => {
    const fromSpec =
      safeSpec && typeof safeSpec === "object" && "state" in safeSpec
        ? ((safeSpec as { state?: Record<string, unknown> }).state ?? {})
        : {};
    const next = { ...fromSpec, ...initialState };
    if (streaming) {
      if (!seedLocked.current) seedLocked.current = next;
      return seedLocked.current;
    }
    seedLocked.current = null;
    return next;
  }, [safeSpec, initialState, streaming]);

  const handlers = useMemo(
    () => ({
      copy: async (params: Record<string, unknown>) => {
        const text = String(params.text ?? "");
        if (text) await copyText(text);
      },
      open_url: async (params: Record<string, unknown>) => {
        const url = String(params.url ?? "");
        if (url) window.open(url, "_blank", "noopener,noreferrer");
      },
      notify: async (params: Record<string, unknown>) => {
        void params;
      },
    }),
    [],
  );

  // Only remount boundary on root change — not every prop fill during stream.
  const resetKey = useMemo(() => {
    const root =
      safeSpec && typeof safeSpec === "object"
        ? String((safeSpec as { root?: unknown }).root ?? "")
        : "";
    return root;
  }, [safeSpec]);

  // Sticky min-height: grow only while streaming so layout never collapses.
  useLayoutEffect(() => {
    const node = surfaceRef.current;
    if (!node) return;
    if (!streaming) {
      floorHeight.current = 0;
      node.style.minHeight = "";
      return;
    }
    const h = node.getBoundingClientRect().height;
    if (h > floorHeight.current) floorHeight.current = h;
    if (floorHeight.current > 0) {
      node.style.minHeight = `${floorHeight.current}px`;
    }
  }, [safeSpec, streaming, mountable]);

  if (streaming && !mountable) {
    return (
      <div
        ref={surfaceRef}
        className="gen-surface gen-surface--skeleton"
        data-streaming="true"
        style={
          floorHeight.current > 0
            ? { minHeight: floorHeight.current }
            : { minHeight: "8rem" }
        }
      >
        <div className="gen-surface__streaming">Building UI…</div>
        <div className="gen-skeleton" aria-hidden="true">
          <div className="gen-skeleton__line gen-skeleton__line--title" />
          <div className="gen-skeleton__card" />
          <div className="gen-skeleton__card" />
        </div>
      </div>
    );
  }

  if (!mountable || !safeSpec) {
    return (
      <div className="gen-surface gen-surface--error" role="alert">
        <strong>Invalid generative UI spec</strong>
        <p>Expected a flat tree with root and elements.</p>
      </div>
    );
  }

  return (
    <div
      ref={surfaceRef}
      className="gen-surface"
      data-streaming={streaming ? "true" : "false"}
    >
      <RenderErrorBoundary resetKey={resetKey}>
        <StateProvider initialState={seed} key={resetKey}>
          <VisibilityProvider>
            <ActionProvider
              handlers={{
                ...handlers,
                notify: async (params: Record<string, unknown>) => {
                  const detail = {
                    message: String(params.message ?? ""),
                    tone: String(params.tone ?? "info"),
                  };
                  window.dispatchEvent(
                    new CustomEvent("aiko-gen-notify", { detail }),
                  );
                },
              }}
            >
              <Renderer
                spec={safeSpec}
                registry={registry}
                fallback={() => (
                  <div className="gen-fallback">Unknown component in catalog</div>
                )}
              />
              <NotifyToState />
              <NoticeBanner />
            </ActionProvider>
          </VisibilityProvider>
        </StateProvider>
      </RenderErrorBoundary>
      {streaming && (
        <div className="gen-surface__streaming" aria-hidden="true">
          Building UI…
        </div>
      )}
    </div>
  );
}

function NotifyToState() {
  const store = useStateStore();
  useEffect(() => {
    const onNotify = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        message: string;
        tone: string;
      };
      store.set("/notice", { ...detail, at: Date.now() });
    };
    window.addEventListener("aiko-gen-notify", onNotify);
    return () => window.removeEventListener("aiko-gen-notify", onNotify);
  }, [store]);
  return null;
}
