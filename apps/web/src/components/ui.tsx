import { useEffect, useId, useRef, type ReactNode } from "react";
import {
  Check,
  ChevronRight,
  X,
  Plus,
  Search,
  CircleAlert,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { Connection, SessionStatus } from "@unlock/sdk";
export const statusLabels: Record<SessionStatus, string> = {
  healthy: "Healthy",
  challenge: "Needs attention",
  paused: "Paused",
  "source-unavailable": "Source unavailable",
  revoked: "Revoked",
};
export function Status({ status }: { status: SessionStatus }) {
  return (
    <span className={`status ${status}`}>
      <span className="dot" />
      {statusLabels[status]}
    </span>
  );
}
export function ServiceIcon({
  name,
  large = false,
}: {
  name: string;
  large?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={`service-icon ${large ? "large" : ""} service-${name.toLowerCase().split(" ")[0]}`}
    >
      {name === "GitHub" ? (
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.86c-2.78.61-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.64-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.03a9.56 9.56 0 0 1 5 0c1.91-1.3 2.75-1.03 2.75-1.03.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.75c0 .26.18.57.69.48A10 10 0 0 0 12 2Z" />
        </svg>
      ) : name === "Linear" ? (
        "◩"
      ) : name === "Vercel" ? (
        "▲"
      ) : (
        name.slice(0, 1)
      )}
    </span>
  );
}
export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </header>
  );
}
export function ConnectButton() {
  return (
    <Link to="/connect" className="button primary">
      <Plus size={16} />
      Connect account
    </Link>
  );
}
export function Empty({
  title = "Nothing here yet",
  children,
}: {
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <Search size={24} />
      <h3>{title}</h3>
      {children}
    </div>
  );
}
export function Notice({
  children,
  warning = false,
}: {
  children: ReactNode;
  warning?: boolean;
}) {
  return (
    <div className={`notice ${warning ? "warning" : ""}`}>
      <CircleAlert size={17} />
      <div>{children}</div>
    </div>
  );
}
export function Modal({
  title,
  children,
  close,
  className,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeCurrent = useRef(close);
  closeCurrent.current = close;
  const id = useId();
  useEffect(() => {
    const d = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    d.showModal();
    const app = (window as Window & { Telegram?: { WebApp?: {
      initData?: string;
      BackButton?: { show(): void; hide(): void; onClick(fn: () => void): void; offClick(fn: () => void): void };
    } } }).Telegram?.WebApp;
    const back = app?.initData ? app.BackButton : undefined;
    const goBack = () => {
      if (Array.from(document.querySelectorAll("dialog[open]")).at(-1) === d)
        closeCurrent.current();
    };
    back?.onClick(goBack);
    back?.show();
    return () => {
      d.close();
      back?.offClick(goBack);
      if (!document.querySelector("dialog[open]")) back?.hide();
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={className}
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Tab") return;
        const stops = Array.from(
          e.currentTarget.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex]",
          ),
        ).filter(
          (node) => node.tabIndex >= 0 && node.getClientRects().length > 0,
        );
        const first = stops[0];
        const last = stops.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }}
      onClick={(e) => {
        const bounds = e.currentTarget.getBoundingClientRect();
        if (
          e.target === e.currentTarget &&
          (e.clientX < bounds.left ||
            e.clientX > bounds.right ||
            e.clientY < bounds.top ||
            e.clientY > bounds.bottom)
        )
          close();
      }}
    >
      <div className="dialog-inner">
        <div className="section-head">
          <h2 id={id}>{title}</h2>
          <button
            className="icon-button"
            onClick={close}
            aria-label="Close dialog"
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
export function AccountLink({ connection: c }: { connection: Connection }) {
  return (
    <Link to="/accounts/$id" params={{ id: c.id }} className="account-link">
      <ServiceIcon name={c.name} />
      <span>
        <strong>{c.name}</strong>
        <small>{c.identity}</small>
      </span>
      <ChevronRight className="row-arrow" size={16} />
    </Link>
  );
}
export function SaveButton({
  pending,
  children = "Save changes",
}: {
  pending: boolean;
  children?: ReactNode;
}) {
  return (
    <button type="submit" className="button primary" disabled={pending}>
      {pending ? (
        "Saving…"
      ) : (
        <>
          <Check size={16} />
          {children}
        </>
      )}
    </button>
  );
}
