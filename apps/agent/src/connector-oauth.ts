import {createHmac,timingSafeEqual} from "node:crypto";
import {safeUserId} from "./security.ts";
export type OAuthBrowserConfig={origin:string;key:string};
type Ticket={owner:string;connectionId:string;expires:number;purpose:"aiko-app-oauth"};
export function oauthLaunch(config:OAuthBrowserConfig,owner:string,connectionId:string) {
 const url=new URL(config.origin);if(url.protocol!=="https:"||url.origin!==config.origin||config.key.length<24)throw Error("OAuth callback configuration invalid");
 const data=Buffer.from(JSON.stringify({owner,connectionId,expires:Date.now()+600000,purpose:"aiko-app-oauth"} satisfies Ticket)).toString("base64url");
 const signature=createHmac("sha256",config.key).update(`aiko.oauth.v1.${data}`).digest("base64url");
 return `${config.origin}/connect/oauth/launch?ticket=${data}.${signature}`;
}
export function oauthTicket(token:string,key:string):Ticket {
 if(token.length>2048)throw Error("Invalid OAuth handoff");const [data,signature,...extra]=token.split(".");
 if(!data||!signature||extra.length)throw Error("Invalid OAuth handoff");
 const expected=createHmac("sha256",key).update(`aiko.oauth.v1.${data}`).digest();const actual=Buffer.from(signature,"base64url");
 if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error("Invalid OAuth handoff");
 const value=JSON.parse(Buffer.from(data,"base64url").toString()) as Ticket;
 if(value.purpose!=="aiko-app-oauth"||!safeUserId(value.owner)||!/^[a-f0-9-]{36}$/.test(value.connectionId)||!Number.isSafeInteger(value.expires)||value.expires<=Date.now()||value.expires>Date.now()+600000)throw Error("Expired OAuth handoff");return value;
}
const cookieName="__Secure-aiko-oauth";
const headers={"cache-control":"no-store","referrer-policy":"no-referrer","x-content-type-options":"nosniff","content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"};
export async function oauthBrowserRoute(request:Request,key:string,operate:(owner:string,id:string,action:"launch"|"verify"|"status",flowId?:string)=>Promise<{authorizationUrl?:string;status:string}>):Promise<Response> {
 const url=new URL(request.url);
 if(request.method!=="GET")return new Response("Method not allowed",{status:405,headers});
 try {
  const launch=url.pathname==="/connect/oauth/launch";
  const token=launch?url.searchParams.get("ticket"):(request.headers.get("cookie")??"").split(";").map(s=>s.trim()).find(s=>s.startsWith(`${cookieName}=`))?.slice(cookieName.length+1);
  if(!token)throw Error("Missing OAuth handoff");const ticket=oauthTicket(token,key);
  if(launch){const result=await operate(ticket.owner,ticket.connectionId,"launch");if(!result.authorizationUrl)throw Error("OAuth handoff unavailable");const target=new URL(result.authorizationUrl);if(target.protocol!=="https:")throw Error("Invalid OAuth destination");return new Response(null,{status:303,headers:{...headers,location:target.href,"set-cookie":`${cookieName}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/connect/oauth; Max-Age=600`}});}
  if(url.pathname==="/connect/oauth/callback"){
   const flowId=url.searchParams.get("flow_id");if(!flowId||!/^[A-Za-z0-9_-]{1,256}$/.test(flowId))throw Error("Invalid verification flow");
   await operate(ticket.owner,ticket.connectionId,"verify",flowId);
   return new Response(null,{status:303,headers:{...headers,location:"/connect/oauth/return"}});
  }
  if(url.pathname!=="/connect/oauth/return")return new Response("Not found",{status:404,headers});
  const result=await operate(ticket.owner,ticket.connectionId,"status");const connected=result.status==="connected",pending=result.status==="pending";
  return new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${pending?'<meta http-equiv="refresh" content="5;url=/connect/oauth/return">':''}<title>Aiko · App connection</title><style>body{font:17px -apple-system,BlinkMacSystemFont,system-ui;background:#f2f2f7;color:#1c1c1e;margin:0;padding:24px}main{max-width:400px;margin:12vh auto;background:white;border-radius:20px;padding:24px}a{display:block;padding:14px;background:#007aff;color:white;border-radius:12px;text-align:center;text-decoration:none;margin-top:24px}p{line-height:1.5}</style></head><body><main><h1>${connected?'App connected':pending?'Checking your connection':'Connection not completed'}</h1><p>${connected?'Your app is connected to Aiko. Return to Telegram to continue.':pending?'Aiko is verifying your provider authorization. This page will update automatically.':'Return to Aiko and reconnect the app.'}</p><a href="https://t.me/aikospillstea_bot">Return to Aiko in Telegram</a><a href="/connect">Open connections</a></main></body></html>`,{headers:{...headers,"content-type":"text/html;charset=utf-8",...(!pending?{"set-cookie":`${cookieName}=; HttpOnly; Secure; SameSite=Lax; Path=/connect/oauth; Max-Age=0`}:{})}});
 }catch{return new Response("This connection could not be verified. Reopen Aiko in Telegram and connect the app again.",{status:400,headers});}
}
