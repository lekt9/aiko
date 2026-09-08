import { expect, test } from "vitest";
import { watchReauthorizationRequest, type WatchStatus } from "../src/lib/browser-watches";
const watch: WatchStatus = { id: "watch", generation: 3, lifecycleRevision: 2, controlRevision: 7, leaseRevision: 4,
  status: "needs-attention", config: { id: "watch", label: "Updates", connectionId: "site", connectionRevision: "r1", sourceGeneration: 1,
    origin: "https://example.test", kind: "push", outcome: "received", action: {kind:"actor",instruction:"Summarize"},
    expiresAt: 9000, backlog: 32, maxOccurrences: 100 },
  collector: {state:"needs-attention",restore:{challenge:"held-challenge",at:1000,queue:{head:12,acknowledged:10,offered:11}}} };
test("restore control pins the retained lifecycle instead of the unrelated control count and never sends proof or transport authority", () => {
  expect(watchReauthorizationRequest(watch, 2000)).toEqual({id:"watch",expectedGeneration:3,expectedLifecycleRevision:2,expectedLeaseRevision:4,challenge:"held-challenge"});
});
test("missing queue, changed challenge, missing revision, pause, deletion and expired lease cannot offer automatic continuation", () => {
  for (const change of [{status:"paused"},{status:"deleted"},{lifecycleRevision:undefined},{leaseRevision:undefined},
    {collector:{state:"needs-attention",restore:{challenge:"held-challenge",at:1000}}},
    {reauthorization:{requestId:"restore",challenge:"older-challenge",status:"pending" as const,attempts:1,deadlineAt:5000}}])
    expect(watchReauthorizationRequest({...watch,...change},2000)).toBeUndefined();
  expect(watchReauthorizationRequest(watch,9000)).toBeUndefined();
});
test("lost response and reload reconstruct the same pending request even after the private hold cleared", () => {
  for (const status of ["pending","needs-attention"] as const) {
    const current = {...watch,collector:{state:"watching"},reauthorization:{requestId:"restore",challenge:"held-challenge",status,attempts:1,deadlineAt:5000}};
    expect(watchReauthorizationRequest(current,2000)).toEqual(watchReauthorizationRequest(watch,2000));
    expect(watchReauthorizationRequest({...current,reauthorization:{...current.reauthorization,status:"confirmed"}},2000)).toBeUndefined();
  }
});
