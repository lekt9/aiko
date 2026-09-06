# Executed by browser-harness, whose helpers are pre-imported. No personal profile.
import base64, json, os, pathlib, time, urllib.request, traceback
ROOT = pathlib.Path(os.environ['UNLOCK_ROOT'])
BASE = os.environ.get('UNLOCK_BASE_URL', 'http://127.0.0.1:4173')
OUT = ROOT / 'artifacts/qa'
OUT.mkdir(parents=True, exist_ok=True)
results = []

def record(name, details=None):
    results.append({'check': name, 'passed': True, 'details': details})
    print('PASS:', name)

def wait(expression, timeout=12):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if js(expression): return
        time.sleep(.12)
    raise AssertionError('Timed out: ' + expression)

def api(path, method='GET', data=None):
    request = urllib.request.Request(BASE+'/api/'+path, data=None if data is None else json.dumps(data).encode(), method=method, headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(request) as response: return json.load(response)

def goto(path, heading):
    goto_url(BASE + path)
    wait_for_load()
    wait('document.querySelector("h1")?.textContent.includes('+json.dumps(heading)+')')
    wait('document.fonts.status === "loaded"')

def ax(role, name, contains=False):
    nodes = cdp('Accessibility.getFullAXTree')['nodes']
    matches = [n for n in nodes if n.get('role',{}).get('value') == role and (name in n.get('name',{}).get('value','') if contains else n.get('name',{}).get('value') == name)]
    if len(matches) != 1: raise AssertionError(f'Expected one {role} {name!r}; found {len(matches)}')
    return matches[0]['backendDOMNodeId']

def click(role, name, contains=False):
    node = ax(role,name,contains)
    cdp('DOM.scrollIntoViewIfNeeded',backendNodeId=node)
    q=cdp('DOM.getBoxModel',backendNodeId=node)['model']['content']
    click_at_xy(sum(q[0::2])/4,sum(q[1::2])/4)
    time.sleep(.15)

def key(name, code=None, modifiers=0):
    vk={'Tab':9,'Enter':13,'Escape':27}.get(name, ord(name.upper()) if len(name)==1 else 0)
    cdp('Input.dispatchKeyEvent',type='keyDown',key=name,code=code or name,modifiers=modifiers,windowsVirtualKeyCode=vk,**({'commands':['selectAll']} if name=='a' and modifiers==2 else {}))
    cdp('Input.dispatchKeyEvent',type='keyUp',key=name,code=code or name,modifiers=modifiers,windowsVirtualKeyCode=vk)

def fill(name,value):
    node=ax('textbox',name)
    cdp('DOM.focus',backendNodeId=node)
    key('a','KeyA',2)
    cdp('Input.insertText',text=value)

def shot(name):
    cdp('Runtime.evaluate',expression='window.scrollTo(0,0)')
    time.sleep(.1)
    metrics=cdp('Page.getLayoutMetrics')['cssContentSize']
    result=cdp('Page.captureScreenshot',format='png',captureBeyondViewport=True,clip={'x':0,'y':0,'width':metrics['width'],'height':metrics['height'],'scale':1})
    (OUT/(name+'.png')).write_bytes(base64.b64decode(result['data']))

def viewport(width,height=1000):
    cdp('Emulation.setDeviceMetricsOverride',width=width,height=height,deviceScaleFactor=1,mobile=False)
    time.sleep(.15)

def no_overflow():
    result=js('''(() => {
      const w=document.documentElement.clientWidth;
      const offenders=[...document.querySelectorAll('main *, .topbar *, .demo-banner *')].filter(e=>{
        const r=e.getBoundingClientRect();
        return r.width>0 && (r.right>w+1 || r.left< -1) && !e.closest('.table-scroll, .code-block');
      }).map(e=>({tag:e.tagName,class:e.className,text:e.textContent.slice(0,70)}));
      return {width:w,scroll:document.documentElement.scrollWidth,offenders};
    })()''')
    assert result['scroll'] <= result['width'], result
    assert not result['offenders'], result
    return result

try:
    api('reset','POST',{})
    new_tab(BASE+'/')
    wait_for_load()
    viewport(1440,1100)
    wait('document.querySelector("h1")?.textContent === "Workspace overview"')
    record('Overview loads through actual HTTP SDK/API')
    click('link','Connect account')
    wait('location.pathname === "/connect"')
    click('button','One-time import',True)
    wait('document.body.innerText.includes("Start with a sample.")')
    assert js('document.querySelectorAll("input[type=radio]:disabled").length') == 4
    shot('import-preview-desktop')
    click('button','Continue with Vercel')
    click('checkbox','Build agent',True)
    click('button','Connect demo account')
    wait('document.body.innerText.includes("One less sign-in.")')
    state=api('workspace'); added=next(c for c in state['connections'] if c['name']=='Vercel')
    assert added['sourceMode']=='snapshot'
    assert added['id'] in state['profiles'][0]['connectionIds']
    record('One-time import preview skips duplicates, connects fixture and assigns profile')
    click('link','View account')
    wait('document.querySelector("h1")?.textContent === "Vercel"')
    click('button','Simulate refresh')
    wait('document.querySelector(".revision")?.textContent.includes("002")')
    click('button','Pause')
    wait('document.body.innerText.includes("Maintenance stopped")')
    click('button','Resume')
    wait('document.querySelector(".revision")?.textContent.includes("003")')
    record('Refresh increments revision; pause/resume change maintenance state')
    click('button','Simulate challenge')
    wait('document.body.innerText.includes("A sign-in challenge needs your attention.")')
    click('link','Reconnect demo session')
    wait('document.body.innerText.includes("Let’s reconnect Vercel.")')
    click('button','Complete demo recovery')
    wait('document.body.innerText.includes("Session ready again.")')
    assert next(c for c in api('connections') if c['id']==added['id'])['revision']==4
    record('Challenge recovery uses dedicated connect route and publishes a new revision')
    goto('/sources','Credential sources')
    # Two Disconnect buttons: use scoped source section via its accessible heading ancestry.
    node=ax('heading','1Password Demo')
    resolved=cdp('DOM.resolveNode',backendNodeId=node)['object']['objectId']
    obj=cdp('Runtime.callFunctionOn',objectId=resolved,functionDeclaration='function(){return this.closest("section").querySelector("button")}',returnByValue=False)['result']['objectId']
    q=cdp('DOM.getBoxModel',objectId=obj)['model']['content'];click_at_xy(sum(q[0::2])/4,sum(q[1::2])/4)
    wait('!!document.querySelector("dialog[open]")')
    click('button','Disconnect source')
    wait('!document.querySelector("dialog[open]")')
    assert next(c for c in api('connections') if c['id']=='github')['status']=='source-unavailable'
    assert next(c for c in api('connections') if c['id']==added['id'])['status']=='healthy'
    click('button','Connect demo')
    wait('document.body.innerText.includes("Demo source updated")')
    assert next(c for c in api('connections') if c['id']=='github')['status']=='challenge'
    record('Source disconnect blocks dependent sessions but leaves imported snapshots independent')
    goto('/accounts/'+added['id'],'Vercel')
    click('button','Revoke access')
    wait('!!document.querySelector("dialog[open]")')
    assert js('document.querySelector("dialog").innerText.includes("does not log out")')
    click('button','Confirm revocation')
    wait('document.body.innerText.includes("Access revoked")')
    assert all(added['id'] not in p['connectionIds'] for p in api('profiles'))
    record('Truthful revocation confirmation removes standing assignments')
    goto('/agents','Agent profiles')
    click('button','Create profile')
    fill('Profile name','Release runner');fill('Description','Demo release operations')
    click('button','Create profile')
    wait('!document.querySelector("dialog[open]")')
    assert any(p['name']=='Release runner' for p in api('profiles'))
    record('Profile creation saves through management SDK')
    node=ax('heading','Build agent')
    obj=cdp('DOM.resolveNode',backendNodeId=node)['object']['objectId']
    button=cdp('Runtime.callFunctionOn',objectId=obj,functionDeclaration='function(){return this.closest("section").querySelector("button")}',returnByValue=False)['result']['objectId']
    q=cdp('DOM.getBoxModel',objectId=button)['model']['content'];click_at_xy(sum(q[0::2])/4,sum(q[1::2])/4)
    wait('!!document.querySelector("dialog[open]")')
    fill('Profile name','Build worker')
    click('checkbox','Profile enabled',True)
    click('checkbox','Notion',True)
    click('button','Save changes')
    wait('!document.querySelector("dialog[open]")')
    p=next(p for p in api('profiles') if p['id']=='builder')
    assert p['name']=='Build worker' and p['enabled']==False and 'notion' in p['connectionIds']
    record('Profile editor renames, disables and assigns accounts with existing description')
    goto('/developers','Built for your stack.')
    click('button','Register demo client')
    fill('Client name','Demo build client');fill('Redirect URI','http://public.example/callback')
    click('button','Register configuration')
    wait('!!document.querySelector("dialog [role=alert]")')
    fill('Redirect URI','http://127.0.0.1:8787/callback')
    click('button','Register configuration')
    wait('!document.querySelector("dialog[open]")')
    assert len(api('workspace')['clients'])==1
    record('OAuth configuration rejects insecure redirect and recovers with valid loopback URI')
    click('button','Browser runtime');assert js('document.querySelector("pre").innerText.includes("hydrate once")')
    click('button','CLI');assert js('document.querySelector("pre").innerText.includes("not implemented")')
    record('Developer tabs show real SDK versus explicitly planned adapters')
    goto('/settings','Workspace settings')
    fill('Workspace name','Demo QA studio')
    click('button','Save changes')
    wait('document.body.innerText.includes("Workspace preferences saved")')
    goto('/settings','Workspace settings')
    assert js('document.querySelector(".field input").value')=='Demo QA studio'
    record('Workspace preferences survive page reload')
    key('k','KeyK',2)
    wait('!!document.querySelector("dialog[open]")')
    fill('Search workspace','GitHub')
    assert js('document.querySelectorAll(".palette-results a").length')==1
    key('Tab');key('Enter')
    wait('location.pathname === "/accounts/github"')
    record('Ctrl+K palette filters accounts and supports keyboard navigation')
    viewport(375,900)
    click('button','Open navigation')
    wait('!!document.querySelector("dialog[open]")')
    key('Escape')
    wait('!document.querySelector("dialog[open]")')
    click('button','Open navigation')
    click('link','Settings')
    wait('location.pathname === "/settings"')
    record('Mobile modal navigation supports Escape and route selection')
    click('button','Reset demo workspace');click('button','Reset everything')
    wait('!document.querySelector("dialog[open]")')
    assert len(api('workspace')['connections'])==4
    record('Explicit reset restores original synthetic workspace')
    goto('/accounts','Accounts')
    fill('Search accounts','no-such-account')
    wait('document.body.innerText.includes("No accounts match")')
    click('button','Clear filters')
    click('button','Healthy')
    assert js('document.querySelectorAll("tbody tr").length') == 3
    click('button','Revoked')
    wait('document.body.innerText.includes("No accounts match")')
    click('button','All accounts')
    assert js('document.querySelectorAll("tbody tr").length') == 4
    record('Account search and health/revoked filters have meaningful empty states')
    goto('/activity','Activity')
    fill('Search activity','Notion')
    assert js('document.querySelectorAll("tbody tr").length') == 1
    record('Activity search filters real redacted events')
    # Failure and recovery via real network blocking, not replacement component stubs.
    cdp('Network.enable');cdp('Network.setBlockedURLs',urls=[BASE+'/api/workspace'])
    goto_url(BASE+'/');wait_for_load()
    wait('document.body.innerText.includes("Workspace unavailable")',20)
    cdp('Network.setBlockedURLs',urls=[])
    click('button','Try again')
    wait('document.querySelector("h1")?.textContent === "Workspace overview"')
    record('Network error state recovers after retry')
    routes=[('/','Workspace overview','overview'),('/accounts','Accounts','accounts'),('/accounts/github','GitHub','account-detail'),('/connect','Make yourself at home.','connect'),('/agents','Agent profiles','agents'),('/sessions','Sessions','sessions'),('/sources','Credential sources','sources'),('/activity','Activity','activity'),('/developers','Built for your stack.','developers'),('/settings','Workspace settings','settings')]
    axe=(ROOT/'node_modules/axe-core/axe.min.js').read_text()
    for path,heading,name in routes:
        viewport(1440,1100);goto(path,heading);shot(name+'-desktop')
        cdp('Runtime.evaluate',expression='window.__axeSource=""')
        for offset in range(0,len(axe),24000):
            cdp('Runtime.evaluate',expression='window.__axeSource+='+json.dumps(axe[offset:offset+24000])+';true')
        cdp('Runtime.evaluate',expression='(0,eval)(window.__axeSource);delete window.__axeSource;true')
        audit=js('''(async()=>{const r=await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}});return r.violations.map(v=>({id:v.id,impact:v.impact,help:v.help,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}))})()''')
        (OUT/(name+'-axe.json')).write_text(json.dumps(audit,indent=2))
        assert not audit, {'route':path,'accessibility_violations':audit}
        record('Accessibility scan '+path, {'violations':audit})
        for width in [320,375,414,768]:
            viewport(width,1000);no_overflow();shot(name+'-'+str(width))
            if path=='/' and width<=414:
                assert js('document.querySelector(".runtime-strip h2").getBoundingClientRect().width')>150
                assert js('document.querySelector(".attention-banner p").getBoundingClientRect().width')>150
            if width==375:
                mobile_audit=js('(async()=>{const r=await axe.run(document,{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa"]}});return r.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))})()')
                assert not mobile_audit, {'route':path,'mobile_violations':mobile_audit}
        record('Responsive geometry '+path+' at 320/375/414/768')
    viewport(1440,1100);goto('/','Workspace overview')
    assert js('localStorage.length')==0
    record('No application data persisted in localStorage')
except Exception as error:
    results.append({'check':'Browser suite','passed':False,'error':str(error),'trace':traceback.format_exc()})
    print(traceback.format_exc())
    try:shot('failure')
    except Exception:pass
finally:
    (OUT/'browser-results.json').write_text(json.dumps(results,indent=2))
    print(json.dumps({'checks':len(results),'failed':sum(not r['passed'] for r in results)}))
if any(not r['passed'] for r in results): raise RuntimeError('Browser verification failed; see artifacts/qa/browser-results.json')
