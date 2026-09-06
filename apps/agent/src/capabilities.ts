export const RELEASE_GATES = [
  "Classic contract branch is unavailable (HTTP 404); no classic implementation is substituted.",
  "CloakBrowser customer-facing OEM/SaaS rights are not verified.",
  "Independent browser network isolation and secure human sign-in relay are unverified.",
  "Persistent Codegraff VM/browser compatibility and stop/start recovery need a separately approved test.",
  "Unlock owner authentication is not yet bridged to Telegram identities.",
] as const;
export type ReadReceipt = {
  kind: "read-receipt";
  owner: string;
  capability: string;
  version: number;
  observedAt: number;
  fixture: boolean;
  text: string;
  entities: Entity[];
  observations?: { id: string; subject: string }[];
};
export type Entity = {
  id: string;
  type: string;
  label: string;
  fields: Record<string, string | number | boolean | null>;
};

/** Deliberately synthetic source data; retrieval and persistence belong to entity-learn. */
export function fixtureRead(
  owner: string,
  capability: string,
  now = Date.now(),
): ReadReceipt {
  const entities: Entity[] =
    capability === "demo.issues.list"
      ? [
          {
            id: "issue:17",
            type: "issue",
            label: "Fix calendar timezone handling",
            fields: { number: 17, priority: "high", status: "open" },
          },
          {
            id: "issue:23",
            type: "issue",
            label: "Review the onboarding copy",
            fields: { number: 23, priority: "normal", status: "open" },
          },
        ]
      : [
          {
            id: "app:github",
            type: "app",
            label: "GitHub",
            fields: { accounts: 2 },
          },
          {
            id: "app:calendar",
            type: "app",
            label: "Calendar",
            fields: { accounts: 1 },
          },
        ];
  return {
    kind: "read-receipt",
    owner,
    capability,
    version: 1,
    observedAt: now,
    fixture: true,
    entities,
    text: `DEMO · synthetic data, not your accounts.\n${entities.map((e) => (e.type === "issue" ? `#${e.fields.number} — ${e.label} (${e.fields.priority} priority)` : `${e.label}: ${e.fields.accounts} sample account(s)`)).join("\n")}\nNothing has been posted or changed.`,
  };
}
