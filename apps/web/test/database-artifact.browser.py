# Run through browser-harness against apps/agent/scripts/database-preview.ts in an isolated browser.
import pathlib, os
exec((pathlib.Path(os.environ['UNLOCK_ROOT']) / 'scripts/browser_helpers.py').read_text())
OUT = pathlib.Path(os.environ['AIKO_UI_QA_OUT']) if os.environ.get('AIKO_UI_QA_OUT') else ROOT / 'artifacts/databases/browser'
OUT.mkdir(parents=True, exist_ok=True)
TOKEN = 'database-preview-synthetic-local-only'
BASE = os.environ.get('DATABASE_PREVIEW_URL', 'http://127.0.0.1:4387')

def enter(search, token=TOKEN):
    new_tab(BASE + '/connect?' + search)
    wait_for_load()
    wait('!!document.querySelector(".db-workspace")')
    click('DisclosureTriangle', 'Use an account access token')
    fill('Account access token', token)
    click('button', 'Connect')

def click_node(node):
    cdp('DOM.scrollIntoViewIfNeeded', backendNodeId=node)
    points = cdp('DOM.getBoxModel', backendNodeId=node)['model']['content']
    click_at_xy(sum(points[0::2]) / 4, sum(points[1::2]) / 4)

def enabled_save():
    buttons = [n for n in cdp('Accessibility.getFullAXTree')['nodes']
        if n.get('role', {}).get('value') == 'button' and n.get('name', {}).get('value') == 'Save field'
        and not any(p.get('name') == 'disabled' and p.get('value', {}).get('value') for p in n.get('properties', []))]
    assert len(buttons) == 1
    click_node(buttons[0]['backendDOMNodeId'])

def database(path, body=None):
    request = urllib.request.Request(BASE + '/api/databases' + path,
        headers={'authorization': 'Bearer ' + TOKEN, 'content-type': 'application/json'},
        data=json.dumps(body).encode() if body else None)
    return json.load(urllib.request.urlopen(request))

def fail_poll():
    js("""window.__dbPollFetch=window.fetch;
    window.fetch=function(input,init) {
      if(String(input).includes('/databases/artifacts/')) return Promise.reject(new TypeError('Synthetic temporary polling failure'));
      return window.__dbPollFetch.call(this,input,init);
    };""")
    wait('!!document.querySelector(".db-artifact > .db-error")')
    assert js('!!document.querySelector(".db-record")')
    assert not js('[...document.querySelectorAll(".db-record button")].some(b=>["Save field","Add record"].includes(b.innerText) && !b.disabled)')

def recover_poll():
    js('window.fetch=window.__dbPollFetch')
    wait('!document.querySelector(".db-artifact > .db-error")')

enter('screen=databases')
wait('document.body.innerText.includes("Saved artifacts")')
click('button', 'Conversation artifacts')
wait('document.querySelectorAll(".db-inline table").length === 2')
viewport(390, 844)
assert js('document.documentElement.scrollWidth <= innerWidth')
audit('inline-mobile'); shot('inline-mobile')
opens = [n for n in cdp('Accessibility.getFullAXTree')['nodes'] if n.get('role', {}).get('value') == 'button' and n.get('name', {}).get('value') == 'Open']
click_node(opens[0]['backendDOMNodeId'])
wait('!!document.querySelector(".mini-app-screen .db-expanded table")')
audit('expanded-mobile'); shot('expanded-mobile')
click('button', 'Open record Autumn launch')
fill('Project', 'Autumn launch reviewed'); enabled_save()
wait('!document.querySelector(".db-error") && ![...document.querySelectorAll(".db-field button")].some(b=>!b.disabled || b.innerText==="Saving…")')
click('button', 'Back to table')
wait('document.querySelector(".db-expanded table").innerText.includes("Autumn launch reviewed")')
record('Native revision-checked edit persists through the expanded artifact')
viewport(1440, 1000); audit('expanded-desktop'); shot('expanded-desktop')
click('button', 'Open record Autumn launch reviewed'); fill('Project', 'My unsaved draft')
row = next(row for row in database('/query', {'query': {'tableId': 'projects'}})['rows'] if row['id'] == 'launch')
operation = database('/commands', {'idempotencyKey': 'browser-concurrent-edit', 'command': {'kind': 'rows.upsert', 'tableId': 'projects', 'rows': [{'id': 'launch', 'expectedRevision': row['revision'], 'values': {'name': 'Changed in another tab'}}]}})
for _ in range(30):
    status = database('/operations/' + operation['operationId'])
    if status['status'] != 'queued': break
    time.sleep(.1)
assert status['status'] == 'committed'
time.sleep(3.2)
assert js('document.querySelector("input[aria-label=Project]").value') == 'My unsaved draft'
enabled_save(); wait('document.body.innerText.includes("This record changed")')
assert next(row for row in database('/query', {'query': {'tableId': 'projects'}})['rows'] if row['id'] == 'launch')['cells']['name']['value'] == 'Changed in another tab'
shot('edit-conflict'); record('Background polling preserves drafts and a conflicting save cannot overwrite newer data')

enter('artifact=approvals-snapshot')
wait('document.body.innerText.includes("Frozen snapshot") && !!document.querySelector("table")')
click('button', 'Open record send.report')
assert not js('document.body.innerText.includes("Approve action") || document.body.innerText.includes("Synthetic approval fixture")')
audit('snapshot-readonly'); shot('snapshot-readonly')
record('Snapshot opens neither live approval detail nor decision controls')

enter('artifact=approvals-live')
wait('!!document.querySelector("table")')
enter('artifact=approvals-live', 'database-preview-read-only')
wait('!!document.querySelector("table")'); click('button', 'Open record send.report')
wait('document.body.innerText.includes("Exact action details")')
assert js('document.querySelector(".db-record").innerText.includes("pending")')
assert not js('document.body.innerText.includes("Approve action") || document.body.innerText.includes("Reject action")')
record('Read-only access can review a pending action without decision controls')

enter('artifact=approvals-live')
wait('!!document.querySelector("table")'); click('button', 'Open record send.report')
wait('document.body.innerText.includes("Exact action details")')
assert js('document.querySelector(".db-payload").innerText.includes("preview@example.invalid")')
viewport(390, 844); audit('approval-detail-mobile'); shot('approval-detail-mobile')
click('button', 'Reject action'); wait('document.querySelector(".db-record").innerText.includes("rejected")')
click('button', 'Back to table'); wait('document.querySelector("table").innerText.includes("rejected")')
record('Protected detail uses the canonical synthetic decision endpoint and the table refreshes')
enter('artifact=people-live')
wait('!!document.querySelector("table")'); click('button', 'Open record Maya')
click('button', 'Edit memory')
wait('document.body.innerText.includes("Reviewed memory: Designer")')
assert not js('document.body.innerText.includes("UNSELECTED_BROWSER_MEMORY_CANARY")')
fill('Role', 'Builder'); click('button', 'Save to memory')
wait('document.body.innerText.includes("Memory and table updated.")')
assert database('/query', {'query': {'tableId': 'people'}})['rows'][0]['cells']['role']['value'] == 'Builder'
audit('memory-correction'); shot('memory-correction')
record('Mapped editor updates actual memory and projection without exposing unselected payload')

click('button', 'Review latest memory'); wait('document.body.innerText.includes("Reviewed memory: Builder")')
fill('Role', 'My correction draft')
js("""window.__dbReviewFetch=window.fetch; window.__dbReviewFail=true;
window.fetch=async function(input,init) {
  if(String(input).endsWith('/databases/field') && window.__dbReviewFail) {window.__dbReviewFail=false; throw new TypeError('Synthetic review failure');}
  return window.__dbReviewFetch.call(this,input,init);
};""")
click('button', 'Review latest memory'); wait('!!document.querySelector(".db-memory-editor [role=alert]")')
click('button', 'Review latest memory'); wait('document.body.innerText.includes("Reviewed memory: Builder")')
assert js('document.querySelector("input[aria-label=Role]").value') == 'My correction draft'
js('window.fetch=window.__dbReviewFetch')
record('A failed current-memory read and retry preserve the correction draft')
field = database('/field', {'tableId': 'people', 'rowId': 'maya', 'columnId': 'role'})
operation = database('/commands', {'idempotencyKey': 'browser-concurrent-memory', 'command': {'kind': 'mapping.correct', 'mappingId': field['memory']['mappingId'], 'expectedMappingRevision': field['memory']['mappingRevision'], 'expectedRowRevision': field['rowRevision'], 'expectedObservationId': field['memory']['observationId'], 'values': {'role': 'Architect'}}})
for _ in range(30):
    status = database('/operations/' + operation['operationId'])
    if status['status'] != 'queued': break
    time.sleep(.1)
assert status['status'] == 'committed'
time.sleep(3.2)
assert js('document.querySelector("input[aria-label=Role]").value') == 'My correction draft'
click('button', 'Save to memory'); wait('document.body.innerText.includes("Your draft is kept")')
click('button', 'Review latest memory'); wait('document.body.innerText.includes("Reviewed memory: Architect")')
assert js('document.querySelector("input[aria-label=Role]").value') == 'My correction draft'
click('button', 'Save to memory'); wait('document.body.innerText.includes("Memory and table updated.")')
assert database('/field', {'tableId': 'people', 'rowId': 'maya', 'columnId': 'role'})['memory']['current']['value'] == 'My correction draft'
record('Concurrent memory correction keeps the draft and requires explicit review of the new head')

click('button', 'Review latest memory'); wait('document.body.innerText.includes("Reviewed memory: My correction draft")')
fill('Role', 'Recovered confirmation')
# Lose one response after the actual host received the command; ordinary UI controls still submit it.
js("""window.__dbCommandKeys=[]; window.__dbOriginalFetch=window.fetch; window.__dbDropOnce=true;
window.fetch=async function(input, init) {
  const response=await window.__dbOriginalFetch.call(this,input,init);
  if(String(input).endsWith('/databases/commands')) {
    window.__dbCommandKeys.push(JSON.parse(init.body).idempotencyKey);
    if(window.__dbDropOnce) {window.__dbDropOnce=false; throw new TypeError('Synthetic lost acknowledgement');}
  }
  return response;
};""")
click('button', 'Save to memory'); wait('document.body.innerText.includes("The update could not be confirmed")')
assert js('document.querySelector("input[aria-label=Role]").disabled')
click('button', 'Check update'); wait('document.body.innerText.includes("Memory and table updated.")')
keys = js('window.__dbCommandKeys')
assert len(keys) == 2 and keys[0] == keys[1]
js('window.fetch=window.__dbOriginalFetch')
record('Lost confirmation keeps the exact command identity and resolves through its original operation')

enter('artifact=people-snapshot')
wait('!!document.querySelector("table")'); click('button', 'Open record Maya')
assert not js('document.body.innerText.includes("Edit memory")')
enter('artifact=people-live', 'database-preview-read-only')
wait('!!document.querySelector("table")'); click('button', 'Open record Maya'); click('button', 'View memory')
wait('document.body.innerText.includes("cannot be corrected with your current access")')
assert not js('document.body.innerText.includes("Save to memory")')
record('Snapshots and read-only credentials cannot submit memory corrections')

enter('screen=databases', 'database-preview-read-only')
wait('document.body.innerText.includes("Saved artifacts")')
assert js('[...document.querySelectorAll("button")].some(b=>b.disabled && b.innerText.includes("Unpublished research") && b.innerText.includes("No saved view"))')
before = database('')
click('button', 'Projects')
wait('!!document.querySelector("table")')
assert not js('document.body.innerText.includes("Add record") || document.body.innerText.includes("Save as new view")')
click('button', 'Open record Changed in another tab')
assert not js('document.body.innerText.includes("Save field") || document.querySelector("input[aria-label=Project]")')
after = database('')
assert before['artifacts'] == after['artifacts'] and before['views'] == after['views']
audit('capability-readonly'); shot('capability-readonly')
record('Read-only library opens an existing artifact without writes and exposes no local mutation controls')

enter('artifact=approval-notes')
wait('!!document.querySelector("table")'); click('button', 'Open record Report context')
fill('Note', 'Reviewed report context'); enabled_save()
wait('!document.querySelector(".db-error") && ![...document.querySelectorAll("button")].some(b=>b.innerText==="Saving…" || b.innerText==="Save field" && !b.disabled)')
assert database('/query', {'query': {'tableId': 'approval-notes'}})['rows'][0]['cells']['note']['value'] == 'Reviewed report context'
click('button', 'Review action'); wait('document.body.innerText.includes("Exact action details")')
assert js('document.querySelector(".db-record").innerText.includes("rejected")')
record('Joined local annotations remain editable and domain review opens the canonical action')

enter('artifact=projects-live')
wait('!!document.querySelector("table")'); click('button', 'Open record Changed in another tab')
fill('Project', 'Draft across access change')
fail_poll(); recover_poll()
assert js('document.querySelector("input[aria-label=Project]").value') == 'Draft across access change'
record('Existing-record draft survives temporary poll failure with edits paused until access is checked')
def writes(enabled):
    request = urllib.request.Request(BASE + '/__fixture/database-writes',
        headers={'authorization': 'Bearer ' + TOKEN, 'content-type': 'application/json'},
        data=json.dumps({'enabled': enabled}).encode())
    assert json.load(urllib.request.urlopen(request))['enabled'] == enabled
try:
    writes(False)
    wait('!document.querySelector("input[aria-label=Project]") && !document.body.innerText.includes("Save field")')
    assert database('/query', {'query': {'tableId': 'projects'}})['capabilities']['write'] == False
    record('Host write revocation removes mutation controls even with an unsaved draft')
finally:
    writes(True)
wait('!!document.querySelector("input[aria-label=Project]")')
assert js('document.querySelector("input[aria-label=Project]").value') == 'Draft across access change'
audit('capability-restored-draft'); shot('capability-restored-draft')

enter('artifact=projects-live')
wait('!!document.querySelector("table")'); click('button', 'Add record')
fill('Project', 'New record draft across access change')
fail_poll(); recover_poll()
assert js('document.querySelector("input[aria-label=Project]").value') == 'New record draft across access change'
record('New-record draft survives temporary poll failure without unmounting the editor')
try:
    writes(False)
    wait('document.body.innerText.includes("Your draft is kept. Creating records is unavailable")')
    assert js('document.querySelector("input[aria-label=Project]").disabled')
    assert js('document.querySelector("input[aria-label=Project]").value') == 'New record draft across access change'
    assert not js('[...document.querySelectorAll("button")].some(b=>b.innerText==="Add record")')
finally:
    writes(True)
wait('!!document.querySelector("input[aria-label=Project]") && !document.querySelector("input[aria-label=Project]").disabled')
click('button', 'Add record'); wait('!!document.querySelector("table")')
assert any(row['cells']['name']['value'] == 'New record draft across access change' for row in database('/query', {'query': {'tableId': 'projects'}})['rows'])
record('New-record drafts survive host write revocation and save after access returns')

click('button', 'Add record'); fill('Project', 'Draft before read revocation')
def read_access(enabled):
    request = urllib.request.Request(BASE + '/__fixture/database-read-access',
        headers={'authorization': 'Bearer ' + TOKEN, 'content-type': 'application/json'},
        data=json.dumps({'enabled': enabled}).encode())
    assert json.load(urllib.request.urlopen(request))['enabled'] == enabled
try:
    read_access(False)
    wait('!!document.querySelector(".db-artifact > .db-error") && !document.querySelector(".db-record") && !document.querySelector("table")')
    assert not js('document.body.innerText.includes("Draft before read revocation")')
finally:
    read_access(True)
wait('!!document.querySelector("table") && !document.querySelector(".db-artifact > .db-error")')
click('button', 'Add record')
assert js('document.querySelector("input[aria-label=Project]").value') == ''
record('Actual read revocation clears retained data and a fresh authorized read recovers without a stuck draft')

enter('artifact=projects-live'); wait('!!document.querySelector("table")')
js("""window.__dbHeldFetch=window.fetch; window.__dbHoldOnce=true; window.__dbHoldReady=false;
window.fetch=async function(input,init) {
  const response=await window.__dbHeldFetch.call(this,input,init);
  if(String(input).includes('/databases/artifacts/') && window.__dbHoldOnce) {
    window.__dbHoldOnce=false;
    window.__dbHeldWrite=(await response.clone().json()).result.capabilities.write;
    window.__dbHoldReady=true;
    await new Promise(resolve=>window.__dbRelease=resolve);
    window.__dbHoldReturned=true;
  }
  return response;
};""")
wait('window.__dbHoldReady === true'); assert js('window.__dbHeldWrite')
try:
    writes(False); click('button', 'Reload table')
    wait('!document.body.innerText.includes("Add record") && !document.body.innerText.includes("Save as new view")')
    js('window.__dbRelease()'); wait('window.__dbHoldReturned === true')
    time.sleep(.2)
    assert not js('document.body.innerText.includes("Add record") || document.body.innerText.includes("Save as new view")')
    record('An older delayed writable response cannot replace newer read-only capabilities')
finally:
    js('window.__dbRelease(); window.fetch=window.__dbHeldFetch')
    writes(True)

# Explicit source refresh uses native command receipts without discarding local drafts.
enter('artifact=people-live')
wait('!!document.querySelector("table")'); click('button', 'Open record Maya')
fill('Name', 'Local unsaved refresh draft')
js("""window.__dbRefreshFetch=window.fetch; window.__dbRefreshKeys=[]; window.__dbDropRefresh=true;
window.fetch=async function(input,init) {
  const payload=init?.body ? JSON.parse(init.body) : null;
  const refresh=String(input).endsWith('/databases/commands') && payload?.command?.kind==='table.refresh';
  if(refresh) window.__dbRefreshKeys.push(payload.idempotencyKey);
  const response=await window.__dbRefreshFetch.call(this,input,init);
  if(refresh && window.__dbDropRefresh) { window.__dbDropRefresh=false; throw new TypeError('Synthetic lost refresh acknowledgement'); }
  return response;
};""")
click('button', 'Refresh sources')
wait('document.body.innerText.includes("Refresh is not confirmed")')
assert js('document.querySelector("input[aria-label=Name]").value') == 'Local unsaved refresh draft'
fail_poll(); recover_poll()
click('button', 'Check refresh'); wait('document.body.innerText.includes("Source checks finished")')
assert js('document.querySelector("input[aria-label=Name]").value') == 'Local unsaved refresh draft'
keys = js('window.__dbRefreshKeys')
assert len(keys) == 2 and keys[0] == keys[1]
js('window.fetch=window.__dbRefreshFetch')
audit('refresh-recovery'); shot('refresh-recovery')
record('Explicit source refresh recovers a lost acknowledgement with the same native identity and preserves drafts through a failed poll')
enter('artifact=people-snapshot')
wait('!!document.querySelector("table")')
assert not js('document.body.innerText.includes("Refresh sources")')
enter('artifact=people-live', 'database-preview-read-only')
wait('!!document.querySelector("table")')
assert not js('document.body.innerText.includes("Refresh sources")')
record('Snapshots and read-only views cannot dispatch source refreshes')

(OUT / 'checks.json').write_text(json.dumps(results, indent=2))
print('Database browser witness passed:', len(results), 'behavior checks plus accessibility audits')
