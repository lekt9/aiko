"""Render historical vault-demo scope from fresh local evidence. No browser/network work."""
import base64, datetime, html, json, pathlib
from verification_evidence import require, validate
ROOT = pathlib.Path(__file__).resolve().parent.parent
run = validate(ROOT)
QA = ROOT / 'artifacts/vault-qa'
CSV = ROOT / 'artifacts/csv-qa'
def evidence(path):
    require(str(path.relative_to(ROOT)) in run['files'], f'{path.name} is not bound to this run')
    return json.loads(path.read_text())
result = evidence(QA/'browser-results.json')
csv_result = evidence(CSV/'browser-results.json')
require(run.get('scope') == 'development-demo', 'Evidence must declare its development-demo scope')
require(result['origin'] == csv_result['origin'] == run.get('origin'), 'Suites must target the recorded development preview')
for suite in (result, csv_result):
    require(suite['checks'] and all(c['passed'] is True for c in suite['checks']), 'Browser evidence must pass')
result['checks'] += csv_result['checks']
unit = evidence(CSV/'unit-results.json')
def count(value, minimum=0):
    return type(value) is int and value >= minimum
require(unit['success'] is True and all(type(unit[k]) is int and unit[k] == 0 for k in ('numFailedTests', 'numFailedTestSuites')), 'Unit evidence must pass')
require(count(unit['numPassedTests'], 1), 'Unit evidence is empty or invalid')
unit_count = unit['numPassedTests']
axe_files = [ROOT/name for name in run['files'] if name.endswith('-axe.json')]
violations = sum(len(evidence(p)) for p in axe_files)
require(axe_files and violations == 0, 'Accessibility evidence must pass')
http_counts = []
for file in ['http-dev.txt']:
    report = evidence(CSV/file)
    require(type(report['failed']) is int and report['failed'] == 0 and count(report['passed'], 1), file + ' must pass')
    require(len(report['checks']) == report['passed'], file + ' has inconsistent counts')
    require(report['origin'] == run['origin'], 'HTTP evidence targets a different preview')
    http_counts.append(str(report['passed']))
now = datetime.datetime.now(datetime.timezone.utc).isoformat()
def picture(file, label, small=False):
    path = (QA/file).resolve()
    require(str(path.relative_to(ROOT)) in run['files'], 'Screenshot is not bound to this run')
    data = base64.b64encode(path.read_bytes()).decode()
    return f'<figure class="{"phone" if small else "wide"}"><img src="data:image/png;base64,{data}" alt="{html.escape(label)}"><figcaption>{html.escape(label)}</figcaption></figure>'
checks = ''.join('<li>'+html.escape(c['check'])+'</li>' for c in result['checks'])
images = picture('final-desktop.png','Vault view · recorded development screenshot') + picture('profile-picker-desktop.png','Profile switching · My vault and named agents')
images += '<div class="phones">'+picture('vault-375.png','Phone · saved login list',True)+picture('login-375.png','Phone · selected login',True)+picture('profile-form-mobile.png','Phone · new profile',True)+'</div>'
images += picture('../csv-qa/preview-desktop.png','CSV preview · recorded development screenshot') + picture('../csv-qa/preview-375.png','CSV preview · phone',True)
origin = html.escape(run['origin'], quote=True)
page = f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unlock development demo verification</title>
<style>body{{max-width:1100px;margin:40px auto;padding:0 20px;font:16px/1.6 system-ui;color:#192337;background:#f5f7fb}}img{{max-width:100%;height:auto}}figure{{margin:24px 0}}pre,code{{overflow-wrap:anywhere}}.phones{{display:flex;flex-wrap:wrap;gap:16px}}.phone{{max-width:320px}}a{{color:#224bd0}}</style></head><body><main>
<h1>Development demo verification</h1>
<p>Measured local fixture behavior at <a href="{origin}">{origin}</a>. This report covers the historical synthetic vault/CSV interface running in development mode. It does not verify Aiko's production interface, deployed providers, real authentication or credential custody.</p>
<p>Run <code>{html.escape(run['runId'])}</code>; source revision <code>{html.escape(run['source']['revision'])}</code>, content SHA-256 <code>{html.escape(run['source']['contentSha256'])}</code>.</p>
<p>Tests completed {html.escape(run['completedAt'])}. Report generated {now}.</p>
<ul><li>{unit_count} unit tests passed.</li><li>{len(result['checks'])} browser checks passed.</li><li>{len(axe_files)} axe scans contained {violations} reported violations.</li><li>{' + '.join(http_counts)} HTTP checks passed against the same development demo.</li></ul>
<p>Typechecking, formatting and the build command also passed in this recorded run. Building the production bundle does not mean the browser checks exercised that bundle. No independent review or comprehensive accessibility certification is implied by generation.</p>
<h2>Recorded browser checks</h2><ol>{checks}</ol>
<h2>Recorded screenshots</h2>{images}
<h2>Scope and reproduction</h2><p>All records and images must be bound to this run, unchanged and fresh. Specific coverage is described by the recorded checks above; historical viewport, import-size and review claims are not carried forward.</p>
<p>With an explicitly enabled loopback development demo and an isolated browser, run <code>python3 scripts/verification_evidence.py</code>, then <code>python3 scripts/write-verification.py</code>. Fresh evidence can replace this report; failed validation preserves it. Raw evidence is in <code>artifacts/vault-qa/</code> and <code>artifacts/csv-qa/</code>.</p>
<p>The <a href="vault-ux.html">vault design proposal</a> and <a href="backend-verification.html">separate backend report</a> retain their own scope and evidence. This report does not establish either backend custody or live service readiness.</p>
</main></body></html>'''
(ROOT/'docs/verification.html').write_text(page)
log = {'revision':run['source']['revision'],'sourceSha256':run['source']['contentSha256'],'runId':run['runId'],'verifiedAt':run['completedAt'],'generatedAt':now,'preview':result['origin'],'unitTests':int(unit_count),'browserChecks':len(result['checks']),'axeScans':len(axe_files),'axeViolations':violations,'report':'docs/verification.html','evidence':['artifacts/vault-qa','artifacts/csv-qa'],'review':'Automated checks passed in the synthetic-demo scope. This run does not establish a human review or security/accessibility certification. Historical dashboard scores are not reused.','limitations':['No real vault custody/authentication in the web demo','No real password import or change in the web demo','No automatic provider renewal in the web demo','Chromium only']}
(ROOT/'.hallmark').mkdir(exist_ok=True)
log['scope'] = 'development-demo'
(ROOT/'.hallmark/log.json').write_text(json.dumps(log,indent=2)+'\n')
print(json.dumps(log,indent=2))
