export type WorkStatus =
  "candidate" | "ready" | "acting" | "waiting" | "completed" | "cancelled";
export interface AgendaPlan {
  kind: "agenda";
  connectionId: string;
  chat: string;
  contactName: string;
  count: number;
  requestText: string;
  reminderText: string;
  reminderAt: number;
  escalateAt: number;
}
export interface WorkDecision {
  id: string;
  kind: "authorize" | "review";
  issue: string;
  recommendation: string;
  neededBy: number;
  expiresAt: number;
  status: "pending" | "approved" | "declined" | "expired" | "superseded";
  planDigest: string;
  fallback: "keep_waiting";
}
export interface Commitment {
  id: string;
  owner: string;
  version: number;
  outcome: string;
  successCondition: string;
  accountableParty: string;
  nextAction: string;
  actionAssignee: string;
  status: WorkStatus;
  acceptanceBasis: "ownerInstruction" | "tentativeInference";
  handling: "aiko" | "owner";
  control: "active" | "paused";
  suspensionReason?: string;
  resumeWhen?: string;
  waitingFor?: string;
  dueAt: number | null;
  timeZone: string;
  nextReviewAt?: number;
  sourceRefs: string[];
  dependencyRefs: string[];
  evidenceRefs: string[];
  coverage: string;
  createdAt: number;
  updatedAt: number;
  plan?: AgendaPlan;
  decision?: WorkDecision;
  mandate?: {
    planDigest: string;
    grantId: string;
    approvedAt: number;
    expiresAt: number;
    sourceUpdateId: number;
  };
  preparationNote?: string;
  evidenceMessageId?: number;
  evidenceAfterMessageId?: number;
}
export interface WorkReceipt {
  id: string;
  workId: string;
  owner: string;
  action: "request" | "reminder";
  planDigest: string;
  token: string;
  status: "started" | "delivered" | "unknown" | "blocked";
  at: number;
  reason?: string;
  providerId?: string;
  afterMessageId?: number;
}
export interface WorkNoticeRef {
  workId: string;
  version: number;
  /** Exact checked prerequisite snapshots for a waiting-work readiness notice. */
  readyDependencies?: { workId: string; version: number }[];
}
