import os, pathlib
exec((pathlib.Path(os.environ['UNLOCK_ROOT'])/'scripts/browser_helpers.py').read_text())
OUT=ROOT/'artifacts/csv-qa';OUT.mkdir(exist_ok=True,parents=True)
def upload(file):
    node=js('document.querySelector("input[type=file]")!==null');assert node
    root=cdp('DOM.getDocument')['root']['nodeId']
    node=cdp('DOM.querySelector',nodeId=root,selector='input[type=file]')['nodeId']
    cdp('DOM.setFileInputFiles',nodeId=node,files=[str(file)])
    wait('!document.body.innerText.includes("Reading CSV locally")');time.sleep(.2)
def select(name,index):
    cdp('DOM.focus',backendNodeId=ax('combobox',name));key('Home')
    for _ in range(index):key('ArrowDown')
    key('Enter');time.sleep(.2)
def closed():wait('!document.querySelector("dialog[open]")')
try:
    api('reset','POST',{});initial_profiles=api('profiles');new_tab(BASE+'/settings');wait_for_load();viewport(1440,1000);wait('document.querySelector("h1")?.textContent==="Settings"')
    click('button','Import CSV');assert 'never uploaded' in js('document.querySelector("dialog").innerText')
    upload(ROOT/'tests/fixtures/bad-demo.csv');wait('document.body.innerText.includes("unclosed quoted field")')
    assert len(api('connections'))==4
    record('Malformed CSV reports a safe inline error without importing anything')
    upload(ROOT/'tests/fixtures/mapped-demo.csv');wait('document.body.innerText.includes("Choose different columns")')
    select('Website',1);select('Username',2)
    wait('document.body.innerText.includes("1 ready")')
    assert 'CSV_PASSWORD_CANARY' not in js('document.body.innerText')
    assert not js('[...document.querySelectorAll(".csv-mapping option")].some(o=>/password/i.test(o.textContent))')
    record('Custom header mapping works; password columns are excluded from selectors and preview')
    click('button','Cancel');closed();assert len(api('connections'))==4
    record('Cancel leaves the entire vault unchanged')
    click('button','Import CSV');upload(ROOT/'tests/fixtures/mixed-demo.csv');wait('document.body.innerText.includes("2 ready")')
    text=js('document.querySelector(".csv-counts").textContent');assert '2 duplicates' in text and '2 invalid' in text
    assert 'CSV_PASSWORD_CANARY' not in js('document.body.innerText')
    shot('preview-desktop');audit('preview-desktop')
    record('Mixed export previews all six rows: two ready, two duplicates, two invalid/unsupported')
    for width in [320,375,414,768]:
        viewport(width,950);no_overflow();shot('preview-'+str(width))
        if width==375:audit('preview-mobile')
    record('CSV preview has no horizontal overflow at 320/375/414/768/1440; desktop/mobile axe clean')
    viewport(1440,1000);cdp('Network.enable');cdp('Network.setBlockedURLs',urls=[BASE+'/api/connections/import'])
    click('button','Import 2 logins');wait('!!document.querySelector("dialog [role=alert]")')
    assert len(api('connections'))==4
    cdp('Network.setBlockedURLs',urls=[])
    record('A failed import leaves the preview available for retry with no partial writes')
    click('button','Import 2 logins');wait('document.body.innerText.includes("2 logins added to My vault")')
    assert '4 rows skipped' in js('document.body.innerText');shot('complete-desktop');audit('complete-desktop')
    assert len(api('connections'))==6
    assert api('profiles')==initial_profiles
    record('One confirmed batch imports both accounts on the same site and reports skipped rows')
    click('button','View logins');closed();click('button','Open New, work')
    wait('document.body.innerText.includes("Not imported in this demo")')
    assert not js('[...document.querySelectorAll("button")].some(b=>b.getAttribute("aria-label")==="Show password")')
    record('Imported CSV details clearly omit passwords rather than displaying a fake imported credential')
    goto('/settings','Settings');click('button','Import CSV');upload(ROOT/'tests/fixtures/mixed-demo.csv')
    wait('document.body.innerText.includes("0 ready")')
    assert js('[...document.querySelectorAll("button")].find(b=>b.textContent==="Import 0 logins").disabled')
    record('Re-import detects all saved accounts and cannot overwrite existing logins')
    upload(ROOT/'tests/fixtures/bulk-demo.csv');wait('document.body.innerText.includes("1000 ready")')
    assert js('document.querySelectorAll(".csv-preview tbody tr").length')==25
    click('button','Next rows');wait('document.body.innerText.includes("Page 2 of 40")')
    assert js('document.querySelector(".csv-preview tbody th").textContent')=='27'
    shot('bulk-preview-desktop')
    record('An entire 1,000-row CSV is parsed; a 25-row paginated preview remains bounded')
    before=api('profiles');click('button','Import 1000 logins');wait('document.body.innerText.includes("1000 logins added to My vault")',30)
    assert len(api('connections'))==1006 and api('profiles')==before
    assert all(c.get('passwordUnavailable') for c in api('connections')[4:])
    assert 'CSV_PASSWORD_CANARY' not in json.dumps(api('workspace'))
    record('The full 1,000-row file imports in one batch; source passwords never reach stored state or activity')
    assert js('localStorage.length')==0
    record('No file content is persisted in localStorage')
    api('reset','POST',{});goto('/settings','Settings')
except Exception as error:
    results.append({'check':'CSV browser suite','passed':False,'error':str(error),'trace':traceback.format_exc()});print(traceback.format_exc())
    try:shot('failure')
    except Exception:pass
finally:
    (OUT/'browser-results.json').write_text(json.dumps({'origin':BASE,'checks':results},indent=2));print(json.dumps({'checks':len(results),'failed':sum(not x['passed'] for x in results)}))
if any(not x['passed'] for x in results):raise RuntimeError('CSV browser verification failed')
