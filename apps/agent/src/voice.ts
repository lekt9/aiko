import { Effect } from "effect";
import { boundedText, type HttpFetch } from "./security.ts";

export type ThinkFeelComposition =
  | { status: "ready"; text: string; persona: string }
  | { status: "blocked"; reason: "unavailable" | "invalid_response" };
export type ThinkFeelComposer = (text: string, signal: AbortSignal) => Promise<ThinkFeelComposition>;

/** The persona sees a redacted draft, not account history, tool payloads or credentials.
 * Numerical/source anchors are immutable. This is a wording guard, not semantic proof.
 */
export function createThinkFeelComposer(options: {
  key?: string;
  persona: string;
  redact: (text: string) => string;
  fetch?: HttpFetch;
  timeoutMs?: number;
}): ThinkFeelComposer {
  const transport = options.fetch ?? fetch;
  return async (draft, signal) => {
    if (!options.key || !draft.trim() || draft.length > 12_000)
      return { status: "blocked", reason: "unavailable" };
    const clean = options.redact(draft).split(options.key).join("[redacted]");
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const anchors: string[] = [];
    const masked = clean.replace(/```[\s\S]*?```|`[^`\n]+`|https?:\/\/[^\s<>]+|obs_[a-f0-9]{64}|(?:[$€£]\s*)?\b\d[\d.,:%/+\-]*(?:\s?(?:am|pm|SGD|USD|kg|km))?/g, value => {
      anchors.push(value);
      return `⟦${nonce}_${anchors.length - 1}⟧`;
    });
    try {
      signal.throwIfAborted();
      const response = await transport("https://playground.curvelabs.org/api/v1/personify", {
        method: "POST", redirect: "manual",
        headers: { "content-type": "application/json", "x-api-key": options.key },
        signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 15_000)]),
        // The SDK's personify operation rewrites supplied text. generate starts a
        // persona conversation and can answer the draft instead of preserving it.
        body: JSON.stringify({ personaId: options.persona, raw: masked }),
      });
      if (!response.ok) { await response.body?.cancel(); return { status: "blocked", reason: "unavailable" }; }
      const data = JSON.parse(await boundedText(response, 64_000));
      let text = data?.personified;
      if ((data.status !== undefined && data.status !== "success") || typeof text !== "string" || !text.trim() || text.length > 16_000)
        return { status: "blocked", reason: "invalid_response" };
      text = text.trim();
      for (let index = 0; index < anchors.length; index++) {
        const token = `⟦${nonce}_${index}⟧`;
        if (text.split(token).length !== 2) return { status: "blocked", reason: "invalid_response" };
      }
      const unanchored = text.replace(new RegExp(`⟦${nonce}_\\d+⟧`, "g"), "");
      if (/\d|https?:\/\/|⟦|⟧/.test(unanchored) || /<think>|```/i.test(text))
        return { status: "blocked", reason: "invalid_response" };
      // Do not let the persona introduce commitments or pretend an action happened.
      const claims = /\b(?:I(?:['’]ve| have| just| successfully| already)?\s+(?:sent|posted|deleted|booked|purchased|paid|transferred|cancelled|scheduled|logged in|connected)|I(?:['’]ll| will)\s+(?:flag|contact|escalate|refund|book|pay|send)|I(?:['’]m| am)\s+(?:human|a real person))\b/gi;
      for (const claim of text.match(claims) ?? [])
        if (!clean.toLowerCase().includes(claim.toLowerCase())) return { status: "blocked", reason: "invalid_response" };
      for (let index = 0; index < anchors.length; index++) text = text.replace(`⟦${nonce}_${index}⟧`, anchors[index]);
      if (/[⟦⟧]/.test(text)) return { status: "blocked", reason: "invalid_response" };
      if (options.redact(text) !== text || text.includes(options.key)) return { status: "blocked", reason: "invalid_response" };
      return { status: "ready", text, persona: options.persona };
    } catch {
      return { status: "blocked", reason: "unavailable" };
    }
  };
}

export type VoiceResult = {
  text: string;
  source: "thinkfeel" | "template" | "model" | "service";
  reason?: "disabled" | "limited" | "unavailable" | "invalid_response" | "rejected" | "recovered";
};
export type VoiceInput =
  | { kind: "task"; receipt: string }
  | { kind: "greeting"; message: string }
  | { kind: "answer"; text: string };
const intros = new Set([
  "Here's what I found.",
  "Here’s what I found.",
  "Here’s the update.",
  "Here's the update.",
  "Take a look.",
  "Here you go.",
  "Let’s take a look.",
  "Let's take a look.",
]);
const greetings = new Set([
  "Hi! I’m Aiko. How can I help?",
  "Hi! I'm Aiko. How can I help?",
  "Hey! I’m Aiko. What can I help with?",
  "Hey! I'm Aiko. What can I help with?",
  "Hi! How can I help?",
  "You're welcome!",
  "You’re welcome!",
]);
export const isGreeting = (text: string) =>
  /^(?:hi|hello|hey|thanks|thank you|how are you|good morning|good evening)[.!?\s]*$/i.test(
    text.trim(),
  );
export const fallbackVoice = (
  input: VoiceInput,
  reason: VoiceResult["reason"],
): VoiceResult => ({
  text:
    input.kind === "answer"
      ? input.text
      : input.kind === "task"
        ? input.receipt
        : "Hi! I’m Aiko. How can I help?",
  source: input.kind === "answer" ? "model" : "template",
  reason,
});

/** Allowlisted non-factual prose only. Receipts never enter or get rewritten by the persona service. */
export function validateVoice(
  input: VoiceInput,
  candidate: unknown,
): VoiceResult {
  if (input.kind === "answer" || typeof candidate !== "string")
    return fallbackVoice(input, "rejected");
  const text = candidate.trim();
  if (input.kind === "greeting" ? !greetings.has(text) : !intros.has(text))
    return fallbackVoice(input, "rejected");
  return {
    text: input.kind === "task" ? `${text}\n\n${input.receipt}` : text,
    source: "thinkfeel",
  };
}

export function createVoice(options: {
  key?: string;
  persona: string;
  enabled: boolean;
  fetch?: HttpFetch;
  timeoutMs?: number;
  now?: () => number;
  requestsPerMinute?: number;
  compose?: ThinkFeelComposer;
  /** Live user surfaces must never receive an unprocessed fallback. */
  required?: boolean;
}) {
  const transport = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const calls: number[] = [];
  let circuitUntil = 0;
  // This instance is shared across all threads in one host, not one limiter per user.
  return (input: VoiceInput, signal: AbortSignal): Effect.Effect<VoiceResult> =>
    Effect.tryPromise({
      try: async () => {
        if (options.compose) {
          const draft = input.kind === "answer" ? input.text : input.kind === "task" ? input.receipt : input.message;
          const composed = await options.compose(draft, signal);
          return composed.status === "ready"
            ? { text: composed.text, source: "thinkfeel" as const }
            : options.required
              ? { text: "", source: "model" as const, reason: composed.reason }
              : fallbackVoice(input, composed.reason);
        }
        if (options.required) return { text: "", source: "model" as const, reason: "unavailable" as const };
        // Real answers are already generated. Do not send transcripts or rewrite their facts through a persona API.
        if (input.kind === "answer") return fallbackVoice(input, "disabled");
        if (!options.enabled || !options.key)
          return fallbackVoice(input, "disabled");
        const at = now();
        while (calls.length && calls[0] <= at - 60_000) calls.shift();
        if (
          circuitUntil > at ||
          calls.length >= (options.requestsPerMinute ?? 10)
        )
          return fallbackVoice(input, "limited");
        signal.throwIfAborted();
        calls.push(at);
        const body =
          input.kind === "greeting"
            ? {
                personaId: options.persona,
                messages: [
                  {
                    role: "system",
                    content:
                      "You are Aiko, an AI assistant. Reply exactly: Hi! I'm Aiko. How can I help?",
                  },
                  { role: "user", content: "Hello" },
                ],
                includeVariations: false,
              }
            : { personaId: options.persona, raw: "Here's what I found." };
        const response = await transport(
          `https://playground.curvelabs.org/api/v1/${input.kind === "greeting" ? "generate" : "personify"}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": options.key,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.any([
              signal,
              AbortSignal.timeout(options.timeoutMs ?? 5_000),
            ]),
            redirect: "manual",
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          circuitUntil = now() + 30_000;
          return fallbackVoice(input, "unavailable");
        }
        const data = JSON.parse(await boundedText(response)) as Record<
          string,
          unknown
        >;
        if (data.status !== undefined && data.status !== "success")
          return fallbackVoice(input, "rejected");
        const candidate =
          input.kind === "greeting"
            ? (data.result as { finalReply?: unknown } | undefined)?.finalReply
            : data.personified;
        return validateVoice(input, candidate);
      },
      catch: () => "unavailable" as const,
    }).pipe(
      Effect.catch(() => {
        circuitUntil = now() + 30_000;
        return Effect.succeed(options.required
          ? { text: "", source: "model" as const, reason: "unavailable" as const }
          : fallbackVoice(input, "unavailable"));
      }),
    );
}
export type Voice = ReturnType<typeof createVoice>;
