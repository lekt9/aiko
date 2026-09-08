/** Independent native Infer capture seam, ready for the production adapter.
 * This captures logical Infer calls. It cannot attest provider token ceilings:
 * Tardie 0.22 InferRequest has no token-limit field; that needs the real host
 * provider-request boundary once the adapter API is supplied. No runtime credit. */
import assert from 'node:assert/strict';
import {Effect,Layer} from '../../apps/agent/node_modules/effect/dist/index.js';
import {Infer,type InferRequest} from '../../apps/agent/node_modules/tardie/src/agent/inference/contract.ts';
import type {Action} from '../../apps/agent/node_modules/tardie/src/agent/log/events.ts';
export function independentInferCapture(options:{respond:(request:InferRequest,signal:AbortSignal)=>Promise<Action>}){
 const calls:{request:InferRequest;key?:string;aborted:boolean;settled:boolean}[]=[];
 const layer=Layer.succeed(Infer,{resolve:()=>({model:{provider:'independent-controlled',model_id:'proposal-fixture'}}),react:(request,key,outerSignal)=>Effect.tryPromise({try:async(innerSignal)=>{
  const signal=outerSignal?AbortSignal.any([innerSignal,outerSignal]):innerSignal;
  const call={request:structuredClone(request),key,aborted:signal.aborted,settled:false};calls.push(call);
  signal.addEventListener('abort',()=>{call.aborted=true;},{once:true});
  const result=await options.respond(structuredClone(request),signal);call.settled=true;return result;
 },catch:error=>error instanceof Error?error:Error(String(error))}) as any});
 return {layer,calls,assertNoHeldout(sentinels:string[]){const serialized=JSON.stringify(calls.map(c=>c.request));for(const sentinel of sentinels)assert(!serialized.includes(sentinel),'held-out data reached native Infer: '+sentinel);},assertCalls(expected:number){assert.equal(calls.length,expected,'unexpected logical Infer calls');}};
}
