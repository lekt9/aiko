import { connectionMiniAppUrl } from "./telegram-mini-app.ts";
import type { SecureBrowserAdapter } from "./connectors-browser.ts";
import type { BrowserDriverFactory } from "./browser-driver.ts";
/** Cloud host binding; credentials travel only through the runner's encrypted private operation seam. */
export function nativeBrowserConnector(owner:string, factory:BrowserDriverFactory):SecureBrowserAdapter {
  const invoke = async(input:import("./native-login.ts").NativeLoginInput,signal?:AbortSignal) => {
    const driver=await factory({owner,domains:["*"],emit:async()=>{},signal}).catch(error=>{console.warn("private_browser_allocation_failed");throw error;});
    if(!driver.nativeAuth) throw Error("Private sign-in unavailable");
    // Do not close this borrowed driver: it uses the owner's persistent sandbox.
    return driver.nativeAuth(input,signal);
  };
  return {
    native:true,
    readContext:async(binding,signal)=>{
      if(binding.owner !== owner) throw Error("Owner mismatch");
      const driver=await factory({owner,domains:[binding.domain],emit:async()=>{},signal});
      const check = async () => {
        const result = await driver.execute({action:"url"},signal) as {url?:string};
        const url = new URL(result?.url ?? "");
        if(url.protocol !== "https:" || (url.hostname !== binding.domain && !url.hostname.endsWith(`.${binding.domain}`))) throw Error("Connection context left its domain");
        return `${url.origin}${url.pathname}`;
      };
      await driver.execute({action:"navigate",url:`https://${binding.domain}/`},signal);
      await check();
      const loginFields=await driver.execute({action:"get_count",selector:'input[type="password"]'},signal) as {count?:number};
      if(loginFields?.count !== 0) throw Error("Connected page still requires sign-in");
      const snapshot=await driver.execute({action:"snapshot"},signal);
      const visibleText=await driver.execute({action:"get_text",selector:"body"},signal);
      const url=await check();
      const text=JSON.stringify({visibleText,snapshot});
      if(!text || text.length > 64000) throw Error("Connection context is unavailable or too large");
      // Only the indexer receives this read; credential operations remain on the private seam.
      return {url,text:text.slice(0,12000)};
    },
    begin:async(binding,signal)=>{
      if(binding.owner !== owner) throw Error("Owner mismatch");
      return {authorizationUrl:connectionMiniAppUrl(binding.connectionId)};
    },
    control:async(binding,input,signal)=>{
      if(binding.owner !== owner) throw Error("Owner mismatch");
      return invoke({...input,connectionId:binding.connectionId,domain:binding.domain},signal);
    },
    status:async(binding,signal)=>{
      if(binding.owner !== owner) throw Error("Owner mismatch");
      const result=await invoke({...binding,action:"status"},signal);
      return result.status === "connected" ? {...binding,status:"connected",verification:{verified:true,revision:result.revision,expiresAt:result.expiresAt}} : {...binding,status:result.status};
    },
    disconnect:async(binding,signal)=>{
      if(binding.owner !== owner) throw Error("Owner mismatch");
      const result=await invoke({...binding,action:"disconnect"},signal);
      return {...binding,status:result.status === "disconnected" ? "disconnected" : "unknown"};
    },
  };
}
