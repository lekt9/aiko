# Run against the connectors Vite dev server on 4189 with browser-harness.
# Synthetic API fixture: no real credentials or external accounts.
import pathlib, json, time
fixture=r"""
history.replaceState(null,"","/connect?connection=11111111-1111-4111-8111-111111111111");
window.Telegram={WebApp:{initData:'fixture-launch',ready(){},expand(){}}};
window.__loginCalls=[];window.__connectionStatus='pending';window.__formStarted=0;
const nativeId='11111111-1111-4111-8111-111111111111';
const originalFetch=window.fetch;
window.fetch=async(input,options={})=>{
 const url=String(input);if(!url.startsWith('/api/'))return originalFetch(input,options);
 const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
 const body=options.body?JSON.parse(options.body):{};
 window.__loginCalls.push({url,action:body.action});
 if(url==='/api/connectors/session')return json({token:'fixture-session'});
 if(options.headers?.Authorization!=='tms fixture-session')return json({},401);
 if(url.endsWith('/connections'))return json({nativeInline:true,connections:[{id:nativeId,connectorId:'browser:example.com',provider:'browser',status:window.__connectionStatus,createdAt:Date.now()}]});
 if(url.endsWith('/approvals'))return json({pending:[]});
 if(url.endsWith('/password-managers'))return json({managers:[]});
 if(url.includes('/native/progress'))return json({progress:window.__formStarted?[{stage:'installing',message:'Preparing browser software…',at:window.__formStarted},{stage:'chromium-ready',message:'Chromium is installed.',at:window.__formStarted+1}]:[]});
 if(url.endsWith('/native')){
  if(window.__failAuth)return json({},401);
  if(body.action==='form') {window.__formStarted=Date.now();await new Promise(r=>setTimeout(r,4000));return json({status:'pending',domain:'example.com',fields:['username','password']});}
  if(body.action==='login'){window.__connectionStatus='connected';return json({status:'connected',domain:'example.com',credentialsSaved:true});}
  throw Error('Unexpected polling after login: '+body.action);
 }
 return json({});
};
"""
new_tab('http://127.0.0.1:4189/connect.html')
cdp('Page.addScriptToEvaluateOnNewDocument',source=fixture)
cdp('Page.navigate',url='http://127.0.0.1:4189/connect.html?connection=11111111-1111-4111-8111-111111111111')
time.sleep(3)
js("window.Telegram={WebApp:{initData:'fixture-launch',ready(){},expand(){}}}")
def node(role,name):
 for n in cdp('Accessibility.getFullAXTree')['nodes']:
  if n.get('role',{}).get('value')==role and n.get('name',{}).get('value')==name:return n['backendDOMNodeId']
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
