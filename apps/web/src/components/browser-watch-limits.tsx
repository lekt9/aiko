import { useId, useRef, useState } from "react";
import {
  makeWatchRenewal,
  retainedWatchRenewal,
  type WatchRenewal,
  type WatchRenewalRequest,
  type WatchSite,
  type WatchStatus,
} from "../lib/browser-watches";

/** Retains the exact predecessor and absolute bounds before the first request. */
export function BrowserWatchLimits({
  watch,
  site,
  busy,
  disabled,
  renew,
}: {
  watch: WatchStatus;
  site?: WatchSite;
  busy: boolean;
  disabled: boolean;
  renew: (request: WatchRenewalRequest) => Promise<WatchRenewal>;
}) {
  const id = useId(),
    opener = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false),
    [extra, setExtra] = useState(0),
    [limit, setLimit] = useState(watch.config!.maxOccurrences),
    [retained, setRetained] = useState<WatchRenewalRequest>(),
    [receipt, setReceipt] = useState<WatchRenewal>(),
    [error, setError] = useState("");
  const config = watch.config!,
    pending =
      retained && (watch.leaseRevision ?? 0) <= retained.expectedLeaseRevision
        ? retained
        : retainedWatchRenewal(watch);
  const renewal = watch.renewal ?? receipt;
  async function submit() {
    try {
      setError("");
      const args =
        pending ??
        makeWatchRenewal(
          watch,
          site,
          extra ? Date.now() + extra : config.expiresAt,
          limit,
          Date.now(),
        );
      setRetained(args);
      const result = await renew(args);
      setReceipt(result);
      if (result.status === "confirmed") {
        setRetained(undefined);
        setOpen(false);
        opener.current?.focus();
      }
    } catch (failure) {
      setError((failure as Error).message);
    }
  }
  return (
    <div className="watch-limit-management">
      <p className="aiko-fineprint">
        {watch.budget
          ? `${watch.budget.used.toLocaleString()} of ${watch.budget.limit.toLocaleString()} observations used · ${watch.budget.remaining.toLocaleString()} remaining`
          : `Limit: ${config.maxOccurrences.toLocaleString()} observations`}
        . Includes observations that do not match this watch.
      </p>
      {renewal?.coverageLapse && (
        <p className="watch-gap">
          Coverage paused from{" "}
          {new Date(renewal.coverageLapse.from).toLocaleString()} to{" "}
          {new Date(renewal.coverageLapse.to).toLocaleString()}. The number of
          missed events is unknown. These events were not recovered.
        </p>
      )}
      {pending ? (
        <div className="watch-gap" role="status">
          <p>
            {renewal?.status === "needs-attention"
              ? "Renewal needs attention. The extended limits are not confirmed."
              : "Confirming the extended limits. The extension is not yet confirmed."}
          </p>
          <p>
            Requested end: {new Date(pending.expiresAt).toLocaleString()} ·{" "}
            {pending.maxOccurrences.toLocaleString()} total observations.
          </p>
          <button
            className="text-button"
            type="button"
            disabled={busy}
            onClick={() => void submit()}
          >
            Check renewal
          </button>
        </div>
      ) : (
        watch.status !== "deleted" && (
          <button
            ref={opener}
            className="text-button"
            type="button"
            disabled={disabled || !site}
            onClick={() => {
              setOpen(!open);
              setLimit(config.maxOccurrences);
              setExtra(0);
              setError("");
            }}
          >
            Extend limits
          </button>
        )
      )}
      {error && (
        <p className="credential-error" role="alert">
          {error}
          {pending ? " Check renewal to verify the same requested limits." : ""}
        </p>
      )}
      {open && !pending && (
        <form
          className="watch-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          aria-label="Extend watch limits"
        >
          <p>
            Extend this watch without changing its action. Paused watches stay
            paused.
          </p>
          <label htmlFor={`${id}-end`}>
            End time
            <select
              id={`${id}-end`}
              value={extra}
              disabled={disabled}
              onChange={(event) => setExtra(Number(event.target.value))}
              autoFocus
            >
              <option value={0}>Keep current end time</option>
              <option value={3_600_000}>1 hour from now</option>
              <option value={21_600_000}>6 hours from now</option>
              <option value={86_400_000}>24 hours from now</option>
            </select>
          </label>
          {site?.expiresAt && (
            <p className="aiko-fineprint">
              This connection allows watching until{" "}
              {new Date(site.expiresAt).toLocaleString()}. The requested end
              time will be capped there.
            </p>
          )}
          <label htmlFor={`${id}-limit`}>
            Total observation limit
            <input
              id={`${id}-limit`}
              type="number"
              min={config.maxOccurrences}
              max={1_000_000}
              step={1}
              value={limit}
              disabled={disabled}
              onChange={(event) => setLimit(Number(event.target.value))}
            />
          </label>
          <div className="watch-actions">
            <button className="text-button" disabled={disabled} type="submit">
              Confirm extension
            </button>
            <button
              className="text-button"
              disabled={busy}
              type="button"
              onClick={() => {
                setOpen(false);
                opener.current?.focus();
              }}
            >
              Cancel extension
            </button>
          </div>
        </form>
      )}
      {!pending && renewal?.status === "confirmed" && (
        <p className="aiko-fineprint" role="status">
          Extended limits confirmed.
          {watch.status === "paused" ? " This watch is still paused." : ""}
        </p>
      )}
    </div>
  );
}
