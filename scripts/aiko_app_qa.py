# Production Telegram gateway, executed inside browser-harness with no browser cookies.
import os, pathlib
exec((pathlib.Path(os.environ['UNLOCK_ROOT'])/'scripts/browser_helpers.py').read_text())
OUT = ROOT / 'artifacts/aiko-production/browser'
OUT.mkdir(parents=True, exist_ok=True)

def home(width=390):
    viewport(width, 950)
    goto('/', 'Good to talk.')
    wait('!!document.querySelector(".gateway-page")')

try:
    new_tab(BASE+'/')
    wait_for_load()
    wait('!!document.querySelector(".gateway-page")')
    for width in [320,375,390,414,430,768,1440]:
        home(width)
        no_overflow()
        assert not js('!!document.querySelector(".app-tile,.vault-sidebar,input[type=password]:not(#aiko-account-credential)")')
        shot('gateway-'+str(width))
        if width in [390,1440]: audit('gateway-'+str(width))
    record('Production gateway has no overflow at seven viewport widths and passes mobile/desktop accessibility checks')
    assert js('document.querySelector(".gateway-cta").href') == 'https://t.me/aikospillstea_bot?start=web'
    assert js('document.body.innerText.includes("Private apps are not connected")')
    assert not js('!!document.querySelector("a[href*=\\\"4242\\\"]")')
    record('Real Telegram destination and unavailable private-app capabilities are explicit; no demo account controls or operator URL')
    click('DisclosureTriangle','Connecting another agent?')
    wait('document.querySelector(".gateway-sdk").open')
    assert js('document.querySelector(".gateway-sdk").innerText.includes("@unlock/sdk/aiko")')
    assert js('document.activeElement.tagName') == 'SUMMARY'
    key(' ', 'Space')
    wait('!document.querySelector(".gateway-sdk").open')
    record('SDK instructions expand by pointer and close by keyboard')
    for path in ['connections','profiles','credentials','reset']:
        for method in ['GET','POST']:
            try:
                api(path, method, {} if method=='POST' else None)
                raise AssertionError('Demo route is executable: '+path)
            except urllib.error.HTTPError as error:
                assert error.code == 404, (path, error.code)
    record('Production API rejects reads and writes to all checked demo routes')
    goto('/logins', 'Good to talk.')
    assert not js('!!document.querySelector(".credential-fields,.app-tile")')
    record('Legacy deep links cannot expose the synthetic workspace')
    home(390)
    assert js('localStorage.length') == 0
    audit('gateway-final')
    click('link','Open Aiko in Telegram')
    wait('location.hostname === "t.me" && location.pathname === "/aikospillstea_bot"')
    assert js('location.search') == '?start=web'
    record('CTA really navigates to the verified bot without account data or browser credentials')
except Exception as error:
    results.append({'check':'Production gateway browser suite','passed':False,'error':str(error),'trace':traceback.format_exc()})
    print(traceback.format_exc())
    try: shot('failure')
    except Exception: pass
finally:
    (OUT/'browser-results.json').write_text(json.dumps({'checks':results},indent=2))
    print(json.dumps(results,indent=2))
