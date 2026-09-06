import { GRAPH_MARKUP, GRAPH_SCRIPT, GRAPH_STYLE } from "./control-graph.ts";

/** Operator/account inspection surface. Credentials live only in this tab's memory. */
export const CONTROL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Aiko · Thread control</title>
<style>
:root{color-scheme:light;--ice:#f1f5fb;--paper:#fff;--ink:#122c47;--muted:#52667c;--line:#d3dfed;--blue:#2f62b7;--blue-light:#eaf1fc;--teal:#12766f;--teal-light:#e6f4f1;--amber:#8c4c1b;--amber-light:#fff1dc;--rose:#b22d49;--rose-light:#fff0f3;--mono:ui-monospace,"SFMono-Regular",Consolas,monospace;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:var(--ice)}
*{box-sizing:border-box}body{margin:0}button,input,select{font:inherit;color:inherit}button,a,input,select,summary{-webkit-tap-highlight-color:transparent}button,select,summary{cursor:pointer}button{min-height:42px;padding:8px 13px;border:1px solid var(--line);border-radius:8px;background:var(--paper);font-weight:550}button:hover{border-color:var(--blue);background:var(--blue-light)}button:disabled{opacity:.55;cursor:default}button.primary{color:white;background:var(--blue);border-color:var(--blue)}button.primary:hover{background:#244f96}button.quiet{background:transparent}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid var(--blue);outline-offset:3px}input,select{min-height:44px;border:1px solid #9bafc6;border-radius:8px;background:var(--paper);padding:9px 12px;max-width:100%;font-size:16px}input[type="checkbox"]{min-height:20px;width:19px;height:19px;accent-color:var(--blue)}input[type="search"]{width:100%}label{font-size:13px;font-weight:600}a{color:var(--blue);text-underline-offset:4px}p,h1,h2,h3{margin:0}h1,h2,h3,.brand{font-family:"Trebuchet MS","Segoe UI",sans-serif}h1{font-size:clamp(29px,4vw,42px);line-height:1.15;letter-spacing:-1.3px;font-weight:700}h2{font-size:20px;letter-spacing:-.45px}h3{font-size:16px;font-weight:700}code,pre,.mono{font-family:var(--mono)}code{font-size:12px;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.65;margin:0;color:var(--muted)}[hidden]{display:none!important}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}.skip{position:absolute;left:16px;top:-80px;padding:12px;background:white;z-index:9}.skip:focus{top:12px}.shell{max-width:1480px;margin:auto;padding:0 32px 32px}.topbar{min-height:82px;display:flex;justify-content:space-between;align-items:center;gap:20px;border-bottom:1px solid var(--line)}.brand{font-size:24px;font-weight:700;letter-spacing:-.8px;display:flex;align-items:center;gap:13px}.brand-mark{height:30px;width:30px;display:grid;grid-template-columns:repeat(2,7px);grid-template-rows:repeat(2,7px);gap:4px;place-content:center;transform:rotate(-8deg);border:1px solid var(--blue);border-radius:8px}.brand-mark i{border-radius:2px;background:var(--blue)}.brand-mark i:last-child{background:var(--teal)}.brand small{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:block;font-size:11px;font-weight:500;letter-spacing:.3px;color:var(--muted)}.top-actions{display:flex;align-items:center;gap:20px}.top-actions a{font-size:13px}.intro{padding:31px 0 26px;display:flex;justify-content:space-between;align-items:flex-end;gap:24px}.intro p{margin-top:9px;color:var(--muted);max-width:700px}.eyebrow{font-size:10px;letter-spacing:1.3px;text-transform:uppercase;color:var(--muted);font-weight:700;display:block;margin-bottom:8px}.status{display:inline-flex;align-items:center;gap:7px;font-size:11px;line-height:1.4;border-radius:5px;padding:4px 7px;background:var(--ice);color:var(--muted);font-weight:650;white-space:nowrap}.status:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}.status.running,.status.delivered{background:var(--teal-light);color:var(--teal)}.status.failed,.status.rejected{background:var(--rose-light);color:var(--rose)}.status.blocked,.status.unknown{background:var(--amber-light);color:var(--amber)}.status.foreground{color:var(--blue);background:var(--blue-light)}.access{display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,440px);gap:64px;align-items:start;padding:40px;background:var(--paper);border:1px solid var(--line);border-radius:14px;max-width:1040px;margin:16px 0 50px}.access h2{font-size:28px;line-height:1.25;max-width:340px;margin-bottom:14px}.access p{color:var(--muted);max-width:430px}.access label{display:block;margin-bottom:8px}.access input{width:100%}.access button{margin-top:17px;width:100%}.hint{font-size:12px;color:var(--muted);line-height:1.6}.access .hint{margin-top:10px}.access-flow{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:26px;font-family:var(--mono);font-size:11px;color:var(--muted)}.access-flow span{border:1px solid var(--line);border-radius:6px;padding:7px 9px}.access-flow b{font-weight:400;color:var(--blue)}.workspace-toolbar{display:flex;gap:22px;flex-wrap:wrap;align-items:flex-end;padding-bottom:22px}.account-field{display:grid;gap:5px;flex:1;max-width:360px}.account-field select{width:100%}.toolbar-actions{display:flex;align-items:center;gap:14px;margin-left:auto;flex-wrap:wrap}.check-label{display:inline-flex;gap:8px;align-items:center;min-height:44px;white-space:nowrap;font-weight:500}.scope{font-size:11px;color:var(--muted);padding-bottom:11px}.scope strong{color:var(--ink);font-weight:600}.workspace{display:grid;grid-template-columns:320px minmax(0,1fr);gap:24px;align-items:start}.lanes{min-width:0}.lane-heading{display:flex;align-items:center;gap:8px;margin-bottom:10px}.lane-heading h2{font-size:13px;letter-spacing:0}.lane-heading span{font-size:11px;color:var(--muted);margin-left:auto}.actor-card{display:block;text-align:left;width:100%;padding:17px 17px 15px;background:var(--paper);border:1px solid var(--line);border-radius:10px;position:relative;margin-bottom:10px;transition:border-color .15s,box-shadow .15s}.actor-card:hover{background:var(--paper)}.actor-card[aria-pressed="true"]{border-color:var(--blue);box-shadow:0 0 0 1px var(--blue)}.actor-card.foreground-card{border-top:3px solid var(--blue);background:#fafdff}.actor-top{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:9px}.actor-title{font-family:"Trebuchet MS","Segoe UI",sans-serif;font-size:16px;font-weight:700}.actor-card code{display:block;font-size:11px;font-weight:400;word-break:break-all;margin-bottom:9px}.actor-summary{font-size:12px;line-height:1.6;color:var(--muted);font-weight:400;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.actor-meta{display:flex;flex-wrap:wrap;gap:5px 12px;align-items:center;margin-top:13px;font-size:10px;font-family:var(--mono);font-weight:400;color:var(--muted)}.background-heading{margin-top:28px}.lane-route{display:flex;align-items:center;gap:9px;font-size:11px;color:var(--muted);margin:16px 0 3px}.lane-route:before{content:"↑";display:grid;place-content:center;border:1px solid var(--line);border-radius:50%;height:23px;width:23px;color:var(--blue)}.hook-control{margin-top:17px;border-top:1px solid var(--line);padding-top:16px}.hook-top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px}.hook-top strong{font-size:12px}.hook-control button{width:100%;margin-top:12px}.inspector{background:var(--paper);border:1px solid var(--line);border-radius:12px;min-width:0;overflow:hidden}.tabs{display:flex;padding:0 22px;border-bottom:1px solid var(--line);gap:20px}.tabs button{border:0;border-bottom:3px solid transparent;border-radius:0;background:none;padding:17px 0 14px;font-size:13px;min-height:54px;color:var(--muted)}.tabs button[aria-selected="true"]{color:var(--blue);border-bottom-color:var(--blue)}.tabs button:focus-visible{outline-offset:-4px}.panel-head{padding:23px 24px 18px}.panel-title{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}.panel-title code{display:block;color:var(--muted);font-size:11px;margin-top:4px}.thread-root{margin-top:10px;font-size:11px;color:var(--muted);display:flex;gap:8px;align-items:baseline}.thread-root code{font-size:10px;word-break:break-all}.pipeline{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:17px 0 0;font-family:var(--mono);font-size:10px;color:var(--muted)}.pipeline span{padding:4px 6px;background:var(--ice);border-radius:4px}.pipeline span:last-child{color:var(--blue);background:var(--blue-light)}.pipeline b{color:#8199b4;font-weight:400}.filters{display:grid;grid-template-columns:minmax(0,1fr) 174px;gap:12px;padding:0 24px 17px;border-bottom:1px solid var(--line)}.filter-field{display:grid;gap:5px}.filter-field label{font-size:11px}.filters input,.filters select{font-size:13px;min-height:41px}.event-tally{font-size:11px;color:var(--muted);padding:13px 24px 0}.events{padding:4px 24px 18px}.event{position:relative;padding:19px 0 19px 23px;border-bottom:1px solid var(--line);min-width:0}.event:last-child{border-bottom:0}.event:before{content:"";position:absolute;left:2px;top:25px;width:7px;height:7px;border:2px solid #96acc7;background:var(--paper);border-radius:50%;z-index:1}.event:after{content:"";position:absolute;left:5px;top:34px;bottom:-26px;border-left:1px solid var(--line)}.event:last-child:after{display:none}.event.decision:before{border-color:var(--blue);background:var(--blue)}.event.warning:before{border-color:var(--amber);background:var(--amber)}.event.failure:before{border-color:var(--rose);background:var(--rose)}.event-header{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline}.event-header h3{font-size:13px}.event-time{font-family:var(--mono);font-size:10px;color:var(--muted)}.event-type{font:10px/1.4 var(--mono);color:var(--muted);margin-top:3px;overflow-wrap:anywhere}.event-text{font-size:13px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere;margin-top:10px;max-height:180px;overflow:auto}.event-note{font-size:12px;margin-top:10px;background:var(--blue-light);color:var(--blue);padding:9px 11px;border-radius:6px;overflow-wrap:anywhere}.event-note.warning{background:var(--amber-light);color:var(--amber)}.event-note.failure{background:var(--rose-light);color:var(--rose)}.fields{display:grid;grid-template-columns:80px minmax(0,1fr);gap:5px 9px;font-size:11px;margin:12px 0 0}.fields dt{color:var(--muted)}.fields dd{margin:0;overflow-wrap:anywhere;min-width:0}.fields code{font-size:10px;word-break:break-all}.thread-link{border:0;padding:0;min-height:26px;font:11px var(--mono);color:var(--blue);background:none;word-break:break-all;text-align:left;text-decoration:underline;text-underline-offset:3px}.root-change{background:var(--ice);border-radius:6px;padding:10px 12px;margin-top:12px;display:grid;grid-template-columns:44px minmax(0,1fr);gap:5px 9px;align-items:baseline;font-size:10px;color:var(--muted)}.root-change code{font-size:10px;word-break:break-all}.event details{margin-top:11px}.event summary,.source-details summary{font-size:11px;color:var(--muted);min-height:30px;display:list-item;padding-top:5px}.event pre,.source-details pre{padding:12px;background:var(--ice);border-radius:6px;margin-top:6px}.supports{margin:7px 0 0;padding-left:17px;color:var(--muted)}.supports li{font-family:var(--mono);font-size:10px;overflow-wrap:anywhere;margin-bottom:4px}.load-row{display:flex;align-items:center;justify-content:center;gap:12px;padding:0 24px 22px}.load-row button{font-size:12px}.empty{padding:29px 20px;color:var(--muted);font-size:13px;line-height:1.7;text-align:center}.empty strong{display:block;color:var(--ink);font-family:"Trebuchet MS","Segoe UI",sans-serif;margin-bottom:5px;font-size:16px}.lanes .empty{border:1px dashed #aabcce;border-radius:9px;padding:24px 17px;text-align:left;font-size:12px}.memory-summary{margin-top:12px;color:var(--muted);font-size:12px}.memory-filter{padding:0 24px 18px;border-bottom:1px solid var(--line)}.memory-filter label{display:block;font-size:11px;margin-bottom:6px}.memory-filter input{font-size:13px}.memory-list{padding:5px 24px 20px}.memory-card{padding:14px 0;border-bottom:1px solid var(--line)}.memory-card:last-child{border:0}.memory-card>summary{min-height:38px;line-height:1.5;font-size:13px;overflow-wrap:anywhere;font-weight:600}.memory-card>summary .hint{display:block;font-size:10px;margin-left:15px;font-weight:400;font-family:var(--mono);overflow-wrap:anywhere}.memory-card pre{padding:12px;margin-top:12px;background:var(--ice);border-radius:6px}.source-details{border-top:1px solid var(--line);padding:15px 24px 20px}.feedback{margin:18px 0 0;min-height:22px;font-size:12px;color:var(--muted)}.feedback.error{color:var(--rose)}.footer{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:10px;color:var(--muted);margin-top:14px}.no-accounts{background:var(--paper);border:1px solid var(--line);border-radius:12px}.inline-error{margin:14px 24px 0;padding:11px 13px;border-radius:7px;background:var(--amber-light);color:var(--amber);font-size:12px}
@media(min-width:1100px){.lanes{position:sticky;top:20px}}
@media(max-width:1000px){.shell{padding:0 22px 24px}.workspace{grid-template-columns:280px minmax(0,1fr);gap:17px}.tabs{padding:0 18px}.panel-head{padding:20px 18px 16px}.filters{padding:0 18px 15px;grid-template-columns:1fr}.event-tally{padding-left:18px}.events{padding:4px 18px 18px}.access{gap:32px;padding:30px}}
@media(max-width:740px){.shell{padding:0 16px 22px}.topbar{min-height:72px}.top-actions{gap:12px}.top-actions a{font-size:11px}.brand{font-size:21px}.brand-mark{display:none}.intro{padding:25px 0 22px;align-items:flex-start}.intro p{font-size:13px}.intro>span{display:none}.workspace{grid-template-columns:1fr}.workspace-toolbar{gap:12px}.account-field{max-width:none;min-width:180px}.toolbar-actions{margin-left:0;gap:10px;width:100%;justify-content:space-between}.scope{padding-bottom:0}.background-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.background-list .actor-card{margin:0;height:100%}.actor-card{padding:14px}.actor-top{align-items:flex-start;flex-wrap:wrap}.actor-title{font-size:15px}.background-heading{margin-top:20px}.hook-control{margin-top:16px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:0 15px}.hook-top{grid-column:1}.hook-control .hint{grid-column:1}.hook-control button{grid-column:2;grid-row:1/3;margin:0;align-self:center;width:auto}.inspector{margin-top:5px}.filters{grid-template-columns:minmax(0,1fr) 145px}.access{grid-template-columns:1fr;gap:27px;padding:25px;margin-top:0}.access h2{font-size:25px;max-width:none}.access-flow{margin-top:20px}.event-header{gap:5px}.event-time{font-size:9px}.footer{font-size:10px}}
@media(max-width:400px){.background-list,.filters{grid-template-columns:1fr}.top-actions a{max-width:90px}.hook-control{display:block}.hook-control button{margin-top:10px;width:100%}.scope{width:100%}.event{padding-left:18px}.fields{grid-template-columns:63px minmax(0,1fr)}}
@media(prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}
.event-text:focus-visible{outline:3px solid var(--blue);outline-offset:3px}
${GRAPH_STYLE}
</style>
</head>
<body>
<a class="skip" href="#main">Skip to control panel</a>
<div class="shell">
<header class="topbar">
  <div class="brand"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span><div>Aiko<small>Thread control</small></div></div>
  <nav class="top-actions" aria-label="Control navigation"><a href="/">Open conversation ↗</a><button id="lock" type="button" class="quiet" hidden>Lock panel</button></nav>
</header>
<main id="main">
  <div class="intro"><div><h1>Behind the conversation.</h1><p>Follow each hook through learning, reflection, and the reply that reaches Telegram.</p></div><span id="connection" class="status">Locked</span></div>
  <section id="access" class="access" aria-labelledby="access-title">
    <div><span class="eyebrow">Account-scoped observability</span><h2>One foreground thread.<br>Room to think behind it.</h2><p>Inspect the working threads, trace why a decision was made, and see what each account has learned.</p><div class="access-flow" aria-label="Background work flows into the foreground conversation"><span>Hooks</span><b aria-hidden="true">→</b><span>Working threads</span><b aria-hidden="true">→</b><span>Telegram</span></div></div>
    <form id="login"><label for="token">Operator or account token</label><input id="token" type="password" autocomplete="off" spellcheck="false" required placeholder="Enter your control access token"><p class="hint">Kept only in memory for this tab. Account credentials show only that account. Write access is required to manage proactive hooks.</p><button id="unlock" class="primary" type="submit">Open control panel</button></form>
  </section>
  <section id="workspace-wrap" aria-label="Account control panel" hidden>
    <div class="workspace-toolbar">
      <div class="account-field"><label for="account">Account</label><select id="account" aria-describedby="scope"></select></div>
      <p id="scope" class="scope"></p>
      <div class="toolbar-actions"><label class="check-label" for="auto"><input id="auto" type="checkbox" checked>Auto-refresh · 5s</label><button id="refresh" type="button">Refresh now</button></div>
    </div>
    <div id="no-accounts" class="empty no-accounts" hidden><strong>No accounts yet</strong>Accounts appear after their first conversation or background event. Refresh after activity begins.</div>
    <div id="workspace" class="workspace">
      <aside class="lanes" aria-label="Threads for selected account">
        <div class="lane-heading"><h2>Foreground</h2><span>Telegram conversation</span></div>
        <div id="foreground"></div>
        <div class="lane-route">Decisions arrive in this thread</div>
        <div class="lane-heading background-heading"><h2>Background actors</h2><span id="background-count"></span></div>
        <div id="background" class="background-list"></div>
        <div class="hook-control"><div class="hook-top"><strong>Proactive hooks</strong><span id="hooks-status" class="status">Unknown</span></div><p id="hooks-description" class="hint">Waiting for the account’s hook state.</p><button id="toggle-hooks" type="button" hidden>Pause proactive hooks</button></div>
      </aside>
      <section class="inspector" aria-label="Thread inspector">
        <div class="tabs" role="tablist" aria-label="Inspect account"><button id="events-tab" type="button" role="tab" aria-selected="true" aria-controls="events-panel" tabindex="0">Event timeline</button><button id="memory-tab" type="button" role="tab" aria-selected="false" aria-controls="memory-panel" tabindex="-1">Entity memory</button><button id="graph-tab" type="button" role="tab" aria-selected="false" aria-controls="graph-panel" tabindex="-1">Node graph</button></div>
        <div id="events-panel" role="tabpanel" aria-labelledby="events-tab">
          <div class="panel-head"><div class="panel-title"><div><h2 id="thread-title">Select a thread</h2><code id="thread-id"></code></div><span id="thread-status" class="status" hidden></span></div><div id="thread-root" class="thread-root" hidden></div><div class="pipeline" aria-label="Event sequence"><span>Hook</span><b aria-hidden="true">→</b><span>Index</span><b aria-hidden="true">→</b><span>Reflect</span><b aria-hidden="true">→</b><span>Decide</span><b aria-hidden="true">→</b><span>Telegram</span></div></div>
          <div class="filters"><div class="filter-field"><label for="event-search">Search loaded events, IDs, or causes</label><input id="event-search" type="search" placeholder="Event, cause, root, text…" autocomplete="off"></div><div class="filter-field"><label for="event-kind">Event category</label><select id="event-kind"><option value="all">All events</option><option value="decision">Decisions</option><option value="delivery">Telegram &amp; media</option><option value="runtime">Sandbox &amp; browser</option><option value="memory">Learning &amp; changes</option><option value="failure">Failures &amp; unknowns</option></select></div></div>
          <p id="event-tally" class="event-tally"></p><div id="events" class="events"></div><div class="load-row"><button id="load-more" type="button" hidden>Load next 100 events</button></div>
        </div>
        <div id="memory-panel" role="tabpanel" aria-labelledby="memory-tab" hidden>
          <div class="panel-head"><div class="panel-title"><div><h2>What this account has learned</h2><code id="memory-account"></code></div><span id="memory-complete" class="status" hidden></span></div><p class="memory-summary">Native entity-learn observations and source state, scoped to this account.</p><div id="memory-root" class="thread-root" hidden></div></div>
          <div class="memory-filter"><label for="memory-search">Search this account’s memory</label><input id="memory-search" type="search" maxlength="512" placeholder="Entity, title, subject, or observation…" autocomplete="off"></div>
          <p id="memory-error" class="inline-error" role="status" hidden></p><p id="memory-tally" class="event-tally"></p><div id="memory-list" class="memory-list"></div>
          <details id="memory-sources" class="source-details"><summary id="sources-title">Source state</summary><pre id="sources-data"></pre></details>
        </div>
        ${GRAPH_MARKUP}
      </section>
    </div>
  </section>
  <p id="feedback" class="feedback" role="status" aria-live="polite"></p>
  <footer class="footer"><span id="last-refresh">No account data loaded.</span><span>Native Tardigrade threads · entity-learn memory</span></footer>
</main>
</div>
<script>
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = {token:'',operator:false,writable:false,account:'',accounts:[],threads:[],foreground:'',selected:'',paused:null,tab:'events',epoch:0,lastRefresh:null,hasThreadData:false};
  const eventCache = new Map();
  const memoryCache = new Map();
  const requests = new Set();
  let timer = null, refreshJob = null, refreshAgain = false, moreAgain = false, actionBusy = false;
  let actorVersion = '', eventVersion = '', memoryVersion = '';
  const element = (tag, className, text) => { const node = document.createElement(tag); if(className) node.className = className; if(text !== undefined) node.textContent = String(text); return node; };
  const message = (text, error = false) => { $('feedback').textContent = text; $('feedback').classList.toggle('error',error); };
  const redact = value => JSON.parse(JSON.stringify(value, (key, item) => /^(authorization|cookie|set-cookie|password|secret|token|accessToken|refreshToken|apiKey|api_key|client_secret)$/i.test(key) ? '[redacted]' : item));
  const printable = value => typeof value === 'string' ? value : JSON.stringify(value);
  const formatTime = value => { if(value === null || value === undefined || value === '') return 'No timestamp'; const date = new Date(value); return Number.isNaN(date.getTime()) ? 'Unknown timestamp' : date.toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}); };
  const roleTitle = thread => thread.role === 'foreground' || thread.visibility === 'foreground' ? 'Telegram conversation' : thread.role === 'indexer' ? 'Learning indexer' : thread.role === 'reflection' ? 'Reflection' : 'Background actor';
  const canManageHooks = () => state.operator || state.writable;
  const accessLabel = () => state.operator ? 'Operator access · all accounts' : state.writable ? 'Account access · can manage hooks' : 'Account access · read only';
  const memoryKey = (account = state.account, query = $('memory-search').value.trim()) => JSON.stringify([account,query]);
  const badge = status => { const allowed = ['idle','running','failed','blocked','delivered','rejected','unknown']; return element('span','status ' + (allowed.includes(status) ? status : ''), status || 'unknown'); };
  const empty = (title, body) => {const node = element('div','empty'); node.append(element('strong','',title),element('span','',body)); return node;};
${GRAPH_SCRIPT}
  function invalidate() { state.epoch++; clearTimeout(timer); for(const controller of requests) controller.abort(); requests.clear(); refreshJob = null; refreshAgain = false; moreAgain = false; }
  async function api(path, body) {
    const controller = new AbortController(); requests.add(controller);
    const timeout = setTimeout(() => controller.abort(),15000);
    try {
      const response = await fetch('/api/control/' + path,{method:body === undefined ? 'GET' : 'POST',headers:{authorization:'Bearer ' + state.token,...(body === undefined ? {} : {'content-type':'application/json'})},body:body === undefined ? undefined : JSON.stringify(body),signal:controller.signal,cache:'no-store',credentials:'omit',redirect:'error'});
      let data; try { data = await response.json(); } catch { const error = new Error('The server returned an unreadable response.'); error.status = response.status; throw error; }
      if(!response.ok) { const error = new Error(response.status === 401 || response.status === 403 ? 'The token does not authorize this account or action.' : 'The server could not complete the request (HTTP ' + response.status + ').'); error.status = response.status; throw error; }
      return data;
    } finally {clearTimeout(timeout);requests.delete(controller);}
  }
  function connection(text, status = '') { $('connection').textContent = text; $('connection').className = 'status ' + status; }
  function resetViews() {
    eventCache.clear(); memoryCache.clear(); graphView.reset(); actorVersion = ''; eventVersion = ''; memoryVersion = '';
    state.threads = []; state.selected = ''; state.foreground = ''; state.paused = null; state.hasThreadData = false;
    $('foreground').replaceChildren(); $('background').replaceChildren(); $('events').replaceChildren(); $('memory-list').replaceChildren(); $('sources-data').textContent = '';
    $('event-search').value = ''; $('event-kind').value = 'all'; $('memory-search').value = '';
    $('event-tally').textContent = ''; $('memory-tally').textContent = ''; $('thread-id').textContent = '';
    $('thread-title').textContent = 'Select a thread'; $('thread-status').hidden = true; $('thread-root').hidden = true;
    $('memory-root').hidden = true; $('memory-error').hidden = true; $('memory-complete').hidden = true; $('load-more').hidden = true;
    $('hooks-status').textContent = 'Unknown'; $('hooks-status').className = 'status'; $('toggle-hooks').disabled = true;
  }
  function lock(text = 'Panel locked. Account data and the token have been cleared from this tab.') {
    invalidate(); state.token = ''; state.operator = false; state.writable = false; state.accounts = []; state.account = ''; state.lastRefresh = null; actionBusy = false;
    resetViews(); $('account').replaceChildren(); delete $('account').dataset.version; $('token').value = ''; $('workspace-wrap').hidden = true; $('access').hidden = false; $('lock').hidden = true; $('unlock').disabled = false; $('refresh').disabled = false;
    $('memory-account').textContent = ''; $('scope').textContent = ''; $('last-refresh').textContent = 'No account data loaded.'; connection('Locked'); message(text); $('token').focus();
  }
  function updateAccountOptions(accounts) {
    const current = state.account;
    const optionsVersion = JSON.stringify(accounts.map(item => [item.account,item.threads]));
    if($('account').dataset.version !== optionsVersion) {
      $('account').replaceChildren(...accounts.map(item => { const option = element('option','',item.account + ' · ' + item.threads + (item.threads === 1 ? ' thread' : ' threads')); option.value = item.account; return option; }));
      $('account').dataset.version = optionsVersion;
    }
    $('account').value = current;
  }
  function selectAccount(account) {
    invalidate(); resetViews(); state.account = account; actionBusy = false;
    const entry = state.accounts.find(item => item.account === account); state.foreground = entry ? entry.foreground : '';
    $('account').value = account; $('workspace').hidden = !account; $('no-accounts').hidden = !!account;
    $('memory-account').textContent = account; $('scope').textContent = accessLabel();
    $('toggle-hooks').hidden = !canManageHooks(); state.lastRefresh = null; $('last-refresh').textContent = 'Loading account data…';
    renderThreads(); renderEvents(); renderMemory(); refresh();
  }
  function selectThread(id) {
    if(!state.threads.some(thread => thread.id === id)) { message('That thread is not available in this account.'); return; }
    if(state.selected === id && state.tab === 'events') return;
    invalidate(); state.selected = id; $('event-search').value = ''; $('event-kind').value = 'all'; eventVersion = ''; setTab('events',false); renderThreads(); renderEvents(); refresh();
  }
  function actorCard(thread) {
    const foreground = thread.id === state.foreground || thread.role === 'foreground' || thread.visibility === 'foreground';
    const button = element('button','actor-card' + (foreground ? ' foreground-card' : '')); button.type = 'button'; button.dataset.thread = thread.id;
    button.setAttribute('aria-pressed',String(state.selected === thread.id)); button.setAttribute('aria-label',roleTitle(thread) + ', ' + thread.id + ', ' + (thread.status || 'unknown')); button.disabled = actionBusy;
    const top = element('div','actor-top'); top.append(element('span','actor-title',roleTitle(thread)),badge(thread.status));
    const meta = element('div','actor-meta'); meta.append(element('span','',(thread.eventCount || 0) + ' events'),element('span','',formatTime(thread.updatedAt)));
    button.append(top,element('code','',thread.id),element('p','actor-summary',thread.summary || 'No activity summary recorded.'),meta);
    button.addEventListener('click',() => selectThread(thread.id)); return button;
  }
  function renderThreads() {
    const version = JSON.stringify([state.threads,state.selected,state.paused,state.operator,state.writable,actionBusy,state.hasThreadData]);
    if(actorVersion === version) return; actorVersion = version;
    const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.thread : null;
    const foreground = state.threads.filter(thread => thread.id === state.foreground || thread.role === 'foreground' || thread.visibility === 'foreground');
    const background = state.threads.filter(thread => !foreground.includes(thread));
    $('foreground').replaceChildren(...(foreground.length ? foreground.map(actorCard) : [empty(state.hasThreadData ? 'No foreground activity yet' : 'Loading foreground thread…',state.hasThreadData ? 'The Telegram conversation appears after its first recorded event.' : 'Reading this account’s thread records.')]));
    $('background').replaceChildren(...(background.length ? background.map(actorCard) : [empty(state.hasThreadData ? 'No background actors yet' : 'Loading background actors…',state.hasThreadData ? 'A hook starts indexing and reflection when there is work to process.' : 'Reading this account’s working threads.')]));
    $('background-count').textContent = String(background.length);
    $('hooks-status').textContent = state.paused === null ? 'Unknown' : state.paused ? 'Paused' : 'Enabled';
    $('hooks-status').className = 'status ' + (state.paused === null ? '' : state.paused ? 'blocked' : 'running');
    $('hooks-description').textContent = state.paused === null ? 'Waiting for the account’s hook state.' : state.paused ? 'New proactive work is paused. Already-running work may still finish.' : 'Incoming hooks can start background learning and reflection.';
    $('toggle-hooks').textContent = state.paused ? 'Resume proactive hooks' : 'Pause proactive hooks'; $('toggle-hooks').disabled = actionBusy || state.paused === null;
    $('account').disabled = actionBusy; $('events-tab').disabled = actionBusy; $('memory-tab').disabled = actionBusy; $('graph-tab').disabled = actionBusy; $('memory-search').disabled = actionBusy;
    if(focused) { const button = [...document.querySelectorAll('[data-thread]')].find(node => node.dataset.thread === focused); if(button) button.focus({preventScroll:true}); }
  }
  function eventStatus(event) {return event.result && typeof event.result === 'object' ? event.result.status : event.status;}
  function isFailure(event) {return /Failed|Failure|Error|Unavailable/.test(event.type || '') || ['failed','unknown','rejected','error','unsupported'].includes(eventStatus(event));}
  function eventCategory(event) { const type = event.type || ''; return /Decision/.test(type) ? 'decision' : /Delivery|ReplyPrepared|Telegram/.test(type) || event.media || event.telegram ? 'delivery' : /Sandbox|Browser/.test(type) ? 'runtime' : /Knowledge|Index|Memory|Learn/.test(type) ? 'memory' : 'other'; }
  function eventTitle(event) {
    const type = event.type || 'Event';
    const titles = {AikoConnectionChanged:'App connection changed',AikoLoginSubmitted:'Private login submitted',AikoLoginAttemptFailed:'Private login needs attention',AikoConnectionIndexRequested:'Connected app context queued',AikoHookReceived:'Hook received',AikoIndexRequested:'Learning index requested',AikoKnowledgeChanged:'Knowledge changed',AikoReflectionRequested:'Reflection requested',AikoDecisionRecorded:'Decision recorded',AikoDecisionPublished:'Decision sent to foreground',AikoProactiveDecision:'Background decision received',AikoReplyPrepared:'Telegram reply prepared',AikoDeliverySettled:'Telegram delivery settled',AikoTelegramActionStarted:'Telegram capability started',AikoTelegramActionSettled:'Telegram capability settled',AikoTelegramTypingStarted:'Typing indicator started',AikoTelegramTypingStopped:'Typing indicator stopped',AikoSandboxProvisioning:'Private sandbox provisioning',AikoSandboxStarting:'Private sandbox starting',AikoSandboxReady:'Private sandbox ready',AikoSandboxStopped:'Private sandbox stopped',AikoSandboxUnavailable:'Sandbox needs reconciliation',AikoBackgroundFailed:'Background work failed',AikoHooksConfigured:'Proactive hooks configured',MessageReceived:'Message received',TurnCompleted:'Actor turn completed'};
    return titles[type] || type.replace(/^Aiko/,'').replace(/([a-z])([A-Z])/g,'$1 $2');
  }
  function field(list, label, value, threadLink = false) {
    if(value === undefined || value === null || value === '') return;
    const dt = element('dt','',label), dd = element('dd');
    if(threadLink && typeof value === 'string' && state.threads.some(thread => thread.id === value)) {
      const button = element('button','thread-link',value); button.type = 'button'; button.addEventListener('click',() => selectThread(value)); dd.append(button);
    } else {dd.append(element('code','',printable(value)));}
    list.append(dt,dd);
  }
  function rootDisplay(target, root) {target.hidden = !root; target.replaceChildren(); if(root) target.append(element('span','','Merkle root'),element('code','',root));}
  function eventNode(row, openRaw) {
    const event = redact(row.event || {}), status = eventStatus(event), category = eventCategory(event);
    const node = element('article','event' + (isFailure(event) ? status === 'unknown' ? ' warning' : ' failure' : category === 'decision' ? ' decision' : '')); node.id = 'event-' + row.seq;
    const head = element('div','event-header'); head.append(element('h3','',eventTitle(event)),element('span','event-time','#' + row.seq + ' · ' + formatTime(event.at)));
    node.append(head,element('div','event-type',event.type || 'Untyped event'));
    if(event.decision === 'notify' || event.decision === 'silent') node.append(element('p','event-note',event.decision === 'notify' ? 'Decision: notify the Telegram conversation' : 'Decision: keep this in the background'));
    const action = event.action || event.result && event.result.action, finalSend = /Delivery/.test(event.type || '') || ['telegram_send','telegram_voice','telegram_screenshot'].includes(action);
    if(status === 'unknown') node.append(element('p','event-note warning',finalSend ? 'Delivery outcome unknown. Telegram delivery has not been confirmed; it will not be automatically repeated.' : 'Capability outcome unknown. The action has not been confirmed and must not be blindly repeated.'));
    else if(status === 'rejected') node.append(element('p','event-note failure',finalSend ? 'Delivery rejected. This event does not confirm that the user received the reply.' : 'Capability request rejected.'));
    else if(status === 'delivered') node.append(element('p','event-note',(finalSend ? 'Telegram delivery confirmed' : 'Telegram capability acknowledged') + (event.result && event.result.providerId ? ' · message ' + event.result.providerId : '') + '.'));
    else if(status === 'unsupported') node.append(element('p','event-note warning','Media processing is unsupported or incomplete. No unprocessed content is claimed as understood.'));
    else if(status === 'processed') node.append(element('p','event-note','Media processed' + (event.result && event.result.truncated ? ' with limited or sampled coverage.' : '.')));
    if(event.type === 'AikoSandboxUnavailable') node.append(element('p','event-note warning','Sandbox state needs operator reconciliation. Duplicate allocation is not attempted.'));
    const telegram = event.telegram || {}, media = Array.isArray(event.media) ? event.media : Array.isArray(telegram.media) ? telegram.media : [];
    for(const item of media) {const detail = [item.kind,item.fileName,item.mimeType,Number.isFinite(item.size) ? item.size.toLocaleString() + ' bytes' : '',Number.isFinite(item.duration) ? item.duration + 's' : ''].filter(Boolean).join(' · '); const entry = element('div','event-note',detail); if(item.fileId) entry.append(element('div','mono',item.fileId)); node.append(entry);}
    if(event.errorCode || event.type === 'AikoBackgroundFailed') node.append(element('p','event-note failure',[event.stage,event.errorCode || 'Background processing failed'].filter(Boolean).join(' · ')));
    if(event.type === 'AikoHooksConfigured') node.append(element('p','event-note',event.paused ? 'New proactive work paused.' : 'Proactive hooks enabled.'));
    for(const value of [event.reason,event.text,typeof event.output === 'string' ? event.output : null,event.result && event.result.text]) if(typeof value === 'string' && value.trim()) {const text = element('p','event-text',value); text.tabIndex = 0; text.setAttribute('aria-label',eventTitle(event) + ' text, event ' + row.seq); node.append(text);}
    const fields = element('dl','fields'); field(fields,'App',event.domain); field(fields,'Connection',event.connectionId); field(fields,'Event ID',event.id); field(fields,'Cause',event.cause); field(fields,'Turn',event.turn); field(fields,'Action',action); field(fields,'Account',event.owner); field(fields,'Sandbox',event.sandbox); field(fields,'Runner',event.runnerVersion); field(fields,'Album',telegram.mediaGroupId || event.mediaGroupId); field(fields,'Reply to',telegram.replyTo && telegram.replyTo.messageId); field(fields,'Callback',telegram.callback && telegram.callback.data); field(fields,'File',event.result && event.result.fileId); field(fields,'Source',event.sourceThread,true); field(fields,'Target',event.target || event.targetThread,true); field(fields,'Subject',event.subject); if(fields.childNodes.length) node.append(fields);
    if(event.root || event.previousRoot) {const roots = element('div','root-change'); if(event.previousRoot) roots.append(element('span','','Before'),element('code','',event.previousRoot)); if(event.root) roots.append(element('span','',event.previousRoot ? 'After' : 'Root'),element('code','',event.root)); node.append(roots);}
    if(Array.isArray(event.changed)) node.append(element('p','hint',event.changed.length + ' changed observation' + (event.changed.length === 1 ? '' : 's') + (event.complete === false ? ' · index incomplete' : '')));
    if(Array.isArray(event.supports) && event.supports.length) {const details = element('details'); details.dataset.openKey = 'supports-' + row.seq; details.open = openRaw.has(details.dataset.openKey); details.append(element('summary','',event.supports.length + ' decision citation' + (event.supports.length === 1 ? '' : 's'))); const list = element('ul','supports'); list.append(...event.supports.map(value => element('li','',printable(value)))); details.append(list); node.append(details);}
    const raw = element('details'); raw.dataset.openKey = 'raw-' + row.seq; raw.open = openRaw.has(raw.dataset.openKey); raw.append(element('summary','','Raw event'),element('pre','',JSON.stringify(event,null,2))); node.append(raw); return node;
  }
  function renderEvents() {
    const thread = state.threads.find(item => item.id === state.selected), cache = eventCache.get(state.selected);
    $('thread-title').textContent = thread ? roleTitle(thread) : state.selected ? 'Loading thread…' : 'Select a thread'; $('thread-id').textContent = state.selected;
    $('thread-status').hidden = !thread; if(thread) {const status = badge(thread.status); $('thread-status').textContent = status.textContent; $('thread-status').className = status.className;}
    rootDisplay($('thread-root'),thread && thread.root);
    const query = $('event-search').value.toLowerCase().trim(), category = $('event-kind').value;
    const version = JSON.stringify([state.selected,cache,query,category]); if(eventVersion === version) return; eventVersion = version;
    const openRaw = new Set([...$('events').querySelectorAll('details[open]')].map(node => node.dataset.openKey));
    const rows = cache ? cache.rows : [];
    const filtered = rows.filter(row => {const event = row.event || {}; return (!query || JSON.stringify(redact(event)).toLowerCase().includes(query) || String(row.seq) === query) && (category === 'all' || (category === 'failure' ? isFailure(event) : eventCategory(event) === category));});
    $('event-tally').textContent = cache ? filtered.length + ' shown · ' + rows.length + ' loaded · oldest first' + (cache.hasMore ? ' · more history available' : '') : '';
    $('events').replaceChildren(...(filtered.length ? filtered.map(row => eventNode(row,openRaw)) : [empty(!state.selected ? 'Choose a thread' : !cache ? 'Loading recorded events…' : rows.length ? 'No matching loaded events' : 'No recorded events yet',!state.selected ? 'Select the conversation or a background actor to inspect its work.' : !cache ? 'Reading this account’s durable thread history.' : rows.length ? 'Try a different search or category. Load more history to search beyond this batch.' : 'New hook, actor, and delivery events will appear here when they are recorded.')]));
    $('load-more').hidden = !cache || !cache.hasMore;
  }
  function renderMemory() {
    const cache = memoryCache.get(memoryKey()), query = $('memory-search').value.trim();
    const version = JSON.stringify([state.account,cache,query,state.tab]); if(memoryVersion === version) return; memoryVersion = version;
    $('memory-account').textContent = state.account; rootDisplay($('memory-root'),cache && cache.root);
    $('memory-complete').hidden = !cache || typeof cache.complete !== 'boolean'; $('memory-complete').textContent = cache && cache.complete ? 'Index complete' : 'Partial index'; $('memory-complete').className = 'status ' + (cache && cache.complete ? 'running' : 'blocked');
    const items = cache && Array.isArray(cache.items) ? cache.items : [];
    const filtered = items;
    $('memory-tally').textContent = cache ? items.length + ' recalled observations · native search limits apply' : '';
    const opened = new Set([...$('memory-list').querySelectorAll('details[open]')].map(node => node.dataset.memoryKey));
    $('memory-list').replaceChildren(...(filtered.length ? filtered.map((item,index) => {
      const observation = redact(item.observation === undefined ? item : item.observation);
      const object = observation && typeof observation === 'object' ? observation : {};
      const details = element('details','memory-card'); details.dataset.memoryKey = String(object.id || object.observationId || object.subject || index); details.open = opened.has(details.dataset.memoryKey);
      const title = typeof object.title === 'string' ? object.title : typeof object.subject === 'string' ? object.subject : 'Recorded observation';
      const summary = element('summary','',title); summary.append(element('span','hint',[object.kind,object.subject,object.id].filter(value => typeof value === 'string').join(' · '))); details.append(summary,element('pre','',JSON.stringify(observation,null,2))); return details;
    }) : [empty(!cache ? state.tab === 'memory' ? 'Loading account memory…' : 'Open memory to load observations' : query ? 'No matching observations' : 'No observations recalled',!cache ? 'The panel reads the selected account’s native entity-learn store.' : query ? 'Try an entity name, observation title, or a shorter search.' : 'Learned entities and facts appear after this account’s indexing work completes.')]));
    const sources = cache && Array.isArray(cache.sources) ? cache.sources : [];
    $('sources-title').textContent = 'Source state · ' + sources.length + (sources.length === 1 ? ' source' : ' sources'); $('sources-data').textContent = cache ? JSON.stringify(redact(sources),null,2) : 'No source state loaded.';
  }
  function setTab(tab, shouldRefresh = true) {
    state.tab = tab;
    for(const name of ['events','memory','graph']) {const active = tab === name;$(name+'-tab').setAttribute('aria-selected',String(active));$(name+'-tab').tabIndex = active ? 0 : -1;$(name+'-panel').hidden = !active;}
    if(shouldRefresh) {invalidate();renderMemory();graphView.render();refresh();}
  }
  function schedule() {clearTimeout(timer); if(state.token && $('auto').checked && !document.hidden && !actionBusy) timer = setTimeout(refresh,5000);}
  async function refresh(loadMore = false) {
    clearTimeout(timer); if(!state.token || actionBusy) return;
    if(refreshJob) {refreshAgain = true;moreAgain = moreAgain || loadMore;return;}
    const job = {epoch:state.epoch,account:state.account,selected:state.selected,memoryQuery:$('memory-search').value.trim()}; refreshJob = job; $('refresh').disabled = true; $('load-more').disabled = true; connection('Refreshing');
    try {
      const oldEvents = eventCache.get(job.selected);
      const readEvents = state.tab === 'events' && !!job.selected && (!oldEvents || !oldEvents.hasMore || loadMore);
      const readMemory = state.tab === 'memory' && !!job.account;
      const results = await Promise.allSettled([
        api('accounts'),
        job.account ? api('threads?account=' + encodeURIComponent(job.account)) : Promise.resolve(null),
        readEvents ? api('events?thread=' + encodeURIComponent(job.selected) + '&after=' + (oldEvents ? oldEvents.after : 0) + '&limit=100') : Promise.resolve(null),
        readMemory ? api('memory?account=' + encodeURIComponent(job.account) + '&search=' + encodeURIComponent(job.memoryQuery)) : Promise.resolve(null),
        state.tab === 'graph' && job.account ? graphView.load(job.account,job.epoch) : Promise.resolve(null)
      ]);
      if(job.epoch !== state.epoch) return;
      for(const result of results) if(result.status === 'rejected' && [401,403].includes(result.reason.status)) throw result.reason;
      for(const result of [...results.slice(0,3),results[4]]) if(result.status === 'rejected') throw result.reason;
      const accounts = results[0].value, threads = results[1].value, events = results[2].value;
      state.accounts = Array.isArray(accounts.accounts) ? accounts.accounts : []; state.operator = accounts.operator === true; state.writable = accounts.writable === true;
      updateAccountOptions(state.accounts);
      if(!state.accounts.some(item => item.account === state.account) && (state.account || state.accounts.length)) { selectAccount(state.accounts[0] ? state.accounts[0].account : ''); return; }
      if(threads) {
        state.threads = Array.isArray(threads.threads) ? threads.threads : []; state.hasThreadData = true; state.foreground = threads.foreground; state.paused = threads.hooks && typeof threads.hooks.paused === 'boolean' ? threads.hooks.paused : null;
        if(!state.threads.some(thread => thread.id === state.selected)) {const foreground = state.threads.find(thread => thread.id === state.foreground); const next = foreground ? foreground.id : state.threads[0] ? state.threads[0].id : ''; if(next !== state.selected) {state.selected = next; refreshAgain = !!next;}}
      }
      if(events) {
        const rows = new Map((oldEvents ? oldEvents.rows : []).map(row => [row.seq,row])); for(const row of events.events || []) rows.set(row.seq,row);
        eventCache.set(job.selected,{rows:[...rows.values()].sort((a,b) => a.seq-b.seq),after:events.nextAfter,hasMore:events.hasMore === true});
      }
      if(readMemory) {
        const memory = results[3]; $('memory-error').hidden = memory.status === 'fulfilled';
        if(memory.status === 'fulfilled') memoryCache.set(memoryKey(job.account,job.memoryQuery),memory.value);
        else $('memory-error').textContent = 'Memory could not be loaded. ' + (memory.reason.status === 404 ? 'This server does not expose the memory inspector.' : 'Check the account’s memory source state and refresh.');
      }
      $('scope').textContent = accessLabel(); $('toggle-hooks').hidden = !canManageHooks();
      renderThreads(); renderEvents(); renderMemory(); state.lastRefresh = Date.now(); $('last-refresh').textContent = 'Last refreshed ' + formatTime(state.lastRefresh) + ' · times shown in your browser’s timezone'; connection($('auto').checked ? 'Watching' : 'Manual refresh', 'running');
      message(readMemory && results[3].status === 'rejected' ? 'Threads refreshed. Memory is currently unavailable.' : '');
    } catch(error) {
      if(job.epoch !== state.epoch) return;
      if(error.status === 401 || error.status === 403) {lock('Access expired or was denied. Enter a token authorized for this account.');return;}
      connection('Refresh failed','failed'); message('Refresh failed. Showing the last data received, which may be out of date. Check that Aiko is running and refresh again.',true);
    } finally {
      if(refreshJob === job) {refreshJob = null; $('refresh').disabled = false; $('load-more').disabled = false; if(refreshAgain) {const nextMore = moreAgain;refreshAgain = false;moreAgain = false;refresh(nextMore);} else schedule();}
    }
  }
  $('login').addEventListener('submit',async event => {
    event.preventDefault(); const token = $('token').value.trim(); if(!token) return;
    invalidate(); const epoch = state.epoch; state.token = token; $('token').value = ''; $('unlock').disabled = true; message('Checking access…');
    try { const data = await api('accounts'); if(epoch !== state.epoch) return; state.accounts = Array.isArray(data.accounts) ? data.accounts : []; state.operator = data.operator === true; state.writable = data.writable === true; $('access').hidden = true; $('workspace-wrap').hidden = false; $('lock').hidden = false; updateAccountOptions(state.accounts); selectAccount(state.accounts[0] ? state.accounts[0].account : ''); $('account').focus(); }
    catch(error) {if(epoch !== state.epoch) return;state.token = '';connection('Locked');message(error.status === 401 || error.status === 403 ? 'Access denied. Enter an operator or account token authorized for this panel.' : 'Could not connect. Check that Aiko is running, then enter your token again.',true);$('token').focus();}
    finally {if(epoch === state.epoch || state.token) $('unlock').disabled = false;}
  });
  $('lock').addEventListener('click',() => lock());
  $('account').addEventListener('change',() => selectAccount($('account').value));
  $('refresh').addEventListener('click',() => refresh());
  $('auto').addEventListener('change',() => {clearTimeout(timer);if($('auto').checked) refresh();else if(!refreshJob) connection('Manual refresh');});
  $('load-more').addEventListener('click',() => refresh(true));
  $('event-search').addEventListener('input',renderEvents); $('event-kind').addEventListener('change',renderEvents);
  $('memory-search').addEventListener('input',() => {invalidate();$('memory-error').hidden = true;renderMemory();timer = setTimeout(refresh,300);});
  const tabs = ['events','memory','graph'];
  for(const name of tabs) {$(name+'-tab').addEventListener('click',()=>setTab(name));$(name+'-tab').addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?tabs[0]:event.key==='End'?tabs.at(-1):tabs[(tabs.indexOf(state.tab)+(event.key==='ArrowLeft'?2:1))%3];setTab(next);$(next+'-tab').focus();}});}
  $('toggle-hooks').addEventListener('click',async () => {
    if(!canManageHooks() || state.paused === null || actionBusy) return;
    invalidate(); const epoch = state.epoch, account = state.account, paused = !state.paused; let failure = ''; actionBusy = true; renderThreads();
    try {await api('hooks',{account,paused});if(epoch !== state.epoch) return;message('Hook change accepted. Reading the recorded account state.');}
    catch(error) {if(epoch !== state.epoch) return;failure = error.status === 403 ? 'This credential cannot change proactive hooks.' : 'The hook change was not confirmed. Review the refreshed state before trying again.';}
    finally {if(epoch === state.epoch) {actionBusy = false;renderThreads();await refresh();if(failure && epoch === state.epoch) message(failure,true);}}
  });
  document.addEventListener('visibilitychange',() => {clearTimeout(timer);if(!document.hidden && state.token && $('auto').checked) refresh();});
  window.addEventListener('pagehide',() => lock('Panel locked when the page was left.'));
})();
</script>
</body>
</html>`;
