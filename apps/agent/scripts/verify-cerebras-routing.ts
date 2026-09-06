import { Effect } from "effect";
import { Infer, type InferRequest } from "tardie";
import { privateEnv } from "../src/config.ts";
import { createModelRouting, parseModelRouting } from "../src/model-routing.ts";
import { WorkflowController, createWorkflowStore } from "../src/workflow-host.ts";

// Explicit live probe: one small inference, no tools or user data.
const env = {
  ...(await privateEnv("/home/deck/.config/unbrowse/aiko.env")),
  AIKO_ALLOW_PAID_INFERENCE: "true",
  AIKO_RAG_PROVIDER: "cerebras",
};
const toolsMode = process.argv.includes("--tools");
const controller = new WorkflowController("acct_routing_probe", "probe", {
  store:createWorkflowStore({get:async()=>undefined,put:async()=>{},list:async()=>[],claim:async()=>false,update:async()=>{}}),
  dispatcher:{resolve:async()=>undefined},
},s=>s);
const routing = createModelRouting({
  owner: "acct_routing_probe",
  env,
  config: parseModelRouting(env, { maxOutputTokens: toolsMode ? 1024 : 128 }),
});
const request: InferRequest = {
  trajectory: [
    {
      type: "MessageReceived",
      id: "probe",
      text: toolsMode ? "Call workflow_list with empty arguments now. Do not write any prose." : "Reply exactly: routing verified",
      at: Date.now(),
    },
  ],
  identity: {
    actor: "aiko",
    instance: "probe",
    thread: "probe",
    turn: "probe",
  },
  system: "Follow the requested output format.",
  tools: toolsMode ? controller.tools().map(t=>t.spec) : [],
};
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const infer = yield* Infer;
    return yield* infer.react(request);
  }).pipe(Effect.provide(routing.layer("rag"))),
);
if (
  toolsMode ? result.kind !== "call" || result.name !== "workflow_list" : result.kind !== "complete" || !String(result.output).toLowerCase().includes("routing verified")
)
  throw new Error("Live Cerebras routing probe did not complete");
console.log(
  JSON.stringify({
    verified: true,
    provider: "cerebras",
    model: routing.config.roles.rag.model,
    liveInference: true,
    generatedToolCall: toolsMode,
    executedToolCalls: 0,
  }),
);
