/** Private browser control. Only the authenticated owner API can call this, never an actor tool. */
import { publicTarget } from "./browser-proxy.ts";
export type NativeLoginInput = { connectionId: string; domain: string; action: "login" | "renew" | "begin" | "status" | "form" | "credentials" | "view" | "click" | "type" | "key" | "scroll" | "finish" | "disconnect" | "navigate" | "allow_origin"; url?: string; credentialReference?: { managerId: string; reference: string }; username?: string; password?: string; code?: string; x?: number; y?: number; text?: string; key?: string; delta?: number };
export type NativeLoginState = { connectionId: string; domain: string; targetId?: string; preserveTargetIds?: string[]; approvedOrigins?: string[]; status: "pending" | "connected" | "disconnected"; expiresAt: number; revision: number; credentialsSaved?: boolean; verifiedSession?: { expiresAt: number; revision: number; credentialsSaved?: boolean } };
export type NativeLoginView = { status: NativeLoginState["status"]; domain: string; currentHost?: string; requiresOrigin?: string; fields?: string[]; screenshot?: string; width?: number; height?: number; expiresAt: number; revision: number; credentialsSaved?: boolean };
export type PrivateCdp = {send(method:string,params:object,sessionId?:string):Promise<any>;close():void};
/** Expired private pages must be cleaned, not merely ignored: they still hold login state. */
export async function prepareNativeLogin(input: NativeLoginInput, states: NativeLoginState[], disconnect: (input: NativeLoginInput) => Promise<unknown>, now = Date.now()) {
  if (!["disconnect", "status"].includes(input.action) && states.some(state => state.status === "pending" && state.connectionId !== input.connectionId && state.expiresAt > now))
    throw Error("Finish the existing private sign-in first");
  for (const state of states) if (state.status === "pending" && state.expiresAt <= now)
    await disconnect({connectionId: state.connectionId, domain: state.domain, action: "disconnect"});
}
export function validateNativeInput(input: NativeLoginInput) {
  if (!input || !/^[a-f0-9-]{36}$/.test(input.connectionId) || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(input.domain) || !["login","renew","begin","status","form","credentials","view","click","type","key","scroll","finish","disconnect","navigate","allow_origin"].includes(input.action)) throw Error("Invalid private sign-in request");
  if (["navigate","allow_origin"].includes(input.action)) {
    const url=publicTarget(input.url??"");
    if(url.protocol!=="https:"||url.href.length>2048||url.username||url.password)throw Error("Use a public HTTPS sign-in address");
    if(input.action==="allow_origin"&&url.origin!==input.url)throw Error("Expected sign-in origin");
  }
  if (input.action === "credentials") {
    if (![input.username,input.password,input.code].some(value => typeof value === "string" && value.length > 0)) throw Error("Credentials required");
    for (const value of [input.username,input.password,input.code]) if (value !== undefined && (typeof value !== "string" || value.length > 2048)) throw Error("Invalid credentials");
  }
  if (input.action === "type" && (typeof input.text !== "string" || !input.text || input.text.length > 2048)) throw Error("Invalid sign-in text");
  if (input.action === "click" && (!Number.isFinite(input.x) || !Number.isFinite(input.y) || input.x! < 0 || input.x! > 390 || input.y! < 0 || input.y! > 640)) throw Error("Invalid sign-in coordinates");
  if (input.action === "key" && !["Enter","Tab","Backspace","Escape"].includes(input.key ?? "")) throw Error("Invalid sign-in key");
  if (input.action === "scroll" && (!Number.isFinite(input.delta) || Math.abs(input.delta!) > 640)) throw Error("Invalid sign-in scroll");
}
const loginPaths: Record<string,string> = {"linkedin.com":"/login", "instagram.com":"/accounts/login/", "facebook.com":"/login", "x.com":"/i/flow/login", "github.com":"/login", "notion.so":"/login", "slack.com":"/signin", "spotify.com":"/login"};
export async function nativeLogin(input:NativeLoginInput, dependencies:{cdp:PrivateCdp; read():NativeLoginState|undefined; save(state:NativeLoginState):void; credentials?(state:NativeLoginState,input:NativeLoginInput):void; verified?(state:NativeLoginState,cookies:unknown[]):Promise<boolean>}):Promise<NativeLoginView> {
  validateNativeInput(input);
  if(["login","renew"].includes(input.action)) throw Error("Use the private vault renewal operation");
  const {cdp}=dependencies; let state = dependencies.read();
  // A verified login awaiting cleanup cannot be replaced by a retried begin.
  if(input.action === "begin" && state?.status === "pending" && state.verifiedSession)
    return nativeLogin({...input,action:"finish"},dependencies);
  if (input.action === "begin") {
    if (state?.status === "pending" && state.connectionId !== input.connectionId) throw Error("Finish or cancel the existing sign-in first");
    state = {connectionId:input.connectionId,domain:input.domain,status:"pending",expiresAt:Date.now()+30*60_000,revision:(state?.revision ?? 0)+1};
    const before = await cdp.send("Target.getTargets", {});
    state.preserveTargetIds = (before.targetInfos ?? []).map((target:any)=>target.targetId);
    dependencies.save(state); // The lock survives a crash before opening the credential page.
    const {targetId}=await cdp.send("Target.createTarget",{url:"about:blank"}); state.targetId=targetId; dependencies.save(state);
    const {sessionId}=await cdp.send("Target.attachToTarget",{targetId,flatten:true});
    await cdp.send("Emulation.setDeviceMetricsOverride",{width:390,height:640,deviceScaleFactor:1,mobile:true},sessionId);
    await cdp.send("Page.navigate",{url:`https://${input.domain}${loginPaths[input.domain] ?? "/"}`},sessionId);
  }
  if (!state && input.action === "status") return {status:"pending",domain:input.domain,expiresAt:Date.now()+600000,revision:1};
  if (!state && ["view","form"].includes(input.action)) return nativeLogin({...input,action:"begin"},dependencies);
  if (!state && input.action === "disconnect") return {status:"disconnected",domain:input.domain,expiresAt:Date.now(),revision:1};
  if (!state || state.connectionId !== input.connectionId || state.domain !== input.domain) throw Error("Private sign-in binding mismatch");
  const closeTarget = async (targetId: string) => {
    try { const closed=await cdp.send("Target.closeTarget", {targetId}); if(closed?.success === false) throw Error("Private sign-in page did not close"); }
    catch(error) {
      // Tabs can disappear between inventory and close (or after an earlier lost reply).
      // Accept only independently confirmed absence; transport failure is not success.
      const targets=await cdp.send("Target.getTargets",{});
      if(!Array.isArray(targets.targetInfos) || targets.targetInfos.some((target:any)=>target.targetId===targetId)) throw error;
    }
  };
  const closeLoginTargets = async () => {
    const targets=await cdp.send("Target.getTargets",{});
    for(const target of targets.targetInfos ?? []) if(target.type === "page" && !state!.preserveTargetIds?.includes(target.targetId)) await closeTarget(target.targetId);
  };
  const summary=():NativeLoginView=>({status:state!.status,domain:state!.domain,expiresAt:state!.expiresAt,revision:state!.revision,...(state!.credentialsSaved !== undefined ? {credentialsSaved:state!.credentialsSaved} : {})});
  if (input.action === "disconnect") {
    // Use a page CDP session for Storage/Network commands, including after the login target closed.
    const cleanup = await cdp.send("Target.createTarget", {url:"about:blank"});
    const {sessionId: cleanupSession} = await cdp.send("Target.attachToTarget", {targetId:cleanup.targetId,flatten:true});
    // All cookies/local storage for this app are removed before allowing agent control again.
    await cdp.send("Storage.clearDataForOrigin",{origin:`https://${state.domain}`,storageTypes:"all"},cleanupSession);
    await cdp.send("Storage.clearDataForOrigin",{origin:`https://www.${state.domain}`,storageTypes:"all"},cleanupSession);
    const cookies=await cdp.send("Storage.getCookies",{});
    for(const cookie of cookies.cookies ?? []) if(cookie.domain.replace(/^\./,"") === state.domain || cookie.domain.endsWith(`.${state.domain}`)) await cdp.send("Network.deleteCookies",{name:cookie.name,domain:cookie.domain,path:cookie.path},cleanupSession);
    if(state.targetId) await closeTarget(state.targetId);
    await closeTarget(cleanup.targetId);
    if (state.status === "pending") await closeLoginTargets();
    state.status="disconnected"; state.expiresAt=Date.now(); state.revision++; delete state.verifiedSession; if (state.credentialsSaved !== undefined) state.credentialsSaved=false; dependencies.save(state); return summary();
  }
  if (input.action === "status" || state.status !== "pending") return summary();
  if (state.expiresAt <= Date.now()) throw Error("Sign-in expired. Cancel and start again");
  const completeVerifiedLogin = async () => {
    const verified = state!.verifiedSession!;
    if(verified.revision !== state!.revision + 1 || verified.expiresAt <= Date.now()) throw Error("Sign-in verification expired");
    if(state!.targetId) await closeTarget(state!.targetId);
    await closeLoginTargets();
    state = {...state!,...verified,status:"connected"};
    delete state.verifiedSession;
    delete state.targetId;
    delete state.preserveTargetIds;
    delete state.approvedOrigins;
    dependencies.save(state);
    return summary();
  };
  if(state.verifiedSession) {
    if(input.action === "finish") return completeVerifiedLogin();
    if(["form","view"].includes(input.action)) return {...summary(),fields:[]};
    throw Error("Sign-in verified; finish closing private pages first");
  }
  let sessionId: string;
  try { ({sessionId}=await cdp.send("Target.attachToTarget",{targetId:state.targetId,flatten:true})); }
  catch (error) {
    // Chromium target IDs do not survive a browser/VM restart. Only an explicit
    // form/view read may recreate the page; credential and interaction requests
    // must fail rather than run against a different document.
    if (["form","view"].includes(input.action)) {
      const targets=await cdp.send("Target.getTargets",{});
      if (Array.isArray(targets.targetInfos) && !targets.targetInfos.some((target:any)=>target.targetId===state!.targetId))
        return nativeLogin({...input,action:"begin"},dependencies);
    }
    throw error;
  }
  const evaluate=async(expression:string)=>(await cdp.send("Runtime.evaluate",{expression,returnByValue:true},sessionId)).result?.value;
  if(input.action==="navigate") {
    const url=publicTarget(input.url!);
    state.approvedOrigins=[...new Set([...(state.approvedOrigins??[]),url.origin])];dependencies.save(state);
    await cdp.send("Page.navigate",{url:url.href},sessionId);
    return {...summary(),fields:[]};
  }
  // Never type into a redirected third-party origin, even if it resembles this app.
  const hostname=await evaluate("location.hostname");
  // Page.navigate acknowledges navigation before the new document is committed.
  // Reading form metadata while it is still about:blank is loading, not a failed login.
  if (!hostname && ["begin", "form", "view"].includes(input.action)) return {...summary(), fields: []};
  const sameApp=hostname === state.domain || hostname === `www.${state.domain}` || String(hostname).endsWith(`.${state.domain}`);
  const currentOrigin=String(await evaluate("location.origin"));
  if(input.action==="allow_origin") {
    if(currentOrigin!==input.url)throw Error("Sign-in page changed; inspect its address again");
    state.approvedOrigins=[...new Set([...(state.approvedOrigins??[]),currentOrigin])];dependencies.save(state);
  }
  if(!sameApp&&!state.approvedOrigins?.includes(currentOrigin)) {
    if(["form","view","begin"].includes(input.action))return {...summary(),fields:[],currentHost:String(hostname),requiresOrigin:currentOrigin};
    throw Error("Sign-in left the selected app");
  }
  // A fixed field vocabulary, never arbitrary site HTML or credential values, reaches the Mini App.
  const fieldsExpression = `(() => {
    const visible = e => e instanceof HTMLInputElement && !e.disabled && !e.readOnly && !!e.getClientRects().length;
    const find = selector => [...document.querySelectorAll(selector)].filter(visible);
    const password = find('input[type="password"]');
    const username = find('input[autocomplete="username"],input[type="email"],input[type="tel"],input[name="username"],input[name="login"],input[name="loginfmt"],input[name="identifier"],input[name="session_key"],input[name="email"],input[id="username"]');
    const code = find('input[autocomplete="one-time-code"],input[name="otp"],input[name="verificationCode"],input[name="pin"]');
    return {username,password,code};
  })()`;
  if (input.action === "credentials") {
    // Reject ambiguous forms and foreign submit destinations before inserting any secret.
    const names = (["username","password","code"] as const).filter(name => !!input[name]);
    const safe = await evaluate(`(() => {const f=${fieldsExpression}; const names=${JSON.stringify(names)};
      return location.protocol === 'https:' && names.every(n => f[n].length === 1 &&
        (!f[n][0].form || new URL(f[n][0].form.action || location.href).origin === location.origin));})()`);
    if (!safe) throw Error("This sign-in step needs a supported, unambiguous form");
    for (const name of names) {
      const focused = await evaluate(`(() => {const f=${fieldsExpression};const e=f[${JSON.stringify(name)}][0];
        if(location.hostname !== ${JSON.stringify(hostname)} || location.protocol !== 'https:' || !e || (e.form && new URL(e.form.action || location.href).origin !== location.origin)) return false;
        e.focus();e.select();return document.activeElement === e;})()`);
      if (!focused) throw Error("Sign-in page changed; try again");
      await cdp.send("Input.insertText",{text:input[name]},sessionId);
    }
    // Submit the selected login form, not an arbitrary button elsewhere on the page.
    const submitted = await evaluate(`(() => {const e=document.activeElement; const f=e?.form;
      if(location.hostname !== ${JSON.stringify(hostname)} || location.protocol !== 'https:' || (f && new URL(f.action || location.href).origin !== location.origin)) return false;
      if(f) {f.requestSubmit();return true;} return 'enter';})()`);
    if (!submitted) throw Error("Sign-in page changed; inspect it before continuing");
    if(submitted==="enter")for(const type of ["keyDown","keyUp"])await cdp.send("Input.dispatchKeyEvent",{type,key:"Enter",code:"Enter",windowsVirtualKeyCode:13},sessionId);
    dependencies.credentials?.(state,input);
    return {...summary(), fields: []};
  }
  if (input.action === "form" || input.action === "begin") {
    const fields = await evaluate(`(() => {const f=${fieldsExpression};return Object.keys(f).filter(n => f[n].length === 1);})()`);
    return {...summary(),currentHost:String(hostname),fields:Array.isArray(fields) ? fields.filter(n => ["username","password","code"].includes(n)) : []};
  }
  if(input.action === "type") {
    const editable=await evaluate("['INPUT','TEXTAREA'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable === true");
    if(!editable) throw Error("Choose a login field first");
    await cdp.send("Input.insertText",{text:input.text},sessionId);
  }
  if(input.action === "click") for(const type of ["mousePressed","mouseReleased"]) await cdp.send("Input.dispatchMouseEvent",{type,x:input.x,y:input.y,button:"left",clickCount:1},sessionId);
  if(input.action === "key") for(const type of ["keyDown","keyUp"]) await cdp.send("Input.dispatchKeyEvent",{type,key:input.key,code:input.key,windowsVirtualKeyCode:({Enter:13,Tab:9,Backspace:8,Escape:27} as Record<string,number>)[input.key!]},sessionId);
  if(input.action === "scroll") await cdp.send("Input.dispatchMouseEvent",{type:"mouseWheel",x:195,y:320,deltaX:0,deltaY:input.delta},sessionId);
  if(input.action === "finish") {
    if (!sameApp) throw Error("Return to the selected app to confirm sign-in");
    // A login button click or arbitrary cookie is not proof of authentication.
    const selector=state.domain === "linkedin.com" ? '.global-nav__me, [data-control-name="nav.settings"]' : state.domain === "x.com" ? '[data-testid="SideNav_AccountSwitcher_Button"]' : 'a[href*="logout"], a[href*="signout"], form[action*="logout"], [data-testid="account-menu"]';
    const authenticated=await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)})) && !document.querySelector('input[type="password"]')`);
    const cookies=await cdp.send("Network.getCookies",{urls:[`https://${hostname}/`]},sessionId);
    if(!authenticated || !(cookies.cookies ?? []).some((c:any)=>c.httpOnly && c.secure && c.value)) throw Error("Signed-in session could not be verified");
    const cookieExpiry=(cookies.cookies as any[]).filter(c=>c.httpOnly && c.secure && c.value && typeof c.expires === "number" && c.expires>0).map(c=>Math.floor(c.expires*1000));
    const verified:NativeLoginState = {...state,status:"connected",expiresAt:Math.min(Date.now()+7*86400_000,...cookieExpiry),revision:state.revision+1};
    if (dependencies.verified) verified.credentialsSaved = await dependencies.verified(verified,cookies.cookies);
    // Persist only verification metadata before cleanup. A retry can close any
    // remaining pages even when the original login target has already gone.
    state.verifiedSession = {expiresAt:verified.expiresAt,revision:verified.revision,...(verified.credentialsSaved !== undefined ? {credentialsSaved:verified.credentialsSaved} : {})};
    dependencies.save(state);
    return completeVerifiedLogin();
  }
  // Mask all login field values in the image. The user's keyboard field also clears after submission.
  await evaluate("document.querySelectorAll('input').forEach(e => { e.style.webkitTextSecurity='disc'; })");
  const capture=await cdp.send("Page.captureScreenshot",{format:"jpeg",quality:65,captureBeyondViewport:true,clip:{x:0,y:0,width:390,height:640,scale:1}},sessionId);
  return {...summary(),currentHost:String(hostname),screenshot:`data:image/jpeg;base64,${capture.data}`,width:390,height:640};
}
