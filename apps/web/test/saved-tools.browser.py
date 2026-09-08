# Production mounted Saved tools screen; owner TMS authentication and all HTTP are local fixtures.
import os,pathlib
exec((pathlib.Path(os.environ['UNLOCK_ROOT'])/'scripts/browser_helpers.py').read_text())
OUT=ROOT/'artifacts/browser-events/ui/saved-tools/browser';OUT.mkdir(parents=True,exist_ok=True)
def shot(name):
    data=cdp('Page.captureScreenshot',format='png',captureBeyondViewport=False)['data']
    (OUT/(name+'.png')).write_bytes(base64.b64decode(data))
def control(name):
    urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:4187/preview/tools-'+name,method='POST')).close()
def state():
    with urllib.request.urlopen('http://127.0.0.1:4187/preview/tools-state') as response:return json.load(response)
control('reset')
new_tab('http://127.0.0.1:4187/connection');wait_for_load()
wait('!!document.querySelector("[data-connection-id=site-fixture]")')
js('document.documentElement.dataset.telegramTheme="light";true')
viewport(390,844);click('button','Saved tools')
wait('!!document.querySelector(".mini-app-screen .saved-tools select")')
cdp('DOM.focus',backendNodeId=ax('combobox','Choose a tool version'));key('ArrowDown');key('Enter')
wait('document.querySelector(".saved-tools h4")?.textContent === "Double a number"')
click('DisclosureTriangle','Source and input contract')
wait('document.body.innerText.includes("fixture:controlled-source")')
no_overflow();audit('inspect-mobile');shot('inspect-mobile')
record('Production Saved tools navigation discovers and inspects source plus input contract through the owner session')
fill('Description','Double a number using a checked revision')
fill('File contents','return 0;')
click('button','Test revision');wait('document.body.innerText.includes("Tests did not pass")')
assert js('[...document.querySelectorAll("button")].find(e=>e.textContent==="Save version").disabled')
assert js('document.querySelector("textarea.saved-tool-code").value')=='return 0;'
record('Failed independent-test fixture leaves candidate and draft visible and cannot save a version')
fill('File contents','return input.n + input.n;')
click('button','Test revision');wait('document.body.innerText.includes("Tests passed")')
control('conflict');click('button','Save version')
wait('document.querySelector(".saved-tool-error")?.textContent.includes("could not be confirmed")')
assert js('document.querySelector("textarea.saved-tool-code").value')=='return input.n + input.n;'
click('button','Refresh tools');wait('document.body.innerText.includes("Your draft is unchanged")')
click('button','Save version');wait('document.body.innerText.includes("Version saved")')
record('Generation conflict preserves tested edits; refreshed status permits an explicit version save')
fill('Fresh inputs (JSON)','{"n":7}')
click('button','Check inputs');wait('document.body.innerText.includes("Inputs ready")')
assert len([c for c in state()['calls'] if c['operation']=='/run'])==0
click('button','Run saved tool');wait('document.querySelector(".saved-tool-output")?.textContent.includes("14")')
assert js('document.querySelectorAll(".saved-tool-output img").length')==0
assert js('document.querySelector(".saved-tool-output pre").textContent.includes("<img")')
record('Fresh-input recall is read only; explicit run shows an escaped checked result')
click('button','Prepare another run');fill('Fresh inputs (JSON)','{"n":9}');click('button','Check inputs')
wait('document.body.innerText.includes("Inputs ready")');control('uncertain');click('button','Run saved tool')
wait('document.body.innerText.includes("Outcome unknown")')
assert js('[...document.querySelectorAll("button")].find(e=>e.textContent==="Run saved tool").disabled')
click('button','Check result');wait('document.body.innerText.includes("has not been sent again")')
assert len([c for c in state()['calls'] if c['operation']=='/run'])==2
record('Uncertain run retains its operation ID and result checks never resend it')
click('button','Back');click('button','Saved tools');wait('!!document.querySelector(".saved-tools select")')
cdp('DOM.focus',backendNodeId=ax('combobox','Choose a tool version'));key('ArrowDown');key('Enter')
wait('document.body.innerText.includes("Outcome unknown")')
assert js('[...document.querySelectorAll("button")].find(e=>e.textContent==="Run saved tool").disabled')
control('settle');click('button','Check result');wait('document.querySelector(".saved-tool-output")?.textContent.includes("18")')
assert len([c for c in state()['calls'] if c['operation']=='/run'])==2
record('Reopening restores the unknown run from native metadata and reads its eventual receipt without replay')
viewport(900,900);no_overflow();audit('result-desktop');shot('result-desktop')
viewport(390,844);js('document.documentElement.dataset.telegramTheme="dark";true');time.sleep(.2);no_overflow();audit('result-dark-mobile');shot('result-dark-mobile')
control('unavailable');click('button','Refresh tools');wait('document.body.innerText.includes("Saved tools are unavailable")')
assert js('[...document.querySelectorAll("button")].find(e=>e.textContent==="Test revision").matches(":disabled")')
record('Unavailable service is visible while the selected tool and user inputs remain on screen')
click('button','Back');wait('!document.querySelector(".mini-app-screen")')
assert js('document.activeElement?.textContent.trim()')=='Saved tools'
record('Back restores keyboard focus to Saved tools navigation')
(OUT/'report.json').write_text(json.dumps({'passed':True,'fixtureOnly':True,'checks':results,'count':len(results)},indent=2))
print(json.dumps({'passed':True,'checks':len(results),'artifacts':str(OUT)}))
