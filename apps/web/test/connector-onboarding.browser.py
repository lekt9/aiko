# Run: UNLOCK_ROOT=$PWD BU_CDP_URL=http://127.0.0.1:9337 BH_NO_BROWSER_COOKIES=1 browser-harness < apps/web/test/connector-onboarding.browser.py
# Browser integration test with deterministic API fixtures, never live provider credentials.
import os, pathlib
exec((pathlib.Path(os.environ['UNLOCK_ROOT'])/'scripts/browser_helpers.py').read_text())
OUT = ROOT / 'artifacts/connectors/browser'
OUT.mkdir(parents=True, exist_ok=True)
clicks = []
def click(role, name, contains=False):
    node = ax(role, name, contains)
    cdp('DOM.scrollIntoViewIfNeeded', backendNodeId=node)
    box = cdp('DOM.getBoxModel', backendNodeId=node)['model']['content']
    x, y = sum(box[0::2])/4, sum(box[1::2])/4
    click_at_xy(x, y)
    time.sleep(.15)
    clicks.append({'role':role,'name':name,'x':x,'y':y,'at':time.time(),'method':'CDP Input.dispatchMouseEvent via click_at_xy'})

def account_sign_in():
    node = ax('textbox', 'Aiko account credential (optional outside Telegram)')
    cdp('DOM.focus', backendNodeId=node)
    cdp('Input.insertText', text='fixture-account-credential')
    click('button', 'Sign in to Aiko')
    wait('document.body.innerText.includes("Account connected for this tab")')


def search_for(value):
    cdp('DOM.focus', backendNodeId=ax('searchbox', 'Search any app or website'))
    key('a', 'KeyA', 2)
    cdp('Input.insertText', text=value)
    wait('[...document.querySelectorAll("button")].some(b=>b.textContent==="Find app" && !b.disabled)')
    click('button', 'Find app')

try:
    new_tab(BASE+'/')
    wait_for_load()
    wait('!!document.querySelector(".connector-onboarding")')
    wait('Object.keys(document.querySelector("input[type=search]")).some(k=>k.startsWith("__reactProps"))')
    # Instrument only this test page's API boundary. Real DOM, React handlers and fetch wrapper run.
    fixture_script = '''window.__calls=[];window.__scenario='available';window.__connectionStatus='pending';window.__realFetch=window.fetch;
    window.Telegram={WebApp:{initData:'fixture-signed-init-data'}};
    window.fetch=async (input, options={})=>{
      const url=String(input);if(!url.startsWith('/api/connectors'))return window.__realFetch(input,options);
      window.__calls.push({url,options});
      const json=(body,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}}));
      if(window.__scenario==='unauthorized')return json({},401);
      if(options.headers?.Authorization!=='Bearer fixture-account-credential' && options.headers?.['x-telegram-init-data']!=='fixture-signed-init-data') return json({},401);
      if(url.includes('?query=')){
        if(window.__scenario==='outage')return json({},503);
        if(window.__scenario==='slow') {await new Promise(r=>setTimeout(r,800));return json({status:'available',fallbackAllowed:false,connectors:[{id:'old',name:'Stale provider',description:'',provider:'arcade'}]});}
        if(window.__scenario==='absent')return json({status:'absent',fallbackAllowed:true,connectors:[],message:'Confirmed absent'});
        if(window.__scenario==='unknown')return json({status:'unavailable',fallbackAllowed:false,connectors:[],message:'Unknown coverage'});
        return json({status:'available',fallbackAllowed:false,connectors:[{id:'arcade:GitHub.List',name:'GitHub',description:'Read GitHub issues',provider:'arcade',domains:['github.com'],toolName:'GitHub.List'}]});
      }
      if(url.endsWith('/connect'))return json({id:'owned-connection',connectorId:'arcade:GitHub.List',provider:'arcade',status:'pending',authorizationUrl:window.__scenario==='unsafe'?'javascript:alert(1)':'https://arcade.dev/authorize?fixture=1'});
      if(url.endsWith('/connections'))return json({connections:[{id:'owned-connection',connectorId:'arcade:GitHub.List',provider:'arcade',status:window.__connectionStatus,authorizationUrl:window.__pendingUrlMode==='expired'?undefined:window.__pendingUrlMode==='invalid'?'javascript:alert(1)':'https://arcade.dev/authorize?fixture=resume'}]});
      if(url.endsWith('/complete')){window.__connectionStatus='connected';return json({status:'connected'});}
      if(url.endsWith('/disconnect')){window.__connectionStatus='disconnected';return json({status:'disconnected'});}
      if(url.endsWith('/discover'))return json({status:'needs_evidence',capabilities:[]});
      if(url.endsWith('/browser'))return json({},503);
      throw new Error('Unexpected connector endpoint '+url);
    };true'''
    js(fixture_script)
    search_for('github.com')
    wait('document.body.innerText.includes("Read GitHub issues")')
    assert not js('document.body.innerText.includes("Start secure browser sign-in")')
    click('button','Connect GitHub')
    wait('!!document.querySelector("a[href*=arcade]" )')
    assert js('document.querySelector("a[href*=arcade]").rel') == 'noopener noreferrer'
    assert js('window.__calls.find(x=>x.url.endsWith("/connect")).options.headers["x-telegram-init-data"]') == 'fixture-signed-init-data'
    assert not js('!!window.__calls.find(x=>x.url.endsWith("/connect")).options.headers.Authorization')
    assert json.loads(js('window.__calls.find(x=>x.url.endsWith("/connect")).options.body')) == {'connectorId':'arcade:GitHub.List'}
    record('Available provider uses owner-authenticated API and secure authorization link, with no browser fallback')
    click('button','Refresh connections')
    wait('document.body.innerText.includes("Check authorization")')
    click('button','Check authorization')
    wait('document.querySelector(".connector-connections").innerText.includes("connected") && !document.body.innerText.includes("Check authorization")')
    click('button','Disconnect arcade:GitHub.List')
    wait('document.querySelector(".connector-connections").innerText.includes("disconnected")')
    assert json.loads(js('window.__calls.find(x=>x.url.endsWith("/disconnect")).options.body')) == {'connectionId':'owned-connection'}
    record('Pending authorization is checked explicitly; disconnect refreshes account-scoped connection status')
    js("window.__scenario='absent'")
    search_for('unknown.example')
    wait('document.body.innerText.includes("Needs discovery or a connector built")')
    click('button','Request website discovery')
    wait('document.body.innerText.includes("This website is not connected")')
    assert json.loads(js('window.__calls.find(x=>x.url.endsWith("/discover")).options.body')) == {'domain':'unknown.example'}
    click('button','Start secure browser sign-in')
    wait('!!document.querySelector("[role=alert]")')
    assert not js('!!document.querySelector("a[href*=arcade]")')
    assert js('document.querySelectorAll("input[type=password]").length') == 1
    assert js('document.querySelector("input[type=password]").id') == 'aiko-account-credential'
    record('Confirmed absence allows a discovery request; unconfigured secure sign-in fails without collecting passwords')
    for scenario in ['unknown','outage','unauthorized']:
        js('window.__scenario='+json.dumps(scenario))
        search_for('another.example')
        wait('[...document.querySelectorAll("button")].some(b=>b.textContent==="Find app" && !b.disabled)')
        assert not js('document.body.innerText.includes("Start secure browser sign-in")')
    assert js('document.body.innerText.includes("Sign in with an Aiko account credential")')
    record('Incomplete catalog, outage and unauthenticated responses never unlock fallback')
    js("window.__scenario='unsafe'")
    search_for('github')
    wait('document.body.innerText.includes("Read GitHub issues")')
    click('button','Connect GitHub')
    wait('document.body.innerText.includes("authorization link is invalid")')
    assert not js('!!document.querySelector("a[href^=javascript]")')
    record('Unsafe authorization URL is rejected')
    js("window.__scenario='slow'")
    search_for('old.example')
    cdp('DOM.focus',backendNodeId=ax('searchbox','Search any app or website'))
    key('a','KeyA',2);cdp('Input.insertText',text='new.example')
    time.sleep(1)
    assert not js('document.body.innerText.includes("Stale provider")')
    record('Editing search cancels stale results')
    js("window.__scenario='available'")
    search_for('github')
    wait('document.body.innerText.includes("Read GitHub issues")')
    for width in [320,390,768,1440]:
        viewport(width,1000);no_overflow()
        if width in [390,1440]: audit('connectors-'+str(width));shot('connectors-'+str(width))
    assert js('localStorage.length') == 0
    record('Connector panel fits four viewport widths, passes mobile/desktop accessibility, and persists no browser credentials')
    # Real browser form submission validates a bearer and selects one identity even with Telegram present.
    account_sign_in()
    assert js('window.__calls.at(-1).options.headers.Authorization') == 'Bearer fixture-account-credential'
    assert not js('!!window.__calls.at(-1).options.headers["x-telegram-init-data"]')
    assert not js('!!document.querySelector("#aiko-account-credential")')
    assert not js('JSON.stringify([localStorage,sessionStorage]).includes("fixture-account-credential")')
    assert 'fixture-account-credential' not in js('document.body.innerText')
    shot('account-signed-in')
    click('button', 'Sign out')
    wait('document.body.innerText.includes("Signed out of this tab")')
    assert js('document.querySelector("#aiko-account-credential").value') == ''
    assert not js('document.querySelector(".connector-connections").innerText.includes("arcade:GitHub.List")')
    click('button', 'Refresh connections')
    wait('!!document.querySelector("[role=alert]")')
    assert not js('!!window.__calls.at(-1).options.headers.Authorization')
    assert not js('!!window.__calls.at(-1).options.headers["x-telegram-init-data"]')
    record('Browser account sign-in validates bearer without Telegram identity; sign-out clears credential, private results and subsequent request auth')
    js("window.__connectionStatus='connected';window.Telegram={WebApp:{initData:''}}")
    account_sign_in()
    click('button', 'Disconnect arcade:GitHub.List')
    wait('document.body.innerText.includes("Your account credential was cleared")')
    assert js('document.querySelector("#aiko-account-credential").value') == ''
    click('button', 'Refresh connections')
    wait('!!document.querySelector("[role=alert]")')
    assert not js('!!window.__calls.at(-1).options.headers.Authorization')
    record('Non-Telegram account can disconnect a real UI connection and bearer is cleared immediately')
    js("window.__scenario='unauthorized'")
    cdp('DOM.focus',backendNodeId=ax('textbox','Aiko account credential (optional outside Telegram)'))
    cdp('Input.insertText',text='fixture-rejected-credential')
    click('button','Sign in to Aiko')
    wait('!!document.querySelector("[role=alert]")')
    assert js('document.querySelector("#aiko-account-credential").value') == ''
    assert not js('document.body.innerText.includes("Account connected for this tab")')
    record('Rejected account credential is cleared and never shows a signed-in state')
    js("window.__scenario='available'")
    account_sign_in()
    cdp('Page.reload')
    wait_for_load()
    wait('!!document.querySelector("#aiko-account-credential")')
    assert js('document.querySelector("#aiko-account-credential").value') == ''
    assert not js('document.body.innerText.includes("Account connected for this tab")')
    assert not js('JSON.stringify([localStorage,sessionStorage]).includes("fixture-account-credential")')
    shot('account-cleared-after-reload')
    record('Reload drops bearer and account identity without local or session storage')
    wait('Object.keys(document.querySelector("input[type=search]")).some(k=>k.startsWith("__reactProps"))')
    js(fixture_script)
    account_sign_in()
    wait('document.body.innerText.includes("Resume authorization")')
    link = 'document.querySelector(".connector-connections a")'
    assert js(link+'.href') == 'https://arcade.dev/authorize?fixture=resume'
    assert js(link+'.rel') == 'noopener noreferrer'
    assert js(link+'.target') == '_blank'
    for width in [390,768,1440]:
        viewport(width,1000);no_overflow()
    shot('pending-authorization-after-reload')
    record('After reload and account sign-in, pending consent resumes from the owner connection response')
    for mode in ['expired','invalid']:
        js('window.__pendingUrlMode='+json.dumps(mode))
        click('button','Refresh connections')
        wait('document.body.innerText.includes("Authorization link expired or unavailable")')
        assert not js('!!document.querySelector(".connector-connections a")')
        assert not js('!!document.querySelector("a[href^=javascript]")')
        shot('pending-authorization-'+mode)
    record('Expired URLs omitted by server and invalid URL schemes never render a resume link')
    js("window.__pendingUrlMode='valid'")
    click('button','Refresh connections')
    wait('document.body.innerText.includes("Resume authorization")')
    click('button','Check authorization')
    wait('!document.body.innerText.includes("Resume authorization")')
    record('Completing authorization removes the resume link')
except Exception as error:
    results.append({'check':'Connector onboarding browser suite','passed':False,'error':str(error),'trace':traceback.format_exc()})
    print(traceback.format_exc())
    try: shot('failure')
    except Exception: pass
finally:
    (OUT/'click-witness.json').write_text(json.dumps({'fixtureOnly':True,'clicks':clicks,'credentialValuesRecorded':False},indent=2))
    (OUT/'browser-results.json').write_text(json.dumps({'checks':results},indent=2))
    print(json.dumps(results,indent=2))
if any(not r['passed'] for r in results): raise AssertionError('Connector browser suite failed')
