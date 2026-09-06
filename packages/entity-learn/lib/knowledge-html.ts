import { fail } from "./codec.js";
import type { Knowledge } from "./knowledge.js";

export const KNOWLEDGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'";
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** An inert, portable evidence view. No arbitrary HTML, scripts, model calls, remote assets or executable links. */
export function renderKnowledgeHtml(knowledge: Knowledge, observation: string): string | null {
  const page = knowledge.get(observation);
  if (!page) return null;
  const o = page.hit.observation;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escape(KNOWLEDGE_CSP)}">
<title>${escape(o.title)} · Evidence notebook</title>
<style>
:root{color-scheme:light;--paper:#f4f7fb;--ink:#17273c;--muted:#475569;--line:#becbdd;--accent:#1657a8;--warn:#784600;--wash:#fff3d6}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.65 system-ui,sans-serif}
main{max-width:960px;margin:auto;padding:48px 24px}header{border-bottom:2px solid var(--ink);padding-bottom:24px}
h1{font:normal clamp(2rem,5vw,3.4rem)/1.15 "Palatino Linotype",Palatino,serif;margin:12px 0 24px;overflow-wrap:anywhere}
h2{font-size:1.05rem;margin:0 0 12px}.label,dt{font:12px/1.6 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.meta{display:flex;gap:12px;flex-wrap:wrap}.status{padding:4px 10px;background:white;border:1px solid var(--line);border-radius:4px}
.notice{border-left:4px solid var(--accent);padding:12px 18px;background:white;margin:24px 0}.warning{border-color:var(--warn);background:var(--wash)}
.claim{display:grid;grid-template-columns:130px minmax(0,1fr);gap:24px;padding:28px 0;border-bottom:1px solid var(--line)}
.claim p{margin:0 0 14px;white-space:pre-wrap;overflow-wrap:anywhere}.basis{font-size:14px;color:var(--accent)}.inferred{color:var(--warn)}
summary{cursor:pointer;min-height:44px;padding:10px 0;font-size:14px;color:var(--accent)}summary:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
blockquote{margin:12px 0;padding:12px 18px;border-left:2px solid var(--line);background:white;white-space:pre-wrap;overflow-wrap:anywhere}
dl{font-size:13px}dd{margin:2px 0 12px;overflow-wrap:anywhere}code{font:12px/1.6 ui-monospace,monospace;overflow-wrap:anywhere}
footer{margin-top:32px;font-size:13px;color:var(--muted)}@media(max-width:580px){main{padding:24px 16px}.claim{grid-template-columns:1fr;gap:8px}}
@media print{body{background:white}main{padding:0}details{display:block}details>*{display:block}summary{display:none}.claim{break-inside:avoid}}
</style></head><body><main><header><div class="label">Evidence notebook · compiled page</div>
<h1>${escape(o.title)}</h1><div class="meta"><span class="status">${escape(page.hit.state)}</span><span class="status">Freshness: ${escape(page.hit.freshness)}</span>
<span class="status">${page.claims.length} cited claims</span></div></header>
<aside class="notice${page.hit.freshness === "stale" ? " warning" : ""}">
${page.hit.freshness === "stale" ? "Inputs changed or became stale. Review the original evidence before relying on this page. " : ""}
Quotes are checked against recorded passages. Their presence does not prove that a claim follows from them.</aside>
<section aria-label="Claims and evidence">${page.claims.map((claim, i) => `<article class="claim"><div class="basis${claim.basis === "inferred" ? " inferred" : ""}">
${claim.basis === "inferred" ? "Inferred" : "Labeled as stated"}<br><span class="label">Claim ${i + 1}</span></div><div><p>${escape(claim.text)}</p>
<details><summary>Inspect ${claim.citations.length} evidence passage${claim.citations.length === 1 ? "" : "s"}</summary>
${claim.citations.map(cite => {
    const source = page.citations.find(c => c.citation === cite)!;
    return `<blockquote>${escape(cite.quote)}</blockquote><dl><dt>${escape(source.title)}</dt><dd>${escape(source.subject)}</dd>
<dt>Observation</dt><dd><code>${escape(cite.observation)}</code></dd><dt>Evidence observed · not event time</dt><dd>${escape(new Date(source.observedAt).toISOString())}</dd>
<dt>Payload path</dt><dd><code>${escape(JSON.stringify(cite.path))}</code></dd><dt>Producer · ${escape(source.producer.kind)}</dt><dd>${escape(source.producer.reference)}</dd>
${source.producer.evidenceReference ? `<dt>Upstream evidence reference</dt><dd>${escape(source.producer.evidenceReference)}</dd>` : ""}
<dt>Evidence status</dt><dd>${escape(source.state)} · ${escape(source.freshness)}</dd></dl>`;
  }).join("")}</details></div></article>`).join("")}</section>
<footer><h2>Page receipt</h2><dl><dt>Observation</dt><dd><code>${escape(o.id)}</code></dd><dt>Compiled by</dt><dd>${escape(o.producer.reference)}</dd>
<dt>Recorded</dt><dd>${escape(new Date(o.recordedAt).toISOString())}</dd></dl>
This is a snapshot, not a live source read. Request a new view from memory to check corrections or suppression. Downloaded copies are not erased when memory is forgotten.</footer>
</main></body></html>`;
  if (Buffer.byteLength(html) > 512 * 1024) fail("too_large", "Knowledge view exceeds its render bound");
  return html;
}
