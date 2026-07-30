// voice-circuit.ts — contract-native TTS voice circuit.
//
// Three engines, auto-selected:
//   PRIMARY: Qwen3-TTS (1.7B VoiceDesign via MLX on Apple Neural Engine)
//            Supports zero-shot voice cloning from reference audio
//   SECONDARY: Kokoro (82M-param neural TTS via MLX)
//   FALLBACK: macOS `say` (built-in, always available)
//
// Contract-native flow (every speak call):
//   1. declare neuron: voice:output
//   2. gate: confirm for network_mutation channels
//   3. synthesize: qwen3 → .wav → afconvert → .m4a
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

export type VoiceEngine = "qwen3" | "kokoro" | "say" | "auto";

export interface VoiceCircuitConfig {
  /** Engine to use (default: "auto" — qwen3 if available, else kokoro, else say). */
  engine?: VoiceEngine;
  /** Voice name for `say` engine (default: "Samantha"). */
  sayVoice?: string;
  /** Kokoro voice name (default: "af_heart" — warm, feminine, US English). */
  kokoroVoice?: string;
  /** Qwen3-TTS voice (default: "default" for preset, or path to reference .wav for cloning). */
  qwen3Voice?: string;
  /** Reference text for voice cloning (used with qwen3Voice reference audio). */
  qwen3RefText?: string;
  /** Voice description for Qwen3 VoiceDesign instruct parameter. */
  qwen3Instruct?: string;
  /** Speaking rate (say: wpm, kokoro/qwen3: multiplier). */
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
const DEFAULT_QWEN3_VOICE = "/tmp/auni-reference.wav"; // cloned reference audio
const DEFAULT_QWEN3_REF_TEXT = "This is the preview of the Auni canonical voice for the Aiko system.";
const DEFAULT_QWEN3_INSTRUCT = "A warm, natural feminine voice with a clear, calm, and confident tone. Medium pitch and pace. Friendly and approachable, like a thoughtful assistant.";
const DEFAULT_RATE = 1.0;
const OUTPUT_DIR = join(tmpdir(), "aiko-voice");
const KOKORO_VENV = "/tmp/kokoro-venv";
const KOKORO_MODEL_PATH =
  "/Users/lewis/.cache/huggingface/hub/models--mlx-community--Kokoro-82M-bf16/snapshots/a71e4d38b236d968966a2002c4c895dbd12b1c3c";
const QWEN3_MODEL_PATH = "/tmp/qwen3-voicedesign";
const QWEN3_REF_AUDIO_PATH = "/tmp/auni-reference.wav";

// ── engine detection ───────────────────────────────────────────────────────

let kokoroAvailable: boolean | null = null;
let qwen3Available: boolean | null = null;

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

function checkQwen3(): boolean {
  if (qwen3Available !== null) return qwen3Available;
  try {
    // Check that model exists and mlx_audio is importable
    if (!existsSync(QWEN3_MODEL_PATH)) {
      qwen3Available = false;
      return false;
    }
    execSync(`${KOKORO_VENV}/bin/python -c "from mlx_audio.tts.generate import generate_audio, load_audio"`, {
      timeout: 5000,
      stdio: "pipe",
    });
    qwen3Available = existsSync(QWEN3_REF_AUDIO_PATH);
  } catch {
    qwen3Available = false;
  }
  return qwen3Available;
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
  private qwen3Voice: string;
  private qwen3RefText: string;
  private qwen3Instruct: string;
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
    this.qwen3Voice = config.qwen3Voice ?? DEFAULT_QWEN3_VOICE;
    this.qwen3RefText = config.qwen3RefText ?? DEFAULT_QWEN3_REF_TEXT;
    this.qwen3Instruct = config.qwen3Instruct ?? DEFAULT_QWEN3_INSTRUCT;
    this.rate = config.rate ?? DEFAULT_RATE;
    this.outputDir = config.outputDir ?? OUTPUT_DIR;
    this.log = config.log ?? (() => {});
    this.onDeclare = config.onDeclare;
    this.onGate = config.onGate;
    this.onSatisfied = config.onSatisfied;
    mkdirSync(this.outputDir, { recursive: true });
  }

  /** Resolve which engine to actually use. */
  private resolveEngine(): "qwen3" | "kokoro" | "say" {
    if (this.engine === "qwen3") return "qwen3";
    if (this.engine === "kokoro") return "kokoro";
    if (this.engine === "say") return "say";
    // "auto": prefer qwen3 > kokoro > say
    if (checkQwen3()) return "qwen3";
    if (checkKokoro()) return "kokoro";
    return "say";
  }

  /** True if Qwen3 is the active engine. */
  get isQwen3(): boolean {
    return this.resolveEngine() === "qwen3";
  }

  /** True if Kokoro is the active engine. */
  get isKokoro(): boolean {
    return this.resolveEngine() === "kokoro";
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
    const activeEngine = this.resolveEngine();
    try {
      if (activeEngine === "qwen3") {
        this.synthesizeQwen3(text, m4aPath);
      } else if (activeEngine === "kokoro") {
        this.synthesizeKokoro(text, m4aPath);
      } else {
        this.synthesizeSay(text, m4aPath);
      }

      // ── contract-native: mark satisfied ──
      if (neuronId && this.onSatisfied) {
        await this.onSatisfied(neuronId);
        this.log(`[voice] neuron ${neuronId} satisfied`);
      }

      this.log(`[voice] generated: ${m4aPath} (${text.length} chars, engine: ${activeEngine})`);
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

    const activeEngine = this.resolveEngine();
    try {
      if (activeEngine === "qwen3") {
        this.synthesizeQwen3(text, m4aPath);
      } else if (activeEngine === "kokoro") {
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

  private synthesizeQwen3(text: string, m4aPath: string): void {
    const wavPath = m4aPath.replace(/\.m4a$/, ".wav");
    const instruct = this.qwen3Instruct;
    const refText = this.qwen3RefText.replace(/"/g, '\\"').replace(/\n/g, " ");
    const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
    const escapedInstruct = instruct.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
    const script = `
import sys
sys.path.insert(0, "${KOKORO_VENV}/lib/python3.11/site-packages")
from mlx_audio.tts.generate import generate_audio, load_audio
from mlx_audio.utils import load_model, load_config

model = load_model("${QWEN3_MODEL_PATH}")
config = load_config("${QWEN3_MODEL_PATH}")
ref_audio = load_audio("${QWEN3_REF_AUDIO_PATH}", 24000)

generate_audio(
    model=model,
    config=config,
    text="${escaped}",
    voice="default",
    instruct="${escapedInstruct}",
    ref_audio=ref_audio,
    ref_text="${refText}",
    speed=${this.rate},
    output_path="${wavPath}",
    verbose=False,
)
print(f"ok:wrote:${wavPath}")
`;
    execSync(`${KOKORO_VENV}/bin/python -c "${this.escapeScript(script)}"`, {
      timeout: 120000,
      stdio: "pipe",
    });
    execSync(`afconvert -f m4af -d aac "${wavPath}" "${m4aPath}"`, { timeout: 10000, stdio: "pipe" });
    try {
      unlinkSync(wavPath);
    } catch {
      /* ok */
    }
  }

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
  static status(): { qwen3: boolean; kokoro: boolean; say: boolean } {
    return { qwen3: checkQwen3(), kokoro: checkKokoro(), say: true };
  }
}
