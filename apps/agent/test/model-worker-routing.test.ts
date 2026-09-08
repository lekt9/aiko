import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Infer, actor, agentMessageMethod, infer, compaction, outputValidateOnce } from "tardie";
import { restingActor } from "tardie/core/runtime";
import { createModelRouting, parseModelRouting } from "../src/model-routing.ts";

const env = {
  AIKO_ALLOW_PAID_INFERENCE: "true", CODEGRAFF_API_KEY: "fixture-codegraff", CEREBRAS_API_KEY: "fixture-cerebras",
  AIKO_RAG_PROVIDER: "cerebras", AIKO_RAG_MODEL: "qwen-3.8-27b",
  AIKO_CONVERSATION_FALLBACKS: '[{"provider":"codegraff","model":"fixture-reviewer"}]',
  AIKO_MODEL_EFFORTS: '{"cerebras/qwen-3.8-27b":["none","high"],"codegraff/fixture-reviewer":["low","high"]}',
};
const request = {
  trajectory: [{type:"MessageReceived",id:"turn",text:"Read the indexed evidence",at:1}],
  identity:{actor:"aiko",instance:"test",thread:"ag.worker",turn:"turn"},system:"Return evidence",tools:[],
};
const reply = () => new Response([
  {id:"reply",object:"chat.completion.chunk",choices:[{index:0,delta:{role:"assistant",content:"Checked"},finish_reason:null}]},
  {id:"reply",object:"chat.completion.chunk",choices:[{index:0,delta:{},finish_reason:"stop"}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}},
].map(chunk=>`data: ${JSON.stringify(chunk)}\n\n`).join("")+"data: [DONE]\n\n",{headers:{"Content-Type":"text/event-stream"}});

test("worker pins use a configured fallback model and the shared owner accounting path", async () => {
  const wires: {url:string;body:any;authorization:string|null}[] = [], owners:string[]=[];
  const router=createModelRouting({owner:"123",env,config:parseModelRouting(env),throttleRetryDelaysMs:[],
    budget:{transport:(owner,upstream)=>{owners.push(owner);return upstream!;}},
    fetch:async(url,init)=>{wires.push({url:String(url),body:JSON.parse(String(init?.body)),authorization:new Headers(init?.headers).get("authorization")});return reply();}});
  const result=await Effect.runPromise(Effect.gen(function*(){return yield* (yield* Infer).react(request);})
    .pipe(Effect.provide(router.layerFor({provider:"codegraff",model_id:"fixture-reviewer"},"high"))));
  expect(result).toMatchObject({kind:"complete",output:"Checked"});
  expect(owners).toEqual(["123"]);
  expect(wires).toHaveLength(1);
  expect(wires[0]).toMatchObject({url:"https://gateway.codegraff.com/v1/chat/completions",body:{model:"fixture-reviewer",reasoning_effort:"high"},authorization:"Bearer fixture-codegraff"});
});

test("explicit Cerebras effort survives adaptation and context reflects the selected provider",async()=>{
  let body:any;
  const router=createModelRouting({owner:"123",env,config:parseModelRouting(env,{contextWindowTokens:131072}),
    fetch:async(_,init)=>{body=JSON.parse(String(init?.body));return reply();}});
  const ref={provider:"cerebras",model_id:"qwen-3.8-27b"};
  await Effect.runPromise(Effect.gen(function*(){return yield* (yield* Infer).react(request);})
    .pipe(Effect.provide(router.layerFor(ref,"high"))));
  expect(body.reasoning_effort).toBe("high");
  expect(router.contextFor(ref)).toEqual({contextWindowTokens:65536,maxOutputTokens:1024});
  expect(router.contextFor({provider:"codegraff",model_id:"fixture-reviewer"}).contextWindowTokens).toBe(131072);
  expect(router.models().find(model=>model.provider==="cerebras")?.efforts).toEqual(["none","high"]);
});

test("unconfigured models and unsupported explicit effort fail before any dispatch",()=>{
  let fetches=0;
  const router=createModelRouting({owner:"123",env,config:parseModelRouting(env),fetch:async()=>{fetches++;return reply();}});
  expect(()=>router.layerFor({provider:"codegraff",model_id:"unconfigured"})).toThrow("configured routes");
  expect(()=>router.layerFor({provider:"cerebras",model_id:"qwen-3.8-27b"},"ultra")).toThrow("effort");
  expect(()=>router.contextFor({provider:"foreign",model_id:"fixture-reviewer"})).toThrow();
  expect(fetches).toBe(0);
});

test("history with a retired model replays under a conservative context without granting that model",()=>{
  let fetches=0;
  const router=createModelRouting({owner:"123",env,config:parseModelRouting(env,{contextWindowTokens:131072}),
    fetch:async()=>{fetches++;return reply();}});
  const retired={provider:"retired-provider",model_id:"old-model"};
  expect(router.contextForHistory(retired).contextWindowTokens).toBe(65536);
  const seen:unknown[]=[];
  const definition=actor({name:"aiko",methods:{message:agentMessageMethod},components:[infer([
    compaction({contextWindowTokens:model=>{seen.push(model);return router.contextForHistory(model).contextWindowTokens;}}),
    outputValidateOnce,
  ])]});
  expect(restingActor(definition,[
    {type:"MessageReceived",id:"history",text:"Previous request",at:1},
    {type:"ModelCalled",turn:"history",callId:"old-call",model:retired,at:2},
    {type:"TurnCompleted",turn:"history",output:"Previous reply",at:3},
  ])).toBe(true);
  expect(seen).toContainEqual(retired);
  expect(()=>router.layerFor(retired)).toThrow("configured routes");
  expect(fetches).toBe(0);
});

test("a pinned worker does not silently switch to the parent model or a fallback",async()=>{
  const models:string[]=[];
  const router=createModelRouting({owner:"123",env,config:parseModelRouting(env),throttleRetryDelaysMs:[],
    fetch:async(_,init)=>{models.push(JSON.parse(String(init?.body)).model);return new Response("unavailable",{status:503});}});
  const result=await Effect.runPromise(Effect.gen(function*(){return yield* (yield* Infer).react(request);})
    .pipe(Effect.provide(router.layerFor({provider:"codegraff",model_id:"fixture-reviewer"}))));
  expect(result.kind).toBe("fail");
  expect(models).toEqual(["fixture-reviewer"]);
});
