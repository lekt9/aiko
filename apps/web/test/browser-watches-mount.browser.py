# Tests the actual connected-site screen and its existing Telegram session client, with fixture HTTP only.
import os,pathlib
exec((pathlib.Path(os.environ['UNLOCK_ROOT'])/'scripts/browser_helpers.py').read_text())
OUT=ROOT/'artifacts/browser-events/ui/mount';OUT.mkdir(parents=True,exist_ok=True)
urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:4187/preview/reset',method='POST')).close()
new_tab('http://127.0.0.1:4187/connection');wait_for_load()
wait('!!document.querySelector("[data-connection-id=site-fixture]")')
js('document.documentElement.dataset.telegramTheme="light";true');time.sleep(.25)
viewport(390,844)
click('button','Example Mail — connected. Manage connection')
wait('!!document.querySelector(".mini-app-screen .browser-watches")')
wait('document.body.innerText.includes("No watches for this site yet.")')
no_overflow();audit('connected-site-mount');shot('connected-site-mount')
click('button','New watch');fill('Watch name','Saved summary watch')
cdp('DOM.focus',backendNodeId=ax('combobox','Do'));key('ArrowDown');key('Enter')
click('button','Start watch')
wait('document.querySelector(".watch-card")?.innerText.includes("Watching")')
record('Connected-site App details mounts watches and starts an advertised action through the existing account session client')
click('button','Back')
wait('!document.querySelector(".mini-app-screen")')
assert js('document.activeElement?.dataset.connectionId')=='site-fixture'
record('Back returns to the connected-site tile and restores keyboard focus')
with urllib.request.urlopen('http://127.0.0.1:4187/preview/state') as response:state=json.load(response)
assert len(state['watches'])==1 and state['watches'][0]['config']['connectionId']=='site-fixture'
assert state['watches'][0]['config']['action']['kind']=='harness'
assert state['watches'][0]['config']['expiresAt']==state['connectionExpiresAt']
(OUT/'report.json').write_text(json.dumps({'passed':True,'fixtureOnly':True,'checks':results,'count':len(results)},indent=2))
print(json.dumps({'passed':True,'checks':len(results),'artifacts':str(OUT)}))
