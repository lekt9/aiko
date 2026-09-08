import type { PrivateBrowserAdapter } from "../../../packages/sdk/src/agent.ts";
import { GMAIL_DOMAIN, isGmailDomain } from "../../../packages/protocol/src/google-connection.ts";
import type { LoginAssistanceStatus } from "../../../packages/protocol/src/login-assistance.ts";
import { nativeLogin, validateNativeInput, type NativeLoginInput, type NativeLoginState, type NativeLoginView } from "./native-login.ts";
import { renewNativeLogin, submitNativeLogin } from "./native-login-renewal.ts";
import type { NativeLoginVault } from "./native-login-vault.ts";
import { assistanceView, sameGmailGrant } from "./native-login-assistance-state.ts";
import { nativeCookieScope, nativeLoginResourceHost } from "./native-login-policy.ts";
import { nativeLoginFields } from "./native-login-page.ts";
import { readGmailLoginEmail, emailRequestExpression, privateEmailIdentity, confirmGmailIdentity } from "./native-gmail-page.ts";
import { googleIdentityRequest, googleEntryExpression, googleAccountExpression, googleConsentExpression } from "./native-google-sso.ts";

type Core = Parameters<typeof nativeLogin>[1];
export interface NativeLoginAssistanceDependencies extends Core {
  vault: NativeLoginVault;
  source(id: string): NativeLoginState | undefined;
  cookieAdapter(targetId: string): Promise<PrivateBrowserAdapter>;
  signal?: AbortSignal;
}
/** The single private runtime used by the browser driver and browser journeys.
 * No mailbox value can cross this return boundary. Each effect is fenced before
 * dispatch; read-only observations may resume only an already approved attempt. */
export async function runPrivateLogin(input: NativeLoginInput, deps: NativeLoginAssistanceDependencies): Promise<NativeLoginView> {
  validateNativeInput(input);
  let identityRejected = false;
  const coreDeps: Core = { ...deps, verified: async (verified, cookies, identity) => {
    if (verified.assistance) {
      const pin = verified.assistance;
      let expected = pin.stage !== "ready" ? deps.vault.pendingIdentity({ ...verified, revision: verified.revision - 1 }) : undefined;
      if (!expected) {
        const source = deps.source(pin.source.connectionId);
        if (sameGmailGrant(pin.source, input.gmailGrant) && source?.status === "connected" && source.domain === GMAIL_DOMAIN && source.revision === pin.source.revision && source.expiresAt === pin.source.expiresAt) expected = await deps.vault.identity(source);
      }
      if (!privateEmailIdentity(identity) || !expected || identity.toLowerCase() !== expected) { identityRejected = true; throw Error("The website account could not be matched to Gmail"); }
    }
    return deps.verified ? deps.verified(verified, cookies, identity) : deps.vault.verified(verified, cookies, identity);
  } };
  const core = (action: NativeLoginInput["action"], fields: Partial<NativeLoginInput> = {}) => nativeLogin({ connectionId: input.connectionId, domain: input.domain, action, ...(input.attemptId ? { attemptId: input.attemptId } : {}), ...fields }, coreDeps);
  let state = deps.read();
  if (state?.assistance && state.status === "pending" && input.action === "begin" && input.attemptId === state.attemptId) return runPrivateLogin({ ...input, action: "form" }, deps);
  if (state?.assistance && state.status === "pending" && !["assist", "assist_consent", "form", "finish", "status", "view", "disconnect"].includes(input.action)) throw Error("Close assisted sign-in before entering other credentials");
  if (input.action === "login") return submitNativeLogin(input, deps, deps.vault, deps.signal);
  if (input.action === "renew") return renewNativeLogin(input, deps, deps.vault, deps.signal);
  if (input.action === "assist") {
    if (!state || state.status !== "pending" || state.verifiedSession || state.attemptId !== input.attemptId || !sameGmailGrant(input.gmailGrant, input.gmailGrant) || input.gmailGrant!.connectionId !== input.sourceConnectionId || isGmailDomain(state.domain)) throw Error("Assisted sign-in binding unavailable");
    if (state.assistance) {
      if (state.assistance.id !== input.assistanceId || state.assistance.method !== input.assistMethod || !sameGmailGrant(state.assistance.source, input.gmailGrant)) throw Error("An assisted sign-in is already active");
    } else {
      const startedAt = state.inputDispatched ? state.credentialSubmittedAt : Math.floor(Date.now() / 1000) * 1000;
      if (startedAt === undefined || Date.now() - startedAt > 5 * 60_000) throw Error("Start a fresh sign-in before using Gmail");
      state.assistance = { id: input.assistanceId!, method: input.assistMethod!, source: { ...input.gmailGrant! }, startedAt,
        expiresAt: Math.min(state.expiresAt, input.gmailGrant!.expiresAt, startedAt + 5 * 60_000), stage: "ready", status: "working" };
      deps.save(state);
    }
  }
  const assistance = state?.assistance;
  if (!assistance || state?.status !== "pending" || !["assist", "assist_consent", "form", "finish"].includes(input.action)) {
    if (["assist", "assist_consent"].includes(input.action)) throw Error("Assisted sign-in unavailable");
    if (assistance && state?.status === "pending" && !["disconnect", "status", "view"].includes(input.action)) throw Error("Close assisted sign-in before entering other credentials");
    return core(input.action, input);
  }
  const attemptId = state!.attemptId;
  const check = () => {
    deps.signal?.throwIfAborted();
    const current = deps.read();
    if (!current || current.status !== "pending" || current.attemptId !== attemptId || current.assistance?.id !== assistance.id || current.expiresAt <= Date.now()) throw Error("Assisted sign-in changed");
    const source = deps.source(assistance.source.connectionId);
    if (!sameGmailGrant(assistance.source, input.gmailGrant) || !source || source.domain !== GMAIL_DOMAIN || source.status !== "connected" || source.revision !== assistance.source.revision || source.expiresAt !== assistance.source.expiresAt) throw Error("Gmail source changed");
    return source;
  };
  const update = (status: LoginAssistanceStatus, stage = assistance.stage) => {
    const current = deps.read()!;
    if (current.attemptId !== attemptId || current.assistance?.id !== assistance.id) throw Error("Assisted sign-in changed");
    assistance.status = status; assistance.stage = stage;
    current.assistance = { ...assistance }; deps.save(current);
  };
  const summary = async (): Promise<NativeLoginView> => ({ ...await core("status"), assistance: assistanceView(assistance) });
  // A Google popup may close itself after updating its original app tab.
  if (assistance.openerTargetId) {
    const inventory = await deps.cdp.send("Target.getTargets", {});
    if (Array.isArray(inventory.targetInfos) && !inventory.targetInfos.some((t: any) => t.targetId === deps.read()!.targetId) && inventory.targetInfos.some((t: any) => t.targetId === assistance.openerTargetId)) {
      const current = deps.read()!; current.targetId = assistance.openerTargetId; deps.save(current);
    }
  }
  // Settlement of an already-dispatched target login does not reuse Gmail.
  try { const verified = await core("finish"); if (verified.status === "connected") return verified; } catch { deps.signal?.throwIfAborted(); }
  if (identityRejected) { update("unsupported"); return summary(); }
  if (Date.now() >= assistance.expiresAt) { update("expired"); return summary(); }
  if (["source_unavailable", "unsupported", "ambiguous", "expired", "uncertain"].includes(assistance.status)) return summary();
  if (["requesting", "choosing", "consenting", "consuming"].includes(assistance.stage)) { update("uncertain"); return summary(); }
  if (assistance.stage === "submitted") return summary();
  if (input.action === "assist_consent" && (input.attemptId !== attemptId || input.assistanceId !== assistance.id || assistance.stage !== "consent")) throw Error("Stale Google consent");
  let source: NativeLoginState;
  try { source = check(); } catch { update("source_unavailable"); return summary(); }
  if (assistance.stage === "consent" && input.action !== "assist_consent") return summary();
  let identity: string | undefined;
  try { identity = await deps.vault.identity(source); } catch { /* Fail closed on lost or uncertain vault custody. */ }
  if (!identity) { update("source_unavailable"); return summary(); }
  const cdp = deps.cdp;
  let temporaryTarget: string | undefined;
  try {
    check();
    if (!await deps.vault.restore(source, cdp)) throw Error("Gmail session unavailable");
    check();
    if (!deps.read()!.inputDispatched || assistance.method === "google") deps.vault.stage(deps.read()!, { connectionId: input.connectionId, domain: input.domain, action: "credentials", username: identity });
    const temp = await cdp.send("Target.createTarget", { url: "about:blank" }); temporaryTarget = temp.targetId;
    const { sessionId: mailboxSession } = await cdp.send("Target.attachToTarget", { targetId: temporaryTarget, flatten: true });
    const bridge = await deps.vault.bridge(source, await deps.cookieAdapter(temporaryTarget!), "native-login-assistance", nativeCookieScope(GMAIL_DOMAIN).domains, () => deps.source(source.connectionId));
    await bridge.run(async () => {
      check();
      if (assistance.method === "google" && assistance.stage === "ready" && !await confirmGmailIdentity(cdp, mailboxSession, identity!, deps.signal)) { update("source_unavailable"); return; }
      check();
      const target = deps.read()!.targetId;
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target, flatten: true });
      const evaluate = async (expression: string) => {
        check();
        const response = await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
        if (response.exceptionDetails) throw Error("Private sign-in inspection failed");
        return response.result?.value;
      };
      const href = await evaluate("location.href");
      const url = new URL(href);
      const sameApp = url.protocol === "https:" && nativeLoginResourceHost(input.domain, url.hostname);
      if (url.href === "about:blank") return;
      if (assistance.stage === "ready") {
        if (!sameApp) { update("unsupported"); return; }
        if (assistance.method === "google") {
          const count = await evaluate(googleEntryExpression(url.origin, false));
          if (count !== 1) { update(count > 1 ? "ambiguous" : "unsupported"); return; }
          check(); update("working", "requesting");
          const current = deps.read()!; current.inputDispatched = true; deps.save(current);
          if (await evaluate(googleEntryExpression(url.origin, true)) !== 1) throw Error("Google sign-in entry changed");
          update("working", "google");
        } else {
          const form = await core("form");
          if (form.fields?.includes("code") && assistance.method === "email_code" && deps.vault.pendingIdentity(deps.read()!) === identity) { update("waiting_email", "email"); return; }
          if (deps.read()!.inputDispatched || !form.fields?.includes("username") || form.fields.some(field => field !== "username")) { update("unsupported"); return; }
          check(); update("working", "requesting");
          await core("credentials", { username: identity });
          update("waiting_email", "email");
        }
        return;
      }
      if (assistance.method === "google") {
        // Popups must be a unique child of this exact private sign-in target.
        if (sameApp) {
          const inventory = await cdp.send("Target.getTargets", {});
          const popups = (inventory.targetInfos ?? []).filter((t: any) => t.type === "page" && t.openerId === target && typeof t.url === "string" && t.url.startsWith("https://accounts.google.com/"));
          if (popups.length === 1) { const current = deps.read()!; assistance.openerTargetId = target; current.assistance = { ...assistance }; current.targetId = popups[0].targetId; deps.save(current); }
          else if (popups.length > 1) update("ambiguous");
          return;
        }
        if (!googleIdentityRequest(href, input.domain)) { update("unsupported"); return; }
        if (assistance.stage === "consent") {
          if (input.action !== "assist_consent") return;
          check(); update("working", "consenting");
          if (!await evaluate(googleConsentExpression(assistance.consentId!, true))) throw Error("Google consent changed");
          update("verifying", "submitted"); return;
        }
        const accounts = await evaluate(googleAccountExpression(identity!, false, href));
        if (accounts > 1) { update("ambiguous"); return; }
        if (accounts === 1) {
          if (assistance.accountChosen) return;
          assistance.accountChosen = true;
          check(); update("working", "choosing");
          if (await evaluate(googleAccountExpression(identity!, true, href)) !== 1) throw Error("Google account changed");
          update("working", "google"); return;
        }
        assistance.consentId = crypto.randomUUID();
        if (await evaluate(googleConsentExpression(assistance.consentId, false))) update("approval_required", "consent");
        else update("unsupported");
        return;
      }
      if (!sameApp) { update("unsupported"); return; }
      const form = await core("form");
      if (form.requiresOrigin || form.pageError || (assistance.method === "email_code" ? !form.fields?.includes("code") || !form.challenge : !await evaluate("/check (?:your )?(?:email|inbox)|sign[ -]?in link.*sent/i.test(document.body.innerText) && !document.querySelector('input[type=password]')"))) { update("unsupported"); return; }
      const request = await evaluate(emailRequestExpression);
      if (!request) { update("unsupported"); return; }
      const nonce = crypto.randomUUID();
      await evaluate(`window.__unlockEmailAttempt=${JSON.stringify(nonce)};window.__unlockCodeField=(${nativeLoginFields}).code[0];true`);
      const message = await readGmailLoginEmail(cdp, mailboxSession, { identity: identity!, domain: input.domain, after: assistance.startedAt, method: assistance.method, request }, deps.signal);
      check();
      if (message.status !== "found") { update(message.status); return; }
      if (!await evaluate(`location.origin===${JSON.stringify(url.origin)} && JSON.stringify(${emailRequestExpression})===${JSON.stringify(JSON.stringify(request))} && window.__unlockEmailAttempt===${JSON.stringify(nonce)} && ${assistance.method === "email_code" ? `window.__unlockCodeField===(${nativeLoginFields}).code[0]` : "true"}`)) { update("unsupported"); return; }
      update("verifying", "consuming"); // No code, URL, or hash of either in custody.
      if (assistance.method === "email_code") {
        await core("credentials", { code: message.value, attemptId, challengeId: form.challenge!.id, expectedRevision: form.challenge!.revision, submissionId: assistance.id });
      } else {
        check();
        const navigation = await cdp.send("Page.navigate", { url: message.value }, sessionId);
        if (navigation.errorText) throw Error("Sign-in link navigation uncertain");
      }
      message.value = "";
      update("verifying", "submitted");
    });
    if (!bridge.status().ready) update("source_unavailable");
  } catch {
    // A private transport error contains no safe provider/body text to return.
    update(["requesting", "choosing", "consenting", "consuming"].includes(assistance.stage) ? "uncertain" : "source_unavailable");
  } finally {
    if (temporaryTarget) {
      try { const closed = await cdp.send("Target.closeTarget", { targetId: temporaryTarget }); if (closed?.success === false) throw Error("Private cleanup unconfirmed"); }
      catch {
        const inventory = await cdp.send("Target.getTargets", {});
        if (!Array.isArray(inventory.targetInfos) || inventory.targetInfos.some((t: any) => t.targetId === temporaryTarget)) throw Error("Private mailbox cleanup unconfirmed");
      }
    }
  }
  return summary();
}
