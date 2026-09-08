# Run against the connectors Vite dev server on 4189 with browser-harness.
# Synthetic API fixture: no real credentials or external accounts.
import pathlib, json, time, os
PREVIEW = os.environ.get("CONNECTOR_PREVIEW_URL", "http://127.0.0.1:4189")
fixture=r"""
history.replaceState(null,"","/connect?connection=11111111-1111-4111-8111-111111111111");
window.Telegram={WebApp:{initData:'',ready(){},expand(){}}};
window.__loginCalls=[];window.__connectionStatus='pending';window.__formStarted=0;
window.__otp={attemptId:'22222222-2222-4222-8222-222222222222',challenge:{id:'33333333-3333-4333-8333-333333333333',revision:1,expiresAt:Date.now()+300000}};
window.__otpBound=false;window.__otpAccepted=false;
window.__privateInputLeak=false;window.__privateSubmissions=[];window.__fieldStep=0;
window.__layoutVariant=0;window.__layoutVersions=[];
// Synthetic model output: deliberately nested, not the standard fallback spec.
const modelLayout=(fields,variant)=>{
 const types={username:'UsernameField',password:'PasswordField',code:'VerificationCodeField'};
 const root='layout-'+variant,group='group-'+variant;
 const elements={
  [root]:{type:'LoginStack',props:{spacing:'comfortable'},children:['heading','hint',group,'submit']},
  heading:{type:'LoginHeading',props:{text:fields.includes('code')?'Verify your sign-in':variant?'Continue signing in':'Sign in'},children:[]},
  hint:{type:'LoginHint',props:{message:fields.includes('code')?'verification_code':'account_details'},children:[]},
  [group]:{type:'LoginStack',props:{spacing:'compact'},children:fields},
  submit:{type:'LoginSubmit',props:{label:fields.includes('code')?'Verify and connect':'Connect'},children:[]},
 };
 for(const kind of fields)elements[kind]={type:types[kind],props:{},children:[]};
 return {version:'private-login/v2',source:'generated',spec:{root,elements}};
};
const nativeId='11111111-1111-4111-8111-111111111111';
const originalFetch=window.fetch;
window.fetch=async(input,options={})=>{
 const url=String(input);if(!url.startsWith('/api/'))return originalFetch(input,options);
 const json=(body,status=200)=>{
  if(window.__scenario==='mfa-generative' && body.fields?.length && !body.pageError && !body.requiresOrigin){
   body={...body,layout:modelLayout(body.fields,window.__layoutVariant)};window.__layoutVersions.push(window.__layoutVariant);
  }
  return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
 };
 const body=options.body?JSON.parse(options.body):{};
 const privateKeys=['username','password','code'].filter(key=>key in body);
 if(['fixture-password','123456','AB12CD'].some(secret=>JSON.stringify(body).includes(secret)) &&
    (url!=='/api/connectors/native'||!['login','credentials'].includes(body.action)))window.__privateInputLeak=true;
 if(privateKeys.length){
  if(url!=='/api/connectors/native'||!['login','credentials'].includes(body.action))window.__privateInputLeak=true;
  window.__privateSubmissions.push({action:body.action,keys:privateKeys});
 }
 window.__loginCalls.push({url,action:body.action,connectionId:body.connectionId,domain:body.domain});
 if(url==='/api/connectors/session')return json({token:'fixture-session'});
 if(options.headers?.Authorization!=='tms fixture-session')return json({},401);
 if(url.endsWith('/connections'))return json({nativeInline:true,connections:[{id:window.__activeId||nativeId,connectorId:'browser:'+(window.__domain||'example.com'),provider:'browser',status:window.__connectionStatus,createdAt:Date.now()},...(window.__scenario==='gmail-assist'?[{id:'66666666-6666-4666-8666-666666666666',connectorId:'browser:mail.google.com',provider:'browser',status:'connected',createdAt:Date.now()}]:[])]});
 if(url.endsWith('/approvals'))return json({pending:[]});
 if(url.endsWith('/password-managers'))return json({managers:[]});
 if(url.endsWith('/disconnect')){window.__connectionStatus='disconnected';return json({status:'disconnected',relayDisconnectStatus:window.__cleanupUnknown?'unknown':'confirmed'});}
 if(url.endsWith('/browser')){window.__domain=body.domain;window.__connectionStatus='pending';window.__activeId='55555555-5555-4555-8555-555555555555';return json({id:window.__activeId,status:'pending',nativeInline:true});}
 if(url.includes('/native/progress'))return json({progress:window.__formStarted?[{stage:'installing',message:'Preparing browser software…',at:window.__formStarted},{stage:'chromium-ready',message:'Chromium is installed.',at:window.__formStarted+1}]:[]});
 if(url.endsWith('/native')){
  if(window.__failAuth)return json({},401);
  const image={screenshot:'data:image/png;base64,fixture-must-not-render',width:390,height:640};
  if(['error-page','legacy-error'].includes(window.__scenario)){
   if(body.action==='navigate'){window.__reloaded=true;return json({status:'pending',domain:'example.com',fields:[]});}
   if(body.action==='form')return json(window.__reloaded?{status:'pending',domain:'example.com',fields:['username','password']}:{status:'pending',domain:'example.com',fields:[],...(window.__scenario==='legacy-error'?{requiresOrigin:'null',currentHost:'chromewebdata'}:{pageError:'navigation_failed'})});
  }
  if(window.__scenario==='gmail-assist'){
   const base={status:'pending',domain:'example.com',attemptId:window.__otp.attemptId,fields:['username','password']};
   if(body.action==='assist'){
    window.__assistRequests=[...(window.__assistRequests||[]),body];
    if(body.attemptId!==base.attemptId||body.sourceConnectionId!=='66666666-6666-4666-8666-666666666666')return json({},400);
    window.__assistance={id:body.assistanceId,method:body.assistMethod,status:body.assistMethod==='google'?'approval_required':'waiting_email',expiresAt:Date.now()+300000};
   }
   if(body.action==='assist_consent'){
    window.__consentRequests=[...(window.__consentRequests||[]),body];
    if(body.attemptId!==base.attemptId||body.assistanceId!==window.__assistance?.id)return json({},400);
    window.__connectionStatus='connected';return json({...base,status:'connected',fields:[]});
   }
   if(window.__sourceRevoked&&window.__assistance)window.__assistance.status='source_unavailable';
   return json(window.__assistance?{...base,fields:[],assistance:window.__assistance}:base);
  }
  if(window.__scenario==='field-steps'){
   const fields=[['username'],['password'],['code']][window.__fieldStep]||[];
   const view={status:'pending',domain:'example.com',fields,...(window.__fieldStep===2?window.__otp:{})};
   if(body.action==='form')return json(view);
   if(body.action==='finish')return json({error:'not_verified'},409);
   if(body.action==='credentials'){
    const kind=fields[0];
    if(privateKeys.length!==1||privateKeys[0]!==kind||body[kind]!=={username:'fixture-user',password:'fixture-password',code:'AB12CD'}[kind])return json({error:'wrong_step'},400);
    window.__fieldStep++;
    if(window.__fieldStep===3){window.__connectionStatus='connected';return json({status:'connected',domain:'example.com'});}
    return json({...view,fields:[['username'],['password'],['code']][window.__fieldStep],...(window.__fieldStep===2?window.__otp:{})});
   }
  }
  if(window.__scenario==='uncertain-page'){
   if(body.action==='form')return json({status:'pending',domain:'example.com',fields:['username','password']});
   if(body.action==='login')return json({status:'pending',domain:'example.com',fields:[],pageError:'navigation_uncertain'});
  }

  if(window.__scenario==='missing' && body.action==='form')return json({status:'pending',domain:'example.com',fields:[],...image});
  if(window.__scenario==='unsupported' && body.action==='form')return json({status:'pending',domain:'example.com',fields:['username','security-question'],...image});
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
  if(body.action==='form') {window.__formStarted=Date.now();await new Promise(r=>setTimeout(r,4000));return json({status:'pending',domain:window.__domain||'example.com',fields:['username','password']});}
  if(body.action==='login'){window.__connectionStatus='connected';return json({status:'connected',domain:window.__domain||'example.com',credentialsSaved:true});}
  throw Error('Unexpected polling after login: '+body.action);
 }
 return json({});
};
"""
new_tab(PREVIEW+'/connect.html')
cdp('Network.enable')
cdp('Network.setBlockedURLs',urls=['https://telegram.org/js/telegram-web-app.js'])
cdp('Page.addScriptToEvaluateOnNewDocument',source=fixture)
cdp('Page.navigate',url=PREVIEW+'/connect.html?connection=11111111-1111-4111-8111-111111111111')
time.sleep(3)
js("window.Telegram={WebApp:{initData:'fixture-launch',ready(){},expand(){}}}")
def node(role,name):
 deadline=time.monotonic()+5
 while time.monotonic()<deadline:
  for n in cdp('Accessibility.getFullAXTree')['nodes']:
   if not n.get('ignored',False) and n.get('role',{}).get('value')==role and n.get('name',{}).get('value')==name:return n['backendDOMNodeId']
  time.sleep(.1)
 raise Exception('Missing '+role+' '+name)
def click(role,name):
 deadline=time.monotonic()+5
 while True:
  n=node(role,name)
  try:
   cdp('DOM.scrollIntoViewIfNeeded',backendNodeId=n)
   q=cdp('DOM.getBoxModel',backendNodeId=n)['model']['content']
  except RuntimeError as error:
   # React can replace a node after the AX read. Retry discovery only: no input
   # has been dispatched. Never catch/retry the click itself.
   if time.monotonic()>=deadline or not any(text in str(error) for text in ['Could not compute box model','No node','Could not find node']):raise
   time.sleep(.1);continue
  click_at_xy(sum(q[0::2])/4,sum(q[1::2])/4)
  return
click('button','Use my Telegram account')
time.sleep(2)
assert js('document.body.innerText.includes("Chromium is installed.")')
assert not js('!!document.querySelector("#website-password")')
print('PASS: opening discovers private fields with live progress before enabling input')
time.sleep(3)
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

def open_fixture(scenario, initial_scenario='ready', values=None):
 cdp('Page.addScriptToEvaluateOnNewDocument',source='sessionStorage.clear();')
 cdp('Page.navigate',url=PREVIEW+'/connect.html?connection=11111111-1111-4111-8111-111111111111')
 wait_for('document.body.innerText.includes("Use my Telegram account")')
 js('window.Telegram={WebApp:{initData:"fixture-launch",ready(){},expand(){}}};window.__scenario='+json.dumps(initial_scenario))
 click('button','Use my Telegram account')
 wait_for('!!document.querySelector(".native-login") || document.body.innerText.includes("Finish sign-in")')
 if not js('!!document.querySelector(".native-login")'):click('button','Finish sign-in')
 wait_for('document.querySelector("#website-username")?.disabled === false')
 for selector,value in (values if values is not None else [('#website-username','fixture-user'),('#website-password','fixture-password')]):
  root=cdp('DOM.getDocument')['root']['nodeId']
  field=cdp('DOM.querySelector',nodeId=root,selector=selector)['nodeId']
  cdp('DOM.focus',nodeId=field);cdp('Input.insertText',text=value)
 js('window.__scenario='+json.dumps(scenario))

def assert_form_only():
 assert not js('!!document.querySelector(".native-login img,.native-login iframe,#private-website-text,#private-login-url")')
 assert not js('document.body.innerText.includes("Sign in on website")')
 assert not js('window.__loginCalls.some(c=>["view","click","type","key","scroll","navigate"].includes(c.action))')

open_fixture('missing')
assert_form_only()
click('button','Connect')
wait_for('document.body.innerText.includes("couldn’t find supported sign-in fields")')
assert_form_only()
assert js('document.querySelector("#website-password").disabled')
assert js('document.querySelector("#website-password").value')=='fixture-password'
assert not js('window.__loginCalls.some(c=>c.action==="login"||c.action==="credentials")')
print('PASS: missing fields show an explanation and status check without rendering or requesting a browser view')

open_fixture('unsupported')
click('button','Connect')
wait_for('document.body.innerText.includes("not supported yet")')
assert not js('!!document.querySelector(".native-login input")')
assert not js('window.__loginCalls.some(c=>c.action==="login"||c.action==="credentials")')
assert not js('window.__privateInputLeak')
print('PASS: an unsupported live field refuses rendering and credential dispatch rather than guessing a form')

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

open_fixture('mfa-refresh')
click('button','Connect')
wait_for('!!document.querySelector("#website-code")')
root=cdp('DOM.getDocument')['root']['nodeId']
field=cdp('DOM.querySelector',nodeId=root,selector='#website-code')['nodeId']
cdp('DOM.focus',nodeId=field);cdp('Input.insertText',text='123456')
js("window.__otp.challenge={id:'44444444-4444-4444-8444-444444444444',revision:2,expiresAt:Date.now()+300000}")
click('button','Check sign-in status')
wait_for('document.querySelector("#website-code")?.disabled === false && document.querySelector("#website-code").value === ""')
assert js('window.__loginCalls.filter(c=>c.action==="credentials").length')==0
print('PASS: refreshed challenge clears the prior draft rather than rebinding an old code')

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
 cdp('Page.navigate',url=PREVIEW+'/connect.html?connection=11111111-1111-4111-8111-111111111111')
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
 wait_for('document.querySelector("#website-password")?.disabled === false')
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

open_fixture('field-steps', initial_scenario='field-steps', values=[('#website-username','fixture-user')])
assert not js('!!document.querySelector("#website-password") || !!document.querySelector("#website-code")')
click('button','Connect')
wait_for('document.querySelector("#website-password")?.disabled === false')
assert not js('!!document.querySelector("#website-username") || !!document.querySelector("#website-code")')
root=cdp('DOM.getDocument')['root']['nodeId']
field=cdp('DOM.querySelector',nodeId=root,selector='#website-password')['nodeId']
cdp('DOM.focus',nodeId=field);cdp('Input.insertText',text='fixture-password')
click('button','Show password')
assert js('document.querySelector("#website-password").type')=='text'
click('button','Hide password')
assert js('document.querySelector("#website-password").value')=='fixture-password'
click('button','Connect')
wait_for('document.querySelector("#website-code")?.disabled === false')
assert not js('!!document.querySelector("#website-username") || !!document.querySelector("#website-password")')
root=cdp('DOM.getDocument')['root']['nodeId']
field=cdp('DOM.querySelector',nodeId=root,selector='#website-code')['nodeId']
cdp('DOM.focus',nodeId=field);cdp('Input.insertText',text='AB12CD')
click('button','Verify and connect')
wait_for('!document.querySelector("#website-code")')
assert js('window.__privateSubmissions')==[{'action':'credentials','keys':['username']},{'action':'credentials','keys':['password']},{'action':'credentials','keys':['code']}]
assert not js('window.__privateInputLeak')
assert not js('JSON.stringify([localStorage,sessionStorage]).includes("fixture-password") || JSON.stringify([localStorage,sessionStorage]).includes("AB12CD")')
print('PASS: live username → password → alphanumeric verification fields; only private step submissions, no persisted credentials')

open_fixture('mfa-generative', initial_scenario='mfa-generative')
assert js('document.querySelector("[data-login-layout]").dataset.loginLayout')=='generated'
assert js('document.querySelector(".native-login h4").textContent')=='Sign in'
assert js('document.body.innerText.includes("Use your account details for this website.")')
js('window.__layoutVariant=1')
click('button','Check sign-in status')
wait_for('window.__layoutVersions.includes(1) && document.querySelector("#website-password")?.disabled === false')
assert js('document.querySelector(".native-login h4").textContent')=='Sign in'
assert js('document.querySelector("#website-password").value')=='fixture-password'
click('button','Connect')
wait_for('document.querySelector("#website-code")?.disabled === false')
assert js('document.querySelector("[data-login-layout]").dataset.loginLayout')=='generated'
assert js('document.querySelector(".native-login h4").textContent')=='Verify your sign-in'
assert not js('!!document.querySelector("#website-password")')
root=cdp('DOM.getDocument')['root']['nodeId']
field=cdp('DOM.querySelector',nodeId=root,selector='#website-code')['nodeId']
cdp('DOM.focus',nodeId=field);cdp('Input.insertText',text='AB12CD')
click('button','Verify and connect')
wait_for('!document.querySelector("#website-code")')
assert js('window.__otpBound')
assert not js('window.__privateInputLeak')
assert not js('JSON.stringify([localStorage,sessionStorage]).includes("fixture-password") || JSON.stringify([localStorage,sessionStorage]).includes("AB12CD")')
print('PASS: generated component composition renders and changes by step, pins drafts across regeneration, and submits credentials only privately')

setup=cdp('Page.addScriptToEvaluateOnNewDocument',source='history.replaceState(null,"","/connect");window.__connectionStatus="disconnected";sessionStorage.clear();')
cdp('Page.navigate',url=PREVIEW+'/connect.html')
wait_for('document.body.innerText.includes("Use my Telegram account")')
js('window.Telegram={WebApp:{initData:"fixture-launch",ready(){},expand(){}}}')
click('button','Use my Telegram account')
wait_for('!document.querySelector("[aria-label=\'Connect Gmail\']").disabled')
assert js('document.querySelector("[aria-label=\'Add apps\'] .drawer-tile").getAttribute("aria-label")')=='Connect Gmail'
assert js('document.body.innerText.includes("Start with Gmail")')
click('button','Connect Gmail')
wait_for('!!document.querySelector("#website-password")')
assert js('document.body.innerText.includes("Sign in with your Google account")')
assert js('window.__loginCalls.filter(c=>c.url.endsWith("/browser")).length')==1
assert js('window.__loginCalls.find(c=>c.url.endsWith("/browser")).domain')=='mail.google.com'
assert not js('window.__loginCalls.some(c=>["login","credentials"].includes(c.action))')
cdp('Page.removeScriptToEvaluateOnNewDocument',identifier=setup['identifier'])
print('PASS: Gmail is recommended first and opens its canonical private Google sign-in without sending credentials')

for method,label in [('google','Continue with Google'),('email_code','Use emailed code'),('email_link','Use emailed sign-in link')]:
 open_fixture('gmail-assist', initial_scenario='gmail-assist', values=[])
 wait_for('document.body.innerText.includes("Use connected Gmail")')
 # The standard disclosure supports keyboard activation, not a clickable div.
 disclosure=node('DisclosureTriangle','Use connected Gmail')
 cdp('DOM.focus',backendNodeId=disclosure)
 cdp('Input.dispatchKeyEvent',type='keyDown',key='Enter',code='Enter',windowsVirtualKeyCode=13,text='\r')
 cdp('Input.dispatchKeyEvent',type='keyUp',key='Enter',code='Enter',windowsVirtualKeyCode=13)
 wait_for('!!document.querySelector("details.manager-fill[open]")')
 click('button',label)
 wait_for('!!document.querySelector("[aria-label=\\"Private sign-in assistance\\"]")')
 assert not js('!!document.querySelector("#website-password,#website-code,#website-username")')
 assert js('window.__assistRequests.length')==1
 assert js('Object.keys(window.__assistRequests[0]).sort()')==sorted(['connectionId','action','attemptId','assistanceId','assistMethod','sourceConnectionId'])
 assert js('window.__assistRequests[0].assistMethod')==method
 assert not js('window.__loginCalls.some(c=>["login","credentials"].includes(c.action))')
 if method=='google':
  assert not js('!!window.__consentRequests?.length')
  click('button','Approve Google sign-in to example.com')
  wait_for('!document.querySelector(".native-login")')
  assert js('window.__consentRequests.length')==1
  assert js('window.__consentRequests[0].assistanceId===window.__assistRequests[0].assistanceId')
 else:
  assert js('document.body.innerText.includes("Codes and links stay private")')
  js('window.__sourceRevoked=true')
  wait_for('document.body.innerText.includes("Gmail is disconnected, expired or changed")')
  assert js('window.__assistRequests.length')==1
 assert not js('window.__privateInputLeak')
print('PASS: all Gmail assistance methods require an owner action, show private progress, bind consent and stop after source loss')
