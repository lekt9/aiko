import {test,expect} from "bun:test";
import {oauthLaunch,oauthTicket,oauthBrowserRoute} from "../src/connector-oauth.ts";
const config={origin:"https://aiko.example",key:"test-key-that-is-longer-than-24-characters"};
const id="12345678-1234-1234-1234-123456789abc";
test("browser handoff binds owner and connection, detects tampering, and cannot authenticate an API account",()=>{
 const link=oauthLaunch(config,"acct_oauth001",id),token=new URL(link).searchParams.get("ticket")!;
 expect(oauthTicket(token,config.key)).toMatchObject({owner:"acct_oauth001",connectionId:id,purpose:"aiko-app-oauth"});
 expect(()=>oauthTicket(token.replace(".",".x"),config.key)).toThrow();
 expect(()=>oauthTicket(token,"another-key")).toThrow();
});
test("native callback uses HttpOnly browser identity and checks provider status, never query owner or next_uri",async()=>{
 const calls:any[]=[];const operate=async(owner:string,connection:string,action:string,flow?:string)=>{calls.push({owner,connection,action,flow});return action==="launch"?{status:"pending",authorizationUrl:"https://accounts.google.com/o/oauth2/auth"}:{status:"pending"};};
 const launch=await oauthBrowserRoute(new Request(oauthLaunch(config,"acct_oauth001",id)),config.key,operate);
 expect(launch.status).toBe(303);expect(launch.headers.get("location")).toStartWith("https://accounts.google.com/");
 const cookie=launch.headers.get("set-cookie")!;expect(cookie).toContain("HttpOnly; Secure; SameSite=Lax");
 const callback=await oauthBrowserRoute(new Request(config.origin+"/connect/oauth/callback?flow_id=flow_123&owner=attacker&next_uri=https://evil.example",{headers:{cookie}}),config.key,operate);
 expect(callback.status).toBe(303);expect(callback.headers.get("location")).toBe("/connect/oauth/return");
 expect(calls[1]).toEqual({owner:"acct_oauth001",connection:id,action:"verify",flow:"flow_123"});
 const pending=await oauthBrowserRoute(new Request(config.origin+"/connect/oauth/return",{headers:{cookie}}),config.key,operate);
 expect(await pending.text()).not.toContain("Your app is connected");
 const denied=await oauthBrowserRoute(new Request(config.origin+"/connect/oauth/callback?flow_id=flow_123"),config.key,operate);expect(denied.status).toBe(400);expect(calls).toHaveLength(3);
});
