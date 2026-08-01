import { CalendarClock, Check, CirclePause, RotateCw } from "lucide-react";
import type { ContractSummary } from "../app/types";

interface ContinuationsSurfaceProps {
  contracts: ContractSummary[];
  detail?: { id: string; history: string };
  loading: boolean;
  onInspect: (id: string) => void;
}

export function ContinuationsSurface({
  contracts,
  detail,
  loading,
  onInspect,
}: ContinuationsSurfaceProps) {
  return (
    <section className="surface list-surface" aria-labelledby="continuations-title">
      <header className="surface-header">
        <div>
          <p>Durable work</p>
          <h1 id="continuations-title">Continuations</h1>
        </div>
        <div className="surface-header__status">
          <CalendarClock size={16} aria-hidden="true" />
          Contract ledger
        </div>
      </header>

      <div className="continuation-summary">
        <div>
          <span>Running</span>
          <strong>{loading ? "—" : "0"}</strong>
        </div>
        <div>
          <span>Waiting</span>
          <strong>{loading ? "—" : contracts.length}</strong>
        </div>
        <div>
          <span>Completed today</span>
          <strong>{loading ? "—" : "0"}</strong>
        </div>
      </div>

      <div className="continuation-list">
        {loading ? (
          <div className="surface-state" role="status">
            <RotateCw className="spin" size={18} aria-hidden="true" />
            Reading the Contract ledger…
          </div>
        ) : contracts.length === 0 ? (
          <div className="surface-state">
            <Check size={18} aria-hidden="true" />
            <div>
              <strong>Nothing is waiting</strong>
              <span>
                When work needs time, a dependency, or another event, it will
                continue here.
              </span>
            </div>
          </div>
        ) : (
          contracts.map((contract) => (
            <article className="continuation-row" key={contract.id}>
              <CirclePause size={17} aria-hidden="true" />
              <div>
                <strong>{contract.plan}</strong>
                <span>{contract.id}</span>
              </div>
              <button type="button" onClick={() => onInspect(contract.id)}>
                Inspect
              </button>
            </article>
          ))
        )}
      </div>
      {detail && (
        <aside className="contract-detail" aria-live="polite">
          <strong>{detail.id}</strong>
          <pre>{detail.history}</pre>
        </aside>
      )}
    </section>
  );
}
