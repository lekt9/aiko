# Synthetic actions, actual native harness and HTTP/UI approval flow; no external interaction.
import os,pathlib
exec((pathlib.Path(os.environ['UNLOCK_ROOT'])/'scripts/browser_helpers.py').read_text())
BASE='http://127.0.0.1:4243';OUT=ROOT/os.environ.get('AIKO_BROWSER_APPROVAL_QA_OUT','artifacts/aiko-browser/approval-qa');OUT.mkdir(parents=True,exist_ok=True)
try:
    wait_for_service()
    new_tab(BASE+'/');wait_for_load();viewport(390,950)
    fill('Local operator token','public-fixture-token-not-a-secret-123456');click('button','Open Aiko')
    wait('!document.getElementById("chat").hidden')
    fill('Message Aiko','Request a synthetic interaction');click('button','Send message')
    wait('document.getElementById("browser-approvals").textContent.includes("Approval required")')
    assert js('document.getElementById("browser-panel").open')
    assert js('document.getElementById("browser-approvals").querySelector("img")===null')
    assert '<img src=x' in js('document.getElementById("browser-approvals").textContent')
    for width in [320,390,768,1440]:
        viewport(width,950);no_overflow()
        if width in [390,1440]:shot('approval-'+str(width));audit('approval-'+str(width))
    record('Synthetic approval arguments and hostile-looking snapshot render as text, not HTML; responsive and axe checks pass')
    click('button','Deny browser action')
    wait('document.getElementById("browser-approvals").childElementCount===0 && document.getElementById("cancel").hidden')
    assert 'was not approved' in js('document.getElementById("messages").textContent')
    record('Deny button reaches native pending operation and reports no requested interaction executed')
    fill('Message Aiko','Request a second synthetic interaction');click('button','Send message')
    wait('document.getElementById("browser-approvals").textContent.includes("Approval required")')
    click('button','Approve browser action')
    wait('document.getElementById("cancel").hidden && document.getElementById("browser-observations").textContent.includes("fixture click")')
    record('Approve button reaches native recheck and synthetic action; not a live external write')
except Exception as error:
    results.append({'check':'Synthetic approval UI','passed':False,'error':str(error),'trace':traceback.format_exc()});print(traceback.format_exc())
    try:shot('failure')
    except Exception:pass
finally:
    (OUT/'browser-results.json').write_text(json.dumps({'checks':results},indent=2));print(json.dumps(results,indent=2))
