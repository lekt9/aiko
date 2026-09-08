# Run through browser-harness against apps/agent/scripts/database-preview.ts in an isolated browser.
import pathlib, os
exec((pathlib.Path(os.environ['UNLOCK_ROOT']) / 'scripts/browser_helpers.py').read_text())
OUT = ROOT / 'artifacts/databases/browser'
OUT.mkdir(parents=True, exist_ok=True)
TOKEN = 'database-preview-synthetic-local-only'
BASE = os.environ.get('DATABASE_PREVIEW_URL', 'http://127.0.0.1:4387')

def enter(search):
    new_tab(BASE + '/connect?' + search)
    wait_for_load()
    click('DisclosureTriangle', 'Use an account access token')
    fill('Account access token', TOKEN)
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
wait('!document.querySelector(".db-error") && ![...document.querySelectorAll(".db-field button")].some(b=>!b.disabled)')
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
wait('!!document.querySelector("table")'); click('button', 'Open record send.report')
wait('document.body.innerText.includes("Exact action details")')
assert js('document.querySelector(".db-payload").innerText.includes("preview@example.invalid")')
viewport(390, 844); audit('approval-detail-mobile'); shot('approval-detail-mobile')
click('button', 'Reject action'); wait('document.querySelector(".db-record").innerText.includes("rejected")')
click('button', 'Back to table'); wait('document.querySelector("table").innerText.includes("rejected")')
record('Protected detail uses the canonical synthetic decision endpoint and the table refreshes')
(OUT / 'checks.json').write_text(json.dumps(results, indent=2))
print('Database browser witness passed:', len(results), 'behavior checks plus accessibility audits')
