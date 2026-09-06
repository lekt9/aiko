import {test,expect} from "bun:test";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {Effect,Layer} from "effect";
import {actor,agentMessageMethod,infer,tool,Infer,outputValidateOnce} from "tardie";
import {createBunHost} from "tardie/bun/host";
import {BrowserController} from "../src/browser.ts";

test("native request-pointer tools hydrate current response without persisting query, inputs or response values",async()=>{
 const directory=await mkdtemp('/tmp/request-controller-');let seen=false;
 const browser=new BrowserController({domains:['*'],redact:s=>s,allowModelAnswers:true,factory:async()=>({execute:async()=>({}),close:async()=>{},requestSearch:async()=>({items:[{pointerId:'pointer-fixture'}],model:'test',coverage:{}} as any),requestRehydrate:async()=>({status:'completed',consumed:true,hydration:{pointerId:'pointer-fixture',body:{value:'fresh-response-sentinel'}}} as any)})});
 const model=Layer.succeed(Infer,{resolve:()=>({model:{provider:"test",model_id:"test"}}),react:req=>{
  const n=req.trajectory.filter(e=>e.type==='ToolReturned').length;
  if(!n)return Effect.succeed({kind:'call' as const,name:'request_memory_search',callId:'search',arguments:{query:'transient-query-sentinel'}});
  if(n===1)return Effect.succeed({kind:'call' as const,name:'request_memory_hydrate',callId:'hydrate',arguments:{pointerId:'pointer-fixture',inputs:{item:'transient-input-sentinel'}}});
  seen=JSON.stringify(req.trajectory).includes('fresh-response-sentinel');return Effect.succeed({kind:'complete' as const,output:'Fresh response inspected.'});
 }});
 const definition=actor({name:'aiko',methods:{message:agentMessageMethod},components:[infer([tool(browser.tools('123','user-123')),outputValidateOnce])]});
 const host=await createBunHost({database:join(directory,'actor.sqlite'),actorName:'aiko',actorInstance:'test',actorFor:()=>definition,layersFor:()=>browser.inference(model,'123')});
 try{await host.commitRoot(host.self('user-123'),{type:'MessageReceived',id:'test',text:'Inspect stored request pointers',at:Date.now()});await host.wake('user-123');const events=await host.read('user-123');expect(seen).toBe(true);const stored=JSON.stringify(events);for(const sentinel of ['fresh-response-sentinel','transient-query-sentinel','transient-input-sentinel'])expect(stored).not.toContain(sentinel);expect(events.filter(e=>e.type==='ToolReturned')).toHaveLength(2);}
 finally{await host.close();await browser.retire('123');await rm(directory,{recursive:true,force:true});}
});
