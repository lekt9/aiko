# Run only against scripts/voyager.fixture.ts through an isolated browser-harness.
import os, pathlib
exec((pathlib.Path(os.environ['UNLOCK_ROOT']) / 'scripts/browser_helpers.py').read_text())
BASE = 'http://127.0.0.1:4244'
OUT = ROOT / 'artifacts/voyager/browser'
OUT.mkdir(parents=True, exist_ok=True)
OWNER = 'voyager-browser-fixture-owner-not-a-secret-123'
OPERATOR = 'voyager-browser-fixture-operator-not-a-secret-123'
UNAVAILABLE = 'voyager-browser-fixture-unavailable-not-a-secret'

def token(value):
    root = cdp('DOM.getDocument')['root']['nodeId']
    node = cdp('DOM.querySelector', nodeId=root, selector='#token')['nodeId']
    cdp('DOM.focus', nodeId=node)
    key('a', 'KeyA', 2)
    cdp('Input.insertText', text=value)

try:
    with urllib.request.urlopen(BASE + '/__fixture/status') as response:
        assert not json.load(response)['revoked'], 'Restart the synthetic fixture before another full run'
    cdp('Network.deleteCookies', name='__Host-aiko-voyager', url=BASE)
    new_tab(BASE + '/'); wait_for_load(); viewport(390, 844)
    wait('!!document.getElementById("token")')
    no_overflow(); audit('login-mobile')
    token(UNAVAILABLE); click('button', 'Open production traces')
    wait('document.getElementById("error").textContent.includes("still here")')
    assert js('document.getElementById("token").value') == UNAVAILABLE
    assert not js('document.querySelector("button").disabled')
    record('A transient production failure keeps the credential in the form and offers retry')
    token(OWNER)
    cdp('Input.dispatchKeyEvent', type='keyDown', key='Enter', code='Enter', text='\r', unmodifiedText='\r', windowsVirtualKeyCode=13)
    cdp('Input.dispatchKeyEvent', type='keyUp', key='Enter', code='Enter', windowsVirtualKeyCode=13)
    wait('location.pathname === "/accounts"')
    assert not js('document.body.textContent.includes("456")')
    assert js('document.querySelector("a.account").textContent.includes("123")')
    assert '__Host-aiko-voyager' not in js('document.cookie')
    no_overflow(); audit('accounts-mobile')
    click('link', '123', True)
    wait('document.body.innerText.includes("Viewer fixture completed")', 25)
    wait('document.body.innerText.includes("/205")')
    assert js('document.getElementById("production-banner").textContent.includes("Production")')
    assert not js('document.querySelector(".rail-new-thread")?.getBoundingClientRect().height')
    assert js('localStorage.getItem("voyager.token")') is None
    for width in [390, 1440]:
        viewport(width, 950)
        assert js('document.documentElement.scrollWidth <= innerWidth')
        assert js('document.getElementById("root").getBoundingClientRect().height > 300')
        shot('native-' + str(width))
    audit('native-desktop')
    click('button', 'Switch to the dark theme')
    audit('native-dark'); shot('native-dark')
    click('button', 'Switch to the light theme')
    record('The pinned native UI renders the production-shaped trace, including paged event 205, without a JavaScript token')
    click('button', 'Sign out')
    wait('location.pathname === "/login"')
    assert not js('!!document.getElementById("root")')
    token(OPERATOR); click('button', 'Open production traces')
    wait('location.pathname === "/accounts"')
    assert js('document.querySelectorAll("a.account").length') == 2
    record('Sign-out clears the view; an operator can choose accounts while an account token cannot')
    click('link', '123', True)
    wait('document.body.innerText.includes("Viewer fixture completed")', 25)
    request = urllib.request.Request(BASE + '/__fixture/revoke', data=b'', method='POST')
    with urllib.request.urlopen(request) as response:
        assert json.load(response)['revoked']
    js('document.dispatchEvent(new Event("visibilitychange"));true')
    wait('location.pathname === "/login"')
    assert not js('!!document.getElementById("root")')
    with urllib.request.urlopen(BASE + '/__fixture/status') as response:
        evidence = json.load(response)
    assert all(item['method'] == 'GET' for item in evidence['received'])
    assert all(item['path'] in ['/v1/status', '/api/control/accounts', '/api/control/threads', '/api/control/events'] for item in evidence['received'])
    record('Revocation clears the visible trace on session recheck; all upstream traffic was a whitelisted GET')
except Exception as error:
    results.append({'check': 'Native Voyager browser journey', 'passed': False, 'error': str(error)})
    raise
finally:
    (OUT / 'results.json').write_text(json.dumps({'checks': results}, indent=2))
    print(json.dumps(results, indent=2))
