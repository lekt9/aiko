import { describe, expect, it } from "vitest";
import {
  classifyVoiceError,
  initialVoiceState,
  insertTranscriptIntoDraft,
  isVoiceToggleKey,
  reduceVoice,
  resolveVoiceErrorClass,
  voiceAvailabilityFromAuth,
  voiceIsActive,
  voiceResultStillCurrent,
  voiceStealsEscape,
  VOICE_MAX_RECORD_MS,
  VOICE_NO_SPEECH_MS,
} from "./voiceDictation";

describe("voiceDictation FSM", () => {
  it("starts idle", () => {
    expect(initialVoiceState().phase).toBe("idle");
  });

  it("start → requesting → recording → stop → transcribing → ok → idle", () => {
    let s = initialVoiceState();
    s = reduceVoice(s, { type: "start" }, 1000);
    expect(s.phase).toBe("requesting_mic");
    s = reduceVoice(s, { type: "mic_granted" }, 1001);
    expect(s.phase).toBe("recording");
    expect(s.recordingStartedAt).toBe(1001);
    expect(voiceIsActive(s.phase)).toBe(true);
    expect(voiceStealsEscape(s.phase)).toBe(true);
    s = reduceVoice(s, { type: "stop" }, 2000);
    expect(s.phase).toBe("transcribing");
    s = reduceVoice(s, { type: "transcribe_ok" }, 2001);
    expect(s.phase).toBe("idle");
    expect(s.error).toBeNull();
  });

  it("mic denied lands in error", () => {
    let s = reduceVoice(initialVoiceState(), { type: "start" });
    s = reduceVoice(s, { type: "mic_denied" });
    expect(s.phase).toBe("error");
    expect(s.error).toBe("mic_denied");
  });

  it("cancel resets from recording", () => {
    let s = reduceVoice(initialVoiceState(), { type: "start" });
    s = reduceVoice(s, { type: "mic_granted" }, 10);
    s = reduceVoice(s, { type: "cancel" });
    expect(s).toEqual(initialVoiceState());
  });

  it("no_speech_timeout only while recording", () => {
    let s = reduceVoice(initialVoiceState(), { type: "start" });
    s = reduceVoice(s, { type: "no_speech_timeout" });
    expect(s.phase).toBe("requesting_mic");
    s = reduceVoice(s, { type: "mic_granted" }, 1);
    s = reduceVoice(s, { type: "no_speech_timeout" });
    expect(s.phase).toBe("error");
    expect(s.error).toBe("no_speech");
  });

  it("clear_error returns to idle", () => {
    let s = reduceVoice(initialVoiceState(), { type: "start" });
    s = reduceVoice(s, { type: "mic_denied" });
    s = reduceVoice(s, { type: "clear_error" });
    expect(s.phase).toBe("idle");
  });
});

describe("insertTranscriptIntoDraft", () => {
  it("appends to empty draft", () => {
    expect(insertTranscriptIntoDraft("", "hello")).toEqual({
      text: "hello",
      caret: 5,
    });
  });

  it("joins with space when left lacks trailing whitespace", () => {
    expect(insertTranscriptIntoDraft("hi", "there", 2)).toEqual({
      text: "hi there",
      caret: 8,
    });
  });

  it("does not double spaces", () => {
    expect(insertTranscriptIntoDraft("hi ", "there", 3).text).toBe("hi there");
  });

  it("inserts at caret in the middle", () => {
    const r = insertTranscriptIntoDraft("aa bb", "XX", 2);
    expect(r.text).toBe("aa XX bb");
  });

  it("ignores empty/whitespace transcript", () => {
    expect(insertTranscriptIntoDraft("keep", "  ").text).toBe("keep");
  });
});

describe("voiceAvailabilityFromAuth", () => {
  it("enables when signed in official", () => {
    expect(
      voiceAvailabilityFromAuth({
        signedInOfficial: true,
        hasOfficialApiKey: false,
        hasRelayOnly: false,
      }).available,
    ).toBe(true);
  });

  it("enables with official API key", () => {
    expect(
      voiceAvailabilityFromAuth({
        signedInOfficial: false,
        hasOfficialApiKey: true,
        hasRelayOnly: true,
      }).available,
    ).toBe(true);
  });

  it("disables relay-only", () => {
    const s = voiceAvailabilityFromAuth({
      signedInOfficial: false,
      hasOfficialApiKey: false,
      hasRelayOnly: true,
    });
    expect(s.available).toBe(false);
    expect(s.reason).toBe("not_available");
  });

  it("disables when active provider is custom even with official login", () => {
    const s = voiceAvailabilityFromAuth({
      signedInOfficial: true,
      hasOfficialApiKey: true,
      hasRelayOnly: false,
      activeProviderIsCustom: true,
    });
    expect(s.available).toBe(false);
    expect(s.reason).toBe("not_available");
  });
});

describe("classifyVoiceError", () => {
  it("maps http 401 to auth", () => {
    expect(classifyVoiceError("nope", 401)).toBe("auth");
  });

  it("trusts known Host errorClass token auth", () => {
    expect(classifyVoiceError("auth")).toBe("auth");
    expect(resolveVoiceErrorClass("auth", "whatever")).toBe("auth");
    expect(resolveVoiceErrorClass("no_speech", null)).toBe("no_speech");
  });

  it("maps empty transcript language", () => {
    expect(classifyVoiceError("empty transcript")).toBe("no_speech");
  });

  it("maps network strings", () => {
    expect(classifyVoiceError("connection refused")).toBe("network");
  });
});

describe("VOICE_NO_SPEECH_MS / max record policy", () => {
  it("documents CLI-aligned silence window without hard-killing audio", () => {
    expect(VOICE_NO_SPEECH_MS).toBe(10_000);
    // Max record must be longer than the silence constant so auto-stop+STT
    // can cover multi-sentence dictation; no_speech comes from empty STT.
    expect(VOICE_MAX_RECORD_MS).toBeGreaterThan(VOICE_NO_SPEECH_MS);
  });
});

describe("voiceResultStillCurrent", () => {
  it("rejects stale generation after cancel", () => {
    expect(voiceResultStillCurrent(1, 1)).toBe(true);
    expect(voiceResultStillCurrent(1, 2)).toBe(false);
  });
});

describe("isVoiceToggleKey", () => {
  it("matches Ctrl+Space only", () => {
    expect(
      isVoiceToggleKey({
        key: " ",
        code: "Space",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe(true);
    expect(
      isVoiceToggleKey({
        key: " ",
        code: "Space",
        ctrlKey: false,
        metaKey: true,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe(false);
  });
});
