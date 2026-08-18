// agentic limbs — typed harness via fde/self-wire
export const LIMBS = [
  { id: "pre_shift", route: "/api/deployments/:id/escalation", channel: "whatsapp", escalation: true },
  { id: "prefs_ingest", route: "/api/preferences", ingest: "poll|webhook|hook" },
  { id: "roster_engine", cell: "roster-to-deployment", engine: "hoysan-draft" },
] as const;
