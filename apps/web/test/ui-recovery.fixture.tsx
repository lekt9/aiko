import { createRoot } from "react-dom/client";
import { useState } from "react";
import { SecretaryWorkPanel } from "../src/components/secretary-work-panel";
import { ConnectorOnboarding } from "../src/components/connector-onboarding";
import { DatabaseArtifact } from "../src/components/database-artifact";
import type { DatabaseArtifactResult, DatabaseClient } from "../src/lib/databases";
import type { PromiseReview } from "../src/lib/promises";
import type { NativeLoginPanelView } from "../src/lib/native-login-input";
import "../src/styles/mini-app.css";

// Synthetic fixture controls. All API requests stay here; an unknown request fails.
const fixture = {
  approvals: [] as object[], approvalReads: 0, decisions: [] as object[],
  holdApprovalRead: false, releaseApprovalRead: () => {}, failDecision: false,
  connections: [] as object[],
  promises: [] as PromiseReview[], promiseReads: 0, promiseDecisions: [] as object[],
  holdPromiseDecision: false, promiseAborts: 0, releasePromiseDecision: () => {},
  holdWork: false, workAborts: 0, workReads: 0, workWrites: [] as object[],
  failWork: false, releaseWork: () => {},
  holdInitialWork: new URLSearchParams(location.search).has("initial"), releaseInitialWork: () => {},
  databaseStatus: 200, databaseReads: 0,
};
Object.assign(window, { uiFixture: fixture, Telegram: { WebApp: { initData: "synthetic-local-session" } } });
const work = { commitments: [], contacts: [], coverage: "Local fixture", now: Date.now() };
window.fetch = async (input, init) => {
  const path = String(input), body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const json = (value: unknown) => Promise.resolve(Response.json(value));
  if (path === "/api/connectors/session") return json({ token: "synthetic-only" });
  if (path === "/api/connectors/connections") return json({ connections: fixture.connections, nativeInline: true });
  if (path === "/api/connectors/browser") return json({ id: "fixture-login", nativeInline: true, status: "pending" });
  // The private form is discovered before any credential fields are rendered.
  if (path === "/api/connectors/native/progress?connectionId=fixture-login" && !body) return json({ progress: [] });
  if (path === "/api/connectors/native" && body?.connectionId === "fixture-login" &&
      Object.keys(body).length === 2 && ["form", "finish"].includes(body.action))
    return json({ status: "pending", domain: "github.com", fields: ["username", "password"] } satisfies NativeLoginPanelView);
  if (path === "/api/connectors/password-managers") return json({ managers: [] });
  if (path === "/api/connectors/disconnect") return json({ relayDisconnectStatus: "confirmed" });
  if (path === "/api/approvals") {
    fixture.approvalReads++;
    if (body) {
      fixture.decisions.push(body);
      if (fixture.failDecision) return Response.json({ error: "unavailable" }, { status: 503 });
      fixture.approvals = [];
    } else if (fixture.holdApprovalRead) {
      fixture.holdApprovalRead = false;
      const pending = structuredClone(fixture.approvals);
      return new Promise(resolve => { fixture.releaseApprovalRead = () => resolve(Response.json({ pending })); });
    }
    return json({ pending: fixture.approvals });
  }
  if (path === "/api/promises") { fixture.promiseReads++; return json({ promises: fixture.promises }); }
  if (path === "/api/promises/decision") {
    fixture.promiseDecisions.push(body);
    const row = fixture.promises.find(row => row.id === body.id && row.hash === body.hash);
    if (!row) return Response.json({ error: "not_found" }, { status: 404 });
    row.state = body.decision === "approve" ? "resolved" : body.decision === "reject" ? "rejected" : "cancelled";
    if (fixture.holdPromiseDecision) return new Promise((resolve, reject) => {
      const abort = () => { fixture.promiseAborts++; reject(init?.signal?.reason); };
      init?.signal?.addEventListener("abort", abort, { once: true });
      fixture.releasePromiseDecision = () => { init?.signal?.removeEventListener("abort", abort); fixture.holdPromiseDecision = false; resolve(Response.json({ promise: row })); };
    });
    return json({ promise: row });
  }
  if (path === "/api/secretary") return json({ connections: [], chats: [], deliveries: [] });
  if (path === "/api/secretary/work") {
    fixture.workReads++;
    if (fixture.workReads === 1 && fixture.holdInitialWork)
      return new Promise(resolve => { fixture.releaseInitialWork = () => resolve(Response.json({ ...work, coverage: "Outdated initial read" })); });
    if (body) fixture.workWrites.push(body);
    if (fixture.failWork) return Response.json({ error: "unavailable" }, { status: 503 });
    if (fixture.holdWork) return new Promise((resolve, reject) => {
      const cancel = () => { fixture.workAborts++; reject(new DOMException("Aborted", "AbortError")); };
      init?.signal?.addEventListener("abort", cancel, { once: true });
      fixture.releaseWork = () => { init?.signal?.removeEventListener("abort", cancel); fixture.holdWork = false; resolve(Response.json(body ? { message: "Saved fixture work" } : work)); };
    });
    return json(body ? { message: "Saved fixture work" } : work);
  }
  throw Error(`Unexpected fixture request: ${path}`);
};

const data = {
  artifact: { artifactId: "fixture", title: "Fixture projects", dataMode: "live", renderer: { kind: "json-render", catalogVersion: "aiko-db/v1" } },
  view: { layout: "table", query: { tableId: "projects" } },
  result: { columns: [{ id: "name", name: "Project", type: "text" }], rows: [{ id: "one", revision: 1, cells: { name: { state: "ready", value: "Original project" } }, records: { $root: { tableId: "projects", rowId: "one", revision: 1 } } }], matched: 1,
    capabilities: { read: true, write: true, saveView: false, createRows: true, createFields: ["name"], records: { one: { editFields: ["name"], reviewMemoryFields: [], actions: [] } } },
  },
} as unknown as DatabaseArtifactResult;
const client = {
  artifact: async () => { fixture.databaseReads++; if (fixture.databaseStatus !== 200) throw Object.assign(new Error("Synthetic read failure"), { status: fixture.databaseStatus }); return structuredClone(data); },
} as unknown as DatabaseClient;
function CallbackFixture() {
  const [version, setVersion] = useState(0);
  // Deliberately replace request while the same account stays mounted.
  const request = async <T,>(path: string, body?: object, signal?: AbortSignal): Promise<T> => {
    const response = await window.fetch(`/api${path}`, { body: body ? JSON.stringify(body) : undefined, signal });
    if (!response.ok) throw Error("Synthetic work failure");
    return response.json();
  };
  return <><button onClick={() => setVersion(version + 1)}>Replace request callback</button><p>Callback {version}</p><SecretaryWorkPanel request={request} /></>;
}
createRoot(document.getElementById("root")!).render(new URLSearchParams(location.search).has("database")
  ? <DatabaseArtifact artifactId="fixture" client={client} inline={false} /> : new URLSearchParams(location.search).has("callback")
    ? <CallbackFixture /> : <ConnectorOnboarding />);
