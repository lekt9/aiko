/** Synthetic CLI witness, never the production entry. Requires a fresh temporary directory.
 * Exercises the application's actual NativeTool adapter with Tardie 0.22 effects and durable
 * CLI calls. No model/provider, browser, log-import grant or embedding capability is installed.
 */
import { Effect, Layer } from "effect";
import { actor, agentMessageMethod, infer, Infer, outputValidateOnce, system, tool, type InferRequest } from "tardie";
import type { MemoryHit, Observation } from "entity-learn";
import { memoryTools, type MemoryReceipt } from "../src/memory.ts";

const text = "Use UTC for the launch.";
function auditStateDir(): string {
  // Avoid Bun.build inlining process.env.NAME, which would make tdg build throw at import.
  const dir = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.AIKO_MEMORY_AUDIT_DIR;
  const name = dir?.split("/").pop();
  if (!dir || !name?.startsWith("aiko-memory-native-") || !dir.includes("/tmp")) {
    throw new Error("Set AIKO_MEMORY_AUDIT_DIR to a fresh aiko-memory-native-* temp directory");
  }
  return dir;
}
export default actor({ name: "aiko", methods: { message: agentMessageMethod }, components: [infer([
  system("Synthetic memory plumbing witness only. Read original evidence before returning a cited result. No accuracy benchmark."),
  tool(memoryTools({ get stateDir() { return auditStateDir(); }, owner: "local", thread: "ag.memory-audit", redact: text => text,
    readPage: async () => { throw new Error("This fixture has no log-import grant"); } }, { fixtures: false })),
  outputValidateOnce,
], { giveUpAfter: 1 })] });

export const layersFor = () => Layer.succeed(Infer, {
  resolve: () => ({ model: { provider: "fixture", model_id: "native-memory-witness" } }),
  react: (request: InferRequest) => Effect.sync(() => {
    const turn = request.identity.turn;
    const message = request.trajectory.findLast(e => e.type === "MessageReceived" && e.id === turn);
    // Tardie 0.22 returns carry callId, not turn. Join through this turn's calls.
    const callIds = new Set(request.trajectory.filter(e => e.type === "ToolCalled" && e.turn === turn).map(e => e.callId));
    const receipts = request.trajectory.filter(e => e.type === "ToolReturned" && callIds.has(e.callId)).map(e => e.result as MemoryReceipt);
    if (receipts.some(r => r.kind !== "memory-receipt" || r.outcome !== "ok")) throw new Error("Unsuccessful native memory receipt");
    const call = (name: string, args: unknown) => ({ kind: "call" as const, name, arguments: args, callId: `${turn}:memory:${receipts.length}` });
    if (message?.text === "seed") {
      if (!receipts.length) return call("memory_remember", { subject: "audit/source", title: "Launch instruction", type: "source", kind: "episode", payload: { text } });
      const source = receipts[0]!.result as unknown as Observation;
      if (receipts.length === 1) return call("memory_publish_page", { subject: "audit/page", title: "Launch timezone", claims: [{ text, basis: "stated",
        citations: [{ observation: source.id, path: ["text"], quote: text }] }] });
      return { kind: "complete" as const, output: `Compiled ${source.id}` };
    }
    if (message?.text === "read") {
      if (!receipts.length) return call("memory_scan", { type: "knowledge-page", limit: 1 });
      const page = (receipts[0]!.result as unknown as { items: MemoryHit[] }).items[0];
      if (!page) throw new Error("Pinned page missing after restart");
      if (receipts.length === 1) return call("memory_page", { observation: page.observation.id });
      const compiled = receipts[1]!.result as unknown as { citations: { citation: { observation: string } }[] };
      const source = compiled.citations[0]!.citation.observation;
      if (receipts.length === 2) return call("memory_get", { observation: source });
      const original = receipts[2]!.result as unknown as MemoryHit;
      if ((original.observation.payload as { text: string }).text !== text || original.observation.id !== source)
        throw new Error("Original evidence does not support the fixture result");
      return { kind: "complete" as const, output: `UTC [${source}]` };
    }
    throw new Error("Only synthetic seed/read inputs are supported");
  }),
});
