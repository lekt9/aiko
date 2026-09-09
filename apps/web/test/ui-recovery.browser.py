# Start: bun --no-env-file apps/web/test/ui-recovery.preview.ts
# Run with browser-harness and an isolated BU_CDP_URL. No provider or account APIs.
import os, pathlib, json
from concurrent.futures import ThreadPoolExecutor
root = pathlib.Path(os.environ['UNLOCK_ROOT'])
helpers = (root / 'scripts/browser_helpers.py').read_text().replace("OUT = ROOT / 'artifacts/vault-qa'", "OUT = ROOT / 'artifacts/agents-principles-fixes-2026-09-08'")
exec(helpers)
OUT = pathlib.Path(os.environ.get('AIKO_UI_QA_OUT', str(OUT)))
OUT.mkdir(parents=True, exist_ok=True)
BASE = os.environ.get('UI_RECOVERY_BASE_URL', 'http://127.0.0.1:4196')

def open_fixture(query=''):
    new_tab(BASE + '/' + query)
    wait_for_load()
    wait('!!window.uiFixture')

def add_approval():
    js('uiFixture.approvals=[{id:"fixture-approval",name:"send_summary",args:{message:"Synthetic action"},snapshot:"Fixture page",expires:Date.now()+60000}];true')
    wait('document.body.innerText.includes("1 action needs your approval")')

def database_status(status):
    js('uiFixture.databaseStatus=' + str(status))

def reload_decision(accept):
    # Chrome holds mouseReleased until a native confirm is answered. Keep CDP
    # available to answer that dialog while the actual coordinate click waits.
    cdp('Page.enable'); drain_events()
    with ThreadPoolExecutor(max_workers=1) as executor:
        clicked = executor.submit(click, 'button', 'Reload table')
        deadline = time.monotonic() + 4
        dialog = None
        while not dialog and time.monotonic() < deadline:
            dialog = next((e for e in drain_events() if e.get('method') == 'Page.javascriptDialogOpening'), None)
            if not dialog: time.sleep(.05)
        assert dialog and dialog['params']['type'] == 'confirm'
        assert dialog['params']['message'] == 'Discard unsaved changes and reload this table?'
        cdp('Page.handleJavaScriptDialog', accept=accept)
        clicked.result(timeout=4)

def viewport_shot(name):
    data = cdp('Page.captureScreenshot', format='png', captureBeyondViewport=False)['data']
    (OUT / (name + '.png')).write_bytes(base64.b64decode(data))

try:
    open_fixture()
    wait('document.body.innerText.includes("Review requests and recent decisions.")')
    click('DisclosureTriangle', 'Telegram assistant settings')
    wait('document.body.innerText.includes("No decisions need you here.")')
    click('button', 'Add work')
    fill('Outcome', 'Preserve my meeting draft')
    js('uiFixture.holdWork=true;uiFixture.pollBefore=uiFixture.approvalReads;true')
    click('button', 'Refresh work')
    wait('document.querySelector(".secretary-work").getAttribute("aria-busy")==="true"')
    wait('uiFixture.approvalReads>uiFixture.pollBefore')
    assert js('uiFixture.workAborts') == 0
    assert js('document.querySelector(".work-form input").value') == 'Preserve my meeting draft'
    add_approval()
    assert js('uiFixture.workAborts') == 0
    assert js('document.querySelector(".work-form input").value') == 'Preserve my meeting draft'
    js('uiFixture.releaseWork();true')
    wait('document.querySelector(".secretary-work").getAttribute("aria-busy")==="false"')
    record('UI-1: real parent polling preserves the in-flight secretary request and releases busy on completion')
    click('DisclosureTriangle', 'Approvals (1)')
    click('button', 'Approve')
    wait('uiFixture.decisions.length===1 && document.body.innerText.includes("Review requests and recent decisions.")')
    assert js('document.querySelector(".work-form input").value') == 'Preserve my meeting draft'
    assert js('JSON.stringify(uiFixture.decisions[0])') == '{"id":"fixture-approval","approve":true}'
    record('UI-3: reviewing and deciding an incoming approval preserves the mounted secretary draft')
    js('uiFixture.failWork=true;true')
    click('button', 'Refresh work')
    wait('!!document.querySelector(".work-error")')
    assert js('document.querySelector(".secretary-work").getAttribute("aria-busy")') == 'false'
    assert js('document.querySelector(".work-form input").value') == 'Preserve my meeting draft'
    js('uiFixture.failWork=false;true')
    click('button', 'Refresh work')
    wait('!document.querySelector(".work-error")')
    record('UI-1: failed work refresh preserves input and allows a successful retry')
    click('combobox', 'What should Aiko track?'); key('ArrowDown'); key('Enter')
    fill('Who owes the outcome?', 'Fixture owner')
    fill('What establishes completion?', 'Approved meeting note')
    fill('Next step', 'Prepare note')
    js('uiFixture.failWork=true;true')
    click('button', 'Track commitment'); wait('!!document.querySelector(".work-error")')
    assert js('document.querySelector(".work-form input").value') == 'Preserve my meeting draft'
    js('uiFixture.failWork=false;uiFixture.holdWork=true;uiFixture.pollBefore=uiFixture.approvalReads;true')
    click('button', 'Track commitment')
    wait('uiFixture.workWrites.length===2 && uiFixture.approvalReads>uiFixture.pollBefore')
    assert js('JSON.stringify(uiFixture.workWrites[0])===JSON.stringify(uiFixture.workWrites[1])')
    assert js('uiFixture.workAborts') == 0
    js('uiFixture.releaseWork();true')
    wait('!document.querySelector(".work-form") && document.querySelector(".secretary-work").getAttribute("aria-busy")==="false"')
    record('UI-1: failed capture retains its draft and operation ID; explicit retry completes across polling')
    click('button', 'Add work')
    fill('Outcome', 'First saved outcome')
    js('uiFixture.holdWork=true;true')
    click('button', 'Track commitment')
    wait('document.querySelector(".secretary-work").getAttribute("aria-busy")==="true"')
    fill('Outcome', 'Newer unsaved outcome')
    js('uiFixture.releaseWork();true')
    wait('document.querySelector(".secretary-work").getAttribute("aria-busy")==="false"')
    assert js('document.querySelector(".work-form input").value') == 'Newer unsaved outcome'
    assert js('document.body.innerText.includes("Your newer draft is still here")')
    record('UI-1: completing a capture preserves edits made while its response is pending')
    click('button', 'Connect GitHub')
    wait('!!document.querySelector("#website-username")')
    fill('Email or username', 'fixture@example.test')
    add_approval()
    assert js('document.querySelector("#website-username").value') == 'fixture@example.test'
    assert js('document.activeElement.id') == 'website-username'
    record('UI-3: incoming approval neither unmounts private sign-in nor steals keyboard focus')
    viewport(360, 800)
    assert js('(()=>{const r=document.querySelector(".mini-app-screen").getBoundingClientRect();return r.x===0&&r.y===0&&r.width===innerWidth&&r.height===innerHeight})()')
    assert not js('!!document.querySelector("dialog[open]")')
    assert js('!!document.querySelector("#root").inert')
    cdp('DOM.focus', backendNodeId=ax('DisclosureTriangle', 'Approvals (1)'))
    key(' ', 'Space')
    wait('document.querySelector(".mini-app-screen .approval-navigation details").open')
    assert js('document.activeElement.matches(":focus-visible")')
    assert js('getComputedStyle(document.activeElement).outlineStyle') != 'none'
    js('uiFixture.failDecision=true;true')
    click('button', 'Approve')
    wait('!!document.querySelector(".mini-app-screen .credential-error")')
    assert js('document.querySelector("#website-username").value') == 'fixture@example.test'
    assert not js('Array.from(document.querySelectorAll(".mini-app-screen .approval-card button")).some(b=>b.disabled)')
    js('uiFixture.failDecision=false;uiFixture.holdApprovalRead=true;uiFixture.pollBefore=uiFixture.approvalReads;true')
    wait('uiFixture.approvalReads>uiFixture.pollBefore')
    click('button', 'Reject')
    wait('document.querySelector(".mini-app-screen .approval-navigation summary").textContent==="Approvals (0)"')
    js('uiFixture.staleReadRendered=false;uiFixture.releaseApprovalRead();requestAnimationFrame(()=>requestAnimationFrame(()=>uiFixture.staleReadRendered=true));true')
    wait('uiFixture.staleReadRendered')
    assert js('document.querySelector("#website-username").value') == 'fixture@example.test'
    assert js('document.querySelector(".mini-app-screen .approval-navigation summary").textContent') == 'Approvals (0)'
    assert js('document.querySelector(".mini-app-screen .approval-navigation details").open')
    wait('document.activeElement.tagName==="SUMMARY"')
    assert js('document.querySelector(".mini-app-screen [aria-label=Promises] button").getBoundingClientRect().height>=44')
    audit('ui-sign-in-approvals'); viewport_shot('ui-sign-in-approvals')
    for width, height in [(375, 800), (800, 375), (1024, 800)]:
        viewport(width, height)
        assert js('(()=>{const s=document.querySelector(".mini-app-screen");return s.scrollWidth<=s.clientWidth})()')
    cdp('Emulation.setEmulatedMedia', features=[{'name':'prefers-color-scheme','value':'dark'}, {'name':'prefers-reduced-motion','value':'reduce'}])
    viewport(375, 800)
    audit('ui-sign-in-approvals-dark'); viewport_shot('ui-sign-in-approvals-dark')
    cdp('Emulation.setEmulatedMedia', features=[])
    record('UI-3: full-screen sign-in keeps keyboard-accessible approvals, recovers decisions, and ignores a stale pre-decision poll')
    add_approval()
    cdp('DOM.focus', backendNodeId=ax('button', 'Reject'))
    js('uiFixture.approvals=[];true')
    wait('document.querySelector(".mini-app-screen .approval-navigation summary").textContent==="Approvals (0)" && document.activeElement.tagName==="SUMMARY"')
    record('UI-3: polling an externally settled approval restores keyboard focus without closing the review')
    key('Escape'); wait('!document.querySelector("#website-username")')
    wait('!document.querySelector("#root").inert')
    assert js('document.querySelector(".work-form input").value') == 'Newer unsaved outcome'
    js('uiFixture.connections=[{id:"fixture-details",connectorId:"arcade:fixture",provider:"arcade",status:"connected",appName:"Fixture app"}];true')
    click('button', 'Refresh connections')
    click('button', 'Fixture app — connected. Manage connection')
    assert js('document.querySelector(".mini-app-screen h2").textContent') == 'App details'
    assert js('document.querySelector(".mini-app-screen").getBoundingClientRect().width===innerWidth')
    click('button', 'Back')
    wait('!document.querySelector(".mini-app-screen")')
    assert js('document.activeElement.dataset.connectionId') == 'fixture-details'
    record('UI-3: app details occupy the Mini App; Back restores the connection tile and existing work')
    fill('Outcome', 'Newer unsaved outcome')
    js('uiFixture.promises=[{id:"fixture-promise",hash:"fixture-frozen-hash",label:"Prepare fixture note",when:{kind:"approval"},state:"pending",createdAt:Date.now(),expiresAt:Date.now()+60000,payload:{kind:"harness",segment:{version:1,code:"return values.message",values:{message:"Approved synthetic note"},packages:{}}}}];uiFixture.approvals=[{id:"combined-approval",name:"fixture_action",args:{},snapshot:"Synthetic",expires:Date.now()+60000}];true')
    wait('document.querySelector(".approval-navigation summary").textContent==="Approvals (2)"')
    assert js('document.querySelector(".work-form input").value') == 'Newer unsaved outcome'
    assert js('document.activeElement.closest(".work-form")!==null')
    click('button', 'Reject')
    wait('document.querySelector(".approval-navigation summary").textContent==="Approvals (1)"')
    click('DisclosureTriangle', 'Review frozen source and final inputs')
    assert js('document.querySelector("[aria-label=Promises]").innerText.includes("Approved synthetic note")')
    js('uiFixture.holdPromiseDecision=true;true')
    click('button', 'Approve this task')
    wait('uiFixture.promiseDecisions.length===1')
    click('button', 'Connect GitHub')
    wait('!!document.querySelector("#website-username")')
    fill('Email or username', 'second-fixture@example.test')
    click('DisclosureTriangle', 'Approvals (1)')
    assert js('document.querySelector(".mini-app-screen [aria-label=Promises]").innerText.includes("Saving decision")')
    assert js('uiFixture.promiseAborts') == 0
    js('uiFixture.releasePromiseDecision();true')
    wait('document.querySelector(".mini-app-screen .approval-navigation summary").textContent==="Approvals (0)"')
    assert js('document.querySelector("#website-username").value') == 'second-fixture@example.test'
    assert js('document.querySelector(".mini-app-screen [aria-label=Promises]").innerText.includes("queued")')
    assert js('JSON.stringify(uiFixture.promiseDecisions)') == '[{"id":"fixture-promise","hash":"fixture-frozen-hash","decision":"approve"}]'
    click('button', 'Back')
    wait('!document.querySelector(".mini-app-screen")')
    assert js('document.querySelector(".work-form input").value') == 'Newer unsaved outcome'
    assert js('document.querySelector(".approval-navigation summary").textContent') == 'Approvals (0)'
    record('UI-3/promises mount: combined count, frozen review, and one pending decision survive root/full-screen navigation without replacing drafts')

    open_fixture('?callback&initial')
    wait('uiFixture.workReads===1')
    click('button', 'Refresh work')
    wait('document.body.innerText.includes("No decisions need you here.")')
    js('uiFixture.initialReadRendered=false;uiFixture.releaseInitialWork();requestAnimationFrame(()=>requestAnimationFrame(()=>uiFixture.initialReadRendered=true));true')
    wait('uiFixture.initialReadRendered && document.querySelector(".secretary-work").getAttribute("aria-busy")==="false"')
    assert not js('document.body.innerText.includes("Outdated initial read")')
    record('UI-1: a late initial read cannot replace the newer refresh result')
    js('uiFixture.holdWork=true;true')
    click('button', 'Refresh work')
    click('button', 'Replace request callback')
    assert js('uiFixture.workAborts') == 0
    js('uiFixture.releaseWork();true')
    wait('document.querySelector(".secretary-work").getAttribute("aria-busy")==="false"')
    js('uiFixture.failWork=true;true')
    click('button', 'Refresh work')
    wait('!!document.querySelector(".work-error")')
    assert js('document.querySelector(".secretary-work").getAttribute("aria-busy")') == 'false'
    record('UI-1: replacing a mounted account request callback does not abort work or strand busy controls')

    new_tab(BASE + '/console'); wait_for_load(); wait('!!window.consoleFixture')
    cdp('DOM.focus', backendNodeId=ax('textbox', 'Local operator token'))
    cdp('Input.insertText', text='synthetic-only')
    click('button', 'Open Aiko'); wait('!document.querySelector("#chat").hidden')
    fill('Message Aiko', 'First console message'); click('button', 'Send message')
    fill('Message Aiko', 'Newer console draft')
    js('consoleFixture.release("accepted");true')
    wait('!document.querySelector("#send").disabled')
    assert js('document.querySelector("#message").value') == 'Newer console draft'
    click('button', 'Send message')
    fill('Message Aiko', 'Third unsent draft')
    js('consoleFixture.release("lost");true')
    wait('!document.querySelector("#retry-message").hidden')
    before = js('consoleFixture.messageReads')
    wait('consoleFixture.messageReads>' + str(before))
    assert js('document.querySelector("#feedback").textContent.includes("Message not confirmed")')
    assert js('document.querySelector("#send").disabled')
    assert js('consoleFixture.sends.length') == 2
    click('button', 'Retry previous message')
    assert js('JSON.stringify(consoleFixture.sends[1])===JSON.stringify(consoleFixture.sends[2])')
    assert js('consoleFixture.commits.size') == 2
    js('consoleFixture.release("accepted");true')
    wait('!document.querySelector("#send").disabled')
    assert js('document.querySelector("#message").value') == 'Third unsent draft'
    click('button', 'Send message')
    assert js('consoleFixture.sends[3].id!==consoleFixture.sends[2].id')
    js('consoleFixture.release("accepted");true')
    wait('document.querySelector("#message").value===""')
    audit('ui-console-recovery'); viewport_shot('ui-console-recovery')
    record('UI-4: shipped console preserves newer drafts, keeps uncertainty visible across polling, and retries only the original ID/text')

    open_fixture('?database')
    wait('!!document.querySelector("table")')
    click('button', 'Open record Original project'); fill('Project', 'Keep my edit')
    database_status(503)
    wait('!!document.querySelector(".db-artifact > .db-error")')
    assert js('!!document.querySelector(".db-record")')
    click('button', 'Retry refresh')
    assert js('!!document.querySelector(".db-record")')
    database_status(200); click('button', 'Retry refresh')
    wait('!!document.querySelector("input[aria-label=Project]")')
    assert js('document.querySelector("input[aria-label=Project]").value') == 'Keep my edit'
    record('UI-2: transient failures and explicit retries preserve an existing-record draft')

    reload_decision(False)
    assert js('document.querySelector("input[aria-label=Project]").value') == 'Keep my edit'
    database_status(503)
    reload_decision(True)
    wait('!!document.querySelector(".db-artifact > .db-error")')
    assert js('!!document.querySelector(".db-record")')
    database_status(200); click('button', 'Retry refresh')
    wait('!!document.querySelector("input[aria-label=Project]")')
    assert js('document.querySelector("input[aria-label=Project]").value') == 'Keep my edit'
    reload_decision(True)
    wait('!!document.querySelector("table")')
    click('button', 'Open record Original project')
    assert js('document.querySelector("input[aria-label=Project]").value') == 'Original project'
    record('UI-2: cancelled or failed discard reload preserves the draft; successful discard resets even an unchanged row revision')

    for status in [401, 403]:
        open_fixture('?database'); wait('!!document.querySelector("table")')
        click('button', 'Add record'); fill('Project', 'Private new draft')
        database_status(503); wait('!!document.querySelector(".db-artifact > .db-error")')
        assert js('document.querySelector("input[aria-label=Project]").value') == 'Private new draft'
        database_status(200); click('button', 'Retry refresh')
        wait('!document.querySelector(".db-artifact > .db-error")')
        assert js('document.querySelector("input[aria-label=Project]").value') == 'Private new draft'
        database_status(status); wait('!!document.querySelector(".db-artifact > .db-error") && !document.querySelector(".db-record")')
        assert not js('document.body.innerText.includes("Private new draft")')
        database_status(200); click('button', 'Retry refresh'); wait('!!document.querySelector("table")')
        click('button', 'Add record')
        assert js('document.querySelector("input[aria-label=Project]").value') == ''
        record('UI-2: new draft survives 503, but HTTP '+str(status)+' clears protected data and drafts before recovery')
except Exception as error:
    results.append({'check': 'UI recovery browser regression', 'passed': False, 'error': str(error), 'trace': traceback.format_exc()})
    raise
finally:
    (OUT / 'ui-browser-results.json').write_text(json.dumps({'checks': results, 'scope': 'isolated Chromium with deterministic in-page requests; no real providers or account service'}, indent=2))
    print(json.dumps(results, indent=2))
