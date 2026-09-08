# Run against the connectors Vite dev server on 4189 with browser-harness.
# Synthetic API fixture: no real credentials or external accounts.
import pathlib, json, time
fixture=r"""
history.replaceState(null,"","/connect?connection=11111111-1111-4111-8111-111111111111");
window.Telegram={WebApp:{initData:'',ready(){},expand(){}}};
window.__loginCalls=[];window.__connectionStatus='pending';window.__formStarted=0;
window.__otp={attemptId:'22222222-2222-4222-8222-222222222222',challenge:{id:'33333333-3333-4333-8333-333333333333',revision:1,expiresAt:Date.now()+300000}};
window.__otpBound=false;window.__otpAccepted=false;
const nativeId='11111111-1111-4111-8111-111111111111';
const originalFetch=window.fetch;
window.fetch=async(input,options={})=>{
 const url=String(input);if(!url.startsWith('/api/'))return originalFetch(input,options);
 const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
 const body=options.body?JSON.parse(options.body):{};
 window.__loginCalls.push({url,action:body.action,connectionId:body.connectionId,domain:body.domain});
 if(url==='/api/connectors/session')return json({token:'fixture-session'});
 if(options.headers?.Authorization!=='tms fixture-session')return json({},401);
 if(url.endsWith('/connections'))return json({nativeInline:true,connections:[{id:window.__activeId||nativeId,connectorId:'browser:example.com',provider:'browser',status:window.__connectionStatus,createdAt:Date.now()}]});
 if(url.endsWith('/approvals'))return json({pending:[]});
 if(url.endsWith('/password-managers'))return json({managers:[]});
 if(url.endsWith('/disconnect')){window.__connectionStatus='disconnected';return json({status:'disconnected',relayDisconnectStatus:window.__cleanupUnknown?'unknown':'confirmed'});}
 if(url.endsWith('/browser')){window.__connectionStatus='pending';window.__activeId='55555555-5555-4555-8555-555555555555';return json({id:window.__activeId,status:'pending',nativeInline:true});}
 if(url.includes('/native/progress'))return json({progress:window.__formStarted?[{stage:'installing',message:'Preparing browser software…',at:window.__formStarted},{stage:'chromium-ready',message:'Chromium is installed.',at:window.__formStarted+1}]:[]});
 if(url.endsWith('/native')){
  if(window.__failAuth)return json({},401);
  const image={screenshot:'data:image/png;base64,fixture-must-not-render',width:390,height:640};
  if(['error-page','legacy-error'].includes(window.__scenario)){
   if(body.action==='navigate'){window.__reloaded=true;return json({status:'pending',domain:'example.com',fields:[]});}
   if(body.action==='form')return json(window.__reloaded?{status:'pending',domain:'example.com',fields:['username','password']}:{status:'pending',domain:'example.com',fields:[],...(window.__scenario==='legacy-error'?{requiresOrigin:'null',currentHost:'chromewebdata'}:{pageError:'navigation_failed'})});
  }
  if(window.__scenario==='uncertain-page'){
   if(body.action==='form')return json({status:'pending',domain:'example.com',fields:['username','password']});
   if(body.action==='login')return json({status:'pending',domain:'example.com',fields:[],pageError:'navigation_uncertain'});
  }

  if(window.__scenario==='missing' && body.action==='form')return json({status:'pending',domain:'example.com',fields:[],...image});
  if(window.__scenario==='origin'){
   if(body.action==='allow_origin'){window.__approved=true;return json({status:'pending',domain:'example.com',...image});}
   if(body.action==='form')return json(window.__approved?{status:'pending',domain:'example.com',fields:['username','password'],...image}:{status:'pending',domain:'example.com',fields:[],requiresOrigin:'https://identity.example.com',currentHost:'identity.example.com',...image});
  }
  if(window.__scenario?.startsWith('mfa')){
   if(body.action==='form')return json({status:'pending',domain:'example.com',fields:window.__submitted?['code']:['username','password'],...(window.__submitted?window.__otp:{}),...image});
   if(body.action==='login'){window.__submitted=true;return json({status:'pending',domain:'example.com',fields:['code'],...window.__otp,...image});}
   if(body.action==='finish'){
    if(window.__otpAccepted||window.__externalApproval){window.__connectionStatus='connected';return json({status:'connected',domain:'example.com'});}
    return json({error:'not_verified'},409);
   }
   if(body.action==='credentials'){
    window.__otpBound=body.attemptId===window.__otp.attemptId&&body.challengeId===window.__otp.challenge.id&&body.expectedRevision===window.__otp.challenge.revision&&/^[a-f0-9-]{36}$/.test(body.submissionId);
    if(!window.__otpBound)return json({error:'invalid_binding'},400);
    window.__otpAccepted=true;window.__connectionStatus='connected';
    if(window.__scenario==='mfa-lost')throw Error('Fixture acknowledgement lost');
    return json({status:'connected',domain:'example.com'});
   }
  }
  if(body.action==='form') {window.__formStarted=Date.now();await new Promise(r=>setTimeout(r,4000));return json({status:'pending',domain:'example.com',fields:['username','password']});}
  if(body.action==='login'){window.__connectionStatus='connected';return json({status:'connected',domain:'example.com',credentialsSaved:true});}
  throw Error('Unexpected polling after login: '+body.action);
 }
 return json({});
};
"""
new_tab('http://127.0.0.1:4189/connect.html')
cdp('Network.enable')
cdp('Network.setBlockedURLs',urls=['https://telegram.org/js/telegram-web-app.js'])
cdp('Page.addScriptToEvaluateOnNewDocument',source=fixture)
cdp('Page.navigate',url='http://127.0.0.1:4189/connect.html?connection=11111111-1111-4111-8111-111111111111')
time.sleep(3)
js("window.Telegram={WebApp:{initData:'fixture-launch',ready(){},expand(){}}}")
def node(role,name):
 deadline=time.monotonic()+5
 while time.monotonic()<deadline:
  for n in cdp('Accessibility.getFullAXTree')['nodes']:
   if n.get('role',{}).get('value')==role and n.get('name',{}).get('value')==name:return n['backendDOMNodeId']
  time.sleep(.1)
 raise Exception('Missing '+role+' '+name)
def click(role,name):
 n=node(role,name);cdp('DOM.scrollIntoViewIfNeeded',backendNodeId=n);q=cdp('DOM.getBoxModel',backendNodeId=n)['model']['content'];click_at_xy(sum(q[0::2])/4,sum(q[1::2])/4)
click('button','Use my Telegram account')
time.sleep(2)
print(js('document.body.innerText'))
for label,value in [('Email or username','fixture-user'),('Password','fixture-password')]:
 n=node('textbox',label) if label!='Password' else None
 if n:cdp('DOM.focus',backendNodeId=n)
 else:
  root=cdp('DOM.getDocument')['root']['nodeId'];n=cdp('DOM.querySelector',nodeId=root,selector='#website-password')['nodeId'];cdp('DOM.focus',nodeId=n)
 cdp('Input.insertText',text=value)
click('button','Connect')
time.sleep(2)
assert js('document.body.innerText.includes("Chromium is installed.")')
print('PASS: live setup progress appears while the form request is still running')
time.sleep(4)
print(js('document.body.innerText'))
assert not js('!!document.querySelector("#website-password")')
assert js('window.__loginCalls.filter(c=>c.action==="login").length')==1
assert js('window.__loginCalls.filter(c=>c.action==="finish").length')==0
print('PASS: immediate login success closes the panel with one submission and no redundant finish calls')
print(js('JSON.stringify(window.__loginCalls)'))

def wait_for(expression, seconds=15):
 deadline=time.monotonic()+seconds
 while time.monotonic()<deadline:
  try:
   if js(expression):return
  except RuntimeError:
   pass # Navigation may replace the execution context before React mounts.
  time.sleep(.15)
 raise AssertionError('Timed out: '+expression+'; '+str(js('document.body.innerText')))

def open_fixture(scenario):
 cdp('Page.addScriptToEvaluateOnNewDocument',source='sessionStorage.clear();')
 cdp('Page.navigate',url='http://127.0.0.1:4189/connect.html?connection=11111111-1111-4111-8111-111111111111')
 wait_for('document.body.innerText.includes("Use my Telegram account")')
 js('window.Telegram={WebApp:{initData:"fixture-launch",ready(){},expand(){}}};window.__scenario='+json.dumps(scenario))
 click('button','Use my Telegram account')
 wait_for('!!document.querySelector("#website-password") || document.body.innerText.includes("Finish sign-in")')
 if not js('!!document.querySelector("#website-password")'):click('button','Finish sign-in')
 wait_for('!!document.querySelector("#website-password")')
 for selector,value in [('#website-username','fixture-user'),('#website-password','fixture-password')]:
  root=cdp('DOM.getDocument')['root']['nodeId']
  field=cdp('DOM.querySelector',nodeId=root,selector=selector)['nodeId']
  cdp('DOM.focus',nodeId=field);cdp('Input.insertText',text=value)

def assert_form_only():
 assert not js('!!document.querySelector(".native-login img,.native-login iframe,#private-website-text,#private-login-url")')
 assert not js('document.body.innerText.includes("Sign in on website")')
 assert not js('window.__loginCalls.some(c=>["view","click","type","key","scroll","navigate"].includes(c.action))')

open_fixture('missing')
assert_form_only()
click('button','Connect')
wait_for('document.body.innerText.includes("couldn’t find supported sign-in fields")')
assert_form_only()
assert js('!!document.querySelector("#website-password")')
assert not js('window.__loginCalls.some(c=>c.action==="login"||c.action==="credentials")')
print('PASS: missing fields show an explanation and status check without rendering or requesting a browser view')

open_fixture('origin')
click('button','Connect')
wait_for('document.body.innerText.includes("Continue to identity.example.com")')
assert_form_only()
assert not js('!!document.querySelector("#website-password")')
click('button','Continue to identity.example.com')
wait_for('!!document.querySelector("#website-password")')
assert_form_only()
print('PASS: provider approval returns to native login fields without exposing a browser')

open_fixture('mfa')
click('button','Connect')
wait_for('!!document.querySelector("#website-code")')
assert_form_only()
root=cdp('DOM.getDocument')['root']['nodeId']
field=cdp('DOM.querySelector',nodeId=root,selector='#website-code')['nodeId']
cdp('DOM.focus',nodeId=field);cdp('Input.insertText',text='123456')
click('button','Verify and connect')
wait_for('!document.querySelector("#website-code")')
assert js('window.__loginCalls.filter(c=>c.action==="login").length')==1
assert js('window.__loginCalls.filter(c=>c.action==="credentials").length')==1
assert js('window.__otpBound')
print('PASS: verification-code flow completes with no browser controls and no repeated credential submission')

open_fixture('mfa-external')
click('button','Connect')
wait_for('!!document.querySelector("#website-code")')
wait_for('document.body.innerText.includes("Aiko will check automatically")')
root=cdp('DOM.getDocument')['root']['nodeId']
field=cdp('DOM.querySelector',nodeId=root,selector='#website-code')['nodeId']
cdp('DOM.focus',nodeId=field);cdp('Input.insertText',text='123')
wait_for('window.__loginCalls.some(c=>c.action==="finish")')
assert js('document.querySelector("#website-code").value')=='123'
assert not js('window.__loginCalls.some(c=>c.action==="credentials")')
js('window.__externalApproval=true')
wait_for('!document.querySelector("#website-code")')
assert js('window.__loginCalls.filter(c=>c.action==="login").length')==1
assert not js('window.__loginCalls.some(c=>c.action==="credentials")')
assert js('document.querySelector("[data-connection-id]").textContent.includes("Connected")')
print('PASS: approval in another app completes automatically, preserving unsent input while waiting and never sending a code')

open_fixture('mfa-external')
click('button','Connect')
wait_for('!!document.querySelector("#website-code")')
click('button','Back')
wait_for('!document.querySelector("#website-code")')
count=js('window.__loginCalls.filter(c=>c.action==="finish").length')
js('window.__externalApproval=true')
time.sleep(6)
assert js('window.__loginCalls.filter(c=>c.action==="finish").length')==count
assert not js('window.__loginCalls.some(c=>c.action==="credentials")')
print('PASS: cancellation stops automatic approval checks and ignores later approval')

open_fixture('mfa-stale')
click('button','Connect')
wait_for('!!document.querySelector("#website-code")')
root=cdp('DOM.getDocument')['root']['nodeId']
field=cdp('DOM.querySelector',nodeId=root,selector='#website-code')['nodeId']
cdp('DOM.focus',nodeId=field);cdp('Input.insertText',text='123456')
js("window.__otp.challenge={id:'44444444-4444-4444-8444-444444444444',revision:2,expiresAt:Date.now()+300000}")
click('button','Verify and connect')
wait_for('document.body.innerText.includes("verification step changed or expired")')
assert js('window.__loginCalls.filter(c=>c.action==="credentials").length')==0
assert js('document.querySelector("#website-code").value')==''
print('PASS: changed challenge refuses dispatch and clears the stale OTP')

open_fixture('mfa-lost')
click('button','Connect')
wait_for('!!document.querySelector("#website-code")')
root=cdp('DOM.getDocument')['root']['nodeId']
field=cdp('DOM.querySelector',nodeId=root,selector='#website-code')['nodeId']
cdp('DOM.focus',nodeId=field);cdp('Input.insertText',text='123456')
click('button','Verify and connect')
wait_for('document.body.innerText.includes("Could not confirm sign-in")')
assert js('document.querySelector("#website-code").value')==''
assert js('window.__loginCalls.filter(c=>c.action==="credentials").length')==1
click('button','Check sign-in status')
wait_for('!document.querySelector("#website-code")')
assert js('window.__loginCalls.filter(c=>c.action==="credentials").length')==1
assert not js('JSON.stringify([localStorage,sessionStorage]).includes("123456")')
print('PASS: lost OTP acknowledgement uses status verification without resending or persisting the code')

for scenario in ['error-page','legacy-error']:
 open_fixture(scenario)
 click('button','Connect')
 wait_for('document.body.innerText.includes("could not be loaded")')
 assert not js('document.body.innerText.includes("Continue to chromewebdata") || document.body.innerText.includes("uses null")')
 assert js('document.querySelector("#website-password").value')=='fixture-password'
 assert not js('window.__loginCalls.some(c=>["login","credentials","allow_origin"].includes(c.action))')
 click('button','Reload sign-in')
 wait_for('!document.body.innerText.includes("could not be loaded") && !document.querySelector(".native-login").getAttribute("aria-busy").includes("true")')
 assert js('document.querySelector("#website-password").value')=='fixture-password'
 assert js('window.__loginCalls.filter(c=>c.action==="navigate").length')==1
 print('PASS: '+scenario+' offers reload without a false provider or losing unsent input')

open_fixture('uncertain-page')
click('button','Connect')
wait_for('document.body.innerText.includes("before submitting again")')
assert not js('document.body.innerText.includes("Reload sign-in")')
assert js('window.__loginCalls.filter(c=>c.action==="login").length')==1
assert not js('window.__loginCalls.some(c=>c.action==="navigate")')
print('PASS: uncertain submission stops without navigation or replay')

for cleanup_unknown in [False, True]:
 setup=cdp('Page.addScriptToEvaluateOnNewDocument',source='window.__connectionStatus="failed";window.__cleanupUnknown='+json.dumps(cleanup_unknown)+';')
 cdp('Page.navigate',url='http://127.0.0.1:4189/connect.html?connection=11111111-1111-4111-8111-111111111111')
 wait_for('document.body.innerText.includes("Use my Telegram account")')
 js('window.Telegram={WebApp:{initData:"fixture-launch",ready(){},expand(){}}}')
 click('button','Use my Telegram account')
 wait_for('document.body.innerText.includes("Reconnect app")')
 assert not js('!!document.querySelector("#website-password")')
 click('button','Reconnect app')
 if cleanup_unknown:
  wait_for('document.body.innerText.includes("previous sign-in could not be closed")')
  assert not js('window.__loginCalls.some(c=>c.url.endsWith("/browser"))')
  assert not js('!!document.querySelector("#website-password")')
  js('window.__cleanupUnknown=false')
  click('button','Reconnect app')
 wait_for('!!document.querySelector("#website-password")')
 assert js('window.__loginCalls.filter(c=>c.url.endsWith("/browser")).length')==1
 assert js('window.__loginCalls.find(c=>c.url.endsWith("/disconnect")).connectionId')=='11111111-1111-4111-8111-111111111111'
 assert js('window.__loginCalls.find(c=>c.url.endsWith("/browser")).domain')=='example.com'
 for selector,value in [('#website-username','fixture-user'),('#website-password','fixture-password')]:
  root=cdp('DOM.getDocument')['root']['nodeId']
  field=cdp('DOM.querySelector',nodeId=root,selector=selector)['nodeId']
  cdp('DOM.focus',nodeId=field);cdp('Input.insertText',text=value)
 click('button','Connect')
 wait_for('!document.querySelector("#website-password")')
 assert js('window.__loginCalls.find(c=>c.action==="login").connectionId')=='55555555-5555-4555-8555-555555555555'
 assert not js('!!document.querySelector(".mini-app-screen")')
 assert js('document.querySelector("[data-connection-id]").textContent.includes("Connected")')
 cdp('Page.removeScriptToEvaluateOnNewDocument',identifier=setup['identifier'])
 print('PASS: needs-attention reconnect reaches a fresh sign-in and connected tile'+(' after safely retrying uncertain cleanup' if cleanup_unknown else ''))
