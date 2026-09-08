# Run from the repository root with browser-harness against an isolated test browser.
# Exercises the production expressions in Chrome, without real accounts or secrets.
import json, subprocess
expressions=json.loads(subprocess.check_output(['bun','-e',"import {nativeLoginFields,nativeLoginLink} from './apps/agent/src/native-login-page.ts'; console.log(JSON.stringify({fields:nativeLoginFields,link:nativeLoginLink}));"],text=True))
new_tab('about:blank')
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
]:
 js('document.body.innerHTML='+json.dumps(html))
 actual=js('(()=>{const f='+expressions['fields']+';return Object.keys(f).filter(k=>f[k].length===1)})()')
 assert actual==expected,(actual,expected)
js('document.body.innerHTML='+json.dumps('<a href="https://service.net/member/access">Sign in</a><a href="https://service.net/member/access">Log in</a>'))
assert js(expressions['link'])=='https://service.net/member/access'
js('document.body.innerHTML += '+json.dumps('<a href="https://service.net/admin/access">Sign in</a>'))
assert js(expressions['link']) is None
print('PASS: fourteen live DOM cases: labels, contextual plain-code OTP, non-verification fields, visibility, ambiguity and discovered login links')
