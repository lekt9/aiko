// @aiko/contract — the reusable contract-native binding surface for aiko-cli.
//
// One barrel over the pieces that make a TS agent contract-native: the binding to
// the signed substrate, the neuron scopes, the safety gate on command execution,
// the agency (declare / drive / frontier), and the "when to contract" policy.
//
// ONE source of truth: the signed libcontract.dylib serves declare / get / mark /
// gate in-process (FFI); ids and rows land in the one signed ledger. There is no TS
// reimplementation of those primitives — when the dylib isn't loaded the binding is
// simply off (a no-op). The planner (plan / frontier / seek) is aiko's own and has
// no substrate counterpart, so it lives in TS regardless.

// ── agency (declareGoal / drive / frontier / seek) ───────────────────────────────
export {
  type Bounds,
  type DriveOptions,
  type DriveStatus,
  declareGoal,
  drive,
  type Executor,
  frontier,
  isEngaged,
  type Lever,
  type Outcome,
  type Plan,
  plan,
  type RiskPolicy,
  type StepResult,
  seek,
} from "./agency";
// ── ranked context pack for agent turns ──────────────────────────────────────────
export {
  type ContractContextPack,
  type FrontierSlice,
  MAX_CONTEXT_PACK_CHARS,
  packContractContext,
  type RecommendSlice,
  type RelatedSlice,
  shouldPackContractContext,
} from "./context-pack";
// ── safety gate (authorizes command execution only) ──────────────────────────────
export { contractGate, type GateDecision, type GateResult } from "./gate";
// ── the signed binding: declare / get / settle / gate (dylib, in-process) ────────
export { declare, fire, get, isAvailable, isNative, markSatisfied } from "./native";
// ── neuron scopes (turn → tool → subagent DAG) + fractal spawn ────────────────────
export {
  currentNeuronId,
  type NeuronOptions,
  openScope,
  settleScope,
  spawnNeuron,
  type SpawnOptions,
  type SpawnResult,
  witness,
} from "./neurons";
// ── the aiko-native planner + shared record types ────────────────────────────────
export { contentId, type StoreEvent, type StoreRow } from "./store";
// ── when to contract ─────────────────────────────────────────────────────────────
export { CONTRACT_PROMPT_SECTION, type ContractDecision, shouldDeclareTurn, whenToContract } from "./when";
