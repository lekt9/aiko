# Start bun apps/agent/scripts/secretary-work-preview.ts, then run with browser-harness in an isolated Chrome.
import os, pathlib, datetime
exec((pathlib.Path(os.environ['UNLOCK_ROOT'])/'scripts/browser_helpers.py').read_text())
OUT = ROOT / 'artifacts/secretary-work/browser'
OUT.mkdir(parents=True, exist_ok=True)
new_tab('http://127.0.0.1:4129/')
wait('document.body.innerText.includes("No decisions need you here.")')
viewport(390, 844)
no_overflow()
audit('empty-mobile')
click('button', 'Add work')
fill('Outcome', 'Prepare Thursday’s project review')
cdp('DOM.focus', backendNodeId=ax('combobox', 'Contact'))
key('ArrowDown'); key('Enter')
assert js('document.querySelectorAll("select")[1].value') != ''
# Native date controls have separate AX spinbuttons; use the input value setter for an unambiguous timestamp.
js('''(() => {
  const dates = [...document.querySelectorAll('input[type="datetime-local"]')];
  for (const [i, input] of dates.entries()) {
    const d = new Date(Date.now() + [3600000,7200000,10800000][i]);
    const value = new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);
    input.dispatchEvent(new Event('input',{bubbles:true}));
    input.dispatchEvent(new Event('change',{bubbles:true}));
  }
  return true;
})()''')
no_overflow()
audit('form-mobile')
click('button', 'Prepare for review')
wait('document.body.innerText.includes("Authorize request and reminder")')
assert js('document.querySelector(".work-decision").innerText.includes("Please send three agenda items")')
assert js('document.querySelector(".work-decision").innerText.includes("A reminder")')
record('Capture prepares exact request and reminder without sending')
shot('decision-mobile')
audit('decision-mobile')
click('DisclosureTriangle', 'Adjust this work')
click('button', 'Edit proposal')
fill('Request message', 'Please send three numbered agenda items for the project review (1, 2, 3).')
assert js('document.querySelector(".work-edit input[type=\\"datetime-local\\"]").value')
click('button', 'Save change')
wait('document.querySelector(".work-decision").innerText.includes("for the project review")')
record('Editing a proposal preserves explicit dates and produces a new exact authorization preview')
click('button', 'Authorize request and reminder')
wait('!document.body.innerText.includes("Authorize request and reminder")')
click('button', 'Waiting', True)
wait('document.body.innerText.includes("still waiting for the complete agenda")')
record('Approval starts the real native workflow and exposes the waiting state')
click('button', 'Pause')
wait('document.body.innerText.includes("Paused")')
click('button', 'Resume with Aiko')
wait('document.body.innerText.includes("Pause") && !document.body.innerText.includes("Paused")')
record('Pause and resume persist through the owner API')
click('DisclosureTriangle', 'Preview controls')
click('button', 'Simulate Maya’s reply')
click('button', 'Refresh work')
click('button', 'Done', True)
wait('document.body.innerText.includes("Preparation note")')
assert js('document.querySelector(".work-note").innerText.includes("Hiring plan")')
record('Contact reply completes the outcome and produces the preparation note')
shot('done-mobile')
audit('done-mobile')
viewport(1440, 1000)
no_overflow(); shot('done-desktop'); audit('done-desktop')
js('document.documentElement.dataset.telegramTheme="dark";true')
no_overflow(); shot('done-dark'); audit('done-dark')
record('Mobile, desktop and dark theme have no horizontal overflow or detected WCAG A/AA violations')
js('document.documentElement.dataset.telegramTheme="light";true')
click('DisclosureTriangle', 'Contact handoffs')
click('button', 'I’ll handle this contact')
wait('document.body.innerText.includes("Hand back to Aiko")')
click('button', 'Refresh work')
assert js('document.body.innerText.includes("Hand back to Aiko")')
record('Contact takeover survives refresh and requires an explicit hand-back')
click('button', 'Add work')
cdp('DOM.focus', backendNodeId=ax('combobox', 'What should Aiko track?'))
key('ArrowDown'); key('Enter')
fill('Outcome', 'Follow up on the revised document')
fill('Who owes the outcome?', 'Maya')
fill('What establishes completion?', 'The revised document is received')
fill('Next step', 'Review what is still missing')
js('''(() => {
  const input = document.querySelector('.work-form input[type="datetime-local"]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'');
  input.dispatchEvent(new Event('input',{bubbles:true}));
  input.dispatchEvent(new Event('change',{bubbles:true}));
  return true;
})()''')
click('button', 'Track commitment')
wait('document.body.innerText.includes("Deadline not set")')
assert js('document.body.innerText.includes("Next review:")')
record('A commitment with an unknown deadline remains undated and has a separate next review')
(OUT/'report.json').write_text(json.dumps({'checks':results,'count':len(results),'passed':True},indent=2))
print(json.dumps({'passed':True,'checks':len(results),'artifacts':str(OUT)}))
