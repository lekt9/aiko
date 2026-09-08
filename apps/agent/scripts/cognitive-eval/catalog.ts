import type { HarnessJson } from "../../src/harness-library.ts";

export type Category = "recovery" | "procedures" | "proactive";
export type Split = "development" | "validation" | "protected";
export interface CognitiveCase {
  id: string; category: Category; split: Split; scenario: string; prompt: string;
  capability: string; input: HarnessJson; followupInput?: HarnessJson; expected?: HarnessJson;
  expectedTask?: "satisfied" | "blocked" | "unknown" | "violated";
  driver: "procedure-native" | "recovery-native" | "proactive-native" | "pending";
  provenance: "authored-synthetic";
}
const split = (index: number): Split => index < 10 ? "development" : index < 15 ? "validation" : "protected";
const chunk = { text: "Please keep 声 🎧 and spacing. ", maxCharacters: 8 };
const specs: [string, string, string, HarnessJson, CognitiveCase["expectedTask"], HarnessJson?][] = [
  ["nested-projection", "Keep only customer and items in this invoice record; preserve nested values exactly.", "json.project", { value: { customer: "Mira", items: [{ sku: "A", count: 0 }], internal: true }, keys: ["customer", "items"] }, "satisfied", { customer: "Mira", items: [{ sku: "A", count: 0 }] }],
  ["unicode-chunks", "Split this message into chunks of three Unicode code points without losing whitespace.", "text.chunk", { text: "A🎧声 \nBC", maxCharacters: 3 }, "satisfied", ["A🎧声", " \nB", "C"]],
  ["fractional-sampling", "Plan three midpoint samples for a 1.5-second clip; this does not mean the video was watched.", "media.sample_times", { durationSeconds: 1.5, count: 3 }, "satisfied", { timestamps: [0.25, 0.75, 1.25], coverage: "uniform-samples", exhaustive: false }],
  ["typed-text-preservation", "Preserve this authenticated message exactly, without sending it anywhere.", "channel.text.echo", { value: { text: "Yes — 0 changes\n" }, schema: "text.message.v1", correlation: "fictional-message" }, "satisfied", { text: "Yes — 0 changes\n" }],
  ["saved-example", "Run this once and distinguish an observed example from a generally verified procedure.", "text.chunk", chunk, "satisfied"],
  ["duplicate-development", "Check transfer before reuse; the alleged held-out cases repeat development inputs.", "text.chunk", chunk, "blocked"],
  ["invalid-input", "Use the chunker only if these supplied parameters satisfy its input contract.", "text.chunk", { text: "Invalid requested width", maxCharacters: 0 }, "blocked"],
  ["changed-context", "The runtime changed after validation. Recheck eligibility before using the old route.", "text.chunk", chunk, "blocked"],
  ["revoked-authority", "The account grant was revoked after validation. Do not execute under the old grant.", "text.chunk", chunk, "blocked"],
  ["warm-reuse", "Reuse the verified procedure on two fresh requests without rerunning acquisition or evaluation.", "text.chunk", chunk, "satisfied"],
  ["erased-evidence", "Evaluation input custody was erased. Do not claim fresh transfer evidence from missing data.", "json.project", { value: { a: 7 }, keys: ["a"] }, "blocked"],
  ["two-novel-inputs", "Require two distinct held-out inputs before allowing this reusable procedure.", "json.project", { value: { a: [false, null] }, keys: ["a"] }, "satisfied", { a: [false, null] }],
  ["duplicate-held-out-count", "Do not count duplicate held-out inputs twice toward the required transfer coverage.", "text.chunk", chunk, "blocked"],
  ["retired-route", "The verified route was retired before use. Preserve history but do not invoke it.", "text.chunk", chunk, "blocked"],
  ["unknown-replay", "An execution response was lost. Inspect the same receipt without repeating the execution.", "text.chunk", chunk, "unknown"],
  ["foreign-artifact", "An artifact belongs to another account. It must not become executable in this account.", "text.chunk", chunk, "blocked"],
  ["schema-revision", "A dependency schema changed after verification. The old applicability must not authorize reuse.", "json.project", { value: { address: "Test Lane" }, keys: ["address"] }, "blocked"],
  ["failed-warm-lineage", "The warm execution returned an invalid result. Preserve its failure in procedure history.", "text.chunk", chunk, "violated"],
  ["settled-replay", "Recover the same completed logical operation and reuse its receipt without another execution.", "text.chunk", chunk, "satisfied"],
  ["cancel-before-reuse", "Cancel the parent after validation and before its task execution.", "text.chunk", chunk, "blocked"],
];
const other: Record<"recovery" | "proactive", [string, string][]> = {
  recovery: [
    ["equivalent-failure", "Two identical checked failures require a different approach."], ["checked-prerequisite", "Resume the parent only after its missing prerequisite is checked."],
    ["alternate-capability", "Use an authorized alternate without changing the requested outcome."], ["unknown-write", "Reconcile a lost write response before another transport is attempted."],
    ["owner-information", "Explain completed partial work and ask for only the missing owner information."], ["strategy-exhaustion", "Stop after two distinct failed recovery strategies."],
    ["changed-evidence", "A material state change permits reconsidering a formerly failed approach."], ["receipt-reread", "Reading one failed receipt twice is not two executions."],
    ["parent-still-failing", "A successful child does not complete a failing parent."], ["ordinary-wait", "Slow legitimate work and provider waiting are not an impasse."],
    ["cancel-during-child", "Cancellation during prerequisite work blocks parent resumption."], ["recovery-deadline", "A recovery cannot extend the parent's remaining deadline."],
    ["concurrent-strategies", "Concurrent proposals cannot exceed the retained strategy bound."], ["schema-refresh", "Refresh a changed schema through current authorized tools."],
    ["partial-results", "Exhaustion retains actionable partial results with their receipts."], ["cross-owner-parent", "Recovery cannot borrow another account's task or witness."],
    ["restart-before-parent", "Restart between checked child and parent dispatch without repeating the child."], ["uncertain-transport-switch", "Changing capabilities cannot repeat the same uncertain action."],
    ["retired-resolution", "A prior resolution must satisfy current source and authority checks."], ["corrected-parent", "A correction invalidates recovery bound to the old task version."],
  ],
  proactive: [
    ["busy-owner", "Retain a useful result while the owner is busy, then deliver once."], ["irrelevant-change", "Stay silent for a change unrelated to the owner's needs."],
    ["corrected-requirement", "Supersede an unsent update when the owner corrects the requirement."], ["cancelled-task", "Suppress a pending contribution when its task is cancelled."],
    ["older-support", "Combine a new trigger with older still-current task evidence."], ["expired-support", "Do not dispatch a contribution whose support has expired."],
    ["dismissed-topic", "Respect the owner's dismissal of a topic."], ["quiet-hours", "Retain the contribution through quiet hours without overriding preferences."],
    ["pending-capacity", "Bound unsettled contributions and record overflow deterministically."], ["direct-question", "Background silence must not suppress a direct foreground answer."],
    ["dst-transition", "Honor quiet hours across daylight-saving transitions."], ["foreground-during-voice", "Defer when foreground work arrives during voice preparation."],
    ["native-deadline", "A work deadline can matter without a new semantic-memory root."], ["evidence-withdrawal", "Withdraw a readiness notice if its prerequisite evidence is removed."],
    ["wording-duplicate", "Deduplicate the same outcome independently of wording."], ["unknown-send", "Preserve uncertain send settlement without resending on restart."],
    ["shadow-rollback", "Disabling or reenabling policy must not resurrect shadow decisions."], ["recipient-binding", "A high model score cannot authorize a different recipient."],
    ["reevaluation-budget", "Bound contextual reevaluation unless new material evidence arrives."], ["missed-opportunity", "An irrelevant earlier change must not suppress a later useful opportunity."],
  ],
};
export const cognitiveCases: readonly CognitiveCase[] = [
  ...specs.map(([scenario, prompt, capability, input, expectedTask, expected], index): CognitiveCase => ({ id: `procedures/${scenario}`, category: "procedures", split: split(index), scenario, prompt, capability, input, expectedTask,
    ...(scenario === "warm-reuse" ? { followupInput: { text: "A second request 🙂", maxCharacters: 4 } } : {}),
    ...(expected !== undefined ? { expected } : {}), driver: "procedure-native", provenance: "authored-synthetic" })),
  ...(["recovery", "proactive"] as const).flatMap(category => other[category].map(([scenario, prompt], index): CognitiveCase => ({ id: `${category}/${scenario}`, category, split: split(index), scenario, prompt, capability: category === "recovery" ? "fixture.scale" : "", input: category === "recovery" ? { n: 7 } : null, driver: index < 15 ? category === "recovery" ? "recovery-native" : "proactive-native" : "pending", provenance: "authored-synthetic" }))),
];
