/** The lab renders completed fixture reports. Dynamic values only enter text/property APIs. */
export const REQUEST_LAB_STYLE = `
.request-lab-active .workspace{grid-template-columns:minmax(0,1fr)}.request-lab-active .lanes{display:none}
.lab{--lab-gutter:26px;min-width:0}.lab-header{display:flex;justify-content:space-between;gap:24px;padding:28px var(--lab-gutter) 20px}.lab-header h2{font-size:29px;letter-spacing:-.9px;line-height:1.2;margin:9px 0}.lab-header p{max-width:680px;font-size:13px;color:var(--muted)}.lab-label{display:inline-flex;align-items:center;gap:8px;color:var(--teal);font:11px var(--mono);letter-spacing:.25px}.lab-label:before{content:"";width:8px;height:8px;border:2px solid currentColor;border-radius:2px}.lab-isolation{align-self:flex-start;flex:none;border:1px solid var(--line);border-radius:8px;padding:10px 13px;font:11px/1.7 var(--mono);color:var(--muted)}.lab-isolation strong{display:block;color:var(--ink);font-weight:600}
.lab-actions{padding:0 var(--lab-gutter) 18px;display:flex;gap:9px;flex-wrap:wrap}.lab-actions button{font-size:12px;min-height:44px}.lab-actions button[data-scenario="missing_dependency"]{color:var(--rose)}.lab-actions button[aria-pressed="true"]{box-shadow:inset 0 -3px var(--blue)}.lab-action-note{padding:0 var(--lab-gutter) 18px;color:var(--muted);font-size:11px}.lab-notice{padding:13px var(--lab-gutter);background:var(--ice);border-block:1px solid var(--line);font-size:12px;color:var(--muted)}.lab-notice[data-tone="error"]{color:var(--rose);background:var(--rose-light)}.lab-notice[data-tone="warning"]{color:var(--amber);background:var(--amber-light)}.lab-notice[data-tone="success"]{color:var(--teal);background:var(--teal-light)}
.lab-empty{padding:40px var(--lab-gutter) 46px;max-width:850px}.lab-empty h3{font-size:20px;margin-bottom:10px}.lab-empty p{color:var(--muted);font-size:13px;max-width:590px}.lab-empty-chain{display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin-top:24px;color:var(--muted);font:12px var(--mono)}.lab-empty-chain span{border-bottom:2px solid var(--line);padding-bottom:7px}.lab-empty-chain b{font-weight:400;color:var(--teal)}
.lab-report{min-width:0}.lab-run-head{display:flex;gap:18px;justify-content:space-between;align-items:start;padding:24px var(--lab-gutter) 18px}.lab-run-head h3{font-size:19px;margin-bottom:5px}.lab-run-head p{font-size:12px;color:var(--muted);max-width:840px}.lab-run-meta{flex:none;font:11px var(--mono);color:var(--muted);text-align:right}.lab-run-meta span{display:block;margin-top:5px}.lab-badge{display:inline-block;padding:3px 7px;font:10px/1.5 var(--mono);color:var(--teal);background:var(--teal-light);border-radius:4px}.lab-badge.warn{color:var(--amber);background:var(--amber-light)}.lab-badge.fail{color:var(--rose);background:var(--rose-light)}
.lab-flow{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:17px;padding:4px var(--lab-gutter) 25px;position:relative}.lab-stage{min-width:0;position:relative}.lab-stage:not(:last-child):after{content:"→";position:absolute;right:-14px;top:47px;font:13px var(--mono);color:var(--teal)}.lab-stage-label{font:10px var(--mono);color:var(--muted);margin:0 0 9px;letter-spacing:.3px}.lab-node{width:100%;min-height:88px;display:flex;flex-direction:column;align-items:start;justify-content:space-between;gap:10px;text-align:left;padding:12px;margin-bottom:8px;border-radius:7px;border-top:3px solid var(--blue);overflow-wrap:anywhere}.lab-node strong{font:600 11px/1.6 var(--mono)}.lab-node small{font-size:10px;color:var(--muted);font-weight:400}.lab-node[data-kind="request"],.lab-node[data-kind="pointer"]{border-top-color:var(--teal)}.lab-node[data-state="stale"]{border-top-color:var(--amber);background:var(--amber-light)}.lab-node[data-state="blocked"]{border-top-color:var(--rose);background:var(--rose-light)}.lab-node[aria-pressed="true"]{outline:2px solid var(--blue);outline-offset:2px;background:var(--blue-light)}
.lab-harness{display:flex;gap:16px;flex-wrap:wrap;align-items:center;padding:14px var(--lab-gutter);border-block:1px solid var(--line);background:var(--ice)}.lab-harness-label{font:11px var(--mono);color:var(--muted)}.lab-harness code{color:var(--ink);font-size:12px}.lab-harness .lab-badge{margin-left:auto}.lab-grid{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr)}.lab-comparison,.lab-selection{padding:24px var(--lab-gutter);min-width:0}.lab-selection{border-left:1px solid var(--line)}.lab-section-title{font-size:14px;margin-bottom:12px}.lab-selection p,.lab-section-hint{font-size:12px;color:var(--muted);margin-top:8px}.lab-fields{display:grid;grid-template-columns:105px minmax(0,1fr);gap:10px 12px;font-size:11px;margin:15px 0}.lab-fields dt{color:var(--muted)}.lab-fields dd{margin:0;overflow-wrap:anywhere}.lab-fields code{font-size:10px}.lab-relations{display:grid;gap:6px}.lab-relations button{text-align:left;font-size:11px;min-height:40px;overflow-wrap:anywhere;font-weight:400}
.lab-values{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.lab-value{background:var(--ice);padding:13px;border-radius:6px;min-width:0}.lab-value[data-changed="true"]{background:var(--teal-light)}.lab-value-label{display:flex;gap:8px;justify-content:space-between;color:var(--muted);font:10px var(--mono);margin-bottom:11px}.lab-value pre{color:var(--ink);font-size:11px;overflow-wrap:anywhere}.lab-freshness{display:flex;flex-wrap:wrap;gap:9px;align-items:center;margin-top:17px;font-size:11px;color:var(--muted)}.lab-freshness strong{color:var(--ink);font-weight:550}.lab-limitation{margin-top:16px;padding:12px;border-left:3px solid var(--amber);background:var(--amber-light);color:var(--amber);font-size:12px}.lab-limitation strong{display:block;font-size:11px;margin-bottom:5px}.lab-response-id{margin-top:11px;color:var(--muted);font-size:10px;overflow-wrap:anywhere}.lab-response-id code{font-size:10px}
.lab-evidence{border-top:1px solid var(--line);padding:24px var(--lab-gutter)}.lab-evidence-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:26px}.lab-checks{list-style:none;padding:0;margin:0;display:grid;gap:13px}.lab-checks li{position:relative;padding-left:24px;font-size:12px}.lab-checks li:before{content:"✓";position:absolute;left:0;top:0;font-family:var(--mono);color:var(--teal)}.lab-checks li[data-passed="false"]:before{content:"×";color:var(--rose)}.lab-checks p{font-size:11px;color:var(--muted);margin-top:3px}.lab-trace-run{margin:0 0 15px}.lab-trace-run h4{font-size:11px;margin:0 0 8px;display:flex;justify-content:space-between;gap:8px}.lab-trace-run ol{margin:0;padding-left:20px}.lab-trace-run li{padding:4px 0;font:10px/1.7 var(--mono);color:var(--muted);overflow-wrap:anywhere}.lab-trace-run li strong{color:var(--teal);font-weight:500}.lab-raw{margin-top:20px;border-top:1px solid var(--line);padding-top:14px}.lab-raw summary{font-size:11px;font-weight:550;min-height:36px}.lab-raw pre{max-height:300px;overflow:auto;background:var(--ice);padding:15px;font-size:10px;border-radius:6px;outline-offset:-3px}.lab-boundary{padding:18px var(--lab-gutter) 24px;border-top:1px solid var(--line);background:var(--ice)}.lab-boundary h3{font-size:12px}.lab-boundary ul{margin:9px 0 0;padding-left:17px;display:grid;gap:6px;font-size:11px;color:var(--muted)}.lab-recorded{margin:20px var(--lab-gutter);font-size:12px;min-height:44px}
@media(max-width:1020px){.lab-flow{grid-template-columns:repeat(3,minmax(0,1fr))}.lab-stage:nth-child(3):after{display:none}.lab-grid{grid-template-columns:1fr}.lab-selection{border-left:0;border-top:1px solid var(--line)}}
@media(max-width:640px){.tabs{flex-wrap:wrap;gap:0 17px;padding-inline:18px}.tabs button{font-size:12px;min-height:46px;padding-top:12px;padding-bottom:10px}.lab{--lab-gutter:18px}.lab-header{display:block;padding-top:22px}.lab-header h2{font-size:25px}.lab-isolation{display:none}.lab-flow{grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.lab-stage:after{display:none}.lab-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.lab-actions button{padding-inline:7px;min-width:0}.lab-run-head{display:block}.lab-run-meta{display:flex;gap:12px;text-align:left;margin-top:12px}.lab-run-meta span{margin:0}.lab-evidence-grid{grid-template-columns:1fr}.lab-harness{gap:8px}.lab-harness .lab-badge{margin-left:0}.lab-fields{grid-template-columns:80px minmax(0,1fr)}.lab-values{gap:8px}.lab-value{padding:10px}.lab-value-label{flex-wrap:wrap}}
@media(prefers-reduced-motion:reduce){.lab *{animation:none!important;transition:none!important}}
`;

export const REQUEST_LAB_MARKUP = `
<div id="request-lab-panel" class="lab" role="tabpanel" aria-labelledby="request-lab-tab" hidden>
  <div class="lab-header"><div><span class="lab-label">Controlled demo · isolated fixture</span><h2>Follow a request into memory.</h2><p>Compile two observed requests, reuse their pointer, and inspect what happens when the fresh response changes.</p></div><div class="lab-isolation"><strong>Real components. Fixture data.</strong>No external requests or publishing.</div></div>
  <div class="lab-actions" role="group" aria-label="Run a controlled request scenario"><button type="button" class="primary" data-scenario="baseline" disabled>Run baseline</button><button type="button" data-scenario="unchanged" disabled>Recheck unchanged</button><button type="button" data-scenario="changed" disabled>Change response</button><button type="button" data-scenario="missing_dependency" disabled>Break dependency</button></div>
  <p class="lab-action-note">Each scenario starts with a fresh baseline in disposable storage. Cache reuse is measured within that run; the selected account’s data is not used.</p>
  <p id="lab-notice" class="lab-notice" role="status" aria-live="polite">Open Request lab to check availability.</p>
  <div id="lab-empty" class="lab-empty"><h3>See which parts work, and where they stop.</h3><p>Run a baseline to inspect the real compiler, request executor, pointer cache, example workflow, and entity-learn dependency checks. Then compare a changed response or a missing upstream value.</p><div class="lab-empty-chain" aria-hidden="true"><span>Observed request</span><b>→</b><span>Callable pointer</span><b>→</b><span>Fresh response</span><b>→</b><span>Derived view</span></div></div>
  <div id="lab-report" class="lab-report" hidden>
    <div class="lab-run-head"><div><h3 id="lab-run-title"></h3><p id="lab-run-summary"></p></div><div id="lab-run-meta" class="lab-run-meta"></div></div>
    <div id="lab-flow" class="lab-flow" aria-label="Captured requests, contract, pointer, response checks and derived views"></div>
    <div id="lab-harness" class="lab-harness"></div>
    <div class="lab-grid"><section class="lab-comparison" aria-labelledby="lab-comparison-title"><h3 id="lab-comparison-title" class="lab-section-title">Response &amp; freshness</h3><div id="lab-values" class="lab-values"></div><div id="lab-freshness" class="lab-freshness"></div><div id="lab-limitation" class="lab-limitation" hidden></div></section><section id="lab-selection" class="lab-selection" aria-label="Selected node details"></section></div>
    <section class="lab-evidence" aria-label="Checks and request trace"><div class="lab-evidence-grid"><div><h3 class="lab-section-title">What the run checked</h3><ul id="lab-checks" class="lab-checks"></ul></div><div><h3 class="lab-section-title">Executed request trace</h3><div id="lab-trace"></div><details class="lab-raw"><summary id="lab-event-summary">Component events</summary><pre id="lab-events" tabindex="0" aria-label="Fixture component events"></pre></details></div></div></section>
    <div class="lab-boundary"><h3>What this demonstration proves</h3><ul id="lab-limits"></ul></div>
  </div>
  <button type="button" id="lab-recorded" class="lab-recorded">Inspect recorded account evidence →</button>
</div>`;

export const REQUEST_LAB_SCRIPT = String.raw`
  const requestLabView = (() => {
    let report = null, selected = '', capability = null, capabilityAccount = '', loading = null, busy = false, task = null, notice = '', tone = '';
    const buttons = () => [...$('request-lab-panel').querySelectorAll('[data-scenario]')];
    const labels = {baseline:'Baseline',unchanged:'Unchanged response',changed:'Changed response',missing_dependency:'Missing dependency'};
    const duration = value => Number.isFinite(value) ? (value < 10 ? value.toFixed(1) : Math.round(value)) + ' ms' : 'No timing';
    const pill = (text, kind = '') => element('span','lab-badge' + (kind ? ' ' + kind : ''),text);
    const pretty = value => JSON.stringify(value,null,2);
    function field(list, name, value) {list.append(element('dt','',name));const item=element('dd');item.append(element('code','',typeof value === 'string' ? value : pretty(value)));list.append(item);}
    function choose(id) {selected=id;renderNodes();renderSelection();}
    function renderNodes() {
      const stages = [['request','Requests'],['definition','Contract'],['pointer','Pointer'],['check','Fresh checks'],['derived','Derived views']];
      const focused = document.activeElement && document.activeElement.dataset.labNode;
      $('lab-flow').replaceChildren(...stages.map(([kind,label]) => {
        const group=element('div','lab-stage');group.append(element('p','lab-stage-label',label));
        for(const node of report.nodes.filter(item=>item.kind===kind)) {
          const button=element('button','lab-node');button.type='button';button.dataset.labNode=node.id;button.dataset.kind=node.kind;button.dataset.state=node.state;button.setAttribute('aria-pressed',String(selected===node.id));
          button.append(element('strong','',node.label),element('small','',node.state));button.addEventListener('click',()=>choose(node.id));group.append(button);
        }
        return group;
      }));
      if(focused) [...$('lab-flow').querySelectorAll('[data-lab-node]')].find(node=>node.dataset.labNode===focused)?.focus();
    }
    function renderSelection() {
      const target=$('lab-selection'), node=report.nodes.find(item=>item.id===selected) || report.nodes[0];target.replaceChildren();
      if(!node) return;
      target.append(element('h3','lab-section-title',node.label),pill(node.state,node.state==='stale'?'warn':''));
      const fields=element('dl','lab-fields');field(fields,'Identity',node.id);field(fields,'Kind',node.kind);
      if(node.kind==='definition') {field(fields,'Capture',report.capture.sourceTraceDigest);field(fields,'Prepared',report.capture.prepared);}
      if(node.kind==='pointer') {field(fields,'Reused',report.pointer.cacheReused);field(fields,'Embedding',report.pointer.embeddingModel);field(fields,'Embed calls',report.pointer.embeddingCalls);}
      if(node.kind==='request') {
        const requests=report.replays.flatMap(replay=>replay.requests.filter(request=>request.stepId===node.id).map(request=>({phase:replay.phase,...request})));
        for(const request of requests) field(fields,request.phase,request.method+' '+request.url);
      }
      if(node.kind==='check') {const replay=report.replays.find(item=>item.observationId===node.id);if(replay){field(fields,'Response',replay.responseDigest || 'No fingerprint');field(fields,'Changed',replay.changed);field(fields,'Result',replay.status+' · '+replay.code);}}
      if(node.kind==='derived') field(fields,'Source',node.id===report.derived.recomputedId?'Explicit fixture recomputation':'Original derived observation');
      target.append(fields);
      const relations=element('div','lab-relations');
      for(const edge of report.edges.filter(item=>item.from===node.id || item.to===node.id)) {
        const outgoing=edge.from===node.id, id=outgoing?edge.to:edge.from, other=report.nodes.find(item=>item.id===id);
        if(!other) continue;
        const button=element('button','',(outgoing?'→ ':'← ')+edge.relation.replaceAll('_',' ')+' · '+other.label);button.type='button';button.addEventListener('click',()=>{choose(id);[...$('lab-flow').querySelectorAll('[data-lab-node]')].find(item=>item.dataset.labNode===id)?.focus();});relations.append(button);
      }
      target.append(relations,element('p','', 'Select another node to inspect its recorded identity and relationships.'));
    }
    function renderComparison() {
      const first=report.replays[0], second=report.replays[1];
      $('lab-values').replaceChildren(...[first,second].map((replay,index)=>{
        const card=element('div','lab-value');card.dataset.changed=String(replay?.changed===true);
        const label=element('div','lab-value-label');label.append(element('span','',index===0?'BASELINE':'COMPARISON'));
        if(replay) label.append(pill(replay.status==='completed' ? replay.changed===null?'initial':replay.changed?'changed':'unchanged' : 'blocked',replay.status==='completed'?'':'warn'));
        card.append(label);
        if(replay) {
          const result=replay.result;
          card.append(element('pre','',result !== undefined ? pretty(result) : replay.status==='completed'?'Response values not included in this report.':'No fresh result.\n'+replay.code));
          const digest=element('p','lab-response-id');digest.append(element('span','','Fingerprint '),element('code','',replay.responseDigest || 'not written'));card.append(digest);
        } else card.append(element('p','lab-section-hint','Choose a comparison scenario to run its baseline and recheck.'));
        return card;
      }));
      const freshness=$('lab-freshness');freshness.replaceChildren();
      for(const [label,value] of [['Before',report.derived.before],['After refresh',report.derived.after],[report.derived.recomputedId?'After fixture recompute':'Current stored view',report.derived.final]]) {
        const item=element('span');item.append(element('strong','',label+' '),pill(value,value==='stale'?'warn':''));freshness.append(item);
      }
      const limitation=$('lab-limitation');limitation.replaceChildren();limitation.hidden=report.scenario==='baseline';
      if(report.scenario==='unchanged') limitation.append(element('strong','','Current limitation · unchanged does not skip invalidation'),element('span','','The response fingerprint stayed the same, but a new check advanced the dependency head. The original view became stale. This fixture explicitly recomputed it; production does not yet subscribe and recompute automatically.'));
      if(report.scenario==='changed') limitation.append(element('strong','','Changed data invalidates the original view'),element('span','','The new response check makes the old view stale. A separate fixture step creates the fresh derived view. Automatic subscriptions remain to be implemented.'));
      if(report.scenario==='missing_dependency') limitation.append(element('strong','','A fresh label does not mean the refresh succeeded'),element('span','','The upstream value was missing, so the dependent request did not run. No new successful check was saved. The earlier view keeps its previous freshness label; inspect the failed refresh receipt too.'));
    }
    function renderReport() {
      const replayBlocked=report.replays.some(replay=>replay.status!=='completed');
      $('lab-run-title').textContent=labels[report.scenario]+' · '+(report.status!=='passed'?'check failed':replayBlocked?'replay blocked':'checks passed');
      $('lab-run-summary').textContent=report.summary;
      $('lab-run-meta').replaceChildren(pill(report.checks.filter(check=>check.passed).length+'/'+report.checks.length+' checks',report.status==='passed'?'':'fail'),element('span','',duration(report.elapsedMs)));
      renderNodes();renderSelection();renderComparison();
      $('lab-harness').replaceChildren(element('span','lab-harness-label','FIXED EXAMPLE WORKFLOW'),element('code','',report.workflow.id),pill(report.workflow.reusable?'Reusable after success':'Not promoted',report.workflow.reusable?'':'warn'));
      const harnessNote=element('span','lab-section-hint',report.workflow.idempotentReuse?'Repeating its run ID reused the receipt; no extra request.':'Run-ID reuse was not confirmed.');$('lab-harness').append(harnessNote);
      $('lab-checks').replaceChildren(...report.checks.map(check=>{const item=element('li');item.dataset.passed=String(check.passed);item.append(element('strong','',check.label),element('p','',check.detail));return item;}));
      $('lab-trace').replaceChildren(...report.replays.map(replay=>{
        const section=element('section','lab-trace-run'), heading=element('h4');heading.append(element('span','',replay.phase+' · '+replay.status),element('span','',duration(replay.durationMs)));section.append(heading);
        const list=element('ol');for(const request of replay.requests){const item=element('li');item.append(element('strong','',request.method+' '+request.status+' '),element('span','',request.url));list.append(item);}section.append(list);
        if(replay.status!=='completed') section.append(element('p','lab-section-hint','Stopped: '+replay.code+'. No successful response check.'));
        const run=report.workflow.runs.find(item=>item.phase===replay.phase);if(run) section.append(element('p','lab-section-hint','Workflow '+run.status+' · '+run.calls+' tool calls.'));
        return section;
      }));
      $('lab-event-summary').textContent=report.evidence.events.length+' fixture component events';$('lab-events').textContent=pretty(report.evidence.events);
      $('lab-limits').replaceChildren(...report.limits.notes.map(note=>element('li','',note)));
    }
    function render() {
      const available=capabilityAccount===state.account && capability?.available===true, authorized=state.writable || state.operator;
      for(const button of buttons()){button.disabled=busy || !available || !authorized;button.setAttribute('aria-pressed',String(report?.scenario===button.dataset.scenario));}
      $('request-lab-panel').setAttribute('aria-busy',String(busy));
      let text=notice, kind=tone;
      if(busy){text='Running the controlled fixture. The report appears when execution finishes.';kind='';}
      else if(!capability){text='Checking whether this host can run the controlled fixture…';kind='';}
      else if(!available){text=capability.reason || 'The request lab is unavailable on this host.';kind='warning';}
      else if(!authorized){text='This token can inspect the dashboard. A token with write or operator access is required to run the isolated lab.';kind='warning';}
      else if(!text){text='Ready. Run a baseline or choose a comparison; every scenario uses disposable fixture storage.';kind='';}
      $('lab-notice').textContent=text;$('lab-notice').dataset.tone=kind;
      $('lab-empty').hidden=!!report;$('lab-report').hidden=!report;
    }
    async function run(scenario) {
      if(busy || !capability?.available || capabilityAccount!==state.account || !(state.writable || state.operator)) return;
      const account=state.account, epoch=state.epoch, active={};task=active;busy=true;notice='';tone='';render();
      try {
        const value=await api('request-lab',{account,scenario});
        if(task!==active || account!==state.account || epoch!==state.epoch) return;
        if(value.version!==1 || value.mode!=='controlled-fixture' || !Array.isArray(value.nodes) || !Array.isArray(value.replays) || !Array.isArray(value.checks)) throw new Error('The host returned an unsupported lab report.');
        report=value;selected=value.pointer.id;renderReport();
        const replayBlocked=value.replays.some(replay=>replay.status!=='completed');
        notice=value.status!=='passed'?'Completed with a failed check. Inspect its evidence below.':replayBlocked?'The dependency check passed: replay stopped before the dependent request. The previous result is not a successful refresh.':'Completed. The checks below describe actual fixture execution.';
        tone=value.status!=='passed'?'error':replayBlocked?'warning':'success';
      } catch(error) {
        if(task!==active || account!==state.account || epoch!==state.epoch) return;
        notice='The lab did not complete. '+(error.message || 'Check the local host and try again.')+(report?' The previous completed report is still shown.':'');tone='error';
      } finally {if(task===active){task=null;busy=false;render();}}
    }
    async function load(account,epoch) {
      if(capabilityAccount===account && capability){render();return;}
      if(loading && loading.account===account && loading.epoch===epoch) return loading.promise;
      const job={account,epoch,promise:null};loading=job;
      job.promise=(async()=>{
        try {const value=await api('request-lab?account='+encodeURIComponent(account));if(loading!==job || state.account!==account || state.epoch!==epoch) return;capability={available:value.available===true,reason:typeof value.reason==='string'?value.reason:undefined};capabilityAccount=account;}
        catch(error){if(loading!==job || state.account!==account || state.epoch!==epoch) return;if(error.status===401 || error.status===403) throw error;capability={available:false,reason:'Could not check lab availability. Refresh or reopen this tab after starting the local host.'};capabilityAccount='';}
        finally {if(loading===job){loading=null;render();}}
      })();return job.promise;
    }
    function reset(){report=null;selected='';capability=null;capabilityAccount='';loading=null;busy=false;task=null;notice='';tone='';for(const id of ['lab-flow','lab-selection','lab-values','lab-harness','lab-checks','lab-trace','lab-events','lab-limits']) $(id).replaceChildren();$('lab-report').hidden=true;$('lab-empty').hidden=false;render();}
    for(const button of buttons()) button.addEventListener('click',()=>run(button.dataset.scenario));
    $('lab-recorded').addEventListener('click',()=>{setTab('graph');$('graph-tab').focus();});
    return {load,render,reset};
  })();
`;
