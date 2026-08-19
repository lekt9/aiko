// agentic limbs — typed harness via fde/self-wire.
// Single source of truth: /api/limbs serves THIS array; never a second inline copy.
export const LIMBS = [
  { id: "pre_shift", route: "/api/deployments/:id/escalation", channel: "whatsapp", escalation: true },
  { id: "prefs_ingest", route: "/api/preferences", ingest: "poll|webhook|hook" },
  { id: "escalation", channel: "whatsapp", ladder: "5:00 blast → 5:30 no-reply → call" },
  { id: "roster_engine", cell: "roster-to-deployment", engine: "hoysan-draft" },
] as const;
