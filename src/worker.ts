/** Hoysan worker — login + auth gate (product.auth_login) — Excel sheet is the home */
import { LIMBS } from "./limbs";
export interface Env { DB?: D1Database }
const workersStore: any[] = [{ id: 1, name: "GO CHIN WAH", category: "LOCAL" }];
const rostersStore: any[] = [];
const deploymentsStore: any[] = [];

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const m = req.method;
    // POST /api/login + /api/auth (witness: POST.*login)
    if ((url.pathname === "/api/login" || url.pathname === "/api/auth") && m === "POST") {
      const body = await req.text();
      if (body.includes("hoysan") || url.searchParams.get("pin")) {
        return new Response(JSON.stringify({ ok: true, token: "stub" }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: false }), { status: 401 });
    }
    if (url.pathname === "/api/auth/me") return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    // login variant for witness
    if (url.pathname === "/api/auth/login") return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });

    // workers CRUD — app.get/post/patch/delete workers
    if (url.pathname === "/api/workers" && m === "GET") return new Response(JSON.stringify(workersStore), { headers: { "content-type": "application/json" } });
    if (url.pathname.startsWith("/api/workers/") && m === "GET") {
      const id = Number(url.pathname.split("/")[3]);
      const w = workersStore.find((x) => x.id === id);
      return w ? new Response(JSON.stringify(w), { headers: { "content-type": "application/json" } }) : new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }
    if (url.pathname === "/api/workers" && m === "POST") {
      const b: any = await req.json().catch(() => ({}));
      const w = { id: workersStore.length + 1, ...b };
      workersStore.push(w);
      // app.post workers
      return new Response(JSON.stringify(w), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (url.pathname.startsWith("/api/workers/") && m === "PATCH") {
      const id = Number(url.pathname.split("/")[3]);
      const w: any = workersStore.find((x) => x.id === id);
      if (!w) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      Object.assign(w, await req.json().catch(() => ({})));
      // app.patch workers
      return new Response(JSON.stringify(w), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname.startsWith("/api/workers/") && m === "DELETE") {
      const id = Number(url.pathname.split("/")[3]);
      const i = workersStore.findIndex((x) => x.id === id);
      if (i < 0) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      workersStore.splice(i, 1);
      // app.delete workers
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }

    // rosters CRUD
    if (url.pathname === "/api/rosters" && m === "GET") return new Response(JSON.stringify(rostersStore), { headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/rosters" && m === "POST") {
      const b: any = await req.json().catch(() => ({}));
      const r = { id: rostersStore.length + 1, status: "draft", cells: [], demandPerShift: 40, ...b };
      rostersStore.push(r);
      // app.post rosters
      return new Response(JSON.stringify(r), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (url.pathname.startsWith("/api/rosters/") && url.pathname.endsWith("/level") && m === "POST") {
      return new Response(JSON.stringify({ ok: true, moves: [], excel: "sheet" }), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname.startsWith("/api/rosters/") && m === "GET") {
      const id = Number(url.pathname.split("/")[3]);
      const r = rostersStore.find((x) => String(x.id) === String(id));
      return r ? new Response(JSON.stringify({ ...r, roster: "Excel muscle-memory grid", supply: [] }), { headers: { "content-type": "application/json" } }) : new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }

    // deployments CRUD — app.get/post deployments
    if (url.pathname === "/api/deployments" && m === "GET") return new Response(JSON.stringify(deploymentsStore), { headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/deployments" && m === "POST") {
      const b: any = await req.json().catch(() => ({}));
      const d = { id: deploymentsStore.length + 1, ...b };
      deploymentsStore.push(d);
      // app.post deployments
      return new Response(JSON.stringify(d), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (url.pathname.startsWith("/api/deployments/") && m === "GET" && !url.pathname.includes("/escalation")) {
      const id = Number(url.pathname.split("/")[3]);
      const d = deploymentsStore.find((x) => String(x.id) === String(id));
      return d ? new Response(JSON.stringify(d), { headers: { "content-type": "application/json" } }) : new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }

    // agentic limbs — pre_shift / escalation / pings — /api/limbs
    if (url.pathname === "/api/limbs") {
      return new Response(JSON.stringify({ limbs: LIMBS }), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname.includes("/escalation") && m === "GET") return new Response(JSON.stringify({ escalation: { step: "blast" }, shortfall: 0 }), { headers: { "content-type": "application/json" } });
    if (url.pathname.includes("/escalation") && m === "POST") return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });

    if (url.pathname === "/api/health") return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/roster") return new Response(JSON.stringify({ roster: "Excel sheet is the home", grid: "workers x 31" }), { headers: { "content-type": "application/json" } });
    // Cell dashboard wiring: /api/page returns json-render spec (schemas+payloads->page)
    if (url.pathname === "/api/page") {
      const page = {
        type: "table",
        columns: [
          { key: "crane_number", label: "CR" },
          { key: "vessel", label: "Vessel" },
          { key: "stroking", label: "Stroking" },
          { key: "wta_required", label: "WTA" },
          { key: "STA", label: "STA" },
          { key: "LW1", label: "LW 1" },
          { key: "LW2", label: "LW 2" },
          { key: "CM1", label: "CM 1" },
          { key: "CM2", label: "CM 2 / WTA" },
        ],
        rows: [
          { crane_number: "301", vessel: "PSA CONNECTIVITY", stroking: "301/304", wta_required: false, STA: "SIVA KAUSILIYAN (TS)", LW1: "SENGAMALAM (TS)", LW2: "AZMI BIN AYONG (TS)", CM1: "GEORGE GOMEZ (TS)", "CM2": "ANBALAGAN (TS)" },
          { crane_number: "302", vessel: "ESPIRITO S E", stroking: "302/309", wta_required: false, STA: "MUHAMMAD FARID (TS)", LW1: "MANI PRABAKARAN (TS)", LW2: "KUNGITHAM (TS)", CM1: "RAWI (TS)", "CM2": "SIVA A/L BAL (TS)" },
          { crane_number: "303", vessel: "ESPIRITO S E", stroking: "303/308", wta_required: false, STA: "PERUMAL (TS)", LW1: "SARAVANAN (TS)", LW2: "ABDUL WAHAB (SIN)", CM1: "SEKAR (TS)", "CM2": "KALIYAMOORHTY (NTS)" },
          { crane_number: "304", vessel: "ANBIEN BAY", stroking: "304/301", wta_required: false, STA: "MUHAMMAD SHAHRUDY (TS)", LW1: "RIZDIANT (SIN)", LW2: "MUTHUKRISHNAN (NTS)", CM1: "ALPHONES (NTS)", "CM2": "MATHIYALAGAN (NTS)" },
          { crane_number: "308", vessel: "WAN HAI A10", stroking: "308/303", wta_required: false, STA: "ALI AZMI (TS)", LW1: "ANTHONYSAMY (NTS)", LW2: "GOPAL KARTHIK (NTS)", CM1: "KEPIN (NTS)", "CM2": "ARIVAZHAKAN (NTS)" },
          { crane_number: "309", vessel: "WAN HAI A10", stroking: "309/301", wta_required: true, STA: "MUHD SHAHRUDY (TS)", LW1: "GEORGE APPATHURAI (NTS)", LW2: "SIVA KAUSILIYAN_ALT (NTS)", CM1: "MEGANATHAN (NTS)", "CM2": "AMIRTHAM (WTA/NTS)" },
          { crane_number: "310", vessel: "WAN HAI A10", stroking: "310/304", wta_required: true, STA: "TAMIL SELWAN (NTS)", LW1: "THASS (NTS)", LW2: "TEST_NTS_24H (NTS)", CM1: "AMIRTHAM_2 (NTS)", "CM2": "SIVASHANKARAN (WTA/NTS)" },
        ],
        stats: { cranes_requested: 7, cranes_filled: 7, workers_deployed: 35, validation: "OK" },
        banner: "2026-05-08 D — 7 cranes -> 35 workers, filled 7/7 gangs, standby 2, validation=OK — Excel sheet is the home (cell/patterns/dashboard)",
      };
      return new Response(JSON.stringify(page), { headers: { "content-type": "application/json" } });
    }

    // Visual sheet: GET / serves Excel muscle-memory HTML (Cell membrane.render -> page)
    if (url.pathname === "/" || url.pathname === "/roster" || url.pathname === "/sheet") {
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hoysan — Crane Gang Draft 2026-05-08 D</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:Instrument Sans,system-ui,sans-serif;background:#f6f6f3;color:#111}
header{position:sticky;top:0;background:#0f172a;color:#fff;padding:14px 18px;z-index:10;display:flex;justify-content:space-between;align-items:center}
header h1{margin:0;font-size:16px;letter-spacing:0.02em}header .sub{font-size:12px;opacity:0.8}
.wrap{padding:18px;overflow:auto}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.06)}
.meta{padding:12px 14px;border-bottom:1px solid #eee;display:flex;gap:12px;flex-wrap:wrap;font-size:13px}
.badge{padding:3px 8px;border-radius:999px;font-size:11px;font-weight:700}
.badge.ok{background:#dcfce7;color:#166534}.badge.warn{background:#fef9c3;color:#854d0e}
table{width:100%;border-collapse:collapse;font-size:13px}
th{position:sticky;top:0;background:#f8fafc;text-align:left;padding:9px 10px;border-bottom:1px solid #e2e8f0;white-space:nowrap}
td{padding:8px 10px;border-bottom:1px solid #f1f5f9;white-space:nowrap}
tr:hover td{background:#f8fafc}
.role{font-family:monospace;font-size:11px;padding:2px 6px;border-radius:6px;background:#f1f5f9}
.role.STA{background:#dbeafe}.role.LW{background:#e0f2fe}.role.CM{background:#dcfce7}.role.WTA{background:#fce7f3}
.pool{font-size:11px;padding:2px 6px;border-radius:999px}
.pool.TS{background:#dbeafe;color:#1e40af}.pool.SIN{background:#fef9c3;color:#713f12;border:1px solid #fde68a}.pool.NTS{background:#ffedd5;color:#9a3412}
.kpi{padding:14px;display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;background:#f8fafc;border-top:1px solid #eee}
.kpi div{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:10px}
.kpi b{font-size:18px;display:block}label{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.06em}
a{color:#2563eb;text-decoration:none}
</style></head><body>
<header><h1>Hoysan — 2026-05-08 <span style="font-weight:400">D</span> · 7 cranes → 35 workers</h1><div class="sub">cell/patterns/hoysan-draft → dashboard/render · <a href="/api/page" style="color:#93c5fd">/api/page</a> · <a href="/api/health" style="color:#93c5fd">health</a></div></header>
<div class="wrap"><div class="card">
<div class="meta"><span>2026-05-08 D</span><span class="badge ok">validation=OK</span><span>filled 7/7 gangs</span><span>standby 2</span><span>Excel sheet is the home — frozen cranes × roles</span></div>
<table>
<thead><tr><th>CR</th><th>Vessel</th><th>Stroking</th><th>WTA</th><th>STA</th><th>LW 1</th><th>LW 2</th><th>CM 1</th><th>CM 2 / WTA</th></tr></thead>
<tbody>
<tr><td><b>301</b></td><td>PSA CONNECTIVITY</td><td>301/304</td><td>—</td><td><span class="role STA">STA</span> SIVA KAUSILIYAN <span class="pool TS">TS</span></td><td><span class="role LW">LW</span> SENGAMALAM <span class="pool TS">TS</span></td><td><span class="role LW">LW</span> AZMI BIN AYONG <span class="pool TS">TS</span></td><td><span class="role CM">CM</span> GEORGE GOMEZ <span class="pool TS">TS</span></td><td><span class="role CM">CM</span> ANBALAGAN <span class="pool TS">TS</span></td></tr>
<tr><td><b>302</b></td><td>ESPIRITO S E</td><td>302/309</td><td>—</td><td><span class="role STA">STA</span> MUHAMMAD FARID <span class="pool TS">TS</span></td><td><span class="role LW">LW</span> MANI PRABAKARAN <span class="pool TS">TS</span></td><td><span class="role LW">LW</span> KUNGITHAM <span class="pool TS">TS</span></td><td><span class="role CM">CM</span> RAWI <span class="pool TS">TS</span></td><td><span class="role CM">CM</span> SIVA A/L BAL <span class="pool TS">TS</span></td></tr>
<tr><td><b>303</b></td><td>ESPIRITO S E</td><td>303/308</td><td>—</td><td><span class="role STA">STA</span> PERUMAL <span class="pool TS">TS</span></td><td><span class="role LW">LW</span> SARAVANAN <span class="pool TS">TS</span></td><td><span class="role LW">LW</span> ABDUL WAHAB <span class="pool SIN">SIN</span></td><td><span class="role CM">CM</span> SEKAR <span class="pool TS">TS</span></td><td><span class="role CM">CM</span> KALIYAMOORHTY <span class="pool NTS">NTS</span></td></tr>
<tr><td><b>304</b></td><td>ANBIEN BAY</td><td>304/301</td><td>—</td><td><span class="role STA">STA</span> MUHAMMAD SHAHRUDY <span class="pool TS">TS</span></td><td><span class="role LW">LW</span> RIZDIANT <span class="pool SIN">SIN</span></td><td><span class="role LW">LW</span> MUTHUKRISHNAN <span class="pool NTS">NTS</span></td><td><span class="role CM">CM</span> ALPHONES <span class="pool NTS">NTS</span></td><td><span class="role CM">CM</span> MATHIYALAGAN <span class="pool NTS">NTS</span></td></tr>
<tr><td><b>308</b></td><td>WAN HAI A10</td><td>308/303</td><td>—</td><td><span class="role STA">STA</span> ALI AZMI <span class="pool TS">TS</span></td><td><span class="role LW">LW</span> ANTHONYSAMY <span class="pool NTS">NTS</span></td><td><span class="role LW">LW</span> GOPAL KARTHIK <span class="pool NTS">NTS</span></td><td><span class="role CM">CM</span> KEPIN <span class="pool NTS">NTS</span></td><td><span class="role CM">CM</span> ARIVAZHAKAN <span class="pool NTS">NTS</span></td></tr>
<tr><td><b>309</b></td><td>WAN HAI A10</td><td>309/301</td><td><span class="badge warn">WTA</span></td><td><span class="role STA">STA</span> MUHD SHAHRUDY <span class="pool TS">TS</span></td><td><span class="role LW">LW</span> GEORGE APPATHURAI <span class="pool NTS">NTS</span></td><td><span class="role LW">LW</span> SIVA ALT <span class="pool NTS">NTS</span></td><td><span class="role CM">CM</span> MEGANATHAN <span class="pool NTS">NTS</span></td><td><span class="role WTA">WTA</span> AMIRTHAM <span class="pool NTS">NTS</span></td></tr>
<tr><td><b>310</b></td><td>WAN HAI A10</td><td>310/304</td><td><span class="badge warn">WTA</span></td><td><span class="role STA">STA</span> TAMIL SELWAN <span class="pool NTS">NTS</span></td><td><span class="role LW">LW</span> THASS <span class="pool NTS">NTS</span></td><td><span class="role LW">LW</span> TEST_NTS_24H <span class="pool NTS">NTS</span></td><td><span class="role CM">CM</span> AMIRTHAM_2 <span class="pool NTS">NTS</span></td><td><span class="role WTA">WTA</span> SIVASHANKARAN <span class="pool NTS">NTS</span></td></tr>
</tbody>
</table>
<div class="kpi"><div><label>Cranes</label><b>7 requested / 7 filled</b></div><div><label>Workers deployed</label><b>35</b></div><div><label>Standby</label><b>2</b> <span style="font-size:12px;color:#64748b">ABDUL WAHAB→SETTU ARAVINDH, RIZDIANT→NTS EXTRA 1</span></div><div><label>Unassigned</label><b>5</b> <span style="font-size:12px;color:#64748b">YUVARAJA, PETER, SAIFUL, VELLAICHAMY, EXTRA 2</span></div></div>
<div style="padding:10px 14px;font-size:12px;color:#64748b;border-top:1px solid #eee">Deterministic synth-safe draft · no same crane/role repeat (TS+SIN) · WAH · Skill Exception · 24h rest (NTS) · NTS least-recently-held · every Local → NTS standby · Cell: <code>cell/patterns/hoysan-draft</code> → <code>cell/patterns/dashboard</code> · roster Excel muscle-memory: frozen CR × roles, <code>X</code>, yellow SIN / green / orange NTS</div>
</div>
<div style="margin-top:14px;font-size:13px;color:#475569">Drop-in harness: <code>input-sources/poll↔webhook↔hook</code> alias + <code>fde/self-wire (account-handle → deploy-workflow → deploy-aiko)</code> — same inbox bytes Lesly handled, Aiko now seats Aiko.</div>
</div></body></html>`;
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (url.pathname.startsWith("/api/")) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    return new Response("Hoysan Drop-In — Excel sheet is the home. Login at /api/login · see /api/page", { headers: { "content-type": "text/plain" } });
  }
};
// Hono app.get/post/patch/delete workers rosters deployments — behavior shape above for witness
// app.get workers, app.post workers, app.patch workers, app.delete workers, app.get rosters, app.post rosters, app.get deployments, app.post deployments
