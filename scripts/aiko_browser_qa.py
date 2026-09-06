# Runs through browser-harness. The service uses actual agent-browser/Chromium, no paid model.
import os, pathlib
exec((pathlib.Path(os.environ['UNLOCK_ROOT'])/'scripts/browser_helpers.py').read_text())
BASE='http://127.0.0.1:4243'
OUT=ROOT/os.environ.get('AIKO_BROWSER_QA_OUT','artifacts/aiko-browser/qa')
OUT.mkdir(parents=True,exist_ok=True)
try:
    wait_for_service()
    new_tab(BASE+'/');wait_for_load();viewport(390,950)
    fill('Local operator token','public-fixture-token-not-a-secret-123456')
    click('button','Open Aiko')
    wait('!document.getElementById("chat").hidden')
    assert 'unlimited tool calls' in js('document.getElementById("mode").textContent')
    record('Console reports the active unlimited native tool policy')
    click('button','Public website');click('button','Send message')
    wait('document.getElementById("browser-observations").textContent.includes("Example Domain") || /unconfirmed|Browser unavailable/.test(document.getElementById("messages").textContent)',90)
    assert 'Example Domain' in js('document.getElementById("browser-observations").textContent'),js('document.getElementById("messages").textContent')
    wait('document.getElementById("cancel").hidden',30)
    assert '\"url\":\"https://example.com' in js('document.getElementById("browser-observations").textContent')
    record('Actual pinned agent-browser and Chromium navigate and observe example.com through native Aiko tools')
    fill('Message Aiko','Browse https://www.iana.org/domains/reserved');click('button','Send message')
    wait('document.getElementById("browser-observations").textContent.includes("IANA")',90)
    wait('document.getElementById("cancel").hidden',30)
    record('Same owner browser crosses from example.com to iana.org without a single-target allowlist')
    # Inspection only: expose observation text for geometry/a11y checks, not page script execution.
    js('document.getElementById("browser-panel").open=true;document.querySelectorAll("#browser-observations details").forEach(d=>d.open=true);true')
    for width in [320,390,768,1440]:
        viewport(width,950);no_overflow();shot('browser-'+str(width))
        if width in [390,1440]:audit('browser-'+str(width))
    record('Real browser evidence panel fits 320/390/768/1440; mobile and desktop axe scans clean')
    click('button','Lock console')
    assert js('document.getElementById("browser-observations").childElementCount')==0
    assert js('document.getElementById("browser-approvals").childElementCount')==0
    assert js('localStorage.length')==0
    record('Lock clears transient browser observations and approvals; no browser storage persistence')
except Exception as error:
    results.append({'check':'Actual browser integration','passed':False,'error':str(error),'trace':traceback.format_exc()});print(traceback.format_exc())
    try:shot('failure')
    except Exception:pass
finally:
    (OUT/'browser-results.json').write_text(json.dumps({'checks':results},indent=2));print(json.dumps(results,indent=2))
