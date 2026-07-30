import { defineRegistry, useBoundProp, useStateStore } from "@json-render/react";
import { aikoCatalog } from "./catalog";

function toneClass(tone?: string | null, prefix = "gen-tone"): string {
  if (!tone || tone === "default") return `${prefix}--default`;
  return `${prefix}--${tone}`;
}

function gapClass(gap?: string | null): string {
  switch (gap) {
    case "sm":
      return "gen-gap-sm";
    case "lg":
      return "gen-gap-lg";
    default:
      return "gen-gap-md";
  }
}

function str(value: unknown, fallback = ""): string {
  if (value == null) return fallback;
  return typeof value === "string" ? value : String(value);
}

function num(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export const { registry, handlers: createCatalogHandlers } = defineRegistry(
  aikoCatalog,
  {
    components: {
      Stack: ({ props, children }) => (
        <div
          className={`gen-stack gen-stack--${props.direction ?? "column"} ${gapClass(props.gap)}`}
          style={{
            alignItems:
              props.align === "center"
                ? "center"
                : props.align === "end"
                  ? "flex-end"
                  : props.align === "stretch"
                    ? "stretch"
                    : "flex-start",
          }}
        >
          {children}
        </div>
      ),

      Grid: ({ props, children }) => (
        <div
          className={`gen-grid ${gapClass(props.gap)}`}
          style={{
            gridTemplateColumns: `repeat(${Math.min(Math.max(num(props.columns, 2), 1), 4)}, minmax(0, 1fr))`,
          }}
        >
          {children}
        </div>
      ),

      Card: ({ props, children }) => {
        const hasBody = Boolean(children);
        return (
          <section
            className={`gen-card ${toneClass(props.tone, "gen-card")}${hasBody ? "" : " gen-card--header-only"}`}
          >
            {(props.title || props.description) && (
              <header className="gen-card__header">
                {props.title && (
                  <h3 className="gen-card__title">{str(props.title)}</h3>
                )}
                {props.description && (
                  <p className="gen-card__description">
                    {str(props.description)}
                  </p>
                )}
              </header>
            )}
            {hasBody && <div className="gen-card__body">{children}</div>}
          </section>
        );
      },

      Heading: ({ props }) => {
        const level = props.level ?? "2";
        const Tag = (`h${level}` as "h1" | "h2" | "h3");
        return (
          <Tag className={`gen-heading gen-heading--${level}`}>
            {str(props.text)}
          </Tag>
        );
      },

      Text: ({ props }) => (
        <p className={`gen-text${props.muted ? " gen-text--muted" : ""}`}>
          {str(props.content)}
        </p>
      ),

      Metric: ({ props }) => (
        <div className="gen-metric">
          <span className="gen-metric__label">{str(props.label)}</span>
          <span className="gen-metric__value">{str(props.value, "—")}</span>
          {(props.delta || props.trend) && (
            <span
              className={`gen-metric__delta gen-metric__delta--${props.trend ?? "flat"}`}
            >
              {props.delta
                ? str(props.delta)
                : props.trend === "up"
                  ? "↑"
                  : props.trend === "down"
                    ? "↓"
                    : "→"}
            </span>
          )}
          {props.hint && (
            <span className="gen-metric__hint">{str(props.hint)}</span>
          )}
        </div>
      ),

      Badge: ({ props }) => (
        <span className={`gen-badge ${toneClass(props.tone, "gen-badge")}`}>
          {str(props.label)}
        </span>
      ),

      Progress: ({ props }) => {
        const max = props.max && num(props.max) > 0 ? num(props.max) : 100;
        const value = num(props.value);
        const pct = Math.max(0, Math.min(100, (value / max) * 100));
        return (
          <div className="gen-progress">
            <div className="gen-progress__meta">
              <span>{str(props.label, "Progress")}</span>
              <span>
                {value}
                {max !== 100 ? ` / ${max}` : "%"}
              </span>
            </div>
            <div
              className="gen-progress__track"
              role="progressbar"
              aria-valuenow={value}
              aria-valuemin={0}
              aria-valuemax={max}
            >
              <div className="gen-progress__fill" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      },

      List: ({ props }) => {
        const items = Array.isArray(props.items) ? props.items : [];
        const Tag = props.ordered ? "ol" : "ul";
        return (
          <Tag className="gen-list">
            {items.map((item, index) => {
              const text = str(item);
              return <li key={`${index}-${text.slice(0, 24)}`}>{text}</li>;
            })}
          </Tag>
        );
      },

      Table: ({ props }) => {
        const columns = Array.isArray(props.columns) ? props.columns : [];
        const rows = Array.isArray(props.rows) ? props.rows : [];
        return (
          <div className="gen-table-wrap">
            <table className="gen-table">
              {props.caption && <caption>{str(props.caption)}</caption>}
              <thead>
                <tr>
                  {columns.map((col, i) => (
                    <th key={`${i}-${str(col)}`}>{str(col)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, ri) => {
                  const cells = Array.isArray(row) ? row : [row];
                  return (
                    <tr key={ri}>
                      {cells.map((cell, ci) => (
                        <td key={ci}>{str(cell)}</td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      },

      BarChart: ({ props }) => {
        const labels = Array.isArray(props.labels) ? props.labels : [];
        const values = Array.isArray(props.values) ? props.values.map((v) => num(v)) : [];
        const max = Math.max(1, ...values, 0);
        return (
          <div className="gen-barchart">
            {props.title && (
              <h4 className="gen-barchart__title">{str(props.title)}</h4>
            )}
            <ul className="gen-barchart__list">
              {labels.map((label, index) => {
                const value = values[index] ?? 0;
                const pct = Math.max(2, (value / max) * 100);
                return (
                  <li key={`${str(label)}-${index}`}>
                    <span className="gen-barchart__label">{str(label)}</span>
                    <span className="gen-barchart__track">
                      <span
                        className="gen-barchart__bar"
                        style={{ width: `${pct}%` }}
                      />
                    </span>
                    <span className="gen-barchart__value">
                      {value}
                      {props.unit ? str(props.unit) : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      },

      Divider: ({ props }) => (
        <div className="gen-divider" role="separator">
          {props.label && <span>{str(props.label)}</span>}
        </div>
      ),

      Button: ({ props, emit }) => (
        <button
          type="button"
          className={`gen-button gen-button--${props.variant ?? "primary"}`}
          onClick={() => emit("press")}
        >
          {str(props.label, "Button")}
        </button>
      ),

      Code: ({ props }) => (
        <pre className="gen-code" data-language={props.language ?? undefined}>
          <code>{str(props.content)}</code>
        </pre>
      ),

      Callout: ({ props }) => (
        <aside className={`gen-callout gen-callout--${props.tone ?? "info"}`}>
          {props.title && (
            <strong className="gen-callout__title">{str(props.title)}</strong>
          )}
          <p>{str(props.content)}</p>
        </aside>
      ),

      Tabs: ({ props, children, bindings }) => {
        const store = useStateStore();
        const tabs = Array.isArray(props.tabs) ? props.tabs : [];
        const [active, setActive] = useBoundProp<string>(
          props.activeId ?? tabs[0]?.id ?? "",
          bindings?.activeId,
        );
        const current = active || tabs[0]?.id || "";

        return (
          <div className="gen-tabs">
            <div className="gen-tabs__list" role="tablist">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={tab.id === current}
                  className="gen-tabs__tab"
                  data-active={tab.id === current}
                  onClick={() => {
                    setActive(tab.id);
                    store.set("/activeTab", tab.id);
                  }}
                >
                  {str(tab.label)}
                </button>
              ))}
            </div>
            <div className="gen-tabs__panel" role="tabpanel">
              {children}
            </div>
          </div>
        );
      },
    },

    actions: {
      copy: async (params) => {
        const text = String(params?.text ?? "");
        if (!text) return;
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
      },
      open_url: async (params) => {
        const url = String(params?.url ?? "");
        if (!url) return;
        window.open(url, "_blank", "noopener,noreferrer");
      },
      notify: async (params, setState) => {
        const message = String(params?.message ?? "");
        const tone = (params?.tone as string | null) ?? "info";
        setState((prev) => ({
          ...prev,
          notice: { message, tone, at: Date.now() },
        }));
      },
    },
  },
);
