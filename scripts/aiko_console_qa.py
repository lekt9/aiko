# Executed through browser-harness against the isolated, non-secret console fixture.
import os, pathlib
exec((pathlib.Path(os.environ['UNLOCK_ROOT'])/'scripts/browser_helpers.py').read_text())
BASE='http://127.0.0.1:4243'
OUT=ROOT/os.environ.get('AIKO_CONSOLE_QA_OUT','artifacts/aiko-build/console-qa')
OUT.mkdir(parents=True,exist_ok=True)
try:
    wait_for_service()
    new_tab(BASE+'/');wait_for_load();viewport(390,844)
    wait('document.querySelector("h1")?.textContent.includes("Your apps")')
    audit('locked-mobile')
    fill('Local operator token','public-fixture-token-not-a-secret-123456')
    click('button','Open Aiko')
    wait('!document.getElementById("chat").hidden')
    assert js('document.getElementById("token").value')==''
    assert 'DEMO' in js('document.getElementById("mode").textContent')
    click('button','Sample issues')
    click('button','Send message')
    wait('document.querySelector(".message.assistant")?.textContent.includes("#17")',30)
    assert js('document.querySelector(".message.assistant").textContent.includes("synthetic data")')
    assert js('document.querySelector(".message.assistant").textContent.includes("Nothing has been posted")')
    assert js('document.getElementById("message").value')==''
    record('Console authenticates and completes a real native Tardie read with an exact synthetic receipt')
    for width in [320,390,768,1440]:
        viewport(width,950);no_overflow();shot('conversation-'+str(width))
        if width in [390,1440]:audit('conversation-'+str(width))
    record('Conversation and composer have no overflow at 320/390/768/1440; mobile/desktop axe clean')
    viewport(390,950)
    assert 'entity-learn 0.2.0' in js('document.getElementById("mode").textContent')
    fill('Message Aiko','Remember: Use UTC for the launch')
    click('button','Send message')
    wait('Array.from(document.querySelectorAll(".message.assistant")).at(-1)?.textContent.includes("Saved an agent memory claim")',30)
    fill('Message Aiko','Search memory for UTC')
    click('button','Send message')
    wait('Array.from(document.querySelectorAll(".message.assistant")).at(-1)?.textContent.includes("Recorded memory")',30)
    last=js('Array.from(document.querySelectorAll(".message.assistant")).at(-1).textContent')
    assert 'Use UTC for the launch' in last and 'obs_' in last and 'Agent claim' in last
    assert 'synthetic data' not in last
    no_overflow();shot('entity-memory-390');audit('entity-memory-390')
    record('Real entity-learn note write and cited recall work through the authenticated console; no fixture note substituted')
    click('button','Lock console')
    assert js('document.getElementById("chat").hidden')
    assert js('document.getElementById("messages").childElementCount')==0
    assert js('localStorage.length')==0
    record('Lock clears rendered messages and token; no credentials are persisted in browser storage')
except Exception as error:
    results.append({'check':'Aiko console browser suite','passed':False,'error':str(error),'trace':traceback.format_exc()});print(traceback.format_exc())
    try:shot('failure')
    except Exception:pass
finally:
    (OUT/'browser-results.json').write_text(json.dumps({'checks':results},indent=2));print(json.dumps(results,indent=2))
