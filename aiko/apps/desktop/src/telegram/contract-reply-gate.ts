// contract-reply-gate.ts — contract-native Telegram reply transformation.
// Now built on the generalised hook pipeline (contract/hooks.ts) and the
// official @curvelabs.org/thinkfeel SDK.
//
// Registers a ThinkFeel persona hook for the "telegram:output" scope.
// The general pipeline handles declare → gate → mark_satisfied for every
// step. This file provides the transform logic via the SDK's personify()
// endpoint — raw text in, persona-voiced text out.

import { ThinkFeel } from "@curvelabs.org/thinkfeel";
import type { Hook, HookContext } from "../contract/hooks";
import * as hooks from "../contract/hooks";
import { isVoiceWorthy, VoiceCircuit } from "../contract/voice-circuit";

const THINKFEEL_KEY = "beta_2UkoVRR6BHehCHfxfhcncjH2rK8qYAXZnLahfGEBBRKbtp";

/** Persona configuration — swap the id to change voice */
export interface PersonaConfig {
  personaId: string;
  label: string;
}

export const UNREEL_PERSONA: PersonaConfig = {
  personaId: "3c36e929-50ac-4971-919f-70e6fc6273b7",
  label: "unreel",
};

export const OUTREACH_PERSONA: PersonaConfig = {
  personaId: "e8417b53-23cc-4e5c-821f-65e2a7b501a5",
  label: "outreach",
};

let activePersona: PersonaConfig = UNREEL_PERSONA;
let client: ThinkFeel | null = null;

/** Swap the active persona at runtime. Rebuilds the SDK client. */
export function setPersona(persona: PersonaConfig): void {
  activePersona = persona;
  client = new ThinkFeel({
    apiKey: THINKFEEL_KEY,
    personaId: persona.personaId,
  });
}

/** Get current persona config. */
export function getPersona(): PersonaConfig {
  return activePersona;
}

/** Lazy-init the SDK client. */
function getClient(): ThinkFeel {
  if (!client) {
    client = new ThinkFeel({
      apiKey: THINKFEEL_KEY,
      personaId: activePersona.personaId,
    });
  }
  return client;
}

// ── ThinkFeel hook (registered below) ──────────────────────────────────────

/**
 * ThinkFeel persona hook for "*:output" — EVERY output channel.
 * Priority 10 — runs early so later hooks see the transformed text.
 * Uses the SDK's personify() endpoint: raw text in, persona-voiced text out.
 */
const thinkfeelHook: Hook = {
  name: "thinkfeel-persona",
  scope: "*:output",
  priority: 10,

  async run(ctx: HookContext) {
    const rawText = ctx.text;
    if (!rawText || rawText.trim().length === 0) {
      return { allowed: true, ctx };
    }

    try {
      const tf = getClient();
      const result = await tf.personify({ raw: rawText });

      if (result.personified && result.personified.trim().length > 0) {
        return {
          allowed: true,
          ctx: { ...ctx, text: result.personified },
        };
      }

      console.error("[thinkfeel-hook] personify returned empty — falling through");
      return { allowed: true, ctx };
    } catch (err) {
      console.error("[thinkfeel-hook] personify failed:", err);
      return { allowed: true, ctx };
    }
  },
};

// ── voice hook (registered alongside thinkfeel) ────────────────────────────

let voiceCircuit: VoiceCircuit | null = null;

function getVoiceCircuit(): VoiceCircuit {
  if (!voiceCircuit) {
    voiceCircuit = new VoiceCircuit({
      engine: "auto",
      sayVoice: "Samantha",
      kokoroVoice: "af_heart",
      rate: 1.0,
      log: (msg) => console.log(msg),
    });
  }
  return voiceCircuit;
}

/**
 * Voice hook for "*:output". Priority 5 — runs after thinkfeel (10)
 * so the persona-transformed text gets spoken, not the raw agent output.
 *
 * Voice is additive — it attaches a .m4a path to ctx.meta but doesn't
 * change the text. The Telegram bridge checks meta.voiceFile and sends
 * it as a voice note alongside the text message.
 */
const voiceHook: Hook = {
  name: "voice-circuit",
  scope: "*:output",
  priority: 5,

  async run(ctx: HookContext) {
    if (!isVoiceWorthy(ctx.text)) {
      return { allowed: true, ctx };
    }

    try {
      const vc = getVoiceCircuit();
      const m4aPath = await vc.speak(ctx.text);

      if (m4aPath) {
        return {
          allowed: true,
          ctx: {
            ...ctx,
            meta: { ...ctx.meta, voiceFile: m4aPath },
          },
        };
      }
    } catch (err) {
      console.error("[voice-hook] failed:", err);
    }

    return { allowed: true, ctx };
  },
};

// ── registration ───────────────────────────────────────────────────────────

let deregister: (() => void) | null = null;
let voiceDeregister: (() => void) | null = null;

/** Activate the ThinkFeel + Voice hooks. Idempotent. */
export function activatePersonaHook(): void {
  if (deregister) return; // already active
  deregister = hooks.register(thinkfeelHook);
  voiceDeregister = hooks.register(voiceHook);
}

/** Deactivate the ThinkFeel + Voice hooks. */
export function deactivatePersonaHook(): void {
  if (deregister) {
    deregister();
    deregister = null;
  }
  if (voiceDeregister) {
    voiceDeregister();
    voiceDeregister = null;
  }
}

// ── convenience: the old gateReply API, now backed by the pipeline ─────────

export interface TransformResult {
  text: string;
  transformed: boolean;
  voiceFile?: string;
  neuronId?: string;
}

/**
 * Run a single reply through the "telegram:output" pipeline.
 * Backward-compatible with the old gateReply signature.
 */
export async function gateReply(userId: number, rawText: string): Promise<TransformResult> {
  const result = await hooks.runPipeline("telegram:output", {
    text: rawText,
    source: `telegram:user:${userId}`,
    meta: { userId },
  });

  return {
    text: result.text,
    transformed: result.text !== rawText,
    voiceFile: result.meta.voiceFile as string | undefined,
    neuronId: result.trace.length > 0 ? (result.trace[result.trace.length - 1]?.neuronId ?? undefined) : undefined,
  };
}
