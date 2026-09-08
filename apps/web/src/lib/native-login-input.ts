/** Private panel metadata only; credential values are never stored in this model. */
export interface NativeLoginPanelView {
  status:string;
  domain:string;
  fields?:string[];
  currentHost?:string;
  requiresOrigin?:string;
  attemptId?:string;
  challenge?:{id:string;revision:number;expiresAt:number};
  submission?:{id:string;challengeId:string;revision:number;status:"dispatched"|"acknowledged"};
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
