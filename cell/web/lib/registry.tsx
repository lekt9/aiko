"use client";
import { defineRegistry } from "@json-render/react";
import { catalog } from "./catalog";

function ToneDot({ tone }: { tone?: string | null }) {
  const cls =
    tone === "ok" ? "ok pulse" :
    tone === "warn" ? "warn" :
    tone === "err" ? "err" : tone === "accent" ? "ok" : "off";
  return <span className={`dot ${cls}`} aria-hidden />;
}

type AnyProps = any;

export const { registry } = defineRegistry(catalog, {
  components: {
    BlockHeader: ({ props }: { props: AnyProps }) => (
      <div>
        <div className="flex items-center gap-2">
          <ToneDot tone={props.tone ?? "neutral"} />
          <span className="min-w-0 text-[13px] font-semibold tracking-[-0.01em]" style={{ overflowWrap: "anywhere" }}>{props.title}</span>
          {props.badge && (
            <span className={`shrink-0 whitespace-nowrap rounded-full border px-1.5 py-0 font-mono text-[10px] font-medium tabular-nums ${props.tone === "ok" ? "border-[var(--ok)] text-[var(--ok)]" : props.tone === "warn" ? "border-[var(--warn)] text-[var(--warn)]" : "border-os-border text-os-dim"}`}>
              {props.badge}
            </span>
          )}
        </div>
        {props.subtitle && <div className="mt-1 font-mono text-[11px] text-os-dim" style={{ overflowWrap: "anywhere" }}>{props.subtitle}</div>}
      </div>
    ),
    Stat: ({ props }: { props: AnyProps }) => (
      <div className="flex items-baseline justify-between gap-3 rounded-sm-t border border-os-hairline bg-os-bg px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-os-dim">{props.label}</span>
        <span className="whitespace-nowrap text-[13px] font-semibold tabular-nums">{props.value}</span>
        {props.hint && <span className="whitespace-nowrap font-mono text-[10px] tabular-nums text-os-dim">{props.hint}</span>}
      </div>
    ),
    Badge: ({ props }: { props: AnyProps }) => {
      const tone = props.tone ?? "neutral";
      const bg =
        tone === "ok" ? "border-[var(--ok)] text-[var(--ok)]" :
        tone === "warn" ? "border-[var(--warn)] text-[var(--warn)]" :
        tone === "err" ? "border-[var(--err)] text-[var(--err)]" :
        tone === "accent" ? "border-os-accent text-os-accent" :
        "border-os-border text-os-dim";
      return <span className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold tabular-nums ${bg}`}>{props.label}</span>;
    },
    KVGrid: ({ props }: { props: AnyProps }) => (
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 max-[640px]:grid-cols-1">
        {props.pairs.map((p: any, i: number) => (
          <div key={i} className="min-w-0 rounded-sm-t border border-os-hairline bg-os-bg px-3 py-2">
            <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-os-dim">{String(p.k).replaceAll("_"," ").replace(/\b\w/g,(c:string)=>c.toUpperCase())}</div>
            <div className="mt-0.5 min-w-0 font-mono text-[12px]" style={{ overflowWrap: "anywhere" }}>{p.v}</div>
          </div>
        ))}
      </div>
    ),
    MiniTable: ({ props }: { props: AnyProps }) => (
      <div className="overflow-auto rounded-sm-t border border-os-border">
        <table className="w-full border-collapse font-mono text-[11px]">
          <thead>
            <tr className="border-b border-os-border bg-os-surface2">
              {props.columns.map((c: any) => (
                <th key={c.key} className="whitespace-nowrap px-2.5 py-1.5 text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-os-dim">{c.label ?? c.key}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {props.rows.map((row: any, i: number) => (
              <tr key={i} className="border-b border-os-hairline last:border-0 hover:bg-os-surface2/60">
                {props.columns.map((c: any) => (
                  <td key={c.key} className="min-w-0 max-w-[160px] truncate px-2.5 py-1.5 tabular-nums">{String(row[c.key] ?? "\u2014")}</td>
                ))}
              </tr>
            ))}
            {props.rows.length === 0 && (
              <tr><td colSpan={props.columns.length} className="px-2.5 py-6 text-center text-os-dim">No rows</td></tr>
            )}
          </tbody>
        </table>
      </div>
    ),
    Timeline: ({ props }: { props: AnyProps }) => (
      <div className="space-y-2">
        {props.items.map((it: any, i: number) => (
          <div key={i} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span className="h-2 w-2 rounded-full bg-os-accent" aria-hidden />
              {i < props.items.length - 1 && <span className="mt-1 w-px flex-1 bg-os-hairline" aria-hidden />}
            </div>
            <div className="min-w-0 flex-1 pb-3">
              <div className="whitespace-nowrap font-mono text-[10px] tabular-nums text-os-dim">{it.at}</div>
              <div className="mt-0.5 min-w-0 text-[12px] leading-relaxed" style={{ overflowWrap: "anywhere" }}>{it.message}</div>
            </div>
          </div>
        ))}
        {props.items.length === 0 && <div className="font-mono text-[11px] text-os-dim">No events</div>}
      </div>
    ),
    // RelationTag — notion-style clickable entity reference rendered inline inside blocks
    RelationTag: ({ props }: { props: AnyProps }) => (
      <button
        onClick={() => {
          const k = String(props.relationKey ?? "");
          const v = String(props.value ?? "");
          if (k && v) window.dispatchEvent(new CustomEvent("dashboard:relation", { detail: { key: k, value: v, sourceId: props.sourceId } }));
        }}
        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-os-border bg-os-bg px-2 py-0.5 font-mono text-[11px] outline-none transition-[border-color,color] duration-[var(--dur-short)] hover:border-[var(--border-strong)] hover:text-os-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2 active:opacity-80"
        title={`${props.relationKey ?? ""} = ${props.value ?? ""}`}
      >
        <span className="dot ok shrink-0" aria-hidden />
        <span className="max-w-[140px] truncate">{props.label ?? props.value ?? "\u2014"}</span>
      </button>
    ),
    PropertyRow: ({ props }: { props: AnyProps }) => (
      <div className="flex items-baseline justify-between gap-3 rounded-sm-t border border-os-hairline bg-os-bg px-3 py-2">
        <span className="whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.14em] text-os-dim">{props.label}</span>
        <span className="min-w-0 flex-1 text-right font-mono text-[12px] tabular-nums" style={{ overflowWrap: "anywhere" }}>{props.value}</span>
      </div>
    ),
    BusinessLogic: ({ props }: { props: AnyProps }) => (
      <details className="group rounded-lg-t border border-os-border bg-os-surface open:bg-os-surface">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-3.5 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-os-dim">Business Logic</span>
            <span className="hidden font-mono text-[10px] text-os-dim sm:inline">{props.title}</span>
          </span>
          <span className="flex items-center gap-2">
            {props.neuronPath && <span className="hidden font-mono text-[10px] tabular-nums text-os-dim sm:inline">{props.neuronPath}</span>}
            <span className="flex h-5 w-5 items-center justify-center rounded-full border border-os-border bg-os-bg font-mono text-[10px] text-os-dim transition-transform group-open:rotate-180" aria-hidden>⌄</span>
          </span>
        </summary>
        <div className="border-t border-os-hairline px-5 pb-4 pt-4">
          <div className="text-[13px] font-semibold tracking-[-0.01em]" style={{ overflowWrap: "anywhere" }}>{props.title}</div>
          {props.summary && <div className="mt-1.5 font-mono text-[11px] leading-relaxed text-os-dim" style={{ overflowWrap: "anywhere" }}>{props.summary}</div>}
          <ol className="mt-4 space-y-3">
            {props.steps.map((s: any) => (
              <li key={s.id} className="flex gap-3">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-os-accent font-mono text-[10px] font-semibold tabular-nums text-os-ink">{s.id}</span>
                <span className="min-w-0 flex-1 pt-0.5 font-mono text-[11px] leading-relaxed text-os-text" style={{ overflowWrap: "anywhere" }}>{s.text}</span>
              </li>
            ))}
          </ol>
        </div>
      </details>
    ),
    Block: ({ props, children }: { props: AnyProps; children?: any }) => (
      <div className="rounded-lg-t border border-os-border bg-os-surface p-5 space-y-4">{children}</div>
    ),
  },
  actions: {
    openCell: async ({ params }: any) => {
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("cell:open", { detail: params }));
    },
    drillRelation: async ({ params }: any) => {
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("cell:drill", { detail: params }));
    },
  },
});
