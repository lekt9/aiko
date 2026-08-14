// Fixture agents.ts for the hermetic Telegram-bridge witness
// (tmp/witness-telegram-bridge.sh, TIER 1).
//
// `providers.aiko` is a DETERMINISTIC stand-in for the AikoAgent, not a mock
// of the code under test: the engine still runs the real `<Task agent=...>`
// path — real prompt assembly, real output-schema parse, real durable output
// row — it just does not spend a model turn to decide which reply kind to
// return. The kind is read out of the inbound event's own summary, so the
// witness can drive all five arms of the reply union in one bounded run and
// assert that each one selects exactly one Telegram verb.
//
// The live harness (a real `aiko --single` turn) is proven separately by
// e2e/aiko-harness-gate.sh; what this fixture proves is the BRIDGE.
import { type AgentLike } from "smthrs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const assets = join(fixtureRoot, "assets");

const MEDIA_FILES: Record<string, string> = {
  photo: join(assets, "reply.png"),
  video: join(assets, "reply.mp4"),
  audio: join(assets, "reply.mp3"),
  voice: join(assets, "reply.ogg"),
};

/** Pull the redacted event the bridge embeds in the worker prompt. */
function parseEvent(prompt: string): Record<string, unknown> {
  for (const line of prompt.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.includes('"source"')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        // fall through — an unparseable line is not the event line
      }
    }
  }
  return {};
}

class FixtureAikoAgent implements AgentLike {
  id = "fixture-aiko";

  async generate(args: { prompt?: string } = {}) {
    const prompt = String(args.prompt ?? "");
    const event = parseEvent(prompt);
    const summary = String(event.summary ?? "").toLowerCase();
    const chatId = String(event.chat_id ?? "");
    const kind = (["photo", "video", "audio", "voice"] as const).find((candidate) =>
      summary.includes(`send a ${candidate}`),
    );
    const payload = kind
      ? {
          chatId,
          replies: [{ kind, path: MEDIA_FILES[kind], caption: kind === "photo" ? "fixture caption" : null }],
        }
      : { chatId, replies: [{ kind: "text", text: `ack: ${event.summary ?? ""}`, parseMode: "none" }] };
    // Returned as TEXT, not as a structured `output` field: that is the path a
    // real CLI harness takes (aiko prints JSON; the engine extracts it), so the
    // witness exercises the same extraction + schema parse a live turn would.
    return { text: JSON.stringify(payload) };
  }
}

export const providers = {
  aiko: new FixtureAikoAgent(),
} as const;

export const agents: Record<string, AgentLike> = {
  smart: providers.aiko,
};
