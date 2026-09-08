import {nativeLoginObservation,loginUuid,type NativeLoginAttemptState} from "./native-login-observation.ts";
/** Private browser control. Only the authenticated owner API can call this, never an actor tool. */
import { publicTarget } from "./browser-proxy.ts";
import { nativeLoginFields, nativeLoginLink, nativeLoginFormSafe, nativeLoginSubmit } from "./native-login-page.ts";
import { gmailIdentityExpression, authenticatedIdentityExpression } from "./native-gmail-page.ts";
import { isGmailDomain } from "../../../packages/protocol/src/google-connection.ts";
import { loginAssistanceMethods, type GmailLoginGrant, type LoginAssistanceMethod, type LoginAssistanceView } from "../../../packages/protocol/src/login-assistance.ts";
import { assistanceView, type NativeLoginAssistanceState } from "./native-login-assistance-state.ts";
import { nativeLoginStartUrl, nativeLoginResourceHost, nativeLoginProviderHost, nativeCookieScope, nativeCookieDomainAllowed, nativeLoginScopesOverlap, nativeLoginAuthenticatedSelector } from "./native-login-policy.ts";
export type NativeLoginInput = { attemptId?: string; challengeId?: string; submissionId?: string; expectedRevision?: number; connectionId: string; domain: string; action: "assist" | "assist_consent" | "login" | "renew" | "begin" | "status" | "form" | "credentials" | "view" | "click" | "type" | "key" | "scroll" | "finish" | "disconnect" | "navigate" | "allow_origin"; sourceConnectionId?: string; assistanceId?: string; assistMethod?: LoginAssistanceMethod; gmailGrant?: GmailLoginGrant; url?: string; credentialReference?: { managerId: string; reference: string }; username?: string; password?: string; code?: string; x?: number; y?: number; text?: string; key?: string; delta?: number };
export type NativeLoginState = NativeLoginAttemptState & { assistance?: NativeLoginAssistanceState; connectionId: string; domain: string; targetId?: string; preserveTargetIds?: string[]; approvedOrigins?: string[]; navigationRecovered?: boolean; inputDispatched?: boolean; credentialSubmittedAt?: number; discoveredLoginUrls?: string[]; status: "pending" | "connected" | "disconnected"; expiresAt: number; revision: number; credentialsSaved?: boolean; expired?: boolean; verifiedSession?: { expiresAt: number; revision: number; credentialsSaved?: boolean } };
export type NativeLoginView = Pick<NativeLoginAttemptState,"attemptId"|"challenge"|"submission"|"loginReceipts"> & { assistance?: LoginAssistanceView; status: NativeLoginState["status"]; domain: string; currentHost?: string; requiresOrigin?: string; pageError?: "navigation_failed" | "navigation_uncertain"; fields?: string[]; screenshot?: string; width?: number; height?: number; expiresAt: number; revision: number; credentialsSaved?: boolean };
export type PrivateCdp = {send(method:string,params:object,sessionId?:string):Promise<any>;close():void};
/** Expired private pages must be cleaned, not merely ignored: they still hold login state. */
export async function prepareNativeLogin(input: NativeLoginInput, states: NativeLoginState[], run: (input: NativeLoginInput, reason?: "expired") => Promise<NativeLoginView | void>, now = Date.now()) {
  // Explicit cancellation must reach revocation even if verified-page cleanup
  // failed earlier. Cleanup of unrelated expired forms can wait for inspection.
  if (input.action === "disconnect") return;
  if (input.action !== "status" && states.some(state => state.status === "connected" && state.connectionId !== input.connectionId &&
      nativeLoginScopesOverlap(state.domain, input.domain)))
    throw Error("This app overlaps an existing connection. Disconnect that connection before signing in again");
  if (input.action !== "status" && states.some(state => state.status === "pending" && state.connectionId !== input.connectionId && (state.verifiedSession?.expiresAt ?? state.expiresAt) > now))
    throw Error("Finish the existing private sign-in first");
  let recovered: NativeLoginView | undefined;
  for (const state of states) if (state.status === "pending" && (state.expiresAt <= now || (state.verifiedSession?.expiresAt ?? Infinity) <= now)) {
    // A verified session has its own deadline; finish closing its pages without
    // revoking custody merely because the original form deadline elapsed.
    if (state.verifiedSession && state.verifiedSession.expiresAt > now) {
      const view = await run({connectionId: state.connectionId, domain: state.domain, action: "finish"});
      if (state.connectionId === input.connectionId && state.domain === input.domain && view) recovered = view;
    } else
      await run({connectionId: state.connectionId, domain: state.domain, action: "disconnect"}, "expired");
  }
  return recovered;
}
export function validateNativeInput(input: NativeLoginInput) {
  if (!input || !/^[a-f0-9-]{36}$/.test(input.connectionId) || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(input.domain) || !["assist","assist_consent","login","renew","begin","status","form","credentials","view","click","type","key","scroll","finish","disconnect","navigate","allow_origin"].includes(input.action)) throw Error("Invalid private sign-in request");
  if (["navigate","allow_origin"].includes(input.action)) {
    const url=publicTarget(input.url??"");
    if(url.protocol!=="https:"||url.href.length>2048||url.username||url.password)throw Error("Use a public HTTPS sign-in address");
    if(input.action==="allow_origin"&&url.origin!==input.url)throw Error("Expected sign-in origin");
  }
  for (const value of [input.attemptId,input.challengeId,input.submissionId]) if (value !== undefined && !loginUuid(value)) throw Error("Invalid login identity");
  if(input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1)) throw Error("Invalid login revision");
  if (["assist", "assist_consent"].includes(input.action) && (!loginUuid(input.attemptId) || !loginUuid(input.assistanceId) || (input.action === "assist" && (!loginUuid(input.sourceConnectionId) || !loginAssistanceMethods.includes(input.assistMethod!))))) throw Error("Invalid assisted sign-in binding");
  if (input.action === "credentials") {
    if (![input.username,input.password,input.code].some(value => typeof value === "string" && value.length > 0)) throw Error("Credentials required");
    for (const value of [input.username,input.password,input.code]) if (value !== undefined && (typeof value !== "string" || value.length > 2048)) throw Error("Invalid credentials");
  }
  if (input.action === "type" && (typeof input.text !== "string" || !input.text || input.text.length > 2048)) throw Error("Invalid sign-in text");
  if (input.action === "click" && (!Number.isFinite(input.x) || !Number.isFinite(input.y) || input.x! < 0 || input.x! > 390 || input.y! < 0 || input.y! > 640)) throw Error("Invalid sign-in coordinates");
  if (input.action === "key" && !["Enter","Tab","Backspace","Escape"].includes(input.key ?? "")) throw Error("Invalid sign-in key");
  if (input.action === "scroll" && (!Number.isFinite(input.delta) || Math.abs(input.delta!) > 640)) throw Error("Invalid sign-in scroll");
}
export async function nativeLogin(input:NativeLoginInput, dependencies:{reopenMissingTarget?:boolean; cdp:PrivateCdp; read():NativeLoginState|undefined; save(state:NativeLoginState):void; credentials?(state:NativeLoginState,input:NativeLoginInput):void; verified?(state:NativeLoginState,cookies:unknown[],identity?:string):Promise<boolean>}):Promise<NativeLoginView> {
  validateNativeInput(input);
  if(["assist","assist_consent","login","renew"].includes(input.action)) throw Error("Use the private vault sign-in operation");
  const {cdp}=dependencies; let state = dependencies.read();
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
  if (state && (state.connectionId !== input.connectionId || state.domain !== input.domain)) throw Error("Private sign-in binding mismatch");
  if (input.attemptId && state?.attemptId && input.attemptId !== state.attemptId && input.action !== "begin") throw Error("Stale login attempt");
  if(input.action === "begin" && input.attemptId && state?.attemptId === input.attemptId && (state.targetId || state.status!=="pending" || state.verifiedSession)) return nativeLogin({...input,action:"form"},dependencies);
  if (state?.status === "disconnected" && state.expired && ["form","view"].includes(input.action) && dependencies.reopenMissingTarget !== false)
    return nativeLogin({...input,action:"begin"},dependencies);
  // A verified login awaiting cleanup cannot be replaced by a retried begin.
  if(input.action === "begin" && state?.status === "pending" && state.verifiedSession)
    return nativeLogin({...input,action:"finish"},dependencies);
  if (input.action === "begin") {
    if (state?.status === "pending" && state.connectionId !== input.connectionId) throw Error("Finish or cancel the existing sign-in first");
    if(state?.status==="pending" && input.attemptId && input.attemptId!==state.attemptId) {
      // Replacing an attempt must close its private targets before the new
      // attempt inventories preserved tabs. Failed cleanup leaves the old lock.
      await nativeLogin({connectionId:state.connectionId,domain:state.domain,attemptId:state.attemptId,action:"disconnect"},dependencies);
      state=dependencies.read();
    }
    if(state?.status==="pending" && !state.targetId && state.preserveTargetIds)
      await closeLoginTargets(); // Recover an opening crash before target identity was saved.
    const history=input.attemptId&&state?.attemptId===input.attemptId?{loginSequence:state.loginSequence,loginReceipts:state.loginReceipts}:{};
    state = {...history,attemptId:input.attemptId ?? crypto.randomUUID(),connectionId:input.connectionId,domain:input.domain,status:"pending",expiresAt:Date.now()+30*60_000,revision:(state?.revision ?? 0)+1};
    const before = await cdp.send("Target.getTargets", {});
    state.preserveTargetIds = (before.targetInfos ?? []).map((target:any)=>target.targetId);
    nativeLoginObservation(state,"opening");
    dependencies.save(state); // The lock survives a crash before opening the credential page.
    const {targetId}=await cdp.send("Target.createTarget",{url:"about:blank"}); state.targetId=targetId; dependencies.save(state);
    const {sessionId}=await cdp.send("Target.attachToTarget",{targetId,flatten:true});
    await cdp.send("Emulation.setDeviceMetricsOverride",{width:390,height:640,deviceScaleFactor:1,mobile:true},sessionId);
    await cdp.send("Page.navigate",{url:nativeLoginStartUrl(input.domain)},sessionId);
  }
  if (!state && input.action === "status") return {status:"pending",domain:input.domain,expiresAt:Date.now()+600000,revision:1};
  if (!state && ["view","form"].includes(input.action)) return nativeLogin({...input,action:"begin"},dependencies);
  if (!state && input.action === "disconnect") return {status:"disconnected",domain:input.domain,expiresAt:Date.now(),revision:1};
  if (!state || state.connectionId !== input.connectionId || state.domain !== input.domain) throw Error("Private sign-in binding mismatch");
  // Expired pages are already revoked, but the connector stays pending until
  // the owner inspects a fresh form. A status poll must not revoke that intent.
  const summary=():NativeLoginView=>({assistance:assistanceView(state!.assistance),status:state!.status === "disconnected" && state!.expired && input.action === "status" ? "pending" : state!.status,domain:state!.domain,expiresAt:state!.expiresAt,revision:state!.revision,...(state!.attemptId ? {attemptId:state!.attemptId,challenge:state!.challenge,submission:state!.submission,loginReceipts:state!.loginReceipts} : {}),...(state!.credentialsSaved !== undefined ? {credentialsSaved:state!.credentialsSaved} : {})});
  if (input.action === "disconnect") {
    // Use a page CDP session for Storage/Network commands, including after the login target closed.
    const cleanup = await cdp.send("Target.createTarget", {url:"about:blank"});
    const {sessionId: cleanupSession} = await cdp.send("Target.attachToTarget", {targetId:cleanup.targetId,flatten:true});
    // All cookies/local storage for this app are removed before allowing agent control again.
    const scope = nativeCookieScope(state.domain);
    for (const host of [...scope.domains, ...(scope.includeSubdomains ? [`www.${state.domain}`] : [])])
      await cdp.send("Storage.clearDataForOrigin",{origin:`https://${host}`,storageTypes:"all"},cleanupSession);
    const cookies=await cdp.send("Storage.getCookies",{});
    for(const cookie of cookies.cookies ?? []) if(nativeCookieDomainAllowed(state.domain,cookie.domain)) await cdp.send("Network.deleteCookies",{name:cookie.name,domain:cookie.domain,path:cookie.path,...(cookie.partitionKey ? {partitionKey:cookie.partitionKey} : {})},cleanupSession);
    if(state.targetId) await closeTarget(state.targetId);
    await closeTarget(cleanup.targetId);
    if (state.status === "pending") await closeLoginTargets();
    state.status="disconnected"; delete state.expired; state.expiresAt=Date.now(); state.revision++; delete state.verifiedSession; if (state.credentialsSaved !== undefined) state.credentialsSaved=false; nativeLoginObservation(state,"disconnected"); dependencies.save(state); return summary();
  }
  if (input.action === "status" || state.status !== "pending") return summary();
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
    nativeLoginObservation(state,"verified");
    dependencies.save(state);
    return summary();
  };
  if(state.verifiedSession) {
    if(input.action === "finish") return completeVerifiedLogin();
    if(["form","view"].includes(input.action)) return {...summary(),fields:[]};
    throw Error("Sign-in verified; finish closing private pages first");
  }
  if (state.expiresAt <= Date.now()) throw Error("Sign-in expired. Cancel and start again");
  if(input.action === "credentials" && input.code) {
    if(!state.attemptId)throw Error("Inspect the current login challenge before submitting a code");
    if(input.attemptId !== state.attemptId || !state.challenge || input.challengeId !== state.challenge.id || input.expectedRevision !== state.challenge.revision || !input.submissionId || state.challenge.expiresAt <= Date.now()) throw Error("Stale or unbound login challenge");
    if(state.loginReceipts?.some(receipt=>receipt.submissionId===input.submissionId&&receipt.challengeId!==input.challengeId))throw Error("Submission identity belongs to another challenge");
    if(state.submission?.challengeId === state.challenge.id) {
      if(state.submission.id !== input.submissionId) throw Error("Challenge submission already dispatched; inspect before retrying");
      return {...summary(),fields:[]};
    }
  }
  let sessionId: string;
  try { ({sessionId}=await cdp.send("Target.attachToTarget",{targetId:state.targetId,flatten:true})); }
  catch (error) {
    // Chromium target IDs do not survive a browser/VM restart. Only an explicit
    // form/view read may recreate the page; credential and interaction requests
    // must fail rather than run against a different document.
    if (["form","view"].includes(input.action) && !state.inputDispatched && dependencies.reopenMissingTarget !== false) {
      const targets=await cdp.send("Target.getTargets",{});
      if (Array.isArray(targets.targetInfos) && !targets.targetInfos.some((target:any)=>target.targetId===state!.targetId)) {
        await closeLoginTargets();
        delete state.targetId;delete state.challenge;delete state.submission;delete state.approvedOrigins;
        dependencies.save(state);
        return nativeLogin({...input,action:"begin"},dependencies);
      }
    }
    throw error;
  }
  const evaluate=async(expression:string)=>{
    const response=await cdp.send("Runtime.evaluate",{expression,returnByValue:true},sessionId);
    if(response.exceptionDetails)throw Error("The sign-in page changed during inspection. Check its status to continue.");
    return response.result?.value;
  };
  if(input.action==="navigate") {
    const url=publicTarget(input.url!);
    delete state.navigationRecovered;delete state.discoveredLoginUrls;
    state.approvedOrigins=[...new Set([...(state.approvedOrigins??[]),url.origin])];dependencies.save(state);
    const navigation=await cdp.send("Page.navigate",{url:url.href},sessionId);
    return {...summary(),fields:[],...(navigation.errorText ? {pageError:"navigation_failed" as const} : {})};
  }
  // Never type into a redirected third-party origin, even if it resembles this app.
  const hostname=await evaluate("location.hostname");
  // Page.navigate acknowledges navigation before the new document is committed.
  // Reading form metadata while it is still about:blank is loading, not a failed login.
  if (!hostname && ["begin", "form", "view"].includes(input.action)) return {...summary(), fields: []};
  const sameApp=nativeLoginResourceHost(state.domain,String(hostname));
  const currentOrigin=String(await evaluate("location.origin"));
  // Opaque/internal documents (including Chromium network-error pages) are not
  // identity providers. Validate the actual origin before displaying or trusting it.
  let pageOrigin: URL | undefined;
  try { pageOrigin=publicTarget(currentOrigin); } catch {}
  if(pageOrigin?.protocol === "https:" && pageOrigin.hostname!==hostname) {
    if(["begin","form","view"].includes(input.action))return {...summary(),fields:[]};
    throw Error("Sign-in page changed; inspect its address again");
  }
  if(!pageOrigin || pageOrigin.protocol!=="https:") {
    if(!["form","view","begin"].includes(input.action))throw Error("The sign-in website could not be loaded. Check its status before continuing.");
    // Retry only a fresh GET, once per attempt. Never reload a document after
    // input was dispatched: the website may already have processed that input.
    if(!state.inputDispatched && !state.navigationRecovered) {
      state.navigationRecovered=true;dependencies.save(state);
      const navigation=await cdp.send("Page.navigate",{url:nativeLoginStartUrl(state.domain)},sessionId);
      return {...summary(),fields:[],...(navigation.errorText ? {pageError:"navigation_failed" as const} : {})};
    }
    return {...summary(),fields:[],pageError:state.inputDispatched ? "navigation_uncertain" : "navigation_failed"};
  }
  if(input.action==="allow_origin") {
    if(currentOrigin!==input.url)throw Error("Sign-in page changed; inspect its address again");
    state.approvedOrigins=[...new Set([...(state.approvedOrigins??[]),currentOrigin])];dependencies.save(state);
  }
  if(!sameApp&&!nativeLoginProviderHost(state.domain,String(hostname))&&!state.approvedOrigins?.includes(currentOrigin)) {
    if(["form","view","begin"].includes(input.action))return {...summary(),fields:[],currentHost:String(hostname),requiresOrigin:currentOrigin};
    throw Error("Sign-in left the selected app");
  }
  // A fixed field vocabulary, never arbitrary site HTML or credential values, reaches the Mini App.
  const fieldsExpression = nativeLoginFields;
  if (input.action === "credentials") {
    // Reject ambiguous forms and foreign submit destinations before inserting any secret.
    const names = (["username","password","code"] as const).filter(name => !!input[name]);
    const safe = await evaluate(`(() => {const f=${fieldsExpression}; const names=${JSON.stringify(names)};
      const safeForm=${nativeLoginFormSafe};
      return location.protocol === 'https:' && names.every(n => f[n].length === 1 && safeForm(f[n][0]));})()`);
    if (!safe) throw Error("This sign-in step needs a supported, unambiguous form");
    state.inputDispatched=true;
    if (input.username) state.credentialSubmittedAt = Math.floor(Date.now() / 1000) * 1000;
    dependencies.save(state);
    if(input.code && state.attemptId) {
      state.submission={id:input.submissionId!,challengeId:state.challenge!.id,revision:state.challenge!.revision,status:"dispatched"};
      nativeLoginObservation(state,"submission_dispatched"); dependencies.save(state);
    }
    for (const name of names) {
      const focused = await evaluate(`(() => {const f=${fieldsExpression};const e=f[${JSON.stringify(name)}][0];
        const safeForm=${nativeLoginFormSafe};
        if(location.origin !== ${JSON.stringify(currentOrigin)} || location.protocol !== 'https:' || !e || !safeForm(e)) return false;
        e.focus();e.select();return document.activeElement === e;})()`);
      if (!focused) throw Error("Sign-in page changed; try again");
      await cdp.send("Input.insertText",{text:input[name]},sessionId);
    }
    // Submit the selected login form, not an arbitrary button elsewhere on the page.
    const submitted = await evaluate(nativeLoginSubmit(currentOrigin));
    if (!submitted) throw Error("Sign-in page changed; inspect it before continuing");
    if(submitted==="enter")for(const type of ["keyDown","keyUp"])await cdp.send("Input.dispatchKeyEvent",{type,key:"Enter",code:"Enter",windowsVirtualKeyCode:13},sessionId);
    dependencies.credentials?.(state,input);
    if(input.code && state.submission) {state.submission.status="acknowledged";nativeLoginObservation(state,"submission_acknowledged");dependencies.save(state);}
    return {...summary(), fields: []};
  }
  if (input.action === "form" || input.action === "begin") {
    const fields = await evaluate(`(() => {const f=${fieldsExpression};return Object.keys(f).filter(n => f[n].length === 1);})()`);
    if(Array.isArray(fields) && !fields.length && !state.inputDispatched && (state.discoveredLoginUrls?.length ?? 0)<3) {
      const link=await evaluate(nativeLoginLink);
      let destination: URL | undefined;
      try { if(typeof link === "string")destination=publicTarget(link); } catch {}
      if(destination?.protocol === "https:" && destination.href.length<=2048 &&
        nativeLoginResourceHost(state.domain,destination.hostname) &&
        !state.discoveredLoginUrls?.includes(destination.href)) {
        state.discoveredLoginUrls=[...(state.discoveredLoginUrls??[]),destination.href];dependencies.save(state);
        const navigation=await cdp.send("Page.navigate",{url:destination.href},sessionId);
        return {...summary(),fields:[],...(navigation.errorText ? {pageError:"navigation_failed" as const} : {})};
      }
    }
    if(Array.isArray(fields) && fields.includes("code") && (!state.challenge || state.submission)) {
      if((state.challenge?.revision??0)>=16)throw Error("Login challenge retry limit reached; start a fresh attempt");
      state.attemptId ??= crypto.randomUUID();
      state.challenge={id:crypto.randomUUID(),revision:(state.challenge?.revision??0)+1,expiresAt:Math.min(state.expiresAt,Date.now()+5*60_000)};
      delete state.submission;nativeLoginObservation(state,"challenge");dependencies.save(state);
    }
    return {...summary(),currentHost:String(hostname),fields:Array.isArray(fields) ? fields.filter(n => ["username","password","code"].includes(n)) : []};
  }
  if(["type","click","key"].includes(input.action)) {state.inputDispatched=true;dependencies.save(state);}
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
    const selector=nativeLoginAuthenticatedSelector(state.domain);
    const authenticated=await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)})) && !document.querySelector('input[type="password"]')`);
    const cookieHosts = [...new Set([hostname, ...nativeCookieScope(state.domain).domains])];
    const cookies=await cdp.send("Network.getCookies",{urls:cookieHosts.map(host => `https://${host}/`)},sessionId);
    if(!authenticated || !(cookies.cookies ?? []).some((c:any)=>c.httpOnly && c.secure && c.value)) throw Error("Signed-in session could not be verified");
    const cookieExpiry=(cookies.cookies as any[]).filter(c=>c.httpOnly && c.secure && c.value && typeof c.expires === "number" && c.expires>0).map(c=>Math.floor(c.expires*1000));
    const verified:NativeLoginState = {...state,status:"connected",expiresAt:Math.min(Date.now()+7*86400_000,...cookieExpiry),revision:state.revision+1};
    const identity = isGmailDomain(state.domain) ? await evaluate(gmailIdentityExpression) : state.assistance ? await evaluate(authenticatedIdentityExpression) : undefined;
    if (dependencies.verified) verified.credentialsSaved = await dependencies.verified(verified,cookies.cookies,typeof identity === "string" ? identity : undefined);
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
