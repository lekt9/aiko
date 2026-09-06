import { useEffect, useMemo, useRef, useState } from "react";
import { Upload } from "lucide-react";
import type { CsvImportResult, CsvLoginRow } from "@unlock/sdk";
import { api, useAction, useWorkspace } from "../../lib/workspace";
import { useVault } from "../../lib/vault";
import {
  parseLoginCsv,
  previewCsv,
  suggestCsvMapping,
  validCsvMapping,
  type CsvMapping,
  type CsvTable,
} from "../../lib/csv-import";
import { MAX_CSV_BYTES, MAX_VAULT_LOGINS } from "../../lib/import-policy";
import { FormError, Modal } from "./primitives";
import "../../styles/csv-import.css";

const PAGE_SIZE = 25;
const fields = [
  ["name", "Login name"],
  ["domain", "Website"],
  ["identity", "Username"],
] as const;
export function CsvImportDialog() {
  const vault = useVault();
  const workspace = useWorkspace();
  const version = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const [mappingOpen, setMappingOpen] = useState(false);
  const [table, setTable] = useState<CsvTable | null>(null);
  const [mapping, setMapping] = useState<CsvMapping>({
    name: -1,
    domain: -1,
    identity: -1,
  });
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const [page, setPage] = useState(0);
  const [summary, setSummary] = useState<{
    imported: number;
    skipped: number;
  } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const save = useAction(
    (rows: CsvLoginRow[]) => api.connections.importCsv({ rows }),
    "",
  );
  useEffect(
    () => () => {
      version.current++;
    },
    [],
  );
  useEffect(() => {
    if (summary) heading.current?.focus();
  }, [summary]);
  const preview = useMemo(
    () => (table ? previewCsv(table, mapping, workspace.connections) : []),
    [table, mapping, workspace.connections],
  );
  const ready = preview.filter((row) => row.status === "ready");
  const duplicateCount = preview.filter(
    (row) => row.status === "duplicate",
  ).length;
  const invalidCount = preview.filter(
    (row) => row.status === "invalid" || row.status === "unsupported",
  ).length;
  const pageCount = Math.ceil(preview.length / PAGE_SIZE);
  const visiblePage = Math.min(page, Math.max(0, pageCount - 1));
  const full = workspace.connections.length + ready.length > MAX_VAULT_LOGINS;
  const busy = reading || save.isPending;
  const close = () => {
    if (!save.isPending) vault.setDialog(null);
  };
  async function load(file?: File) {
    if (!file) return;
    const current = ++version.current;
    setTable(null);
    setSummary(null);
    setError("");
    save.reset();
    setFileName(file.name);
    setPage(0);
    if (file.size > MAX_CSV_BYTES) {
      setReading(false);
      setError("Choose a CSV no larger than 1 MiB.");
      return;
    }
    setReading(true);
    try {
      const text = await file.text();
      if (current !== version.current) return;
      const parsed = parseLoginCsv(text);
      const suggested = suggestCsvMapping(parsed);
      setTable(parsed);
      setMapping(suggested);
      setMappingOpen(!validCsvMapping(parsed, suggested));
    } catch (problem) {
      if (current === version.current)
        setError(
          problem instanceof Error
            ? problem.message
            : "The CSV could not be read. Try exporting it again.",
        );
    } finally {
      if (current === version.current) setReading(false);
    }
  }
  function submit() {
    if (busy || !ready.length || full) return;
    const skipped = duplicateCount + invalidCount;
    save.mutate(
      ready.map((row) => row.login!),
      {
        onSuccess: (result: CsvImportResult) => {
          setSummary({
            imported: result.imported,
            skipped: skipped + result.duplicates + result.invalid,
          });
          setTable(null);
          setFileName("");
        },
      },
    );
  }
  return (
    <Modal title={summary ? "Import complete" : "Import CSV"} close={close}>
      <div className="csv-import">
        {summary ? (
          <>
            <h3 ref={heading} tabIndex={-1}>
              {summary.imported} {summary.imported === 1 ? "login" : "logins"}{" "}
              added to My vault
            </h3>
            <p>
              {summary.skipped} rows skipped. Existing logins and agent access
              were not changed.
            </p>
            <p className="demo-note">
              Passwords were not imported. These are independent demo records,
              not usable saved credentials.
            </p>
            <div className="form-actions">
              <button
                className="button"
                onClick={() => {
                  setSummary(null);
                  save.reset();
                }}
              >
                Import another CSV
              </button>
              <button
                className="button primary"
                onClick={() => vault.switchProfile()}
              >
                View logins
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="modal-intro">
              Bring a whole CSV into My vault. Review every row before
              importing; share logins with agents afterwards.
            </p>
            <div className="demo-note">
              <strong>Demo files only.</strong> Websites and usernames must end
              in .example or .test. Recognized password, note and token columns
              are discarded locally, never uploaded. Only map demo metadata. Do
              not choose a real vault export.
            </div>
            <div className="csv-file">
              <button
                className="button"
                disabled={busy}
                onClick={() => fileInput.current?.click()}
              >
                <Upload size={18} aria-hidden="true" />{" "}
                {table ? "Change file" : "Choose CSV file"}
              </button>
              {table && (
                <span className="csv-file-name">
                  {fileName} · {table.rows.length} rows
                </span>
              )}
              <input
                ref={fileInput}
                hidden
                aria-label="Choose CSV file"
                type="file"
                accept=".csv,.tsv,text/csv,text/tab-separated-values"
                disabled={busy}
                onChange={(e) => {
                  const file = e.currentTarget.files?.[0];
                  e.currentTarget.value = "";
                  void load(file);
                }}
              />
              <small>
                UTF-8 · up to 1,000 rows · 1 MiB · comma, semicolon or tab
                separated
              </small>
            </div>
            <a
              className="text-button"
              href="/sample-logins.csv"
              download="unlock-sample-logins.csv"
            >
              Download sample CSV
            </a>
            {reading && <p role="status">Reading CSV locally…</p>}
            {error && (
              <p role="alert" className="inline-error">
                {error}
              </p>
            )}
            {table && (
              <>
                <details
                  className="csv-column-settings"
                  open={mappingOpen}
                  onToggle={(e) => setMappingOpen(e.currentTarget.open)}
                >
                  <summary>
                    {validCsvMapping(table, mapping)
                      ? "Columns matched · Change"
                      : "Match columns"}
                  </summary>
                  <fieldset className="csv-mapping" disabled={save.isPending}>
                    <legend className="csv-mapping-legend">
                      Match CSV columns
                    </legend>
                    {fields.map(([key, label]) => (
                      <label className="field" key={key}>
                        {label}
                        <select
                          value={mapping[key]}
                          onChange={(e) => {
                            setMapping((old) => ({
                              ...old,
                              [key]: Number(e.target.value),
                            }));
                            setPage(0);
                            save.reset();
                          }}
                        >
                          <option value={-1}>
                            {key === "name"
                              ? "Use website as name"
                              : "Choose a column"}
                          </option>
                          {table.columns.map(
                            (column, index) =>
                              !column.ignored && (
                                <option key={index} value={index}>
                                  {index + 1}. {column.label}
                                </option>
                              ),
                          )}
                        </select>
                      </label>
                    ))}
                  </fieldset>
                </details>
                {!validCsvMapping(table, mapping) ? (
                  <p className="inline-error" role="alert">
                    Choose different columns for Website and Username. Login
                    name is optional.
                  </p>
                ) : (
                  <>
                    <p className="csv-counts" role="status">
                      <strong>{ready.length} ready</strong> · {duplicateCount}{" "}
                      duplicates · {invalidCount} invalid or unsupported
                    </p>
                    <p className="helper">
                      Duplicates match website + username. Different usernames
                      on the same website are kept. Only valid new rows will be
                      imported; nothing is overwritten.
                    </p>
                    <div
                      className="csv-preview"
                      tabIndex={0}
                      role="region"
                      aria-label="CSV row preview"
                    >
                      <table>
                        <caption>All CSV rows · passwords excluded</caption>
                        <thead>
                          <tr>
                            <th scope="col">Row</th>
                            <th scope="col">Login</th>
                            <th scope="col">Result</th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview
                            .slice(
                              visiblePage * PAGE_SIZE,
                              (visiblePage + 1) * PAGE_SIZE,
                            )
                            .map((row) => (
                              <tr key={row.row}>
                                <th scope="row">{row.row}</th>
                                <td>
                                  {row.login ? (
                                    <>
                                      <strong>{row.login.name}</strong>
                                      <span>{row.login.domain}</span>
                                      <span>{row.login.identity}</span>
                                    </>
                                  ) : (
                                    "Not imported"
                                  )}
                                </td>
                                <td>
                                  <strong>
                                    {row.status === "ready"
                                      ? "Ready"
                                      : row.status === "duplicate"
                                        ? "Duplicate"
                                        : "Skipped"}
                                  </strong>
                                  <span>{row.message}</span>
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                    {pageCount > 1 && (
                      <nav
                        className="csv-pagination"
                        aria-label="CSV preview pages"
                      >
                        <button
                          className="button"
                          disabled={visiblePage === 0 || save.isPending}
                          onClick={() => setPage(visiblePage - 1)}
                        >
                          Previous rows
                        </button>
                        <span>
                          Page {visiblePage + 1} of {pageCount}
                        </span>
                        <button
                          className="button"
                          disabled={
                            visiblePage === pageCount - 1 || save.isPending
                          }
                          onClick={() => setPage(visiblePage + 1)}
                        >
                          Next rows
                        </button>
                      </nav>
                    )}
                    {full && (
                      <p className="inline-error" role="alert">
                        This batch would exceed the 2,000-record demo limit.
                        Nothing will be imported. Use a smaller file or reset
                        the demo vault.
                      </p>
                    )}
                  </>
                )}
              </>
            )}
            <FormError error={save.error} />
            <div className="form-actions">
              <button
                className="button"
                disabled={save.isPending}
                onClick={close}
              >
                Cancel
              </button>
              <button
                className="button primary"
                disabled={busy || !ready.length || full}
                onClick={submit}
              >
                {save.isPending
                  ? "Importing…"
                  : `Import ${ready.length} ${ready.length === 1 ? "login" : "logins"}`}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
