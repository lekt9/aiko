# Run through browser-harness against the isolated database-preview.ts fixture.
import pathlib, os
exec((pathlib.Path(os.environ['UNLOCK_ROOT']) / 'scripts/browser_helpers.py').read_text())
OUT = pathlib.Path(os.environ['AIKO_UI_QA_OUT']) if os.environ.get('AIKO_UI_QA_OUT') else ROOT / 'artifacts/databases/layouts'
OUT.mkdir(parents=True, exist_ok=True)
BASE = os.environ.get('DATABASE_PREVIEW_URL', 'http://127.0.0.1:4389')
TOKEN = 'database-preview-synthetic-local-only'

def enter(artifact):
    new_tab(BASE + '/connect?artifact=' + artifact)
    wait_for_load()
    wait('!!document.querySelector(".db-workspace")')
    click('DisclosureTriangle', 'Use an account access token')
    fill('Account access token', TOKEN); click('button', 'Connect')
    wait('!!document.querySelector(".db-layout-controls")')

def choose(label, value):
    options = js('Array.from(document.querySelector(' + json.dumps('select[aria-label="' + label + '"]') + ').options).map(o=>o.value)')
    click('combobox', label); key('Home')
    for _ in range(options.index(value)): key('ArrowDown')
    key('Enter')
    wait('document.querySelector(' + json.dumps('select[aria-label="' + label + '"]') + ').value === ' + json.dumps(value))

def database(path, body=None):
    req = urllib.request.Request(BASE + '/api/databases' + path, headers={'authorization': 'Bearer ' + TOKEN, 'content-type': 'application/json'}, data=json.dumps(body).encode() if body else None)
    return json.load(urllib.request.urlopen(req))

enter('deliveries-list')
wait('document.querySelectorAll(".db-record-list > li").length === 5')
assert not js('!!document.querySelector("table")')
click('button', 'Open record Leap day launch'); fill('Delivery', 'Leap day launch reviewed')
buttons = [node for node in cdp('Accessibility.getFullAXTree')['nodes'] if node.get('role', {}).get('value') == 'button' and node.get('name', {}).get('value') == 'Save field' and not any(prop.get('name') == 'disabled' and prop.get('value', {}).get('value') for prop in node.get('properties', []))]
assert len(buttons) == 1
node = buttons[0]['backendDOMNodeId']; cdp('DOM.scrollIntoViewIfNeeded', backendNodeId=node)
points = cdp('DOM.getBoxModel', backendNodeId=node)['model']['content']; click_at_xy(sum(points[0::2])/4, sum(points[1::2])/4)
wait('!document.querySelector(".db-error") && ![...document.querySelectorAll(".db-field button")].some(b=>!b.disabled)')
click('button', 'Back to table'); wait('document.body.innerText.includes("Leap day launch reviewed")')
audit('list'); shot('list')
record('Saved list layout opens and edits the canonical record')

enter('deliveries-board')
wait('document.querySelectorAll(".db-board-column").length === 5')
assert js('document.querySelector(".db-board-column h3").innerText.startsWith("Planned")')
assert js('document.querySelectorAll(".db-board .db-record-card").length') == 5
viewport(390, 844); assert js('document.documentElement.scrollWidth <= innerWidth')
audit('board-mobile'); shot('board-mobile')
viewport(1440, 1000); audit('board-desktop'); shot('board-desktop')
record('Board shows enum lanes and separate null/missing lanes without losing records')

enter('deliveries-calendar')
wait('document.querySelector(".db-calendar-heading").innerText.includes("February 2028")')
assert js('!!document.querySelector("time[datetime=\\"2028-02-29\\"]")')
assert js('document.querySelector(".db-calendar-days").innerText.includes("Leap day launch reviewed")')
assert js('document.querySelector(".db-undated h3").innerText.includes("3")')
click('button', 'Next month'); wait('document.querySelector(".db-calendar-heading").innerText.includes("March 2028")')
assert js('document.querySelector(".db-calendar-days").innerText.includes("March credit")')
viewport(390, 844); assert js('document.documentElement.scrollWidth <= innerWidth')
audit('calendar-mobile'); shot('calendar-mobile')
record('Calendar renders UTC leap dates, navigates months and retains undated records')

enter('deliveries-chart')
wait('document.querySelectorAll(".db-chart li").length === 5')
assert js('document.querySelector(".db-chart").innerText.includes("9007199254740993.05")')
assert js('document.querySelector(".db-chart").innerText.includes("-9007199254740993.05")')
assert js('document.querySelectorAll(".db-chart-track").length') == 3
assert js('Array.from(document.querySelectorAll(".db-chart-track > span")).map(e=>e.style.width)') == ['50%', '50%', '0%']
viewport(1440, 1000); audit('chart'); shot('chart')
record('Chart keeps exact signed decimal labels and does not chart absent values as zero')

enter('deliveries-table'); choose('Layout', 'board')
fill('Filter records', 'Leap'); click('button', 'Filter')
wait('document.querySelectorAll(".db-board .db-record-card").length === 1')
before = database('')
js("""window.__layoutFetch=window.fetch; window.__layoutDropOnce=true; window.__layoutReloadFailed=false; window.__layoutCommands=[];
window.fetch=async function(input,init) {
  if(window.__layoutReloadFail && String(input).includes('/databases/artifacts/')) {
    window.__layoutReloadFail=false; window.__layoutReloadFailed=true; throw new TypeError('Synthetic query failure');
  }
  const response=await window.__layoutFetch.call(this,input,init);
  if(String(input).endsWith('/databases/commands')) {
    const body=JSON.parse(init.body); window.__layoutCommands.push(body);
    if(body.command.kind==='view.save' && window.__layoutDropOnce) {
      window.__layoutDropOnce=false; window.__layoutReloadFail=true;
      await new Promise(resolve=>setTimeout(resolve,8000)); throw new TypeError('Synthetic lost save acknowledgement');
    }
  }
  return response;
};""")
click('button', 'Save as new view')
wait('window.__layoutReloadFailed === true')
wait('document.body.innerText.includes("Check save")', timeout=20)
assert js('document.querySelector("select[aria-label=Layout]").value') == 'board'
click('button', 'Check save'); wait('document.body.innerText.includes("Saved as a new live view")')
commands = js('window.__layoutCommands')
view_commands = [command for command in commands if command['command']['kind'] == 'view.save']
assert len(view_commands) == 2 and view_commands[0] == view_commands[1]
saved_id = next(command['command']['artifactId'] for command in commands if command['command']['kind'] == 'artifact.create')
js('window.fetch=window.__layoutFetch')
after = database('')
assert len(after['artifacts']) == len(before['artifacts']) + 1 and len(after['views']) == len(before['views']) + 1
saved = database('/artifacts/' + saved_id)
assert saved['view']['layout'] == 'board' and saved['view']['groupField'] == 'status'
assert saved['view']['query']['filter']['filters'][-1]['value'] == 'Leap'
assert 'cursor' not in saved['view']['query']
assert database('/artifacts/deliveries-table')['view']['layout'] == 'table'
click('button', 'Open saved view'); wait('!!document.querySelector(".mini-app-screen .db-board")')
record('Two-stage save survives a data remount and lost acknowledgement with one new view/artifact')

enter('approvals-live'); choose('Layout', 'board'); choose('Group by', 'state')
click('button', 'Open record send.report'); wait('document.body.innerText.includes("Exact action details")')
click('button', 'Reject action'); wait('document.querySelector(".db-record").innerText.includes("rejected")')
record('Approval board opens canonical human review and uses the actual synthetic decision endpoint')
enter('approvals-snapshot'); choose('Layout', 'list')
assert not js('document.body.innerText.includes("Save as new view")')
click('button', 'Open record send.report')
assert not js('document.body.innerText.includes("Approve action") || document.body.innerText.includes("Edit memory")')
record('Snapshot layout changes neither create a live view nor expose decision controls')

(OUT / 'checks.json').write_text(json.dumps(results, indent=2))
print('Database layouts browser witness passed:', len(results), 'behavior checks plus accessibility audits')
