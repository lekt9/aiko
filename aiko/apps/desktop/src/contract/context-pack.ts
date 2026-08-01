// context-pack.ts — rank + pack contract graph context for one agent turn.
//
// The chat path used to only inject a one-line LEARNED HINT from recommend().
// Neurons fired for provenance, but the model never saw frontier / related
// proofs. This module is the packer: given the user message, gather
// recommend + frontier levers + related ledger evidence into a hard-capped
// CONTRACT CONTEXT block for the system prompt.
//
// Best-effort and enhancement-only: any substrate failure returns "".

import { frontier } from "./agency";
import * as native from "./native";
import { dumpRows, type StoreRow } from "./store";
import { type ContractDecision, shouldDeclareTurn, whenToContract } from "./when";

/** Hard cap on the injected block (keeps TPM honest). */
export const MAX_CONTEXT_PACK_CHARS = (() => {
  const raw = Number(process.env.AIKO_CONTEXT_PACK_CHARS);
  if (Number.isFinite(raw) && raw >= 800) return Math.floor(raw);
  return 3_500;
})();

const MAX_FRONTIER = 5;
const MAX_RELATED = 4;
const MAX_PROOF_CHARS = 280;
const INTERNAL_PLAN = /^(algorithm:|word:|tool:|turn:|claim:|mult:|value-of:|sabbath:)/i;

export interface RecommendSlice {
  binary: string;
  example: string;
  score: number;
}

export interface FrontierSlice {
  id: string;
  label: string;
  plan: string;
}

export interface RelatedSlice {
  id: string;
  plan: string;
  status: "open" | "satisfied" | "failed";
  proof?: string;
}

export interface ContractContextPack {
  decision: ContractDecision;
  recommend: RecommendSlice | null;
  frontier: FrontierSlice[];
  related: RelatedSlice[];
  /** Ready-to-append system prompt section (empty when nothing useful). */
  text: string;
}

function cleanLabel(raw: unknown): string {
  const text = String(raw ?? "").trim();
  if (!text || INTERNAL_PLAN.test(text)) return "";
  return text.replace(/^goal:/i, "").slice(0, 160);
}

function goalTokens(goal: string): string[] {
  return goal
    .toLowerCase()
    .replace(/[^a-z0-9_\-.\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !/^(the|and|for|with|from|this|that|into|your|have|been)$/.test(t))
    .slice(0, 12);
}

function scorePlan(plan: string, tokens: string[]): number {
  const p = plan.toLowerCase();
  let s = 0;
  for (const t of tokens) {
    if (p.includes(t)) s += 1;
  }
  return s;
}

function decodeProof(proof: string | undefined): string | undefined {
  if (!proof) return undefined;
  try {
    const raw = Buffer.from(proof, "base64").toString("utf8");
    const j = JSON.parse(raw) as unknown;
    const text = typeof j === "string" ? j : JSON.stringify(j);
    const one = text.replace(/\s+/g, " ").trim();
    if (!one) return undefined;
    return one.length <= MAX_PROOF_CHARS ? one : `${one.slice(0, MAX_PROOF_CHARS - 1)}…`;
  } catch {
    const one = proof.replace(/\s+/g, " ").trim();
    if (!one) return undefined;
    return one.length <= MAX_PROOF_CHARS ? one : `${one.slice(0, MAX_PROOF_CHARS - 1)}…`;
  }
}

/** Pull a short proof snippet for a neuron id from the signed ledger (if live). */
function proofForId(id: string): string | undefined {
  if (!native.isAvailable()) return undefined;
  try {
    const rows = native.get(id);
    if (!rows) return undefined;
    let last: string | undefined;
    for (const line of rows.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const row = JSON.parse(t) as { proof?: string; event?: string };
        if (row.proof) last = decodeProof(row.proof) ?? last;
      } catch {
        /* skip */
      }
    }
    return last;
  } catch {
    return undefined;
  }
}

function frontierSlices(goal: string): FrontierSlice[] {
  const plan = frontier(goal);
  const tokens = goalTokens(goal);
  const scored: Array<FrontierSlice & { score: number }> = [];
  const seen = new Set<string>();

  for (const lever of plan.levers) {
    const label = cleanLabel(lever.plan ?? lever.label ?? lever.title);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const planText = String(lever.plan ?? label);
    // Rank by token overlap with THIS turn's goal. Drop zero-score open rows from
    // unrelated sessions (the local frontier was returning every open goal:).
    const score = scorePlan(planText + " " + label, tokens);
    if (tokens.length > 0 && score <= 0) continue;
    scored.push({
      id: String(lever.id ?? ""),
      label,
      plan: planText.slice(0, 200),
      score,
    });
  }

  scored.sort((a, b) => b.score - a.score);

  // If nothing matched the open set, fall back to a fresh plan for THIS goal only.
  if (scored.length === 0) {
    try {
      const fresh = frontier(goal); // may re-plan when open set empty
      // Prefer planGoal-shaped levers already in `plan` when all were filtered —
      // re-call plan via frontier after filtering left us cold: use label=goal itself.
      const self = cleanLabel(goal);
      if (self) {
        return [{ id: "", label: self.slice(0, 160), plan: `goal:${goal.slice(0, 200)}` }];
      }
      void fresh;
    } catch {
      /* ignore */
    }
  }

  return scored.slice(0, MAX_FRONTIER).map(({ id, label, plan: p }) => ({ id, label, plan: p }));
}

/**
 * Rank related ledger rows (TS fallback store + open frontier ids) by token overlap
 * with the goal. Prefer open/satisfied goals over pure machinery.
 */
function relatedSlices(goal: string, frontierIds: string[]): RelatedSlice[] {
  const tokens = goalTokens(goal);
  if (tokens.length === 0) return [];

  type Cand = RelatedSlice & { score: number; ts: string };
  const cands: Cand[] = [];
  const seen = new Set<string>();

  // 1) Frontier lever ids → pull proof from signed ledger if any.
  for (const id of frontierIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const proof = proofForId(id);
    if (proof) {
      cands.push({
        id,
        plan: id,
        status: "satisfied",
        proof,
        score: 3,
        ts: "",
      });
    }
  }

  // 2) Local aiko store rows (plan/frontier backend) — ranked by token overlap.
  let rows: StoreRow[] = [];
  try {
    rows = dumpRows();
  } catch {
    rows = [];
  }

  const terminal = new Map<string, "satisfied" | "failed">();
  for (const r of rows) {
    if (r.event === "satisfied") terminal.set(r.id, "satisfied");
    if (r.event === "died") terminal.set(r.id, "failed");
  }

  const declared = new Map<string, StoreRow>();
  for (const r of rows) {
    if (r.event === "declared" && r.plan) declared.set(r.id, r);
  }

  for (const [id, meta] of declared) {
    if (seen.has(id)) continue;
    const plan = meta.plan ?? "";
    if (INTERNAL_PLAN.test(plan)) continue;
    const sc = scorePlan(plan, tokens);
    if (sc <= 0) continue;
    // Prefer goal-ish rows.
    const isGoal = plan.startsWith("goal:") || meta.action === "goal" || meta.agent === "aiko-agency";
    const status = terminal.get(id) ?? "open";
    const proof =
      status === "satisfied"
        ? (decodeProof(rows.filter((r) => r.id === id && r.event === "satisfied").at(-1)?.proof) ?? proofForId(id))
        : proofForId(id);
    seen.add(id);
    cands.push({
      id,
      plan: cleanLabel(plan) || plan.slice(0, 160),
      status,
      proof,
      score: sc + (isGoal ? 2 : 0) + (status === "satisfied" ? 1 : 0) + (status === "open" ? 0.5 : 0),
      ts: meta.ts ?? "",
    });
  }

  cands.sort((a, b) => b.score - a.score || b.ts.localeCompare(a.ts));
  return cands.slice(0, MAX_RELATED).map(({ id, plan, status, proof }) => ({
    id,
    plan,
    status,
    ...(proof ? { proof } : {}),
  }));
}

function renderPack(pack: Omit<ContractContextPack, "text" | "decision"> & { decision: ContractDecision }): string {
  if (!pack.decision.fire) return "";
  if (!pack.recommend && pack.frontier.length === 0 && pack.related.length === 0) {
    // Still tell the model the turn is contracted (goal declared) even when cold.
    return [
      "",
      "CONTRACT CONTEXT:",
      `- Goal is registered on the contract ledger (reason: ${pack.decision.reason}).`,
      "- No prior ranked evidence yet — gather with tools, then verify before claiming done.",
      "- Prefer concrete tool results over re-deriving from long chat history.",
    ].join("\n");
  }

  const lines: string[] = ["", "CONTRACT CONTEXT (ranked substrate — prefer this over raw history dump):"];
  lines.push(`- Fire reason: ${pack.decision.reason}`);

  if (pack.recommend) {
    const ex = pack.recommend.example ? ` e.g. \`${pack.recommend.example.slice(0, 120)}\`` : "";
    lines.push(
      `- Learned route: \`${pack.recommend.binary}\` (score ${pack.recommend.score.toFixed(3)}).${ex} Soft prior — verify it still fits.`,
    );
  }

  if (pack.frontier.length > 0) {
    lines.push("- Open frontier (act on these next if still open):");
    for (const [i, f] of pack.frontier.entries()) {
      const id = f.id ? ` [${f.id}]` : "";
      lines.push(`  ${i + 1}. ${f.label}${id}`);
    }
  }

  if (pack.related.length > 0) {
    lines.push("- Related ledger evidence:");
    for (const r of pack.related) {
      const proof = r.proof ? ` → ${r.proof}` : "";
      lines.push(`  • (${r.status}) ${r.plan}${proof}`);
    }
  }

  lines.push(
    "- Use this graph to decide tools and next steps. Do not re-read multi-MB past dumps; re-run tools if you need fresh data.",
  );

  let text = lines.join("\n");
  if (text.length > MAX_CONTEXT_PACK_CHARS) {
    text = `${text.slice(0, MAX_CONTEXT_PACK_CHARS - 1)}…`;
  }
  return text;
}

/**
 * Build the ranked contract context pack for one user turn.
 * Safe to call always; returns empty text when the turn is non-contract or cold.
 */
export function packContractContext(
  userMessage: string,
  mode: "agent" | "plan" | "ask" | string = "agent",
): ContractContextPack {
  const decision = whenToContract(userMessage, mode);
  if (!decision.fire) {
    return { decision, recommend: null, frontier: [], related: [], text: "" };
  }

  const goal = userMessage.trim().slice(0, 500);
  let recommend: RecommendSlice | null = null;
  try {
    const rec = native.recommend(goal.slice(0, 200));
    if (rec?.binary) {
      recommend = { binary: rec.binary, example: rec.example ?? "", score: rec.score ?? 0 };
    }
  } catch {
    recommend = null;
  }

  let front: FrontierSlice[] = [];
  try {
    front = frontierSlices(goal);
  } catch {
    front = [];
  }

  let related: RelatedSlice[] = [];
  try {
    related = relatedSlices(goal, front.map((f) => f.id).filter(Boolean));
  } catch {
    related = [];
  }

  const partial = { decision, recommend, frontier: front, related };
  return { ...partial, text: renderPack(partial) };
}

/** True when this turn should declare + pack (mirrors shouldDeclareTurn). */
export function shouldPackContractContext(
  userMessage: string,
  mode: "agent" | "plan" | "ask" | string = "agent",
): boolean {
  return shouldDeclareTurn(userMessage, mode);
}
