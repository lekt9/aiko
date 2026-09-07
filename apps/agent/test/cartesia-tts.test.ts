import { test, expect } from "bun:test";
import { createCartesiaTts } from "../src/cartesia-tts.ts";

const riff = (sampleFrames = 8) => {
  const data = new Uint8Array(44 + sampleFrames * 2);
  const view = new DataView(data.buffer);
  data.set(new TextEncoder().encode("RIFF"), 0);
  data.set(new TextEncoder().encode("WAVE"), 8);
  view.setUint32(4, 36 + sampleFrames * 2, true);
  view.setUint32(40, sampleFrames * 2, true);
  return data;
};

const wavResponse = () =>
  new Response(riff().buffer as ArrayBuffer, {
    headers: { "content-type": "audio/wav" },
  });

test("transcript is spoken verbatim with SSML tags intact and ends with terminal punctuation", async () => {
  let body: any;
  const tts = createCartesiaTts({
    key: "fixture-key",
    voiceId: "voice-1",
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return wavResponse();
    },
  });
  const bytes = await tts(
    'Your confirmation code is <spell>ABC123</spell><break time="300ms"/> Thanks!',
    new AbortController().signal,
  );
  expect(Buffer.from(bytes.subarray(0, 4)).toString("ascii")).toBe("RIFF");
  expect(body.model_id).toBe("sonic-3.6");
  expect(body.voice).toEqual({ mode: "id", id: "voice-1" });
  expect(body.output_format).toMatchObject({ container: "wav", encoding: "pcm_s16le", sample_rate: 44100 });
  expect(body.transcript).toBe('Your confirmation code is <spell>ABC123</spell><break time="300ms"/> Thanks!');
});

test("markdown artifacts and un-ended drafts are normalized into spoken form", async () => {
  let body: any;
  const tts = createCartesiaTts({
    key: "fixture-key",
    voiceId: "voice-1",
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return wavResponse();
    },
  });
  await tts("Here's what I found.\n\n- **First item** `code`\n- [linked](https://example.com)", new AbortController().signal);
  expect(body.transcript).not.toMatch(/```|\*\*|`|\]\(/);
});

test("provider failures and non-wave bodies fail closed", async () => {
  const failing = createCartesiaTts({
    key: "fixture-key",
    voiceId: "voice-1",
    fetch: async () => new Response("rate limited", { status: 429 }),
  });
  await expect(failing("Hello.", new AbortController().signal)).rejects.toThrow("unavailable");
  const junk = createCartesiaTts({
    key: "fixture-key",
    voiceId: "voice-1",
    fetch: async () => new Response(JSON.stringify({ error: "not audio" }), { status: 200 }),
  });
  await expect(junk("Hello.", new AbortController().signal)).rejects.toThrow("Invalid speech result");
});
