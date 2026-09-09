import type { LoginAssistanceView } from "../../../../packages/protocol/src/login-assistance";
/** Private panel metadata only; credential values are never stored in this model. */
export interface NativeLoginPanelView {
  assistance?:LoginAssistanceView;
  status:string;
  domain:string;
  expiresAt?:number;
  fields?:string[];
  /** Detected choices only; source and consent checks still authorize assistance. */
  providers?:("google")[];
  /** Untrusted generated layout; the registry boundary validates it against fields. */
  layout?:unknown;
  currentHost?:string;
  requiresOrigin?:string;
  pageError?:"navigation_failed"|"navigation_uncertain";
  attemptId?:string;
  challenge?:{id:string;revision:number;expiresAt:number};
  submission?:{id:string;challengeId:string;revision:number;status:"dispatched"|"acknowledged"};
}
/** Older browser runners may mistake an opaque error document for a provider. */
export function nativeLoginPageError(view:NativeLoginPanelView|undefined):string|undefined {
  if(view?.requiresOrigin) {
    try {
      const url=new URL(view.requiresOrigin);
      if(url.protocol!=="https:" || url.origin!==view.requiresOrigin || url.username || url.password || url.port || !url.hostname.includes(".") || url.hostname!==view.currentHost) throw Error();
    } catch { return "The sign-in website could not be loaded. Reload sign-in to try again."; }
  }
  if(view?.pageError==="navigation_uncertain")return "The website stopped responding after your sign-in was sent. Check its status before submitting again.";
  if(view?.pageError)return "The sign-in website could not be loaded. Reload sign-in to try again.";
}
const uuid=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export class NativeLoginChallengeError extends Error {}
/** Bind a user-entered OTP to the displayed challenge, never silently to a newer form. */
export function nativeOtpSubmission(displayed:NativeLoginPanelView|undefined,current:NativeLoginPanelView,now=Date.now(),submissionId=crypto.randomUUID()) {
  const challenge=displayed?.challenge;
  if(!uuid(displayed?.attemptId)||!challenge||!uuid(challenge.id)||!Number.isSafeInteger(challenge.revision)||challenge.revision<1||!Number.isSafeInteger(challenge.expiresAt)||challenge.expiresAt<=now||
    displayed?.status!=="pending"||!displayed.fields?.includes("code")||current.domain!==displayed.domain||current.status!=="pending"||current.requiresOrigin||!current.fields?.includes("code")||current.attemptId!==displayed.attemptId||current.challenge?.id!==challenge.id||current.challenge.revision!==challenge.revision||current.challenge.expiresAt!==challenge.expiresAt)
    throw new NativeLoginChallengeError("The verification step changed or expired. Enter a new code for the current sign-in step.");
  if(current.submission?.challengeId===challenge.id)
    throw new NativeLoginChallengeError("That verification step was already submitted. Check sign-in status before entering another code.");
  if(!uuid(submissionId))throw new NativeLoginChallengeError("Could not prepare verification. Check sign-in status and try again.");
  return {attemptId:displayed.attemptId,challengeId:challenge.id,expectedRevision:challenge.revision,submissionId};
}
