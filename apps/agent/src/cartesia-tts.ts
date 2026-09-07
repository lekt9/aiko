import type { HttpFetch } from "./security.ts";

/** Cartesia Sonic TTS. The transcript is passed through verbatim, so the model
 * may use Sonic's SSML-like tags (<break time="500ms"/>, <speed ratio="1.1"/>,
 * <spell>ABC123</spell>); write replies as spoken prose with terminal
 * punctuation and no markdown. Audio returns as WAV for the private sandbox to
 * convert to OGG/opus — the API key never enters the sandbox. */
export function createCartesiaTts(options: {
  key: string;
  voiceId: string;
  model?: string;
  fetch?: HttpFetch;
  timeoutMs?: number;
}) {
  const transport = options.fetch ?? fetch;
  return async (text: string, signal: AbortSignal): Promise<Uint8Array> => {
    if (!text.trim() || text.length > 12_000)
      throw new Error("Invalid speech length");
    signal.throwIfAborted();
    // Spoken form: markdown and symbol artifacts would be read aloud, but
    // Sonic's SSML tags must survive untouched.
    const ssml: string[] = [];
    const transcript =
      text
        .replace(/<[a-z/][^<>]*>/gi, tag => {
          if (/^<\/?(?:break|speed|volume|emotion|spell)\b/i.test(tag)) {
            ssml.push(tag);
            return `⟦ssml${ssml.length - 1}⟧`;
          }
          return " ";
        })
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/[*_#>]+/g, " ")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/[ \t]+/g, " ")
        .trim()
        .replace(/^(?:Here's what I found\.|Here’s what I found\.)\s*/i, "")
        .replace(/\s+$/, "");
      const spoken = /[.!?]$/.test(transcript) ? transcript : `${transcript}.`;
      for (let index = 0; index < ssml.length; index++) {
        const token = `⟦ssml${index}⟧`;
        if (spoken.split(token).length !== 2) throw new Error("Invalid speech length");
      }
      const restored = ssml.reduce((out, tag, index) => out.replace(`⟦ssml${index}⟧`, tag), spoken);
    const response = await transport("https://api.cartesia.ai/tts/bytes", {
      method: "POST",
      redirect: "manual",
      headers: {
        "X-API-Key": options.key,
        "Cartesia-Version": "2026-08-14",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model_id: options.model ?? "sonic-3.6",
        transcript: restored,
        voice: { mode: "id", id: options.voiceId },
        output_format: {
          container: "wav",
          encoding: "pcm_s16le",
          sample_rate: 44100,
        },
        generation_config: { speed: 1, volume: 1 },
      }),
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(options.timeoutMs ?? 30_000),
      ]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Speech synthesis is unavailable");
    }
    const wav = new Uint8Array(await response.arrayBuffer());
    if (
      wav.length < 44 ||
      Buffer.from(wav.subarray(0, 4)).toString("ascii") !== "RIFF" ||
      Buffer.from(wav.subarray(8, 12)).toString("ascii") !== "WAVE"
    )
      throw new Error("Invalid speech result");
    return wav;
  };
}
export type CartesiaTts = ReturnType<typeof createCartesiaTts>;
