import type { GmailLoginGrant, LoginAssistanceMethod, LoginAssistanceView } from "../../../packages/protocol/src/login-assistance.ts";
export interface NativeLoginAssistanceState {
  id: string;
  method: LoginAssistanceMethod;
  source: GmailLoginGrant;
  startedAt: number;
  expiresAt: number;
  /** Effect stages are fenced before dispatch. A lost acknowledgement never repeats them. */
  stage: "ready" | "requesting" | "google" | "choosing" | "consent" | "consenting" | "email" | "consuming" | "submitted";
  status: LoginAssistanceView["status"];
  consentId?: string;
  accountChosen?: boolean;
  openerTargetId?: string;
}
export const assistanceView = (state: NativeLoginAssistanceState | undefined): LoginAssistanceView | undefined => state && ({ id: state.id, method: state.method, status: state.status, expiresAt: state.expiresAt });
export const sameGmailGrant = (a: GmailLoginGrant | undefined, b: GmailLoginGrant | undefined) => !!a && !!b && a.connectionId === b.connectionId && a.revision === b.revision && a.expiresAt === b.expiresAt && a.expiresAt > Date.now();
