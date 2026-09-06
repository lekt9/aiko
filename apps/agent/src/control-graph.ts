/** Trusted panel code only. All graph content is assigned through DOM text/property APIs, never innerHTML. */
export const GRAPH_STYLE = `
.graph-tools{display:flex;gap:12px;flex-wrap:wrap;align-items:end;padding:0 24px 18px}.graph-tools label{display:grid;gap:5px}.graph-tools button{min-height:44px}.graph-tools select{font-size:14px}.graph-summary{padding:0 24px 16px;font-size:12px;color:var(--muted)}.graph-layout{display:grid;grid-template-columns:minmax(0,1fr);border-top:1px solid var(--line)}.graph-viewport{overflow:auto;max-height:580px;background:var(--ice);position:relative}.graph-viewport:focus-visible{outline:3px solid var(--blue);outline-offset:-3px}.graph-canvas{position:relative;width:720px;margin:auto}.graph-canvas svg{position:absolute;inset:0;pointer-events:none}.graph-canvas path{fill:none;stroke:#8199b4;stroke-width:1.4}.graph-canvas path.selected{stroke:var(--blue);stroke-width:2.5}.graph-node{position:absolute;width:204px;height:76px;text-align:left;padding:10px;border-left:4px solid var(--blue);overflow:hidden;display:flex;flex-direction:column;justify-content:center;gap:4px;border-radius:7px}.graph-node[data-kind="request"],.graph-node[data-kind="source"],.graph-node[data-kind="knowledge-source"]{border-left-color:var(--teal)}.graph-node[data-kind="index-error"]{border-left-color:var(--rose)}.graph-node[aria-pressed="true"],.graph-list button[aria-pressed="true"]{outline:2px solid var(--blue);outline-offset:-2px;background:var(--blue-light)}.graph-node strong{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}.graph-node small{font-size:10px;color:var(--muted);font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}.graph-column{position:absolute;top:12px;font:11px var(--mono);color:var(--muted)}.graph-list{padding:12px 24px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;max-height:580px;overflow:auto}.graph-list button{display:flex;flex-direction:column;gap:4px;align-items:start;text-align:left;min-width:0;overflow-wrap:anywhere}.graph-list button small{font-size:11px;font-weight:400;color:var(--muted)}.graph-detail{padding:20px 24px;border-top:1px solid var(--line);min-width:0}.graph-detail h3{margin-bottom:10px}.graph-detail .fields{grid-template-columns:125px minmax(0,1fr)}.graph-relations{list-style:none;padding:0;display:grid;gap:8px}.graph-relations button{width:100%;text-align:left;min-height:44px;font-size:12px;overflow-wrap:anywhere}.graph-pages{display:flex;gap:8px;flex-wrap:wrap;padding:16px 24px;border-top:1px solid var(--line)}.graph-legend{font-size:12px;color:var(--muted);padding:12px 24px}.graph-legend strong{color:var(--ink)}
@media(max-width:740px){.graph-list{grid-template-columns:1fr}.graph-tools{padding:0 18px 16px}.graph-detail .fields{grid-template-columns:1fr}.graph-detail .fields dd{margin-bottom:8px}.tabs{gap:16px}.tabs button{font-size:12px}}
`;
export const GRAPH_MARKUP = `
<div id="graph-panel" role="tabpanel" aria-labelledby="graph-tab" hidden>
  <div class="panel-head"><h2>Evidence &amp; request graph</h2><p class="memory-summary">Inspect what was recorded, how it connects, and where indexing stopped. No browsing or model calls.</p></div>
  <div class="graph-tools"><label for="graph-store">Evidence lane<select id="graph-store"><option value="knowledge">Account knowledge</option><option value="browser">Browser indexing</option></select></label><label for="graph-search">Filter loaded nodes<input id="graph-search" type="search" placeholder="Label, ID, status…" maxlength="256"></label><button id="graph-mode" type="button">Show list</button></div>
  <p id="graph-summary" class="graph-summary" role="status" aria-live="polite">Open the graph to read recorded structure.</p>
  <p class="graph-legend"><strong>Evidence → records → derivations</strong> are layout lanes, not a claimed execution order. Arrows follow the named relationship; select a node to read it.</p>
  <div class="graph-layout"><div id="graph-viewport" class="graph-viewport" role="region" aria-label="Node graph, scroll to explore; a full list is also available" tabindex="0"><div id="graph-canvas" class="graph-canvas"></div></div><div id="graph-list" class="graph-list" hidden></div><section id="graph-detail" class="graph-detail" aria-label="Selected node and relationships"></section></div>
  <div class="graph-pages"><button id="graph-first" type="button">First window</button><button id="graph-next" type="button" disabled>Next window</button></div>
</div>`;
export const GRAPH_SCRIPT = `
  const graphView = (() => {
    let data = null, selected = '', after = '', browserAfter = 0, error = '', version = '';
    let listMode = window.matchMedia('(max-width:740px)').matches;
    const lane = () => $('graph-store').value;
    const current = () => data && data[lane()];
    const svg = (tag, attributes) => {const n = document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v] of Object.entries(attributes)) n.setAttribute(k,String(v));return n;};
    const name = node => node.label || node.id;
    function choose(id) {selected = id;version = '';render();}
    function nodeButton(node, diagram) {
      const button = element('button',diagram ? 'graph-node' : ''); button.type = 'button';button.dataset.graphNode = node.id;button.dataset.kind = node.kind;button.setAttribute('aria-pressed',String(node.id === selected));
      button.append(element('strong','',name(node)),element('small','',node.kind + ' · ' + node.status));
      button.setAttribute('aria-label',name(node) + ', ' + node.kind + ', ' + node.status); button.addEventListener('click',() => choose(node.id));return button;
    }
    function render() {
      const graph = current(), query = $('graph-search').value.trim().toLowerCase();
      const key = JSON.stringify([data,selected,lane(),query,listMode,error]);if(version === key)return;version = key;
      const focused = document.activeElement && document.activeElement.dataset.graphNode;
      const all = graph && graph.nodes || [], edges = graph && graph.edges || [];
      if(!all.some(n => n.id === selected)) selected = '';
      const filtered = all.filter(n => !query || JSON.stringify(n).toLowerCase().includes(query));
      const shown = filtered.slice(0,64), visible = new Set(shown.map(n => n.id));
      $('graph-mode').textContent = listMode ? 'Show diagram' : 'Show list';
      $('graph-viewport').hidden = listMode; $('graph-list').hidden = !listMode;
      const summary = !graph ? 'Open the graph to read recorded structure.' : graph.status !== 'available' ? 'This lane could not be read. Refresh to try again.' : filtered.length + ' matching nodes / ' + all.length + ' loaded · ' + edges.length + ' relationships · ' + graph.coverage + ' window' + (graph.sourceVersion !== undefined ? ' · journal version ' + graph.sourceVersion : ' · log events ' + graph.after + '–' + graph.through) + ((graph.reasons || []).length ? ' · limits: ' + graph.reasons.join(', ') : '') + (!listMode && filtered.length > 64 ? ' · diagram shows first 64; use the list for all loaded nodes' : '') + (lane() === 'browser' ? '. Historical receipts only; current pointer availability and replay authorization are not checked.' : '. Canonical scoped records; quotation and relationship presence do not prove a claim.');
      $('graph-summary').textContent = error ? error + ' Previous graph cleared.' : summary;
      $('graph-next').disabled = !graph || graph.nextAfter === null || graph.nextAfter === undefined;
      $('graph-first').disabled = !after && !browserAfter;
      const canvas = $('graph-canvas');canvas.replaceChildren();
      const positions = new Map(), counts = [0,0,0];
      const column = node => ['request','source','knowledge-source'].includes(node.kind) ? 0 : ['knowledge-page','request-pointer','index-error'].includes(node.kind) ? 2 : 1;
      for(const node of shown){const c = column(node);positions.set(node.id,{x:16+c*236,y:44+counts[c]++*96,c});}
      const height = Math.max(240,Math.max(...counts)*96+64);canvas.style.height = height + 'px';
      const lines = svg('svg',{width:720,height,'aria-hidden':'true'}), defs = svg('defs',{}), marker = svg('marker',{id:'graph-arrow',viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:6,markerHeight:6,orient:'auto-start-reverse'});
      marker.append(svg('path',{d:'M 0 0 L 10 5 L 0 10 z',fill:'#8199b4',style:'fill:#8199b4;stroke:none'}));defs.append(marker);lines.append(defs);
      for(const e of edges){if(!visible.has(e.from)||!visible.has(e.to))continue;const a=positions.get(e.from),b=positions.get(e.to);if(e.from===e.to)continue;
        const same = a.c === b.c, right = a.x < b.x;const x1=a.x+(same||right?204:0),x2=b.x+(same||!right?204:0),y1=a.y+38,y2=b.y+38;
        const bend = same ? x1+15 : (x1+x2)/2;
        lines.append(svg('path',{d:'M '+x1+' '+y1+' C '+bend+' '+y1+', '+bend+' '+y2+', '+x2+' '+y2,'marker-end':'url(#graph-arrow)',class:e.from===selected||e.to===selected?'selected':''}));}
      canvas.append(lines);
      ['Evidence','Records','Derivations'].forEach((title,i)=>{const label=element('span','graph-column',title);label.style.left=(16+i*236)+'px';canvas.append(label);});
      for(const node of shown){const button=nodeButton(node,true),p=positions.get(node.id);button.style.left=p.x+'px';button.style.top=p.y+'px';canvas.append(button);}
      $('graph-list').replaceChildren(...filtered.map(n=>nodeButton(n,false)));
      if(!filtered.length){const note=empty(graph && graph.status==='available'?'No nodes in this window':'No graph loaded',query?'Clear the filter or read another window.':'Use Refresh now to read available records. Browser indexing appears only after recorded browsing activity.');canvas.append(note);$('graph-list').append(note.cloneNode(true));}
      const detail = $('graph-detail');detail.replaceChildren(); const node = all.find(n=>n.id===selected);
      if(!node){detail.append(element('p','hint','Select a node for its recorded status, metadata and named relationships. No action here executes a request.'));}
      else {
        detail.append(element('h3','',name(node)));const fields = element('dl','fields');
        for(const [key,value] of Object.entries({id:node.id,kind:node.kind,status:node.status,...node.details})){fields.append(element('dt','',key),element('dd','',value===null?'Not recorded':value));}detail.append(fields);
        const related = edges.filter(e=>e.from===node.id||e.to===node.id), list=element('ul','graph-relations');
        detail.append(element('h3','',related.length+' recorded relationships'));
        for(const e of related){const other=all.find(n=>n.id===(e.from===node.id?e.to:e.from));if(!other)continue;const li=element('li'),button=element('button','',(e.from===node.id?'This node — '+e.relation+' → ':'← '+e.relation+' — ')+name(other));button.type='button';button.addEventListener('click',()=>{choose(other.id);$('graph-detail').scrollIntoView({block:'nearest'});});li.append(button);list.append(li);}detail.append(list);
      }
      if(focused){const root=listMode?$('graph-list'):canvas;const button=[...root.querySelectorAll('[data-graph-node]')].find(n=>n.dataset.graphNode===focused);if(button)button.focus({preventScroll:true});}
    }
    function reset() {data=null;selected='';after='';browserAfter=0;error='';version='';$('graph-search').value='';render();}
    async function load(account, epoch) {
      try {const value=await api('memory-graph?account='+encodeURIComponent(account)+(after?'&after='+encodeURIComponent(after):'')+'&browserAfter='+browserAfter);
        if(epoch!==state.epoch)return;data=value;error='';render();}
      catch(e){if(epoch!==state.epoch)return;data=null;selected='';error='Graph refresh failed. Refresh to read current records.';render();throw e;}
    }
    $('graph-store').addEventListener('change',()=>{selected='';render();});$('graph-search').addEventListener('input',render);
    $('graph-mode').addEventListener('click',()=>{listMode=!listMode;render();});
    $('graph-next').addEventListener('click',()=>{const graph=current();if(!graph || graph.nextAfter==null)return;if(lane()==='knowledge')after=graph.nextAfter;else browserAfter=graph.nextAfter;data=null;selected='';invalidate();render();refresh();});
    $('graph-first').addEventListener('click',()=>{reset();invalidate();refresh();});
    return {reset,load,render};
  })();
`;
