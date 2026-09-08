import { useEffect, useId, useRef, useState } from "react";
import type { WatchRequest } from "../lib/browser-watches";
import {
  hasUnsettledRun,
  isSavedVersion,
  libraryRequest,
  operationLabel,
  shortVersion,
  toolInput,
  ToolRevisionSession,
  type ToolCatalog,
  type ToolInspection,
} from "../lib/saved-tools";
import "../styles/saved-tools.css";
export function SavedToolsPanel({ request }: { request: WatchRequest }) {
  const heading = useId(),
    life = useRef<AbortController | undefined>(undefined),
    requestRef = useRef(request),
    pending = useRef(false),
    sessions = useRef(new Map<string, ToolRevisionSession>());
  requestRef.current = request;
  const [catalog, setCatalog] = useState<ToolCatalog>(),
    [session, setSession] = useState<ToolRevisionSession>(),
    [file, setFile] = useState("");
  const [busy, setBusy] = useState(false),
    [available, setAvailable] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [input, setInput] = useState("{}"),
    [ready, setReady] = useState<{
      digest: string;
      input: unknown;
      key: string;
    }>(),
    [output, setOutput] = useState<{ id: string; value: unknown }>();
  const [, render] = useState(0),
    editor = useRef<HTMLHeadingElement>(null);
  const call = <T,>(path: string, body?: object) =>
    libraryRequest<T>(requestRef.current, path, body, life.current?.signal);
  async function refresh() {
    try {
      const next = await call<ToolCatalog>("");
      if (!Array.isArray(next.candidates) || !Array.isArray(next.routes))
        throw Error("Saved tool status is unavailable. Try Refresh tools.");
      setCatalog(next);
      setAvailable(true);
      return next;
    } catch (error) {
      setAvailable(false);
      throw error;
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    void refresh().catch((e) => {
      if (!controller.signal.aborted) setError((e as Error).message);
    });
    return () => controller.abort();
  }, []);
  async function perform(work: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      if (!life.current?.signal.aborted) setError((e as Error).message);
    } finally {
      pending.current = false;
      if (!life.current?.signal.aborted) {
        setBusy(false);
        render((n) => n + 1);
      }
    }
  }
  async function inspect(digest: string) {
    const value = await call<ToolInspection>("/inspect", { digest });
    let selected = sessions.current.get(digest);
    if (!selected) {
      selected = new ToolRevisionSession(value);
      sessions.current.set(digest, selected);
    } else {
      selected.inspection.expectedGeneration = value.expectedGeneration;
      selected.inspection.route = value.route;
    }
    setSession(selected);
    setFile(value.artifact.entrypoint);
    setInput("{}");
    setReady(undefined);
    setOutput(undefined);
  }
  useEffect(() => {
    if (session) editor.current?.focus();
  }, [session]);
  const matching =
    catalog?.candidates
      .filter((item) => item.name === session?.inspection.artifact.name)
      .map((item) => item.harnessDigest) ?? [];
  const operations = (catalog?.operations ?? []).filter((item) =>
    matching.includes(item.digest),
  );
  if (
    session?.runAttempt &&
    !operations.some(
      (item) => item.operationId === session.runAttempt!.operationId,
    )
  )
    operations.unshift(session.runAttempt);
  const unsettled = hasUnsettledRun(operations),
    test = session?.tested;
  return (
    <section className="saved-tools" aria-labelledby={heading} aria-busy={busy}>
      <div className="app-section-heading">
        <h3 id={heading}>Your saved tools</h3>
        <button
          className="text-button"
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              await refresh();
              if (session) {
                const fresh = await call<ToolInspection>("/inspect", {
                  digest: session.inspection.digest,
                });
                session.inspection.expectedGeneration =
                  fresh.expectedGeneration;
                session.inspection.route = fresh.route;
              }
              setNotice("Tool status refreshed. Your draft is unchanged.");
            })
          }
        >
          Refresh tools
        </button>
      </div>
      <p>
        Keep useful tools, test changes, and reuse them with fresh inputs.
        Watches keep their chosen version until you update them.
      </p>
      {error && (
        <p className="saved-tool-error" role="alert">
          {error}
        </p>
      )}
      <p className="saved-tool-notice" role="status" aria-live="polite">
        {busy ? "Working…" : notice}
      </p>
      {!catalog && !error && <p>Loading saved tools…</p>}
      {catalog && !catalog.candidates.length && (
        <p>
          No saved tools yet. Ask Aiko to save a useful tool from your work,
          then refresh this list.
        </p>
      )}
      {!!catalog?.candidates.length && (
        <label className="saved-tool-field">
          Choose a tool version
          <select
            value={session?.inspection.digest ?? ""}
            disabled={busy}
            onChange={(e) => {
              const digest = e.target.value;
              if (digest) void perform(() => inspect(digest));
            }}
          >
            <option value="">Select a saved tool</option>
            {catalog.candidates.map((item) => (
              <option key={item.harnessDigest} value={item.harnessDigest}>
                {item.name} · {shortVersion(item.harnessDigest)}
                {catalog.routes.some((route) =>
                  isSavedVersion(route, item.harnessDigest),
                )
                  ? " · Saved"
                  : " · Candidate"}
              </option>
            ))}
          </select>
        </label>
      )}
      {session && (
        <>
          <h4 ref={editor} tabIndex={-1}>
            {session.inspection.artifact.name}
          </h4>
          <p>{session.inspection.contract.outcome}</p>
          <p className="saved-tool-meta">
            {isSavedVersion(session.inspection.route, session.inspection.digest)
              ? "Saved version"
              : "Candidate version"}{" "}
            {shortVersion(session.inspection.digest)} ·{" "}
            {session.inspection.contract.effect === "read"
              ? "Reads information"
              : "Can change information"}
          </p>
          <details className="saved-tool-details">
            <summary>Source and input contract</summary>
            <h5>Where this tool came from</h5>
            <ul>
              {session.inspection.artifact.sources.map((source, index) => (
                <li key={index}>
                  <span>{source.uri}</span>
                  <br />
                  <small>Revision {source.revision}</small>
                </li>
              ))}
            </ul>
            <h5>Input contract</h5>
            <pre>
              {JSON.stringify(session.inspection.contract.inputSchema, null, 2)}
            </pre>
            <h5>Expected result</h5>
            <pre>
              {JSON.stringify(
                session.inspection.contract.outputSchema,
                null,
                2,
              )}
            </pre>
          </details>
          <fieldset disabled={busy || !available} className="saved-tool-editor">
            <legend>Edit candidate</legend>
            <label className="saved-tool-field">
              Description
              <textarea
                rows={2}
                maxLength={8000}
                value={session.description}
                onChange={(e) => {
                  session.description = e.target.value;
                  render((n) => n + 1);
                }}
              />
            </label>
            <label className="saved-tool-field">
              Source file
              <select value={file} onChange={(e) => setFile(e.target.value)}>
                {Object.keys(session.files).map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </label>
            <label className="saved-tool-field">
              File contents
              <textarea
                className="saved-tool-code"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                rows={10}
                maxLength={65536}
                value={session.files[file] ?? ""}
                onChange={(e) => {
                  session.files[file] = e.target.value;
                  render((n) => n + 1);
                }}
              />
            </label>
            <p className="saved-tool-meta">
              Testing creates a separate candidate and runs its registered,
              independent test cases. It may use controlled resources and take
              time.
            </p>
            <div className="saved-tool-actions">
              <button
                className="button"
                onClick={() =>
                  void perform(async () => {
                    const result = await session.test(
                      requestRef.current,
                      life.current?.signal,
                    );
                    await refresh();
                    setNotice(
                      result.status === "eligible"
                        ? "Revision passed its independent tests. You can save this version."
                        : result.status === "failed"
                          ? "This candidate did not pass. Your edits are retained; revise them and test again."
                          : "Test outcome is not confirmed. Check the same test result before trying a new revision.",
                    );
                  })
                }
              >
                {test?.status === "unknown" || test?.status === "pending"
                  ? "Check test result"
                  : "Test revision"}
              </button>
              <button
                className="button primary"
                disabled={test?.status !== "eligible"}
                onClick={() =>
                  void perform(async () => {
                    const digest = await session.save(
                      requestRef.current,
                      life.current?.signal,
                    );
                    await refresh();
                    await inspect(digest);
                    setNotice(
                      "Version saved. Existing watches keep their chosen version.",
                    );
                  })
                }
              >
                Save version
              </button>
            </div>
            {test && (
              <p className="saved-tool-test" role="status">
                {
                  {
                    eligible: "Tests passed",
                    failed: "Tests did not pass",
                    pending: "Tests pending",
                    unknown: "Test outcome unknown",
                  }[test.status]
                }
                {test.evaluation?.witnessIds?.length
                  ? ` · ${test.evaluation.witnessIds.length} checked cases`
                  : ""}
                <br />
                <small>Candidate {shortVersion(test.digest)}</small>
              </p>
            )}
          </fieldset>
          <fieldset disabled={busy || !available} className="saved-tool-editor">
            <legend>Use the saved version</legend>
            <p>
              Check whether the saved version supports your current inputs
              before running it.
            </p>
            <label className="saved-tool-field">
              Fresh inputs (JSON)
              <textarea
                className="saved-tool-code"
                spellCheck={false}
                rows={4}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  setReady(undefined);
                }}
              />
            </label>
            <div className="saved-tool-actions">
              <button
                className="button"
                onClick={() =>
                  void perform(async () => {
                    const values = toolInput(input);
                    const result = await call<{
                      status: string;
                      digest?: string;
                    }>("/recall", {
                      name: session.inspection.artifact.name,
                      contractDigest:
                        session.inspection.artifact.contractDigest,
                      input: values,
                    });
                    if (result.status !== "available" || !result.digest) {
                      setReady(undefined);
                      setNotice(
                        "No verified saved version is available for these inputs. Check the contract or test and save a version.",
                      );
                      return;
                    }
                    setReady({
                      digest: result.digest,
                      input: values,
                      key: input,
                    });
                    setNotice(
                      `Inputs ready for saved version ${shortVersion(result.digest)}. Run only when you want to execute it.`,
                    );
                  })
                }
              >
                Check inputs
              </button>
              <button
                className="button primary"
                disabled={
                  !ready ||
                  ready.key !== input ||
                  unsettled ||
                  !!session.runAttempt
                }
                onClick={() =>
                  void perform(async () => {
                    if (!ready) return;
                    const run = await session.run(
                      requestRef.current,
                      ready.digest,
                      ready.input,
                      life.current?.signal,
                    );
                    setReady(undefined);
                    await refresh();
                    setNotice(operationLabel(run.status));
                    if (run.status === "satisfied")
                      setOutput({
                        id: run.operationId,
                        value: await session.output(
                          requestRef.current,
                          run,
                          life.current?.signal,
                        ),
                      });
                  })
                }
              >
                Run saved tool
              </button>
            </div>
            {unsettled && (
              <p className="saved-tool-meta">
                An earlier run has no confirmed outcome. Check its result below;
                starting another run is held.
              </p>
            )}
            {session.runAttempt && !unsettled && (
              <button
                className="text-button"
                onClick={() => {
                  session.runAttempt = undefined;
                  setReady(undefined);
                  setNotice(
                    "Enter fresh inputs and check them before starting a new run.",
                  );
                  render((n) => n + 1);
                }}
              >
                Prepare another run
              </button>
            )}
          </fieldset>
          {!!operations.length && (
            <div className="saved-tool-history">
              <h4>Recent runs</h4>
              {operations.map((operation) => (
                <div
                  className="saved-tool-operation"
                  key={operation.operationId}
                >
                  <p>
                    <b>{operationLabel(operation.status)}</b>
                    <br />
                    <small>{operation.operationId}</small>
                  </p>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        setOutput({
                          id: operation.operationId,
                          value: await session.output(
                            requestRef.current,
                            operation,
                            life.current?.signal,
                          ),
                        });
                        await refresh();
                        setNotice(
                          "Showing the checked result of this run. No new action was sent.",
                        );
                      })
                    }
                  >
                    {operation.status === "satisfied"
                      ? "View result"
                      : "Check result"}
                  </button>
                </div>
              ))}
            </div>
          )}
          {output && (
            <div className="saved-tool-output">
              <h4>Run result</h4>
              <p className="saved-tool-meta">Retained result for {output.id}</p>
              <pre>{JSON.stringify(output.value, null, 2)}</pre>
            </div>
          )}
        </>
      )}
    </section>
  );
}
