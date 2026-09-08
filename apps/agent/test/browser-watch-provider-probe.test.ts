import {test,expect} from "bun:test";
import {cleanupProviderProbe,type ProbeCleanup} from "../../../scripts/probe-browser-watch-activity.ts";

function fixture(sequence:(string|Error)[]){
  let now=0;const calls:{path:string;method?:string}[]=[],events:string[]=[],saved:ProbeCleanup[]=[];
  const result:ProbeCleanup={stopRequested:false,deleteRequested:false,stopped:false,deleted:false};
  const options={id:"allocated-probe",deadline:3000,result,now:()=>now,wait:async(ms:number)=>{now+=ms;},
    observe:(kind:string)=>{events.push(kind);},checkpoint:async()=>{saved.push(structuredClone(result));},
    gateway:{request:async(path:string,_body?:unknown,_signal?:AbortSignal,method?:string)=>{
      calls.push({path,method});
      if(path.endsWith("/stop")||method==="DELETE")return {accepted:true};
      const state=sequence.shift()??"deleting";if(state instanceof Error)throw state;return {state};
    }},
  };
  return {options,calls,events,saved,result};
}
test("probe DELETE acceptance remains pending until the allocated VM is confirmed absent",async()=>{
  const f=fixture(["stopping","stopped",Error("codegraff_http_404")]);
  await cleanupProviderProbe(f.options);
  expect(f.result).toEqual({stopRequested:true,deleteRequested:true,stopped:true,deleted:true});
  expect(f.events).toContain("cleanup_delete_accepted");
  expect(f.events.at(-1)).toBe("cleanup_delete_confirmed");
  expect(f.saved.find(row=>row.deleteRequested)).toMatchObject({deleted:false});
  expect(f.calls.filter(call=>call.method==="DELETE")).toHaveLength(1);
  expect(f.calls.every(call=>call.path.startsWith("/v1/sandboxes/allocated-probe"))).toBe(true);
});
test("probe cleanup deadline does not turn asynchronous delete or transient reads into a success",async()=>{
  const f=fixture([Error("codegraff_http_503"),"deleting","deleting"]);
  await cleanupProviderProbe(f.options);
  expect(f.result).toEqual({stopRequested:true,deleteRequested:true,stopped:false,deleted:false});
  expect(f.events).not.toContain("cleanup_delete_confirmed");
  expect(f.calls.filter(call=>call.method==="DELETE")).toHaveLength(1);
});
test("probe cleanup tolerates lost DELETE response and checkpoint errors while checking the same resource",async()=>{
  const f=fixture([Error("codegraff_http_404")]);
  const original=f.options.gateway.request;
  f.options.gateway.request=async(...args)=>{if(args[3]==="DELETE")throw Error("lost_reply");return original(...args);};
  f.options.checkpoint=async()=>{throw Error("disk_unavailable");};
  await cleanupProviderProbe(f.options);
  expect(f.result.deleted).toBe(true);
  expect(f.events).toContain("cleanup_delete_unconfirmed");
  expect(f.events.at(-1)).toBe("cleanup_delete_confirmed");
});
