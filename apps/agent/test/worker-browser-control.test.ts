import {expect,test} from 'bun:test';
import {Effect} from 'effect';
import {Self} from 'tardie/core/runtime';
import {EventLog} from 'tardie/core/log';
import type {Event} from 'tardie/core/event';
import {BrowserController,type WorkerBrowserControlBinding} from '../src/browser.ts';
import {createPublicProxy} from '../src/browser-proxy.ts';
import {request} from 'node:http';

const origin='https://example.com';
async function fixture(){
 let grant:Awaited<ReturnType<WorkerBrowserControlBinding['current']>>={scope:'browser',origins:[origin],browserOperations:['navigate','click','get_text','fill']};
 let opened=0,privateSession=false,changed=false; const executed:string[]=[], parent:Event[]=[], rows:Event[]=[];
 let during:(()=>void)|undefined;
 const browser=new BrowserController({domains:['*'],redact:s=>s,requireInteractionApproval:false,factory:async({emit})=>{
  opened++;return {execute:async()=>{throw Error('Worker used unscoped driver');},close:async()=>{},authorizeInspection:async()=>!privateSession,
   executeScoped:async(action,policy,signal)=>{
    expect(policy).toEqual({origin,origins:[origin]});signal?.throwIfAborted();
    if(privateSession)throw Object.assign(Error('Private sign-in'),{code:'private_sign_in_pending'});
    if(action.action==='url')return {url:origin+'/page'};
    if(action.action==='snapshot')return {snapshot:changed?'changed':'[button Save]'};
    executed.push(action.action);during?.();
    await emit({type:'AikoBrowserLearningCheckpoint',id:crypto.randomUUID(),observed:1});
    return {text:'TRANSIENT_WORKER_PAGE'};
   }};
 }});
 const binding:WorkerBrowserControlBinding={parentThread:'user-123',current:async()=>grant,journal:{read:async()=>parent,append:async events=>{parent.push(...events);}}};
 const tools=browser.workerControlTools('123','worker',binding);
 const log={read:Effect.sync(()=>rows),head:Effect.sync(()=>rows.length),readFrom:(n:number)=>Effect.sync(()=>rows.slice(n)),append:(events:readonly Event[])=>Effect.sync(()=>{rows.push(...events);})};
 const run=(suffix:string,args:Record<string,unknown>={},callId:string=crypto.randomUUID(),signal=new AbortController().signal,thread='worker')=>Effect.runPromise(tools.find(t=>t.spec.name===`worker_browser_${suffix}`)!.run({origin,...args},{callId,turn:'turn',signal}).pipe(Effect.provideService(Self,{actor:'aiko',instance:'test',thread}),Effect.provideService(EventLog,log)));
 const pending=async()=>{for(let i=0;i<200;i++){const approval=browser.status('123').pending[0];if(approval)return approval;await Bun.sleep(5);}throw Error('No approval');};
 return {browser,tools,rows,parent,executed,run,pending,opened:()=>opened,setGrant:(v:typeof grant)=>{grant=v;},setPrivate:(v:boolean)=>{privateSession=v;},setChanged:()=>{changed=true;},during:(v:typeof during)=>{during=v;}};
}

test('worker native UI shares capture and exact parent consent, keeps source private and replays no effects',async()=>{
 const f=await fixture();try{
  expect(await f.run('get_text',{selector:'body'})).toMatchObject({status:'blocked'});expect(f.opened()).toBe(0);
  expect(await f.run('navigate',{url:origin+'/page'},'navigate')).toMatchObject({status:'completed'});
  const click=f.run('click',{selector:'#save'},'click');const approval=await f.pending();
  expect(f.executed).toEqual(['navigate']);expect(f.parent.some(e=>e.type==='AikoBrowserApprovalRequested')).toBe(true);
  expect(f.browser.decide('456',approval.id,true)).toBe(false);expect(f.browser.decide('123',approval.id,true)).toBe(true);
  expect(await click).toMatchObject({status:'completed',untrustedPageContent:expect.stringContaining('TRANSIENT_WORKER_PAGE')});
  expect(f.executed).toEqual(['navigate','click']);expect(f.opened()).toBe(1);
  expect(f.parent.filter(e=>e.type==='AikoBrowserLearningCheckpoint')).toHaveLength(2);
  expect(f.parent.some(e=>e.type==='AikoBrowserApprovalGranted')).toBe(true);
  expect(f.rows.filter(e=>e.type==='AikoBrowserActionStarted')).toHaveLength(2);
  expect(JSON.stringify([...f.rows,...f.parent])).not.toContain('TRANSIENT_WORKER_PAGE');
  expect(await f.run('click',{selector:'#save'},'click')).toMatchObject({status:'completed'});expect(f.executed).toEqual(['navigate','click']);
  const read=f.tools.find(t=>t.spec.name==='worker_browser_get_text')!;
  expect(await read.authorizeRetained!({origin,selector:'body'})).toBe(true);
  f.setPrivate(true);expect(await read.authorizeRetained!({origin,selector:'body'})).toBe(false);
  expect(await f.run('get_text',{selector:'body'})).toMatchObject({status:'blocked'});
 }finally{await f.browser.close();}
});

test('worker UI denies missing, narrowed, revoked and mismatched grants before dispatch, including consent races',async()=>{
 const f=await fixture();try{
  for(const grant of [undefined,{scope:'browser' as const,origins:[origin]}, {scope:'browser' as const,origins:[origin],browserOperations:['click']}, {scope:'browser' as const,origins:[origin],browserOperations:['navigate'],actions:['sha256:'+'1'.repeat(64)]}]){
   f.setGrant(grant);expect(await f.run('navigate',{url:origin})).toMatchObject({status:'blocked'});
  }
  f.setGrant({scope:'browser',origins:[origin],browserOperations:['navigate','click']});
  expect(await f.run('navigate',{url:'https://other.com/'})).toMatchObject({status:'blocked'});
  expect(await f.run('navigate',{url:origin},'foreign',undefined,'foreign')).toMatchObject({status:'blocked'});expect(f.opened()).toBe(0);
  await f.run('navigate',{url:origin});
  const click=f.run('click',{selector:'#save'});const approval=await f.pending();f.setGrant(undefined);f.browser.decide('123',approval.id,true);
  expect(await click).toMatchObject({status:'blocked'});expect(f.executed).toEqual(['navigate']);
 }finally{await f.browser.close();}
});

test('worker UI changed previews and cancelled approval cannot click; interruption after dispatch stays unknown on replay',async()=>{
 const f=await fixture();try{
  await f.run('navigate',{url:origin});
  const changed=f.run('click',{selector:'#save'}),approval=await f.pending();f.setChanged();f.browser.decide('123',approval.id,true);
  expect(await changed).toMatchObject({status:'blocked'});expect(f.executed).toEqual(['navigate']);
  const signal=new AbortController(),cancelled=f.run('click',{selector:'#save'},'cancelled',signal.signal);await f.pending();signal.abort();
  await cancelled;expect(f.executed).toEqual(['navigate']);
  await f.run('navigate',{url:origin});
  const abort=new AbortController();f.during(()=>abort.abort());
  await f.run('navigate',{url:origin},'unknown',abort.signal);
  f.during(undefined);const count=f.executed.length;
  expect(await f.run('navigate',{url:origin},'unknown')).toMatchObject({status:'unknown'});expect(f.executed).toHaveLength(count);
 }finally{await f.browser.close();}
});

test('the existing public proxy blocks delegated off-origin HTTP and CONNECT before connection',async()=>{
 const proxy=await createPublicProxy(),url=new URL(proxy.url);try{
  proxy.restrictOrigins([origin]);
  for(const [method,path] of [['GET','http://outside.invalid/private'],['CONNECT','outside.invalid:443']]){
   const status=await new Promise<number>((resolve,reject)=>{const req=request({hostname:url.hostname,port:url.port,method,path},res=>{res.resume();resolve(res.statusCode!);});req.on('connect',(res,socket)=>{socket.destroy();resolve(res.statusCode!);});req.on('error',reject);req.end();});
   expect(status).toBe(403);
  }
  expect(()=>proxy.restrictOrigins(['http://127.0.0.1'])).toThrow();
 }finally{await proxy.close();}
});

test('native driver rechecks current origin and private authority around scoped actions through its existing CDP path',async()=>{
 const {spyOn}=await import('bun:test');
 const {AgentBrowserClient}=await import('@unbrowse/browser-harness/client');
 const {CdpNetworkListener}=await import('@unbrowse/browser-harness/network-listener');
 const {browserDriverFactory}=await import('../src/browser-driver.ts');
 let url=origin+'/',afterClick:undefined|(()=>void),password=false;
 const calls:string[]=[],rpc:string[]=[];
 const server=Bun.serve({port:0,fetch(req,server){if(server.upgrade(req))return;return new Response(null,{status:400});},websocket:{message(ws,raw){
  const call=JSON.parse(String(raw));rpc.push(call.method);
  const result=call.method==='Target.getTargets'?{targetInfos:[{type:'page',targetId:'page',url}]}:call.method==='Target.attachToTarget'?{sessionId:'session'}:password?{exceptionDetails:{text:'Password gate'}}:{result:{value:{url,title:'Fixture',text:'Public body',links:[],count:0}}};
  ws.send(JSON.stringify({id:call.id,result}));
 }}});
 const client=AgentBrowserClient.prototype as any,network=CdpNetworkListener.prototype as any;
 const mocks=[
  spyOn(client,'prepareViewport').mockResolvedValue(undefined),spyOn(client,'streamStatus').mockResolvedValue({enabled:true,port:1}),
  spyOn(client,'connectTelemetry').mockResolvedValue(undefined),spyOn(client,'networkObservationEndpoint').mockResolvedValue(`ws://127.0.0.1:${server.port}/devtools/browser/fixture`),
  spyOn(client,'open').mockImplementation(async(destination:string)=>{calls.push('navigate');url=destination;}),
  spyOn(client,'executeAgentAction').mockImplementation(async(action:any)=>{if(action.action==='url')return {output:{url}};calls.push(action.action);afterClick?.();return {output:{text:'Native returned content'}};}),
  spyOn(client,'closeAll').mockResolvedValue(undefined),spyOn(client,'disconnectTelemetry').mockReturnValue(undefined),
  spyOn(network,'connect').mockResolvedValue(undefined),spyOn(network,'flush').mockResolvedValue(undefined),spyOn(network,'stopAndSnapshot').mockResolvedValue({}),
 ];
 let driver:Awaited<ReturnType<ReturnType<typeof browserDriverFactory>>>|undefined;
 try{
  driver=await browserDriverFactory('/fixture/never-launched')({owner:'123',domains:['*'],emit:async()=>{}});
  const policy={origin,origins:[origin]};
  await expect(driver.executeScoped!({action:'navigate',url:'https://outside.invalid/'},policy)).rejects.toThrow();expect(calls).toEqual([]);
  expect(await driver.executeScoped!({action:'navigate',url:origin+'/'},policy)).toMatchObject({navigation:'completed'});
  expect(await driver.executeScoped!({action:'click',selector:'#save'},policy)).toMatchObject({text:'Native returned content'});
  password=true;await expect(driver.executeScoped!({action:'click',selector:'#save'},policy)).rejects.toThrow();expect(calls).toEqual(['navigate','click']);password=false;
  url='https://outside.invalid/';await expect(driver.executeScoped!({action:'click',selector:'#save'},policy)).rejects.toThrow();expect(calls).toEqual(['navigate','click']);
  url=origin+'/';afterClick=()=>{url='https://outside.invalid/';};await expect(driver.executeScoped!({action:'click',selector:'#save'},policy)).rejects.toThrow();
  expect(calls).toEqual(['navigate','click','click']);expect(rpc).toContain('Runtime.evaluate');
 }finally{await driver?.close();for(const mock of mocks)mock.mockRestore();await server.stop(true);}
});
