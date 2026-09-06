import assert from 'node:assert/strict'
import { writeFile,mkdir } from 'node:fs/promises'
import { createCdpCookieAdapter } from '../packages/sdk/dist/cdp.js'
const relay=process.env.UNLOCK_CDP_RELAY,browserContextId=process.env.UNLOCK_CDP_CONTEXT,targetId=process.env.UNLOCK_CDP_TARGET
if(!relay||!browserContextId||!targetId)throw new Error('Run through scripts/backend-browser-qa.py in browser-harness')
const cdp={async send(method,params,sessionId){const r=await fetch(relay,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params,sessionId})});if(!r.ok)throw new Error('Private CDP relay failed');return r.json()}}
const adapter=await createCdpCookieAdapter(cdp,{browserContextId,targetId}),checks=[]
const check=name=>checks.push({check:name,passed:true})
const base={name:'sid',value:'SYNTHETIC-COOKIE-NOT-REAL',domain:'service.test',path:'/',expires:-1,secure:true,httpOnly:true,sameSite:'Lax',hostOnly:true}
await cdp.send('Storage.setCookies',{browserContextId,cookies:[{name:'untouched',value:'SYNTHETIC-UNRELATED',url:'https://unrelated.test/',secure:true,httpOnly:true}]})
const cookies=[base,{...base,name:'scoped',domain:'.service.test',hostOnly:false,path:'/app'},{...base,sameSite:'None',partitionKey:{topLevelSite:'https://top.test',hasCrossSiteAncestor:true}}]
await adapter.replaceCookies(cookies,['service.test'])
let captured=await adapter.exportCookies(['service.test'])
assert.equal(captured.length,3)
for(const item of cookies)assert.ok(captured.some(c=>JSON.stringify(c)===JSON.stringify(item)))
check('Real Chromium preserves host-only/domain cookies, paths, Secure, HttpOnly, SameSite and partition keys')
await adapter.replaceCookies([{...base,value:'SYNTHETIC-ROTATED'},cookies[2]],['service.test'])
captured=await adapter.exportCookies(['service.test']);assert.equal(captured.length,2);assert.equal(captured.some(c=>c.name==='scoped'),false);assert.ok(captured.some(c=>c.value==='SYNTHETIC-ROTATED'))
check('Full scoped replacement synchronizes rotation and deletions without resurrecting removed cookies')
await adapter.replaceCookies([],['service.test']);assert.deepEqual(await adapter.exportCookies(['service.test']),[])
const remaining=await cdp.send('Storage.getCookies',{browserContextId});assert.equal(remaining.cookies.length,1);assert.equal(remaining.cookies[0].domain,'unrelated.test')
check('Clearing a scoped jar preserves unrelated domains')
await assert.rejects(createCdpCookieAdapter(cdp,{browserContextId:'wrong-context',targetId}))
check('Target/context mismatches fail closed before mutation')
await mkdir('artifacts/backend-qa',{recursive:true});await writeFile('artifacts/backend-qa/browser-results.json',JSON.stringify({timestamp:new Date().toISOString(),browser:(await cdp.send('Browser.getVersion',{})).product,isolated:true,checks},null,2));console.log(`PASS: ${checks.length} real Chromium private-adapter checks; no cookie values printed.`)
