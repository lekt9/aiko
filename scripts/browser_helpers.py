# Shared mechanics executed in browser-harness's pre-imported helper scope.
import base64, json, os, pathlib, time, urllib.request, traceback
ROOT = pathlib.Path(os.environ['UNLOCK_ROOT'])
BASE = os.environ.get('UNLOCK_BASE_URL', 'http://127.0.0.1:4173')
OUT = ROOT / 'artifacts/vault-qa'
OUT.mkdir(parents=True, exist_ok=True)
results = []
def record(name):
    results.append({'check':name,'passed':True}); print('PASS:',name)
def wait(expression, timeout=15):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        if js(expression): return
        time.sleep(.12)
    raise AssertionError('Timed out: '+expression)
def wait_for_service(path='/health', timeout=20):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        try:
            with urllib.request.urlopen(BASE+path,timeout=1) as response:
                if response.status==200:return
        except OSError:pass
        time.sleep(.1)
    raise AssertionError('Fixture service did not become ready')
def api(path, method='GET', data=None):
    req=urllib.request.Request(BASE+'/api/'+path,data=None if data is None else json.dumps(data).encode(),method=method,headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req) as r:return json.load(r)
def goto(path, heading='All logins'):
    goto_url(BASE+path);wait_for_load();wait('document.querySelector("h1")?.textContent.includes('+json.dumps(heading)+')');wait('document.fonts.status === "loaded"')
def ax(role,name,contains=False):
    matches=[n for n in cdp('Accessibility.getFullAXTree')['nodes'] if n.get('role',{}).get('value')==role and (name in n.get('name',{}).get('value','') if contains else n.get('name',{}).get('value')==name)]
    assert len(matches)==1, f'Expected one {role} {name!r}, found {len(matches)}'
    return matches[0]['backendDOMNodeId']
def click(role,name,contains=False):
    node=ax(role,name,contains);cdp('DOM.scrollIntoViewIfNeeded',backendNodeId=node)
    q=cdp('DOM.getBoxModel',backendNodeId=node)['model']['content'];click_at_xy(sum(q[0::2])/4,sum(q[1::2])/4);time.sleep(.15)
def key(name,code=None,modifiers=0):
    vk={'Tab':9,'Enter':13,'Escape':27,'Home':36,'ArrowDown':40,'ArrowUp':38}.get(name,ord(name.upper()) if len(name)==1 else 0)
    cdp('Input.dispatchKeyEvent',type='keyDown',key=name,code=code or name,modifiers=modifiers,windowsVirtualKeyCode=vk,**({'commands':['selectAll']} if name=='a' and modifiers==2 else {}))
    cdp('Input.dispatchKeyEvent',type='keyUp',key=name,code=code or name,modifiers=modifiers,windowsVirtualKeyCode=vk)
def fill(name,value):
    cdp('DOM.focus',backendNodeId=ax('textbox',name));key('a','KeyA',2);cdp('Input.insertText',text=value)
def viewport(width,height=1000):
    cdp('Emulation.setDeviceMetricsOverride',width=width,height=height,deviceScaleFactor=1,mobile=False);wait('window.innerWidth === '+str(width))
def shot(name):
    metrics=cdp('Page.getLayoutMetrics')['cssContentSize']
    data=cdp('Page.captureScreenshot',format='png',captureBeyondViewport=True,clip={'x':0,'y':0,'width':metrics['width'],'height':metrics['height'],'scale':1})['data']
    (OUT/(name+'.png')).write_bytes(base64.b64decode(data))
def no_overflow():
    result=js('''(()=>{const w=document.documentElement.clientWidth;return {width:w,scroll:document.documentElement.scrollWidth,bad:[...document.querySelectorAll('main *,aside *,dialog[open] *')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.right>w+1||r.left< -1)}).map(e=>({tag:e.tagName,class:e.className,text:e.textContent.slice(0,50)}))}})()''')
    assert result['scroll']<=result['width'] and not result['bad'],result
AXE=(ROOT/'node_modules/axe-core/axe.min.js').read_text()
def audit(name):
    if not js('!!window.axe'):
        cdp('Runtime.evaluate',expression='window.__axeSource=""')
        for i in range(0,len(AXE),24000):cdp('Runtime.evaluate',expression='window.__axeSource+='+json.dumps(AXE[i:i+24000])+';true')
        cdp('Runtime.evaluate',expression='(0,eval)(window.__axeSource);delete window.__axeSource;true')
    # Axe can exceed browser-harness's 5s IPC limit on a busy host. Start once,
    # then poll completion; do not replay mutations or suppress failed checks.
    js('window.__axeDone=false;window.__axeError=null;axe.run(document,{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa"]}}).then(r=>{window.__axeResult=r.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}));window.__axeDone=true}).catch(e=>{window.__axeError=String(e);window.__axeDone=true});true')
    wait('window.__axeDone',45)
    assert not js('window.__axeError')
    result=js('window.__axeResult')
    (OUT/(name+'-axe.json')).write_text(json.dumps(result,indent=2));assert not result, result
