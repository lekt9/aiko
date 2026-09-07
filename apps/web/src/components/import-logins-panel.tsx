import { useRef, useState } from "react";
import { FileUp, LoaderCircle } from "lucide-react";
import { MiniAppScreen } from "./mini-app-screen";
import {
  parseLoginCsv,
  type CsvMapping,
  type CsvTable,
} from "../lib/csv-import";
import {
  csvMappingFor,
  previewConnectorCsv,
  rowsFromPreviews,
} from "../lib/login-import";
import type { ConnectorConnection } from "../lib/connectors";

/** Onboarding import from an existing password manager export. Parsing and
 * column mapping happen on this device; password columns are discarded by the
 * parser and never uploaded — only names, websites and usernames are sent. */
export function ImportLoginsPanel({
  request,
  connections,
  onClose,
  onImported,
}: {
  request: <T>(path: string, body?: object, signal?: AbortSignal) => Promise<T>;
  connections: ConnectorConnection[];
  onClose: () => void;
  onImported: () => void;
}) {
  const [table, setTable] = useState<CsvTable>();
  const [mapping, setMapping] = useState<CsvMapping>();
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [importing, setImporting] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  function load(source: File) {
    setError("");
    setNotice("");
    if (source.size > 1_048_576) {
      setError("Choose an export no larger than 1 MiB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = parseLoginCsv(String(reader.result ?? ""));
        setTable(parsed);
        setMapping(csvMappingFor(parsed));
        setFileName(source.name);
      } catch (failure) {
        setTable(undefined);
        setError(
          failure instanceof Error
            ? failure.message
            : "This file could not be read as a CSV export.",
        );
      }
    };
    reader.onerror = () =>
      setError(
        "This file could not be read. Export it again from your password manager.",
      );
    reader.readAsText(source);
  }
  function previews() {
    if (!table || !mapping) return [];
    try {
      return previewConnectorCsv(table, mapping, connections);
    } catch {
      setError("This file could not be read as a login export.");
      return [];
    }
  }
  async function submit() {
    if (importing) return;
    const ready = rowsFromPreviews(previews());
    if (!ready.length) {
      setError("Nothing to import yet. Check the rows below.");
      return;
    }
    setImporting(true);
    setError("");
    try {
      const result = await request<{
        imported: number;
        updated: number;
        skipped: { row: number; reason: string }[];
      }>("/imports/logins", { rows: ready });
      onImported();
      const extra = result.skipped.length
        ? ` ${result.skipped.length} row${result.skipped.length === 1 ? " was" : "s were"} skipped.`
        : "";
      setNotice(
        `Added ${result.imported} app${result.imported === 1 ? "" : "s"}${
          result.updated ? `, updated ${result.updated}` : ""
        }.${extra} Tap an app to finish its sign-in.`,
      );
      setTable(undefined);
      setFileName("");
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The import could not be completed.",
      );
    } finally {
      setImporting(false);
    }
  }
  const preview = previews();
  const readyCount = preview.filter((p) => p.status === "ready").length;
  const columns = table?.columns ?? [];
  const select =
    (field: keyof CsvMapping) =>
    (event: React.ChangeEvent<HTMLSelectElement>) =>
      setMapping((current) =>
        current ? { ...current, [field]: Number(event.target.value) } : current,
      );
  return (
    <MiniAppScreen title="Import logins" close={onClose}>
      <section
        aria-label="Import from a password manager export"
        aria-busy={importing}
      >
        <div className="credential-identity">
          <span className="credential-symbol">
            <FileUp size={26} aria-hidden="true" />
          </span>
          <div>
            <h3>From an existing password manager</h3>
            <p>
              Upload a CSV export from 1Password, Bitwarden, Chrome, NordPass
              and most others.
            </p>
          </div>
        </div>
        {error && (
          <p className="credential-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="connector-feedback" role="status">
            {notice}
          </p>
        )}
        {!table && (
          <>
            <input
              ref={file}
              type="file"
              accept=".csv,.tsv,text/csv,text/tab-separated-values"
              className="visually-hidden-input"
              aria-label="Password manager CSV export"
              onChange={(event) => {
                const source = event.target.files?.[0];
                if (source) load(source);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              className="button primary credential-submit"
              onClick={() => file.current?.click()}
            >
              Choose export file
            </button>
          </>
        )}
        {table && mapping && (
          <>
            <p className="aiko-fineprint">
              {fileName} — {table.rows.length} row
              {table.rows.length === 1 ? "" : "s"}. Password columns are removed
              on this device and never uploaded.
            </p>
            <div className="credential-fields import-mapping">
              {(["name", "domain", "identity"] as const).map((field) => (
                <div className="credential-field" key={field}>
                  <label htmlFor={`import-column-${field}`}>
                    {field === "name"
                      ? "Name column"
                      : field === "domain"
                        ? "Website column"
                        : "Username column"}
                  </label>
                  <select
                    id={`import-column-${field}`}
                    value={mapping[field]}
                    onChange={select(field)}
                  >
                    <option value={-1}>
                      {field === "name" ? "None" : "Choose a column…"}
                    </option>
                    {columns.map((column, index) =>
                      column.ignored ? null : (
                        <option key={index} value={index}>
                          {column.label}
                        </option>
                      ),
                    )}
                  </select>
                </div>
              ))}
            </div>
            <ul className="import-preview" aria-label="Rows ready to import">
              {preview.slice(0, 200).map((row) => (
                <li key={row.row} className={`import-row is-${row.status}`}>
                  <span className="import-row-name">
                    {row.login?.name ?? `Row ${row.row}`}
                  </span>
                  <span className="import-row-domain">
                    {row.login?.website}
                  </span>
                  <span className="import-row-status">{row.message}</span>
                </li>
              ))}
            </ul>
            {preview.length > 200 && (
              <p className="aiko-fineprint">Showing the first 200 rows.</p>
            )}
            <button
              type="button"
              className="button primary credential-submit"
              disabled={importing || !readyCount}
              onClick={() => void submit()}
            >
              {importing ? (
                <>
                  <LoaderCircle
                    size={16}
                    className="app-spinner"
                    aria-hidden="true"
                  />{" "}
                  Importing…
                </>
              ) : (
                `Import ${readyCount} app${readyCount === 1 ? "" : "s"}`
              )}
            </button>
            <button
              type="button"
              className="button"
              disabled={importing}
              onClick={() => {
                setTable(undefined);
                setFileName("");
              }}
            >
              Choose a different file
            </button>
          </>
        )}
        <p className="aiko-fineprint">
          Imports stage the app and its username only. Passwords stay in your
          password manager — you submit them during each app’s private sign-in.
        </p>
      </section>
    </MiniAppScreen>
  );
}
