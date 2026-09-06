import os, pathlib
exec((pathlib.Path(os.environ['UNLOCK_ROOT'])/'scripts/browser_helpers.py').read_text())
def choose_profile(name):
    click('button','Switch profile:',True)
    if name=='My vault':click('button','My vault All your saved logins')
    else:
        p=next(p for p in api('profiles') if p['name']==name)
        click('button',f'{name} {len(p["connectionIds"])} '+('login' if len(p['connectionIds'])==1 else 'logins')+(' · Access off' if not p['enabled'] else ''))
    wait('!document.querySelector(".profile-popover")')
def dialog_closed():wait('!document.querySelector("dialog[open]")')
def open_login(name):click('button','Open '+name);wait('document.querySelector(".login-identity h2")?.textContent === '+json.dumps(name))
try:
    api('reset','POST',{})
    new_tab(BASE+'/');wait_for_load()
    viewport(1440,1000);wait('document.querySelector("h1")?.textContent === "All logins"')
    text=js('document.body.innerText')
    for forbidden in ['Workspace overview','Healthy sessions','Revision','Simulate refresh','Session health']:
        assert forbidden not in text,forbidden
    record('Home is a vault, with no operational dashboard or session controls')
    before=api('profiles');choose_profile('Build agent')
    wait('document.querySelectorAll(".login-row").length===2')
    assert api('profiles')==before
    assert 'profile=builder' in js('location.search')
    record('Profile switching filters logins without changing access')
    open_login('GitHub');click('button','Show password');assert js('document.querySelector(".revealed").textContent')=='demo-password-only'
    click('button','Copy username');wait('[...document.querySelectorAll("button")].some(b=>b.getAttribute("aria-label")==="username copied")')
    choose_profile('Research agent')
    assert 'demo-password-only' not in js('document.body.innerText')
    record('Owner reveal/copy works for fixtures; switching profiles clears revealed password')
    choose_profile('Build agent');click('button','Add login')
    click('checkbox','Figma',True);click('button','Add 1 login');dialog_closed()
    wait('document.querySelectorAll(".login-row").length===3')
    assert len(api('connections'))==4
    record('Adding an existing login shares the saved item without duplicating credentials')
    click('DisclosureTriangle','More login actions')
    click('button','Remove from profile');wait('!!document.querySelector("dialog[open]")')
    click('button','Remove from profile');dialog_closed()
    wait('document.querySelectorAll(".login-row").length===2')
    assert next(c for c in api('connections') if c['id']=='figma')['status']!='revoked'
    assert 'figma' in next(p for p in api('profiles') if p['id']=='design')['connectionIds']
    record('Remove from profile preserves My vault and other profiles')
    choose_profile('My vault');click('button','Add login')
    assert js('[...document.querySelectorAll("input")].find(b=>b.getAttribute("aria-label")==="Sample password").readOnly')
    click('button','Save login');dialog_closed();wait('document.querySelector(".login-identity h2")?.textContent === "Vercel"')
    created=next(c for c in api('connections') if c['name']=='Vercel' and c['status']!='revoked')
    record('Familiar add-login form saves a synthetic fixture; real password entry is unavailable')
    click('DisclosureTriangle','More login actions');click('button','Edit login')
    fill('Login name','Deploy login');fill('Username','deploy@new.example');click('button','Save changes');dialog_closed()
    wait('document.querySelector(".login-identity h2")?.textContent === "Deploy login"')
    assert next(c for c in api('connections') if c['id']==created['id'])['identity']=='deploy@new.example'
    click('button','Sign in');click('button','Complete demo sign-in');dialog_closed()
    wait('!document.querySelector(".signin-notice")')
    record('Edit login and simple Sign in again recovery work without session jargon')
    click('button','Add favorite');wait('[...document.querySelectorAll("button")].some(b=>b.getAttribute("aria-label")==="Remove favorite")')
    click('link','Favorites');wait('document.querySelectorAll(".login-row").length===2')
    fill('Search logins','nothing-matches');wait('document.body.innerText.includes("No matching logins")')
    fill('Search logins','')
    record('Favorites and search are functional with useful empty states')
    choose_profile('My vault');open_login('Deploy login');click('DisclosureTriangle','More login actions');click('button','Delete login');click('button','Delete for everyone');dialog_closed()
    wait('document.querySelectorAll(".login-row").length===4')
    assert next(c for c in api('connections') if c['id']==created['id'])['status']=='revoked'
    record('Delete login removes vault-wide access, distinct from removal from a profile')
    click('button','Switch profile:',True);click('button','New profile')
    fill('Profile name','Release agent');click('radio','mint');click('checkbox','GitHub',True);click('button','Create profile');dialog_closed()
    wait('document.querySelectorAll(".login-row").length===1')
    p=next(p for p in api('profiles') if p['name']=='Release agent');assert p['avatar']=='mint' and p['connectionIds']==['github']
    click('button','Switch profile:',True);click('button','Edit profile')
    fill('Profile name','Release helper');click('checkbox','Allow agent access',True);click('button','Save profile');dialog_closed()
    wait('document.body.innerText.includes("Access is off for this profile.")')
    record('New/edit profile lives in the dropdown, with avatar, logins and access toggle')
    click('button','Edit access');click('checkbox','Research agent',True);click('button','Save access');dialog_closed()
    assert 'github' in next(p for p in api('profiles') if p['id']=='research')['connectionIds']
    record('Available to editor changes shared access atomically')
    choose_profile('My vault');click('link','Settings');wait('document.querySelector("h1")?.textContent === "Settings"')
    click('button','Import CSV')
    node=cdp('DOM.querySelector',nodeId=cdp('DOM.getDocument')['root']['nodeId'],selector='input[type=file]')['nodeId']
    cdp('DOM.setFileInputFiles',nodeId=node,files=[str(ROOT/'apps/web/public/sample-logins.csv')])
    wait('document.body.innerText.includes("2 ready")');click('button','Import 2 logins');wait('document.body.innerText.includes("Import complete")');click('button','View logins');dialog_closed();open_login('Vercel')
    imported=next(c for c in api('connections') if c['name']=='Vercel' and c['status']!='revoked');assert imported['sourceMode']=='snapshot'
    record('Settings imports a whole CSV while skipping existing logins')
    click('link','Settings');click('button','Disconnect');click('button','Disconnect');dialog_closed()
    assert next(c for c in api('connections') if c['id']=='github')['status']=='source-unavailable'
    assert next(c for c in api('connections') if c['id']==imported['id'])['status']=='challenge'
    click('button','Reconnect demo');wait('document.body.innerText.includes("Demo connected")')
    fill('Vault name','Simple demo vault');click('button','Save name');wait('document.body.innerText.includes("Vault name saved")')
    assert api('workspace')['settings']['name']=='Simple demo vault'
    record('Manager reconnect and preferences work in Settings; imports remain independent')
    click('DisclosureTriangle','About this demo',True);click('button','Reset demo vault');click('button','Reset vault');dialog_closed()
    wait('document.querySelector("h1")?.textContent === "All logins"')
    key('k','KeyK',2);assert js('document.activeElement.getAttribute("aria-label")')=='Search logins'
    fill('Search logins','GitHub');wait('document.querySelectorAll(".login-row").length===1')
    goto('/?profile=builder&login=github&q=GitHub')
    assert js('document.querySelectorAll(".login-row").length')==1
    goto('/?profile=builder&login=notion')
    assert not js('document.querySelector(".credential-fields")')
    goto('/?profile=missing')
    assert js('document.body.innerText.includes("Profile not found")')
    assert not js('document.querySelector(".credential-fields")')
    record('URL state survives reload; unavailable profiles/logins do not fall back to another vault')
    goto('/sessions');assert js('location.pathname')=='/'
    goto('/accounts/github');assert 'login=github' in js('location.search')
    goto('/sources','Settings');assert js('location.pathname')=='/settings'
    record('Old dashboard and detail URLs redirect into the new information architecture')
    viewport(375,900);goto('/');open_login('GitHub')
    assert js('getComputedStyle(document.querySelector(".login-list-panel")).display')=='none'
    click('button','All logins');wait('getComputedStyle(document.querySelector(".login-list-panel")).display!=="none"')
    choose_profile('Build agent');assert js('document.querySelectorAll(".login-row").length')==2
    click('button','Add login');key('Escape');dialog_closed()
    record('Mobile uses list → details → Back, with profile switching and Escape support')
    cdp('Network.enable');cdp('Network.setBlockedURLs',urls=[BASE+'/api/workspace'])
    goto_url(BASE+'/');wait_for_load();wait('document.body.innerText.includes("Workspace unavailable")',20)
    cdp('Network.setBlockedURLs',urls=[]);click('button','Try again');wait('document.querySelector("h1")?.textContent === "All logins"')
    record('Real network failure recovers using Try again')
    for path,name,heading in [('/','vault','All logins'),('/?profile=builder','agent-vault','All logins'),('/?login=github','login','All logins'),('/?login=notion','signin','All logins'),('/settings','settings','Settings')]:
        for width in [320,375,414,768,1440]:
            viewport(width,1000);goto(path,heading);no_overflow();shot(name+'-'+str(width))
            if width in [375,1440]:audit(name+'-'+str(width))
        record(name+' responsive at 320/375/414/768/1440; desktop/mobile axe clean')
    viewport(1440,1000);goto('/');click('button','Switch profile:',True);shot('profile-picker-desktop');audit('profile-picker-desktop');key('Escape')
    viewport(375,900);click('button','Switch profile:',True);no_overflow();shot('profile-picker-mobile');audit('profile-picker-mobile');click('button','New profile');shot('profile-form-mobile');audit('profile-form-mobile');key('Escape')
    record('Profile picker and profile form pass mobile accessibility checks')
    for width in [320,375,768,1440]:
        viewport(width,950);goto('/?profile=builder');click('button','Add login');no_overflow();shot('add-existing-'+str(width));audit('add-existing-'+str(width));key('Escape')
    record('Add-existing dialog works at narrow and wide widths')
    api('reset','POST',{});viewport(375,900);goto('/');click('button','Add login')
    click('button','Use browser sign-in instead')
    assert not js('document.querySelector(".password-input")')
    for _ in range(14):
        key('Tab');assert js('document.activeElement.closest("dialog")!==null')
    click('button','Save login');dialog_closed()
    assert next(c for c in api('connections') if c['name']=='Vercel')['kind']=='session'
    assert 'Browser sign-in' in js('document.body.innerText')
    assert not js('document.querySelector(".masked")')
    record('Browser-sign-in alternative saves a passwordless item; native dialog traps keyboard focus')
    api('reset','POST',{});goto('/settings','Settings');click('button','Add a login from 1Password');click('button','Save login');dialog_closed()
    assert next(c for c in api('connections') if c['name']=='Vercel')['sourceMode']=='reference'
    record('Connected-manager add flow saves a live-reference fixture, distinct from an import')
    api('reset','POST',{});viewport(1440,1000);goto('/?login=github');shot('final-desktop')
    for width,height in [(1280,800),(1920,1080)]:
        viewport(width,height);no_overflow();shot('vault-'+str(width))
    cdp('Emulation.setEmulatedMedia',features=[{'name':'prefers-reduced-motion','value':'reduce'}])
    assert js('getComputedStyle(document.querySelector(".profile-trigger")).transitionDuration')=='0s'
    cdp('Emulation.setEmulatedMedia',features=[])
    record('Steam Deck/larger desktop geometry and reduced-motion styles verified')
    assert js('localStorage.length')==0
    record('No passwords or profile state written to localStorage')
except Exception as error:
    results.append({'check':'Vault browser suite','passed':False,'error':str(error),'trace':traceback.format_exc()});print(traceback.format_exc())
    try:shot('failure')
    except Exception:pass
finally:
    (OUT/'browser-results.json').write_text(json.dumps({'origin':BASE,'checks':results},indent=2));print(json.dumps({'checks':len(results),'failed':sum(not x['passed'] for x in results)}))
if any(not x['passed'] for x in results):raise RuntimeError('Vault browser verification failed')
