import { useEffect, useId, useRef, useState } from "react";
import {
  makeWatchConfig,
  watchEventLabel,
  watchPath,
  watchSampleText,
  watchStateLabel,
  type WatchConfig,
  type WatchDiscovery,
  type WatchReply,
  type WatchRequest,
  type WatchSample,
  type WatchStatus,
} from "../lib/browser-watches";
import "../styles/browser-watches.css";
import { BrowserWatchLimits } from "./browser-watch-limits";
import type { WatchRenewal } from "../lib/browser-watches";

type Draft = {
  id: string;
  label: string;
  eventId: string;
  actionId: string;
  instruction: string;
  duration: number;
  maxOccurrences: number;
  prior?: WatchStatus;
};
const at = (time?: number) =>
  time
    ? new Date(time).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "None yet";
export function BrowserWatchesPanel({
  connectionId,
  siteName,
  request,
}: {
  connectionId: string;
  siteName: string;
  request: WatchRequest;
}) {
  const heading = useId(),
    requestRef = useRef(request);
  requestRef.current = request;
  const lifetime = useRef<AbortController | null>(null),
    pending = useRef(false);
  const draftName = useRef<HTMLInputElement>(null),
    newButton = useRef<HTMLButtonElement>(null),
    opener = useRef<HTMLElement | null>(null);
  const [watches, setWatches] = useState<WatchStatus[]>(),
    [discovery, setDiscovery] = useState<WatchDiscovery>();
  const [error, setError] = useState(""),
    [choiceError, setChoiceError] = useState(""),
    [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false),
    [needsRefresh, setNeedsRefresh] = useState(false),
    [draft, setDraft] = useState<Draft>();
  const [samples, setSamples] = useState<Record<string, WatchSample>>({}),
    [deleting, setDeleting] = useState<string>();
  useEffect(() => {
    if (draft) draftName.current?.focus();
    else if (opener.current) {
      (opener.current.isConnected
        ? opener.current
        : newButton.current
      )?.focus();
      opener.current = null;
    }
  }, [draft?.id]);
  const site = discovery?.sites.find(
    (site) => site.connectionId === connectionId,
  );
  const selectedAction = discovery?.actions.find(
    (action) => action.id === draft?.actionId,
  );
  const canCreate = !!site?.events.length && !!discovery?.actions.length;
  const disabled = busy || needsRefresh;
  async function read<T>(path: string, body?: object) {
    return (
      await requestRef.current<WatchReply<T>>(
        watchPath + path,
        body,
        lifetime.current?.signal,
      )
    ).result;
  }
  async function refresh() {
    const results = await Promise.allSettled([
      read<WatchStatus[]>(""),
      read<WatchDiscovery>("/discovery"),
    ]);
    if (lifetime.current?.signal.aborted) return;
    const status = results[0],
      choices = results[1];
    if (status.status === "rejected") throw status.reason;
    if (!Array.isArray(status.value))
      throw Error("Watch status is unavailable. Try Refresh.");
    setWatches(
      status.value.filter(
        (watch) =>
          watch.config?.connectionId === connectionId &&
          (watch.status !== "deleted" ||
            (watch.release && watch.release.status !== "confirmed")),
      ),
    );
    if (
      choices.status === "fulfilled" &&
      Array.isArray(choices.value?.sites) &&
      Array.isArray(choices.value?.actions) &&
      choices.value?.defaults
    ) {
      setDiscovery(choices.value);
      setChoiceError("");
    } else {
      setDiscovery(undefined);
      setChoiceError(
        "New watches are unavailable right now. Existing watches can still be managed.",
      );
    }
    setNeedsRefresh(false);
  }
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    void refresh().catch((failure) => {
      if (!controller.signal.aborted) setError((failure as Error).message);
    });
    return () => controller.abort();
    // The parent keys this panel by authenticated account and selected connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);
  async function perform(action: () => Promise<void>, message?: string) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await refresh();
      if (!lifetime.current?.signal.aborted && message) setNotice(message);
    } catch (failure) {
      if (!lifetime.current?.signal.aborted) {
        setError((failure as Error).message);
        setNeedsRefresh(true);
      }
    } finally {
      pending.current = false;
      if (!lifetime.current?.signal.aborted) setBusy(false);
    }
  }
  function openDraft(prior?: WatchStatus) {
    if (!discovery || !site) return;
    opener.current = document.activeElement as HTMLElement;
    const config = prior?.config;
    const action = config
      ? discovery.actions.find(
          (choice) =>
            (choice.action.kind === "actor" &&
              config.action.kind === "actor" &&
              choice.supportsInstruction) ||
            JSON.stringify(choice.action) === JSON.stringify(config.action),
        )
      : undefined;
    setDraft({
      id: config?.id ?? crypto.randomUUID(),
      label: config?.label ?? "",
      eventId: site.events[0]?.id ?? "",
      actionId: action?.id ?? (config ? "" : (discovery.actions[0]?.id ?? "")),
      instruction:
        config?.action.kind === "actor" ? config.action.instruction : "",
      duration: Math.min(discovery.defaults.expiresInMs, 3_600_000),
      maxOccurrences:
        config?.maxOccurrences ?? discovery.defaults.maxOccurrences,
      ...(prior ? { prior } : {}),
    });
    setError("");
    setNotice("");
  }
  function update(value: Partial<Draft>) {
    setDraft((current) => (current ? { ...current, ...value } : current));
  }
  async function save() {
    if (!draft || !discovery) return;
    const current = draft;
    const config = makeWatchConfig({
      discovery,
      connectionId,
      eventId: current.eventId,
      actionId: current.actionId,
      instruction: current.instruction,
      label: current.label,
      duration: current.duration,
      maxOccurrences: current.maxOccurrences,
      id: current.id,
      now: Date.now(),
      prior: current.prior?.config,
    });
    await read("/configure", {
      config,
      expectedGeneration: current.prior?.generation ?? 0,
    });
    setDraft(undefined);
  }
  const actionName = (config: WatchConfig) =>
    discovery?.actions.find(
      (choice) =>
        (choice.action.kind === "actor" &&
          config.action.kind === "actor" &&
          choice.supportsInstruction) ||
        JSON.stringify(choice.action) === JSON.stringify(config.action),
    )?.label ??
    (config.action.kind === "actor"
      ? "Ask Aiko"
      : config.action.kind === "webhook"
        ? "Notify a saved destination"
        : "Run saved action");
  return (
    <section
      className="browser-watches"
      aria-labelledby={heading}
      aria-busy={busy}
    >
      <div className="app-section-heading">
        <h3 id={heading}>Watches</h3>
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={() =>
            void perform(async () => {}, "Watch status refreshed.")
          }
        >
          Refresh watches
        </button>
      </div>
      <p>Choose what Aiko should do when something happens on {siteName}.</p>
      {error && (
        <p className="credential-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="watch-notice" role="status">
          {notice}
        </p>
      )}
      {!watches && !error && <p role="status">Loading watches…</p>}
      {watches && (
        <>
          {choiceError && <p className="aiko-fineprint">{choiceError}</p>}
          {!choiceError && discovery && !canCreate && (
            <p className="aiko-fineprint">
              No supported event and action choices are available for this
              connection yet.
            </p>
          )}
          {!watches.length && (
            <p className="watch-empty">No watches for this site yet.</p>
          )}
          {watches.map((watch) => {
            const config = watch.config!,
              releasePending =
                !!watch.release && watch.release.status !== "confirmed",
              gap = watch.collector?.coverageGap,
              sample = samples[watch.id],
              preview = sample && watchSampleText(sample.payload);
            return (
              <article
                className="watch-card"
                key={watch.id}
                aria-label={watch.label ?? "Site watch"}
              >
                <header>
                  <h4>{watch.label ?? "Site watch"}</h4>
                  <span className={`watch-status watch-status-${watch.status}`}>
                    {releasePending && watch.status === "deleted"
                      ? watch.release?.status === "needs-attention"
                        ? "Needs attention"
                        : "Stopping listener"
                      : watchStateLabel(watch.status)}
                  </span>
                </header>
                <p className="watch-rule">
                  <span>
                    <b>When</b> {watchEventLabel(config)}
                  </span>
                  <span>
                    <b>Do</b> {actionName(config)}
                  </span>
                </p>
                {config.action.kind === "actor" && (
                  <p className="watch-instruction">
                    {config.action.instruction}
                  </p>
                )}
                <dl className="watch-facts">
                  <div>
                    <dt>Last event</dt>
                    <dd>{at(watch.lastEventAt)}</dd>
                  </div>
                  <div>
                    <dt>Ends</dt>
                    <dd>{at(config.expiresAt)}</dd>
                  </div>
                </dl>
                <BrowserWatchLimits watch={watch} site={site} busy={busy} disabled={disabled}
                  renew={async args => {
                    if (pending.current) throw Error("Another update is in progress.");
                    pending.current = true; setBusy(true);
                    try {
                      const result = await read<WatchRenewal>("/renew", args);
                      await refresh();
                      return result;
                    } catch (failure) {
                      setNeedsRefresh(true);
                      throw failure;
                    } finally { pending.current = false; if (!lifetime.current?.signal.aborted) setBusy(false); }
                  }} />
                {releasePending && (
                  <p className="aiko-fineprint" role="status">
                    {watch.release?.status === "needs-attention"
                      ? "Listener shutdown needs attention. This watch will stay here until shutdown is confirmed. Refresh to check progress."
                      : watch.status === "deleted"
                        ? "Deletion requested. Confirming the browser listener has stopped."
                        : "Paused. Confirming the browser listener has stopped."}
                  </p>
                )}
                {watch.status === "setting-up" && (
                  <p className="aiko-fineprint">
                    Aiko is setting up the listener. Refresh to check when it is
                    ready.
                  </p>
                )}
                {watch.status === "needs-attention" && (
                  <p className="aiko-fineprint">
                    {config.expiresAt <= Date.now()
                      ? "This watch expired. Extend its limits if the connection still allows watching."
                      : watch.collector?.reason === "private-sign-in"
                        ? "Watching is suspended during private sign-in. Finish signing in, then refresh."
                        : gap
                          ? "Some events could not be captured. Review the loss below."
                          : "The source or listener needs attention. Check this connection and refresh its status."}
                  </p>
                )}
                {gap && (
                  <div className="watch-gap">
                    <strong>
                      {gap.countUncertain ? "At least " : ""}
                      {gap.missed.toLocaleString()} missed{" "}
                      {gap.missed === 1 ? "event" : "events"}
                    </strong>
                    <p>
                      These events were not recovered.{" "}
                      {gap.acknowledged
                        ? `${gap.acknowledged.toLocaleString()} acknowledged.`
                        : "Acknowledging keeps this loss in the history."}
                    </p>
                    {gap.missed > gap.acknowledged && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={disabled}
                        onClick={() =>
                          void perform(async () => {
                            await read("/acknowledge-gap", {
                              id: watch.id,
                              expectedGeneration: watch.generation,
                              missed: gap.missed,
                            });
                          }, "Missed events acknowledged. The loss remains recorded.")
                        }
                      >
                        Acknowledge missed events
                      </button>
                    )}
                  </div>
                )}
                {watch.lastTaskStatus && (
                  <p className="aiko-fineprint">
                    Last action:{" "}
                    {watch.lastTaskStatus === "unknown"
                      ? "outcome uncertain"
                      : watch.lastTaskStatus}
                    {watch.lastTaskAt ? ` · ${at(watch.lastTaskAt)}` : ""}
                  </p>
                )}
                {watch.lastTaskStatus === "unknown" && (
                  <div className="watch-gap">
                    <p>
                      The action may have happened. Check its existing receipt
                      before deciding what to do next.
                    </p>
                    {watch.lastTaskOperationId ? (
                      <button
                        type="button"
                        className="text-button"
                        disabled={disabled}
                        onClick={() =>
                          void perform(async () => {
                            await read("/reconcile", {
                              operationId: watch.lastTaskOperationId,
                              requestId: crypto.randomUUID(),
                            });
                          }, "Existing receipt checked.")
                        }
                      >
                        Check action outcome
                      </button>
                    ) : (
                      <p className="aiko-fineprint">
                        Receipt checking is unavailable for this action.
                      </p>
                    )}
                  </div>
                )}
                <div className="watch-actions">
                  <button
                    type="button"
                    className="text-button"
                    disabled={disabled}
                    onClick={() =>
                      void perform(async () => {
                        const result = await read<WatchSample>("/sample", {
                          id: watch.id,
                        });
                        setSamples((current) => ({
                          ...current,
                          [watch.id]: result,
                        }));
                      })
                    }
                  >
                    View example
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={
                      disabled ||
                      releasePending ||
                      watch.status === "deleted" ||
                      (watch.status === "paused" &&
                        (releasePending || config.expiresAt <= Date.now()))
                    }
                    onClick={() =>
                      void perform(
                        async () => {
                          await read("/control", {
                            id: watch.id,
                            status:
                              watch.status === "paused" ? "active" : "paused",
                            expectedRevision: watch.controlRevision ?? 0,
                          });
                        },
                        watch.status === "paused"
                          ? "Resume requested. Check the listener status."
                          : "Pause requested. Check the listener status.",
                      )
                    }
                  >
                    {watch.status === "paused" ? "Resume watch" : "Pause watch"}
                  </button>
                  {canCreate &&
                    watch.status !== "deleted" &&
                    config.expiresAt > Date.now() && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={disabled || releasePending}
                        onClick={() => openDraft(watch)}
                      >
                        Change action
                      </button>
                    )}
                  <button
                    type="button"
                    className="text-button watch-delete"
                    disabled={disabled || watch.status === "deleted"}
                    onClick={() => setDeleting(watch.id)}
                  >
                    Delete watch
                  </button>
                </div>
                {sample && (
                  <div className="watch-example" role="status">
                    <h5>Captured example</h5>
                    {sample.status === "available" ? (
                      <>
                        <p className="aiko-fineprint">
                          {at(sample.event?.observedAt)}
                        </p>
                        <p className="watch-example-text">
                          {preview ??
                            "An event was captured. No readable preview is available."}
                        </p>
                      </>
                    ) : (
                      <p>No matching example has arrived yet.</p>
                    )}
                    <p className="aiko-fineprint">
                      Viewing an example does not run the action.
                    </p>
                  </div>
                )}
                {deleting === watch.id && (
                  <div className="watch-confirm">
                    <p>
                      Delete this watch? Pending work will be cancelled.
                      Previous results stay recorded.
                    </p>
                    <div className="watch-actions">
                      <button
                        type="button"
                        className="text-button watch-delete"
                        disabled={disabled}
                        onClick={() =>
                          void perform(async () => {
                            await read("/control", {
                              id: watch.id,
                              status: "deleted",
                              expectedRevision: watch.controlRevision ?? 0,
                            });
                            setDeleting(undefined);
                          }, "Deletion requested. Check the listener status.")
                        }
                      >
                        Confirm delete
                      </button>
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy}
                        onClick={() => setDeleting(undefined)}
                      >
                        Keep watch
                      </button>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
          {!draft && (
            <button
              ref={newButton}
              type="button"
              className="button"
              disabled={!canCreate || disabled}
              onClick={() => openDraft()}
            >
              New watch
            </button>
          )}
        </>
      )}
      {draft && discovery && (
        <form
          className="watch-form"
          onSubmit={(event) => {
            event.preventDefault();
            void perform(
              save,
              draft.prior
                ? "Action updated for future events."
                : "Watch saved. Check its listener status below.",
            );
          }}
        >
          <h4>{draft.prior ? "Change what happens" : "New watch"}</h4>
          <p className="watch-site">
            <span>Site</span>
            <strong>{siteName}</strong>
          </p>
          <label>
            Watch name
            <input
              ref={draftName}
              value={draft.label}
              maxLength={160}
              required
              disabled={busy}
              onChange={(event) => update({ label: event.target.value })}
            />
          </label>
          {draft.prior?.config ? (
            <p>
              <strong>When</strong> {watchEventLabel(draft.prior.config)}
            </p>
          ) : (
            <label>
              When
              <select
                value={draft.eventId}
                required
                disabled={busy}
                onChange={(event) => update({ eventId: event.target.value })}
              >
                {site?.events.map((event) => (
                  <option key={event.id} value={event.id}>
                    {event.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Do
            <select
              value={draft.actionId}
              required
              disabled={busy}
              onChange={(event) => update({ actionId: event.target.value })}
            >
              <option value="" disabled>
                Choose an available action
              </option>
              {discovery.actions.map((action) => (
                <option key={action.id} value={action.id}>
                  {action.label}
                </option>
              ))}
            </select>
          </label>
          {selectedAction?.description && (
            <p className="aiko-fineprint">{selectedAction.description}</p>
          )}
          {selectedAction?.action.kind === "actor" &&
            selectedAction.supportsInstruction && (
              <label>
                What should Aiko do?
                <textarea
                  rows={3}
                  value={draft.instruction}
                  maxLength={8000}
                  required
                  disabled={busy}
                  onChange={(event) =>
                    update({ instruction: event.target.value })
                  }
                />
              </label>
            )}
          {!draft.prior && (
            <div className="watch-limits">
              <label>
                Watch for
                <select
                  value={draft.duration}
                  disabled={busy}
                  onChange={(event) =>
                    update({ duration: Number(event.target.value) })
                  }
                >
                  {[
                    ...new Set([
                      Math.min(discovery.defaults.expiresInMs, 3_600_000),
                      ...[3_600_000, 28_800_000, 86_400_000].filter(
                        (ms) => ms <= discovery.defaults.expiresInMs,
                      ),
                    ]),
                  ].map((ms) => (
                    <option key={ms} value={ms}>
                      {ms < 3_600_000
                        ? ms < 60_000 ? `${Math.max(1,Math.floor(ms / 1000))} seconds` : `${Math.floor(ms / 60_000)} minutes`
                        : `${ms / 3_600_000} ${ms === 3_600_000 ? "hour" : "hours"}`}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Stop after
                <input
                  type="number"
                  min={1}
                  max={discovery.defaults.maxOccurrences}
                  step={1}
                  value={draft.maxOccurrences}
                  disabled={busy}
                  required
                  onChange={(event) =>
                    update({ maxOccurrences: Number(event.target.value) })
                  }
                />
                <span className="aiko-fineprint">matching events</span>
              </label>
            </div>
          )}
          {!draft.prior && site?.expiresAt !== undefined && (
            <p className="aiko-fineprint">Your current site connection allows this watch until {at(site.expiresAt)}.</p>
          )}
          <p className="aiko-fineprint">
            {draft.prior
              ? "This updates the action for future events. Its source, end time and previous results stay the same."
              : "Starting allows this action to run automatically for matching events. You can pause it here."}
          </p>
          <div className="watch-actions">
            <button
              type="submit"
              className="button primary"
              disabled={disabled || !selectedAction}
            >
              {busy ? "Saving…" : draft.prior ? "Save action" : "Start watch"}
            </button>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => setDraft(undefined)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
