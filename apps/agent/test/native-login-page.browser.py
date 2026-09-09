# Run from the repository root with browser-harness against an isolated test browser.
# Exercises the production expressions in Chrome, without real accounts or secrets.
import json, os, subprocess
expressions=json.loads(subprocess.check_output(['bun','-e',"import {nativeLoginFields,nativeLoginLink,nativeLoginFieldTargets} from './apps/agent/src/native-login-page.ts'; console.log(JSON.stringify({fields:nativeLoginFields,link:nativeLoginLink,targets:nativeLoginFieldTargets}));"],text=True))
new_tab('about:blank')
digits=''.join('<input maxlength="1" inputmode="numeric">' for _ in range(6))
count=0
for html,expected in [
 ('<form><input type="email"><button>Subscribe</button></form><form><input autocomplete="username"><input type="password"></form>',['username','password']),
 ('<form><input type="email"><button>Subscribe</button></form>',[]),
 ('<form><label for="a">Email or mobile number</label><input id="a"><input type="password"></form>',['username','password']),
 ('<form><input name="opaque-id"><input type="password"></form>',['username','password']),
 ('<form><input aria-label="Email verification code" inputmode="numeric"></form>',['code']),
 ('<h1>Check your email</h1><p>Enter the code we sent to your email</p><label for="otp">Code</label><input id="otp" name="email" autocomplete="off"><button>Continue</button>',['code']),
 ('<h1>Enter your security code</h1><input aria-label="Code">',['code']),
 ('<h1>Checkout</h1><p>Enter your code for a discount</p><label for="coupon">Code</label><input id="coupon">',[]),
 ('<h1>Check your email</h1><label for="postal">Postal code</label><input id="postal">',[]),
 ('<h1>Sign in</h1><label for="user">Code</label><input id="user" name="email"><input type="password">',['username','password']),
 ('<form><input type="email" disabled><input type="email" style="display:none"><input type="email"><button>Sign in</button></form>',['username']),
 ('<form><input type="text"><input type="text"><input type="password"></form>',['password']),
 ('<h1>Sign in</h1><span id="account">Email or username</span><input aria-labelledby="missing account">',['username']),
 ('<h1>Check your email</h1><span id="otp-title">Code</span><input aria-labelledby="otp-title">',['code']),
 ('<h1>Sign in</h1><fieldset disabled><input type="email"></fieldset><div inert><input type="password"></div><div aria-hidden="true"><input type="password"></div>',[]),
 ('<h1>Check your email</h1><form>'+digits+'</form>',['code']),
 ('<div role="group">'+digits.replace('<input ', '<input autocomplete="one-time-code" ',1)+'</div>',['code']),
 ('<h1>Enter your verification code</h1><form>'+digits+'</form><form>'+digits+'</form>',[]),
 ('<h1>Check your email</h1><form>'+digits+'<input aria-label="Postal code"></form>',[]),
 ('<h1>Check your email</h1>'+digits,[]),
 ('<h1>Check your email</h1><form><input maxlength="1" autocomplete="one-time-code"></form>',[]),
 ('<h1>Check your email</h1><form><input autocomplete="one-time-code"><input autocomplete="one-time-code"></form>',[]),
 ('<h1>Checkout</h1><form>'+digits+'</form>',[]),
]:
 count+=1
 js('document.body.innerHTML='+json.dumps(html))
 actual=js('(()=>{const f='+expressions['fields']+';return Object.keys(f).filter(k=>('+expressions['targets']+')(f,k).length>0)})()')
 assert actual==expected,(actual,expected)
js('document.body.innerHTML='+json.dumps('<a href="https://service.net/member/access">Sign in</a><a href="https://service.net/member/access">Log in</a>'))
assert js(expressions['link'])=='https://service.net/member/access'
js('document.body.innerHTML += '+json.dumps('<a href="https://service.net/admin/access">Sign in</a>'))
assert js(expressions['link']) is None
print(f'PASS: {count+2} discovery DOM cases: accessible labels, bounded split OTP, hidden/disabled fields, ambiguity and links')

# Optional HTTPS fixture exercises dispatch scripts with real Input.insertText.
# Never navigate to a real sign-in: caller must use the documented mapped fixture.
fixture_url=os.environ.get('AIKO_LOGIN_FIELDS_FIXTURE_URL')
if fixture_url:
 new_tab(fixture_url)
 wait_for_load()
 assert js('document.querySelector(\'meta[name="unlock-gmail-fixture"]\')?.content')=='synthetic'
 origin=js('location.origin')
 scripts=json.loads(subprocess.check_output(['bun','-e',"import {nativeLoginPrepareFields,nativeLoginFocusField,nativeLoginSubmit} from './apps/agent/src/native-login-page.ts';import {googleEntryExpression} from './apps/agent/src/native-google-sso.ts';const origin=process.argv[1];console.log(JSON.stringify({prepare:nativeLoginPrepareFields(origin,['code'],6,'fixture-pin'),short:nativeLoginPrepareFields(origin,['code'],3,'fixture-pin'),focus:Array.from({length:6},(_,i)=>nativeLoginFocusField(origin,'code',i,'fixture-pin')),submit:nativeLoginSubmit(origin,'fixture-pin'),google:googleEntryExpression(origin,false),googleClick:googleEntryExpression(origin,true)}));",origin],text=True))
 def reset():
  js('document.body.innerHTML='+json.dumps('<h1>Enter your verification code</h1><form id="login" action="/verify"><input name="action" type="hidden">'+digits+'<button>Verify</button></form>'))
  js("window.submitted=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submitted++}")
 reset()
 assert js(scripts['short']) is False
 assert js(scripts['focus'][0]) is False
 assert js(scripts['prepare'])=={'code':6}
 for index,value in enumerate('654321'):
  assert js(scripts['focus'][index]) is True
  cdp('Input.insertText',text=value)
 assert js("Array.from(document.querySelectorAll('input[maxlength]'),e=>e.value).join('')")=='654321'
 assert js(scripts['submit']) is True
 assert js('window.submitted')==1
 assert js(scripts['submit']) is False
 reset()
 assert js(scripts['prepare'])=={'code':6}
 js("const e=document.querySelector('input[maxlength]');e.replaceWith(e.cloneNode(true))")
 assert js(scripts['focus'][0]) is False
 reset()
 assert js(scripts['prepare'])=={'code':6}
 js("document.querySelector('form').setAttribute('action','https://foreign.example/steal')")
 assert js(scripts['focus'][0]) is False
 assert js(scripts['prepare']) is False
 reset()
 js("const b=document.createElement('button');b.type='submit';b.setAttribute('form','login');b.setAttribute('formaction','https://foreign.example/steal');document.body.append(b)")
 assert js(scripts['prepare']) is False
 reset()
 assert js(scripts['prepare'])=={'code':6}
 js("history.replaceState({},'',location.pathname+'?changed=1')")
 assert js(scripts['focus'][0]) is False
 for html,expected in [
  ('<button>Sign in with Google</button>',1),
  ('<span id="provider">Sign in   with Google</span><button aria-labelledby="provider">Icon</button>',1),
  ('<button>Sign in with Google</button><button>Continue with Google</button>',2),
  ('<fieldset disabled><button>Sign in with Google</button></fieldset>',0),
  ('<button style="visibility:hidden">Sign in with Google</button>',0),
  ('<div aria-disabled="true"><button>Sign in with Google</button></div>',0),
  ('<div inert><button>Sign in with Google</button></div>',0),
  ('<button>Allow Google Drive access</button>',0),
 ]:
  js('document.body.innerHTML='+json.dumps(html))
  js("window.clicked=0;document.querySelectorAll('button').forEach(e=>e.onclick=()=>window.clicked++)")
  assert js(scripts['google'])==expected
  assert js('window.clicked')==0
  assert js(scripts['googleClick'])==expected
  assert js('window.clicked')==(1 if expected==1 else 0)
 print('PASS: HTTPS dispatch: complete split OTP, changed elements/URL/action, foreign submit overrides, single-use submit, and 8 Google entry cases')
