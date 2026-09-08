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
require(result['origin'] == csv_result['origin'], 'Suites must target the same preview')
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
for file in ['http-dev.txt', 'http-production.txt']:
    report = evidence(CSV/file)
    require(type(report['failed']) is int and report['failed'] == 0 and count(report['passed'], 1), file + ' must pass')
    require(len(report['checks']) == report['passed'], file + ' has inconsistent counts')
    http_counts.append(str(report['passed']))
now = datetime.datetime.now(datetime.timezone.utc).isoformat()
def picture(file, label, small=False):
    path = (QA/file).resolve()
    require(str(path.relative_to(ROOT)) in run['files'], 'Screenshot is not bound to this run')
    data = base64.b64encode(path.read_bytes()).decode()
    return f'<figure class="{"phone" if small else "wide"}"><img src="data:image/png;base64,{data}" alt="{html.escape(label)}"><figcaption>{html.escape(label)}</figcaption></figure>'
checks = ''.join('<li>'+html.escape(c['check'])+'</li>' for c in result['checks'])
images = picture('final-desktop.png','Production vault · 1440px') + picture('profile-picker-desktop.png','Profile switching · My vault and named agents')
images += '<div class="phones">'+picture('vault-375.png','Phone · saved login list',True)+picture('login-375.png','Phone · selected login',True)+picture('profile-form-mobile.png','Phone · new profile',True)+'</div>'
images += picture('../csv-qa/preview-desktop.png','Whole-file CSV preview · production') + picture('../csv-qa/preview-375.png','CSV preview · phone',True)
page = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unlock — vault redesign verification</title>
<style>*{{box-sizing:border-box}}body{{margin:0;color:#192337;background:#f5f7fb;font:16px/1.65 system-ui,sans-serif}}main{{max-width:1180px;margin:auto;padding:48px 24px}}h1{{font-size:clamp(32px,5vw,56px);line-height:1.1;letter-spacing:-.04em}}h2{{margin-top:44px}}p,li{{max-width:85ch}}a{{color:#224bd0}}.eyebrow{{text-transform:uppercase;letter-spacing:.12em;font-size:12px;font-weight:700;color:#405373}}.summary{{background:#e6edff;border-left:4px solid #244bdc;padding:20px 24px}}.facts{{display:flex;gap:32px;flex-wrap:wrap;margin:32px 0}}.facts strong{{font-size:32px;display:block;line-height:1.2}}.facts span{{font-size:13px}}figure{{margin:24px 0}}img{{display:block;width:100%;height:auto;border:1px solid #d7deeb;border-radius:12px}}figcaption{{font-size:13px;color:#46546d;margin-top:8px}}.phones{{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px}}details{{background:white;padding:16px 24px;border:1px solid #d7deeb;border-radius:12px}}summary{{cursor:pointer;font-weight:600}}footer{{border-top:1px solid #d7deeb;margin-top:48px;padding-top:20px;font-size:13px;color:#46546d}}code{{overflow-wrap:anywhere}}a:focus-visible,summary:focus-visible{{outline:3px solid #244bdc;outline-offset:4px}}@media(max-width:650px){{.phones{{grid-template-columns:1fr}}.phone{{max-width:375px;margin-inline:auto}}main{{padding:28px 16px}}}}</style></head><body><main>
<p class="eyebrow">Unlock · implemented vault redesign</p><h1>A vault, not a dashboard.</h1>
<p>Saved logins first. A visible profile switcher. Sessions stay out of the everyday interface.</p>
<div class="summary"><strong>Production preview: <a href="http://127.0.0.1:4174">http://127.0.0.1:4174</a></strong><br>Development: <a href="http://127.0.0.1:4173">http://127.0.0.1:4173</a>. Synthetic fixtures only; not a production password vault.</div>
<div class="facts"><div><strong>{unit_count}</strong><span>unit/service/runtime tests passed</span></div><div><strong>{len(result['checks'])}</strong><span>production browser checks passed</span></div><div><strong>{len(axe_files)}</strong><span>axe scans · {violations} violations</span></div><div><strong>{' + '.join(http_counts)}</strong><span>real HTTP checks · dev + production</span></div></div>
<h2>What changed</h2><ul><li>Home now opens the login list, with search, favorites and a familiar detail panel.</li><li>My vault and agent profiles live in one dropdown. Switching the view does not change permissions.</li><li>Add a login, share an existing one, or create a profile with selected logins. Sharing does not duplicate credentials.</li><li>Available to controls standing access. Remove from profile and Delete login are different, confirmed actions.</li><li>No overview metrics, session pages, revision counters, maintenance controls or activity/developer navigation. Only actionable sign-in or manager-reconnect exceptions remain.</li><li>Imports and connected-manager samples are in Settings. Optional SDK guidance is collapsed.</li></ul>
<h2>Whole-file CSV import</h2><p>Settings → Import CSV accepts up to 1,000 rows / 1 MiB per file. Common column names are matched automatically; custom mappings are available. Every row appears in a paginated preview. Duplicate website/username pairs and invalid/non-login records are reported explicitly; different accounts on the same website are retained. Nothing is silently truncated or overwritten.</p><p>Importing creates independent demo records in My vault, without granting agent access. Recognized password/note/token columns are discarded locally; only mapped fictional metadata is sent. Real domains are rejected. CSV items display <strong>Password: Not imported in this demo</strong>. The server revalidates every row and publishes the batch only after capacity checks. Request bodies are bounded while streaming.</p><h2>Local production-build screenshots</h2>{images}
<h2>Verification and review</h2><p>Strict TypeScript, {unit_count} tests, formatting and the production build pass. The browser suite exercised real coordinate/keyboard input through browser-harness in isolated Chromium. Five views were checked at 320, 375, 414, 768 and 1440px; dialogs and profile switching have separate checks. Additional 1280×800 and 1920px geometry and reduced motion were verified.</p>
<p>Review retained the separate trusted-runtime boundary and strict synthetic input rules. New regressions cover favorites without revision changes, source-owned identity protection, atomic profile assignment, removal versus global deletion, and rejection of real-domain usernames/password fields. Native dialog keyboard wrapping was tightened after testing showed focus could leave the dialog for browser chrome.</p>
<p>The CSV suite imported all 1,000 rows through the production browser and verified duplicates, malformed quoting, manual mapping, cancellation, real network failure/retry, missing-password labeling and unchanged profile access. Column mapping is collapsed when recognized. A footer overlay that could obscure pagination was removed after browser testing.</p>
<p>This report only accepts complete passing automated checks bound to one fresh run and source fingerprint. Earlier failures are not evidence of success; generating this page does not rerun tests or constitute an independent review.</p>
<details><summary>All {len(result['checks'])} production browser checks</summary><ol>{checks}</ol></details>
<h2>Web-preview scope</h2><p>The separately implemented encrypted backend and new SDK have <a href="backend-verification.html">their own evidence report</a>. This report covers the unchanged synthetic web protocol, not production custody.</p><h2>Deliberate limits of this web demo</h2><ul><li>The password is a fixed fake value. Add/edit forms cannot ingest or update a real password.</li><li>There is no owner authentication, vault cryptography, tenant isolation, production OAuth issuer or real password-manager authorization.</li><li>Sign-in and source reconnect are simulations. The separate backend has a private CDP adapter and renewal worker, but they are not connected to this demo. Provider-specific browser recipes remain gated.</li><li>Session machinery is hidden from the UI, not newly implemented as an autonomous service.</li><li>Access removal blocks future retrieval/sync; already-delivered cookies may still work at the destination.</li><li>State is shared process-local memory. Tests and server restarts reset it. No credentials or UI profile state are written to localStorage.</li><li>Axe is not complete accessibility certification. Safari, Firefox, screen readers and real touch hardware are unverified.</li></ul>
<h2>Evidence and continuity</h2><p>Historical vault-demo implementation: <code>apps/web/src/components/vault/</code>; SDK: <code>packages/sdk/</code>; raw evidence: <code>artifacts/vault-qa/</code> and <code>artifacts/csv-qa/</code>. Capture a fresh run with <code>python3 scripts/verification_evidence.py</code>, then render with <code>python3 scripts/write-verification.py</code>.</p>
<p>The approved direction is in <a href="vault-ux.html">the vault UX proposal</a>. The <a href="unlock-discussion.html">architecture discussion</a> and <a href="build-plan.html">repository-backed production plan</a> remain intact. <a href="dashboard-verification.html">The earlier dashboard report</a> is historical and does not describe the current navigation.</p>
<footer>Tests completed {html.escape(run['completedAt'])}. Report generated {now}. Source revision {html.escape(run['source']['revision'])}; run {html.escape(run['runId'])}. Synthetic local demo evidence only. Screenshots are embedded; this report requires no external assets.</footer>
</main></body></html>'''
(ROOT/'docs/verification.html').write_text(page)
log = {'revision':run['source']['revision'],'sourceSha256':run['source']['contentSha256'],'runId':run['runId'],'verifiedAt':run['completedAt'],'generatedAt':now,'preview':result['origin'],'unitTests':int(unit_count),'browserChecks':len(result['checks']),'axeScans':len(axe_files),'axeViolations':violations,'report':'docs/verification.html','evidence':['artifacts/vault-qa','artifacts/csv-qa'],'review':'Automated checks passed in the synthetic-demo scope. This run does not establish a human review or security/accessibility certification. Historical dashboard scores are not reused.','limitations':['No real vault custody/authentication in the web demo','No real password import or change in the web demo','No automatic provider renewal in the web demo','Chromium only']}
(ROOT/'.hallmark').mkdir(exist_ok=True)
(ROOT/'.hallmark/log.json').write_text(json.dumps(log,indent=2)+'\n')
print(json.dumps(log,indent=2))
