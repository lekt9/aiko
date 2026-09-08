/** Value-free private sign-in UI contract. No mail bodies, addresses, codes or URLs. */
export const loginAssistanceMethods = ["google", "email_code", "email_link"] as const;
export type LoginAssistanceMethod = typeof loginAssistanceMethods[number];
export type LoginAssistanceStatus = "working" | "waiting_email" | "approval_required" | "verifying" | "source_unavailable" | "unsupported" | "ambiguous" | "expired" | "uncertain";
export interface LoginAssistanceView { id: string; method: LoginAssistanceMethod; status: LoginAssistanceStatus; expiresAt: number }
export const loginAssistanceMessage: Record<LoginAssistanceStatus, string> = {
  working: "Continuing private sign-in with your connected Google account…",
  waiting_email: "Waiting for this website’s sign-in email in Gmail. Codes and links stay private.",
  approval_required: "Google asks to share your name, email address and profile picture with this website. Approve only if you want to sign in.",
  verifying: "Sign-in was submitted. Checking the website without submitting again…",
  source_unavailable: "Gmail is disconnected, expired or changed. Reconnect Gmail, then start a new sign-in for this website.",
  unsupported: "This sign-in needs a step Aiko cannot safely complete. Close this attempt to use another sign-in method.",
  ambiguous: "More than one account, message or sign-in value matched. Nothing was submitted. Start a fresh sign-in rather than guessing.",
  expired: "This sign-in expired. Close it and start again to request a fresh email.",
  uncertain: "A sign-in action may have completed. Check its status; Aiko will not repeat it.",
};
/** Supplied by the owning connector host, never accepted from a browser/model request. */
export interface GmailLoginGrant { connectionId: string; revision: number; expiresAt: number }
