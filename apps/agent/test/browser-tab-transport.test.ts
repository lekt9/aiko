import {expect,spyOn,test} from "bun:test";
import {Codegraff,CodegraffSandbox} from "../src/codegraff.ts";

test("Codegraff task dispatch carries its tab through the runner, flushes before the next dispatch, and never stops siblings",async()=>{
  const packets=new Map<string,any>(),seen:string[]=[],privateRequests:any[]=[];
  const sandbox=new CodegraffSandbox({owner:"owner",gateway:new Codegraff("fixture",async()=>{throw Error("No provider access");}),store:{get:async()=>undefined,put:async()=>{}},emit:async()=>{},runnerBundle:"fixture",bootstrap:"fixture"});
  const ensure=spyOn(sandbox,"ensure").mockResolvedValue("vm-owned"),stop=spyOn(sandbox,"stop").mockResolvedValue(true);
  const upload=spyOn(sandbox as any,"upload").mockImplementation(async(_id:string,path:string,body:string)=>{packets.set(path.split("/").at(-1)!.replace(".json",""),JSON.parse(body));});
  const invoke=spyOn(sandbox as any,"invokePrivate").mockImplementation(async(_id:string,input:any)=>{privateRequests.push(input);return {closed:true};});
  const exec=spyOn(sandbox,"exec").mockImplementation(async(_id,command)=>{
    if(command.includes("runner.js execute")){
      const packet=packets.get(command.split(" ").at(-1)!);seen.push(packet.tab);
      return JSON.stringify({status:"completed",output:{tab:packet.tab},events:[]});
    }
    return JSON.stringify({events:[]});
  });
  try {
    await expect(sandbox.browserFactory()({owner:"foreign",domains:["*"],emit:async()=>{}})).rejects.toThrow("owner");
    expect(ensure).not.toHaveBeenCalled();
    const creation=new AbortController();
    const account=await sandbox.browserFactory()({owner:"owner",domains:["*"],emit:async()=>{},signal:creation.signal});
    const a=await account.forTab!("task_a"),b=await account.forTab!("task_b");creation.abort();
    expect(await Promise.all([a.execute({action:"navigate",url:"https://example.com/a"}),b.execute({action:"navigate",url:"https://example.com/b"})])).toEqual([{tab:"task_a"},{tab:"task_b"}]);
    expect(seen).toEqual(["task_a","task_b"]);
    await a.close();expect(privateRequests).toEqual([{operation:"tab-close",tab:"task_a"}]);expect(stop).not.toHaveBeenCalled();
    expect(await b.execute({action:"title"})).toEqual({tab:"task_b"});
    await account.close();expect(stop).toHaveBeenCalledTimes(1);
  }finally{for(const mock of [ensure,stop,upload,invoke,exec])mock.mockRestore();}
});
