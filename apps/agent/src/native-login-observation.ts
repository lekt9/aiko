import type {Event} from "tardie/core/event";
/** Private state metadata only. No DOM, URLs, credential values, or secret hashes. */
export interface NativeLoginObservation {
  type: "AikoPrivateLoginObserved";
  id: string;
  connectionId: string;
  attemptId: string;
  sequence: number;
  revision: number;
  kind: "opening" | "challenge" | "submission_dispatched" | "submission_acknowledged" | "verified" | "disconnected";
  at: number;
  expiresAt: number;
  challengeId?: string;
  challengeRevision?: number;
  submissionId?: string;
}
export interface NativeLoginAttemptState {
  attemptId?: string;
  loginSequence?: number;
  loginReceipts?: NativeLoginObservation[];
  challenge?: {id:string;revision:number;expiresAt:number};
  submission?: {id:string;challengeId:string;revision:number;status:"dispatched"|"acknowledged"};
}
export const loginUuid = (value:unknown):value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function nativeLoginObservation(state: NativeLoginAttemptState & {connectionId:string;revision:number;expiresAt:number}, kind:NativeLoginObservation["kind"]):NativeLoginObservation|undefined {
  if(!state.attemptId)return;
  state.loginSequence=(state.loginSequence??0)+1;
  const observation:NativeLoginObservation={type:"AikoPrivateLoginObserved",id:`${state.attemptId}:${state.loginSequence}`,connectionId:state.connectionId,attemptId:state.attemptId,sequence:state.loginSequence,revision:state.revision,kind,at:Date.now(),expiresAt:kind === "challenge" ? Math.min(state.expiresAt,state.challenge?.expiresAt??Infinity) : state.expiresAt,
    ...(state.challenge?{challengeId:state.challenge.id,challengeRevision:state.challenge.revision}:{}),...(state.submission?{submissionId:state.submission.id}:{})};
  state.loginReceipts=[...(state.loginReceipts??[]),observation].slice(-64);
  return observation;
}

/** Allowlist clone before anything from private adapters reaches the general log. */
export function loginObservationEvent(owner:string,value:NativeLoginObservation):Event {
  if(value.type!=="AikoPrivateLoginObserved"||!loginUuid(value.connectionId)||!loginUuid(value.attemptId)||!Number.isSafeInteger(value.sequence)||value.sequence<1||!Number.isSafeInteger(value.revision)||value.revision<1||!Number.isSafeInteger(value.at)||!Number.isSafeInteger(value.expiresAt)||!["opening","challenge","submission_dispatched","submission_acknowledged","verified","disconnected"].includes(value.kind)||value.challengeId!==undefined&&!loginUuid(value.challengeId)||value.submissionId!==undefined&&!loginUuid(value.submissionId)||value.challengeRevision!==undefined&&(!Number.isSafeInteger(value.challengeRevision)||value.challengeRevision<1))throw Error("Invalid login observation");
  return {type:"AikoPrivateLoginObserved",id:`${value.attemptId}:${value.sequence}`,owner,connectionId:value.connectionId,attemptId:value.attemptId,sequence:value.sequence,revision:value.revision,kind:value.kind,at:value.at,expiresAt:value.expiresAt,
    ...(value.challengeId?{challengeId:value.challengeId,challengeRevision:value.challengeRevision}:{}),...(value.submissionId?{submissionId:value.submissionId}:{})};
}
