import { cloudflareState } from "./cloudflare-paths.ts";
/** Exercise request memory through the deployed Tardigrade agent itself. */
import { writeFile } from "node:fs/promises";
process.umask(0o077);
const state=await cloudflareState();
if(state.AIKO_E2E_OWNER!=="acct_cloudflare_e2e02")throw Error("Invalid canary account");
const id=`native-request-witness-${Date.now()}`,turn=`plane:${id}`,started=Date.now();
async function request(path:string,body?:object) {
 const response=await fetch(state.AIKO_CLOUDFLARE_URL+path,{method:body?"POST":"GET",headers:{Authorization:`Bearer ${state.AIKO_E2E_TOKEN}`,...(body?{"Content-Type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(120000)});
 if(!response.ok)throw Error(`Agent witness HTTP ${response.status}`);return await response.json() as any;
}
await request("/v1/messages",{id,text:"Isolated request-memory integration check. Only use the connected synthetic site https://unlock-login-canary.lewis-6d8.workers.dev. Use request_memory_search to find the previously observed GET /api/details request, then request_memory_hydrate to fetch its fresh JSON using the learned upstream /api/items dependency. Supply every required input reported by search: route segments are api/items for the upstream request and api/details for the terminal request. Choose a pointer whose prerequisite document is the site root (no project route inputs). In the reported shapes, the step with a name field is details; the step with only an item field is items. Call search with a query string, never a request handle from older history. Do not invent the item query value; it must come from the upstream response. Inspect the fresh response and report its project name. Use these actual tools; a cached answer does not verify this check. Do not navigate, modify data, create connections, or send messages to other channels. If request memory is unavailable, report that fact and stop. Finish with respond."});
console.log(JSON.stringify({turn,phase:"submitted"}));
let after=0;const history:any[]=[];
while(Date.now()-started<8*60_000) {
 for(;;) {
  const page=await request(`/api/control/events?thread=user-${state.AIKO_E2E_OWNER}&after=${after}&limit=100`);
  history.push(...page.events.map((row:any)=>row.event));
  if(page.nextAfter<after)throw Error("Invalid event cursor");after=page.nextAfter;
  if(!page.hasMore)break;
 }
 const own=history.filter(event=>event.turn===turn);
 const reply=own.find(event=>event.type==="AikoReplyPrepared");
 if(reply) {
  const tools=own.filter(event=>event.type==="ToolReturned"&&event.result?.kind==="browser-receipt").map(event=>({operation:event.result.operation,status:event.result.status}));
  const checked=history.filter(event=>event.type==="AikoRequestMemoryChecked"&&event.at>=started);
  const freshProjectNamed=JSON.stringify(reply.result).includes("Verified live canary project");
  const verified=freshProjectNamed&&tools.some(tool=>tool.operation==="request_memory_search"&&tool.status==="completed")&&tools.some(tool=>tool.operation==="request_memory_hydrate"&&tool.status==="completed")&&checked.length>0;
  await writeFile("artifacts/request-memory/deployed-agent.json",JSON.stringify({at:new Date().toISOString(),turn,verified,freshProjectNamed,tools,checks:checked.length,replyTypes:Object.keys(reply).filter(key=>key!=="text"),messagesToOtherChannels:0},null,2));
  console.log(JSON.stringify({verified,tools,checks:checked.length}));
  if(!verified)throw Error("Agent did not complete request search and hydration");process.exit(0);
 }
 if(own.some(event=>["TurnFailed","TurnCancelled"].includes(event.type)))throw Error("Agent witness failed or cancelled");
 await Bun.sleep(2000);
}
throw Error("Agent witness did not settle before deadline");
