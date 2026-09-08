import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PromisesPanel, PromisesProvider } from "../src/components/promises-panel";
import type { PromiseRequest, PromiseReview } from "../src/lib/promises";
const row: PromiseReview = { id: "promise-fixture", hash: "a".repeat(64), label: "Send the reviewed summary", when: { kind: "approval" }, state: "pending", createdAt: Date.now(), expiresAt: Date.now() + 600_000, payload: { kind: "harness", segment: { version: 1, code: 'return await tools.call({name:"send_summary",arguments:finalPayload});', packages: { tools: ["call"] }, values: { finalPayload: { destination: "Synthetic recipient", text: "Final ThinkFeel summary" } } } } };
const fixture = { rows: [row], decisions: [] as object[], reads: 0, holdRead: false, holdDecision: false, readStatus: 200, failDecision: false, releaseRead: () => {}, releaseDecision: () => {} };
(window as any).promiseFixture = fixture;
const request: PromiseRequest = async <T,>(path: string, body?: object) => {
  if (path === "/promises/decision") {
    fixture.decisions.push(body!);
    if (fixture.holdDecision) await new Promise<void>(resolve => { fixture.releaseDecision = resolve; });
    if (fixture.failDecision) throw Error("Synthetic response loss");
    const decision = (body as { decision: string }).decision;
    fixture.rows = fixture.rows.map(r => ({ ...r, state: decision === "approve" ? "resolved" : decision === "reject" ? "rejected" : "cancelled" }));
    return { promise: fixture.rows[0] } as T;
  }
  if (path !== "/promises") throw Error("Fixture forbids other APIs");
  fixture.reads++;
  const snapshot = structuredClone(fixture.rows);
  if (fixture.holdRead) await new Promise<void>(resolve => { fixture.releaseRead = resolve; });
  if (fixture.readStatus !== 200) throw Object.assign(Error("Synthetic read failure"), { status: fixture.readStatus });
  return { promises: snapshot } as T;
};
function App() {
  const [scope, setScope] = useState("owner-a"), [visible, setVisible] = useState(false), [count, setCount] = useState(0), [tick, setTick] = useState(0), [second, setSecond] = useState(false);
  return <PromisesProvider authScope={scope} request={(...args) => request(...args)} onPendingCount={setCount}><main><h1>Promise review fixture</h1><label>Unrelated draft<textarea /></label>
    <button onClick={() => setVisible(!visible)}>Review promises ({count})</button>
    <button onClick={() => setTick(tick + 1)}>Replace callback</button>
    <button onClick={() => setSecond(!second)}>Move review</button>
    <button onClick={() => setScope(scope === "owner-a" ? "owner-b" : "owner-a")}>Switch account</button>
    <div hidden={!visible}>{second ? <aside><PromisesPanel /></aside> : <div><PromisesPanel /></div>}</div>
  </main></PromisesProvider>;
}
createRoot(document.getElementById("root")!).render(<App />);
