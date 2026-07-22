// when.ts — when should aiko-cli fire the /contract substrate?
//
// Default is YES for agentic work. Skip only disposable Q&A / greetings.
// Used by Agent turns (auto-declare goals) and the system prompt (so the model
// knows when to run `aiko "<goal>"` via bash).

/** Why we fire (or skip) the substrate for this user text. */
export type ContractDecision =
  | { fire: true; reason: "agentic" | "ship" | "slash" | "onchain" }
  | { fire: false; reason: "trivia" | "greeting" | "empty" | "non-agent-mode" };

const ACTION =
  /\b(fix|build|ship|deploy|implement|refactor|add|create|write|delete|remove|update|migrate|debug|investigate|review|test|commit|push|pr|merge|release|install|configure|wire|integrate|scaffold|trim|engage)\b/i;

const SHIP = /\b(ship(ped)?|done|finished|complete(d)?|preflight|algorithm:|ready to ship|call it done)\b/i;

const ONCHAIN =
  /\b(on[- ]?chain|iq_ledger|declare_onchain|witness_onchain|settle_onchain|solana pda|mainnet|devnet)\b/i;

const GREETING = /^(hi|hello|hey|yo|sup|thanks|thank you|ok|okay|cool|nice|👍|🙏)[\s!.]*$/i;

const TRIVIA_QUESTION = /^(what|who|when|where|why|how|which|is|are|can|does|do|should|could|would)\b.+\?\s*$/i;

/**
 * Decide whether this user message should hit the /contract substrate.
 * Mode-aware: only agent mode auto-fires; ask/plan still get prompt guidance.
 */
export function whenToContract(
  userMessage: string,
  mode: "agent" | "plan" | "ask" | string = "agent",
): ContractDecision {
  const t = userMessage.trim();
  if (!t) return { fire: false, reason: "empty" };

  if (/^\/?(contract|aiko)\b/i.test(t)) return { fire: true, reason: "slash" };
  if (ONCHAIN.test(t)) return { fire: true, reason: "onchain" };
  if (SHIP.test(t)) return { fire: true, reason: "ship" };

  if (mode !== "agent") return { fire: false, reason: "non-agent-mode" };

  if (GREETING.test(t)) return { fire: false, reason: "greeting" };

  // Short pure questions without action verbs → trivia (no durable outcome).
  if (t.length < 120 && TRIVIA_QUESTION.test(t) && !ACTION.test(t)) {
    return { fire: false, reason: "trivia" };
  }

  // Default YES for agent mode: multi-step work, imperatives, anything else agentic.
  return { fire: true, reason: "agentic" };
}

/** True when the turn should declare a goal neuron (best-effort, substrate may be off). */
export function shouldDeclareTurn(userMessage: string, mode: "agent" | "plan" | "ask" | string = "agent"): boolean {
  return whenToContract(userMessage, mode).fire;
}

/**
 * Working discipline folded into the agent's system prompt. It describes HOW to work,
 * not any internal machinery — the substrate mechanics (recording the goal, nesting
 * tool calls, settling) run autonomously in code and are never surfaced as commands.
 * No verb vocabulary here on purpose: the model should just do the right thing.
 */
export const CONTRACT_PROMPT_SECTION = `HOW TO WORK:
- Own the user's goal. Break it down and execute with your tools — don't wait to be told
  each step, and don't just describe what you'd do.
- Before you call anything done, review your own work: question each requirement (is it
  actually needed?), remove what isn't, simplify what's left, then VERIFY it truly works —
  never claim something is finished on untested code.
- For a one-off answer or pure trivia, just answer — skip the process.`;
