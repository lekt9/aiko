/** Local deterministic CLI witness using the production response gate and outbox. No external sends. */
import { actor, agentMessageMethod, infer, tool, Infer, system, outputValidateOnce } from "tardie";
import { Effect, Layer } from "effect";
import { responseTool, withRequiredResponse, RESPONSE_INSTRUCTIONS } from "../src/channel-response.ts";
import { voiceAndOutbox } from "../src/actor.ts";
import { createVoice } from "../src/voice.ts";
export default actor({name:"aiko",methods:{message:agentMessageMethod},components:[
  voiceAndOutbox("local",createVoice({enabled:false,persona:"deterministic-audit"}),undefined,{live:true,redact:text=>text}),
  infer([system(RESPONSE_INSTRUCTIONS),tool(responseTool("local","ag.audit",text=>text)),outputValidateOnce]),
]});
export const layersFor = () => withRequiredResponse(Layer.succeed(Infer, {
  resolve:()=>({model:{provider:"audit",model_id:"deterministic"}}),
  react:()=>Effect.succeed({kind:"complete" as const,output:"Native response tool and durable outbox verified."}),
}));
