import { CircleAlert, Radio, RotateCw } from "lucide-react";
import type { ConnectionState } from "../app/types";

interface RuntimeBadgeProps {
  state: ConnectionState;
  onRetry: () => void;
}

export function RuntimeBadge({ state, onRetry }: RuntimeBadgeProps) {
  if (state.kind === "connected") {
    return (
      <div className="runtime-badge runtime-badge--connected" title={state.health.address}>
        <Radio size={14} aria-hidden="true" />
        <span>Aiko {state.health.version}</span>
      </div>
    );
  }

  if (state.kind === "connecting") {
    return (
      <div className="runtime-badge" role="status">
        <RotateCw className="spin" size={14} aria-hidden="true" />
        <span>Connecting</span>
      </div>
    );
  }

  return (
    <button className="runtime-badge runtime-badge--error" onClick={onRetry}>
      <CircleAlert size={14} aria-hidden="true" />
      <span>Runtime offline</span>
    </button>
  );
}
