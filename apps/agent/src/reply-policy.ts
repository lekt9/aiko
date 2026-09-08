import type { ReadReceipt } from "./capabilities.ts";
import type { MemoryReceipt } from "./memory.ts";

/** Model prose is an answer, never an execution receipt. Keep unsupported action claims out of delivery. */
export function liveAnswer(
  output: unknown,
  owner: string,
  receipts: readonly (ReadReceipt | MemoryReceipt)[],
  redact: (text: string) => string,
): string | undefined {
  if (typeof output !== "string" || !output.trim()) return undefined;
  let text = redact(output.replace(/<think>[\s\S]*?<\/think>/gi, "").trim());
  // Defense in depth, not a semantic proof: app mutations are also absent from the mounted tool surface.
  if (
    /\bI(?:['’]ve| have| just| successfully| already)?\s+(?:sent|posted|deleted|booked|purchased|paid|transferred|cancelled your|scheduled your|logged (?:you )?in|connected your)\b/i.test(
      text,
    )
  )
    return undefined;
  const citations = new Set<string>();
  const add = (observation: unknown) => {
    const value = observation as { id?: unknown; scope?: unknown } | null;
    if (
      value?.scope === `aiko:${owner}` &&
      typeof value.id === "string" &&
      /^obs_[a-f0-9]{64}$/.test(value.id)
    )
      citations.add(value.id);
  };
  for (const receipt of receipts) {
    if (receipt.kind === "read-receipt") {
      for (const observation of receipt.observations ?? [])
        citations.add(observation.id);
    } else {
      const result = receipt.result as {
        id?: unknown;
        observation?: unknown;
        items?: { observation?: unknown }[];
      } | null;
      add(result);
      add(result?.observation);
      if (Array.isArray(result?.items))
        for (const hit of result.items) add(hit.observation);
    }
  }
  text = text.replace(/obs_[a-f0-9]{64}/g, (id) =>
    citations.has(id) ? id : "[unverified citation]",
  );
  const suffix = [...citations].filter((id) => !text.includes(id)).slice(0, 3);
  return text;
}
