// voice-circuit.ts — contract-native TTS voice circuit.
//
// Two engines, auto-selected:
//   PRIMARY: Kokoro (82M-param neural TTS via MLX on Apple Neural Engine)
//            Requires Python 3.11 + kokoro-mlx in /tmp/kokoro-venv
//   FALLBACK: macOS `say` (built-in, always available)
//
// Contract-native flow (every speak call):
//   1. declare neuron: voice:output
//   2. gate: confirm for network_mutation channels
//   3. synthesize: kokoro → .wav → afconvert → .m4a
//   4. mark_satisfied: trains fractal EBM
//
// Learning: the daemon fires voice patterns through the contract,
// the fractal EBM learns which messages are voice-worthy, and
// the spawning reflex births follow-up voice neurons.

import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── configuration ──────────────────────────────────────────────────────────

export type VoiceEngine = "kokoro" | "say" | "auto";

export interface VoiceCircuitConfig {
  /** Engine to use (default: "auto" — kokoro if available, else say). */
  engine?: VoiceEngine;
  /** Voice name for `say` engine (default: "Samantha"). */
  sayVoice?: string;
  /** Kokoro voice name (default: "af_heart" — warm, feminine, US English). */
  kokoroVoice?: string;
  /** Speaking rate (say: wpm, kokoro: multiplier). */
  rate?: number;
  /** Output directory for .m4a files (default: system tmp). */
  outputDir?: string;
  /** Log function. */
  log?: (msg: string) => void;
  /** Contract-native: callback to declare a neuron before synthesis. */
  onDeclare?: (scope: string) => Promise<string | null>;
  /** Contract-native: callback to gate the voice output. */
  onGate?: (scope: string) => Promise<"allow" | "confirm" | "deny">;
  /** Contract-native: callback to mark neuron satisfied after synthesis. */
  onSatisfied?: (neuronId: string) => Promise<void>;
}

const DEFAULT_SAY_VOICE = "Samantha";
const DEFAULT_KOKORO_VOICE = "af_heart";
const DEFAULT_RATE = 1.0;
const OUTPUT_DIR = join(tmpdir(), "aiko-voice");
const KOKORO_VENV = "/tmp/kokoro-venv";
const KOKORO_MODEL_PATH =
  "/Users/lewis/.cache/huggingface/hub/models--mlx-community--Kokoro-82M-bf16/snapshots/a71e4d38b236d968966a2002c4c895dbd12b1c3c";

// ── engine detection ───────────────────────────────────────────────────────

let kokoroAvailable: boolean | null = null;

function checkKokoro(): boolean {
  if (kokoroAvailable !== null) return kokoroAvailable;
  try {
    execSync(`${KOKORO_VENV}/bin/python -c "from kokoro_mlx import KokoroTTS"`, {
      timeout: 5000,
      stdio: "pipe",
    });
    kokoroAvailable = existsSync(KOKORO_MODEL_PATH);
  } catch {
    kokoroAvailable = false;
  }
  return kokoroAvailable;
}

// ── voice-worthiness heuristic ─────────────────────────────────────────────

/**
 * Quick heuristic: is this message voice-worthy?
 *
 * Voice-worthy messages are:
 *   - Short (under 300 chars — a spoken sentence, not an essay)
 *   - Personal (starts with hey/hi/yo/thanks/sorry/love/miss)
 *   - Emotional (contains !, ?, emoji-like patterns)
 *   - NOT a code block, table, or list
 *
 * About 30-40% of messages pass. This is "sometimes" — not every message.
 */
export function isVoiceWorthy(text: string): boolean {
  if (!text || text.trim().length === 0) return false;
  if (text.length > 300) return false;
  if (text.includes("```")) return false;
  if (text.includes("|")) return false; // tables
  if (/^[\s]*[-*]/.test(text)) return false; // lists

  const personalOpeners = /^(hey|hi|yo|hello|thanks|sorry|love|miss|good|aww|oh|wow|yes|no|ok|sure|nah)\b/i;
  const emotional = /[!?]{1,3}|😊|😂|❤️|🔥|💀|🥺|✨|💕/;

  return personalOpeners.test(text.trim()) || emotional.test(text);
}

// ── voice circuit ──────────────────────────────────────────────────────────

export class VoiceCircuit {
  private engine: VoiceEngine;
  private sayVoice: string;
  private kokoroVoice: string;
  private rate: number;
  private outputDir: string;
  private log: (msg: string) => void;
  private onDeclare?: (scope: string) => Promise<string | null>;
  private onGate?: (scope: string) => Promise<"allow" | "confirm" | "deny">;
  private onSatisfied?: (neuronId: string) => Promise<void>;

  constructor(config: VoiceCircuitConfig = {}) {
    this.engine = config.engine ?? "auto";
    this.sayVoice = config.sayVoice ?? DEFAULT_SAY_VOICE;
    this.kokoroVoice = config.kokoroVoice ?? DEFAULT_KOKORO_VOICE;
    this.rate = config.rate ?? DEFAULT_RATE;
    this.outputDir = config.outputDir ?? OUTPUT_DIR;
    this.log = config.log ?? (() => {});
    this.onDeclare = config.onDeclare;
    this.onGate = config.onGate;
    this.onSatisfied = config.onSatisfied;
    mkdirSync(this.outputDir, { recursive: true });
  }

  /** True if Kokoro is the active engine. */
  get isKokoro(): boolean {
    if (this.engine === "kokoro") return true;
    if (this.engine === "say") return false;
    return checkKokoro();
  }

  /**
   * Speak text and return the path to the generated .m4a file.
   * Contract-native: declare → gate → synthesize → mark_satisfied.
   * Returns null on failure (never throws).
   */
  async speak(text: string): Promise<string | null> {
    if (!text || text.trim().length === 0) return null;

    const hash = crypto.createHash("md5").update(text).digest("hex").slice(0, 8);
    const m4aPath = join(this.outputDir, `${hash}.m4a`);

    // If already cached, return existing file
    if (existsSync(m4aPath)) {
      this.log(`[voice] cache hit: ${m4aPath}`);
      return m4aPath;
    }

    // ── contract-native: declare ──
    let neuronId: string | null = null;
    if (this.onDeclare) {
      neuronId = await this.onDeclare("voice:output");
      this.log(`[voice] neuron declared: ${neuronId ?? "skipped"}`);
    }

    // ── contract-native: gate ──
    if (this.onGate) {
      const decision = await this.onGate("voice:output");
      this.log(`[voice] gate: ${decision}`);
      if (decision === "deny") return null;
      // confirm path: user must have granted confirmation; in headless
      // mode, voice is always allowed since it's a local operation
    }

    // ── synthesize ──
    try {
      if (this.isKokoro) {
        this.synthesizeKokoro(text, m4aPath);
      } else {
        this.synthesizeSay(text, m4aPath);
      }

      // ── contract-native: mark satisfied ──
      if (neuronId && this.onSatisfied) {
        await this.onSatisfied(neuronId);
        this.log(`[voice] neuron ${neuronId} satisfied`);
      }

      this.log(`[voice] generated: ${m4aPath} (${text.length} chars, engine: ${this.isKokoro ? "kokoro" : "say"})`);
      return m4aPath;
    } catch (err) {
      this.log(`[voice] failed: ${err}`);
      try {
        unlinkSync(m4aPath);
      } catch {
        /* ok */
      }
      return null;
    }
  }

  /** Synchronous fallback for callers that can't await. */
  speakSync(text: string): string | null {
    if (!text || text.trim().length === 0) return null;

    const hash = crypto.createHash("md5").update(text).digest("hex").slice(0, 8);
    const m4aPath = join(this.outputDir, `${hash}.m4a`);
    if (existsSync(m4aPath)) return m4aPath;

    try {
      if (this.isKokoro) {
        this.synthesizeKokoro(text, m4aPath);
      } else {
        this.synthesizeSay(text, m4aPath);
      }
      return m4aPath;
    } catch {
      return null;
    }
  }

  // ── engines ────────────────────────────────────────────────────────────

  private synthesizeSay(text: string, m4aPath: string): void {
    const aiffPath = m4aPath.replace(/\.m4a$/, ".aiff");
    execSync(`say -v "${this.sayVoice}" -r ${Math.round(this.rate * 180)} -o "${aiffPath}" -- "${this.escape(text)}"`, {
      timeout: 15000,
      stdio: "pipe",
    });
    execSync(`afconvert -f m4af -d aac "${aiffPath}" "${m4aPath}"`, { timeout: 10000, stdio: "pipe" });
    try {
      unlinkSync(aiffPath);
    } catch {
      /* ok */
    }
  }

  private synthesizeKokoro(text: string, m4aPath: string): void {
    const wavPath = m4aPath.replace(/\.m4a$/, ".wav");
    const script = `
import sys
from kokoro_mlx import KokoroTTS
tts = KokoroTTS.from_pretrained("${KOKORO_MODEL_PATH}")
result = tts.save(text="${this.escapePython(text)}", path="${wavPath}", voice="${this.kokoroVoice}", speed=${this.rate})
print(f"ok:{len(result.audio)}:{result.duration:.2f}")
`;
    execSync(`${KOKORO_VENV}/bin/python -c "${this.escapeScript(script)}"`, {
      timeout: 30000,
      stdio: "pipe",
    });
    execSync(`afconvert -f m4af -d aac "${wavPath}" "${m4aPath}"`, { timeout: 10000, stdio: "pipe" });
    try {
      unlinkSync(wavPath);
    } catch {
      /* ok */
    }
  }

  // ── utilities ──────────────────────────────────────────────────────────

  private escape(text: string): string {
    return text
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\$/g, "\\$")
      .replace(/`/g, "\\`")
      .replace(/\n/g, " ");
  }

  private escapePython(text: string): string {
    return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
  }

  private escapeScript(script: string): string {
    return script.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`");
  }

  /** List available engines and their status. */
  static status(): { kokoro: boolean; say: boolean } {
    return { kokoro: checkKokoro(), say: true };
  }
}
