import { LayoutDashboard, RefreshCw, ExternalLink, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { GenerativeView } from "../generative/GenerativeView";
import {
  getUiComponent,
  listRoutes,
  listUiComponents,
  rankUiComponents,
  seedUiCatalog,
  uiStoreRoot,
} from "../generative/store";
import type {
  StoredUiComponent,
  UiIndexEntry,
  UiRankHit,
} from "../generative/types";
import type { Spec } from "@json-render/react";

interface UiLibrarySurfaceProps {
  workspaceName?: string;
}

export function UiLibrarySurface({ workspaceName }: UiLibrarySurfaceProps) {
  const [items, setItems] = useState<UiIndexEntry[]>([]);
  const [routes, setRoutes] = useState<Record<string, string>>({});
  const [root, setRoot] = useState("");
  const [selected, setSelected] = useState<StoredUiComponent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<UiRankHit[]>([]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await seedUiCatalog().catch(() => undefined);
      const [list, r, storeRoot] = await Promise.all([
        listUiComponents(workspaceName),
        listRoutes(),
        uiStoreRoot(),
      ]);
      setItems(list);
      setRoutes(r);
      setRoot(storeRoot);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load UI library");
    } finally {
      setLoading(false);
    }
  }, [workspaceName]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      return;
    }
    const handle = window.setTimeout(() => {
      void rankUiComponents(query.trim(), 12)
        .then(setHits)
        .catch(() => setHits([]));
    }, 180);
    return () => window.clearTimeout(handle);
  }, [query]);

  const open = async (id: string) => {
    setError(null);
    try {
      const component = await getUiComponent(id);
      setSelected(component);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open UI");
    }
  };

  const visibleItems = hits.length > 0 ? null : items;

  return (
    <section className="surface ui-library" aria-labelledby="ui-lib-title">
      <header className="ui-library__header">
        <div>
          <p className="surface__overline">Surfaces</p>
          <h1 id="ui-lib-title">UI library</h1>
          <p className="ui-library__lead">
            Contract-native generative components — content-addressed, ranked,
            and re-retrievable under <code>{root || "~/.aiko/ui"}</code>.
            Pull with <code>ui resolve aiko:ui/…</code> or{" "}
            <code>contract recommend "ui:…"</code>.
          </p>
        </div>
        <button type="button" className="ui-library__refresh" onClick={() => void refresh()}>
          <RefreshCw size={15} aria-hidden="true" />
          Refresh
        </button>
      </header>

      <div className="ui-library__search">
        <Search size={15} aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Rank surfaces… e.g. playlist downloads table"
          aria-label="Rank UI surfaces"
        />
      </div>

      {error && (
        <p className="ui-library__error" role="alert">
          {error}
        </p>
      )}

      <div className="ui-library__grid">
        <div className="ui-library__list">
          <h2>{hits.length > 0 ? "Ranked" : "Components"}</h2>
          {loading && <p className="ui-library__muted">Loading…</p>}
          {!loading && hits.length === 0 && items.length === 0 && (
            <p className="ui-library__muted">
              No saved surfaces yet. Ask Aiko for a dashboard or playlist —
              each json-render block is stored as <code>aiko:ui/…</code> and
              registered on the contract ledger.
            </p>
          )}
          <ul>
            {hits.map((hit) => (
              <li key={hit.id}>
                <button
                  type="button"
                  className="ui-library__item"
                  data-active={selected?.meta.id === hit.id}
                  onClick={() => void open(hit.id)}
                >
                  <LayoutDashboard size={16} aria-hidden="true" />
                  <span>
                    <strong>{hit.title}</strong>
                    <small>
                      score {hit.score.toFixed(2)} · {hit.pointer}
                      {hit.contractId ? ` · contract:${hit.contractId}` : ""}
                    </small>
                  </span>
                </button>
              </li>
            ))}
            {visibleItems?.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="ui-library__item"
                  data-active={selected?.meta.id === item.id}
                  onClick={() => void open(item.id)}
                >
                  <LayoutDashboard size={16} aria-hidden="true" />
                  <span>
                    <strong>{item.title}</strong>
                    <small>
                      {item.pointer}
                      {item.route ? ` · ${item.route}` : ""}
                      {item.contractId ? ` · contract:${item.contractId}` : ""}
                    </small>
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {Object.keys(routes).length > 0 && hits.length === 0 && (
            <>
              <h2>Routes</h2>
              <ul className="ui-library__routes">
                {Object.entries(routes).map(([route, id]) => (
                  <li key={route}>
                    <button type="button" onClick={() => void open(id)}>
                      <ExternalLink size={14} aria-hidden="true" />
                      <code>{route}</code>
                      <span>→ {id}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div className="ui-library__preview">
          {selected ? (
            <>
              <div className="ui-library__preview-meta">
                <h2>{selected.meta.title}</h2>
                <code>{`aiko:ui/${selected.meta.id}`}</code>
                {selected.meta.specPointer && (
                  <code>{selected.meta.specPointer}</code>
                )}
                {selected.meta.route && <code>{selected.meta.route}</code>}
                {selected.meta.contractId && (
                  <span>contract: {selected.meta.contractId}</span>
                )}
                {selected.meta.action && (
                  <code className="ui-library__action">{selected.meta.action}</code>
                )}
              </div>
              <GenerativeView
                spec={selected.spec as Spec}
                initialState={selected.state}
              />
              {Object.keys(selected.bindings ?? {}).length > 0 && (
                <details className="ui-library__bindings">
                  <summary>Pointer bindings</summary>
                  <pre>
                    {JSON.stringify(selected.bindings, null, 2)}
                  </pre>
                </details>
              )}
            </>
          ) : (
            <div className="ui-library__empty-preview">
              <LayoutDashboard size={28} aria-hidden="true" />
              <p>
                Select a surface to reopen it. Rank by goal, then retrieve with{" "}
                <code>ui.resolve</code> — same shape as contract recommend.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
