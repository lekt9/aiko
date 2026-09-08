"""Run local watch UI fixtures with a disposable Chrome profile, never a real account.

Prerequisites: workspace packages built, Bun, browser-harness, axe-core, and Chrome.
BROWSER_WATCH_CHROME=/absolute/path/to/chrome python3 apps/web/test/browser-watches.fixture-run.py
Port 4187 must be free. This command owns and cleans up its preview and browser.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[3]
saved_tools = '--saved-tools' in sys.argv
OUT = ROOT / ('artifacts/browser-events/ui/saved-tools' if saved_tools else 'artifacts/browser-events/ui')
OUT.mkdir(parents=True, exist_ok=True)
chrome = os.environ.get('BROWSER_WATCH_CHROME') or shutil.which('chromium') or shutil.which('google-chrome')
if not chrome:
    raise SystemExit('Set BROWSER_WATCH_CHROME to an installed Chrome executable. No browser account is reused.')
for executable in ['bun', 'browser-harness']:
    if not shutil.which(executable):
        raise SystemExit(f'Missing prerequisite: {executable}')
with socket.socket() as probe:
    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        probe.bind(('127.0.0.1', 4187))
    except OSError:
        raise SystemExit('Port 4187 is in use. Stop the previous watch preview before running this fixture.')
children = []
started = time.time()
receipt = {'fixtureOnly': True, 'passed': False, 'status': 'running', 'startedAt': started}
receipt_file = OUT / 'fixture-run.json'
receipt_file.write_text(json.dumps(receipt, indent=2))

def abort(signum, _frame):
    raise KeyboardInterrupt(f'Interrupted by signal {signum}')

signal.signal(signal.SIGTERM, abort)

def wait_ready(check, process):
    until = time.monotonic() + 20
    while time.monotonic() < until:
        if process.poll() is not None:
            raise RuntimeError('Fixture process exited before readiness; inspect preview/chrome logs.')
        try:
            value = check()
            if value:
                return value
        except (OSError, ValueError):
            pass
        time.sleep(.1)
    raise RuntimeError('Fixture process did not become ready within 20 seconds.')

with tempfile.TemporaryDirectory(prefix='unlock-watch-fixture-') as profile:
    try:
        with (OUT / 'fixture-chrome.log').open('w') as chrome_log, (OUT / 'fixture-preview.log').open('w') as server_log, (OUT / 'fixture-browser.log').open('w') as browser_log:
            browser = subprocess.Popen([chrome, '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', f'--user-data-dir={profile}', 'about:blank'], stdout=chrome_log, stderr=subprocess.STDOUT, start_new_session=True)
            children.append(browser)
            port = wait_ready(lambda: int((Path(profile) / 'DevToolsActivePort').read_text().splitlines()[0]), browser)
            server = subprocess.Popen(['bun', '--no-env-file', 'apps/web/test/browser-watches.preview.ts'], cwd=ROOT, stdout=server_log, stderr=subprocess.STDOUT, start_new_session=True)
            children.append(server)
            def preview_ready():
                with urllib.request.urlopen('http://127.0.0.1:4187/preview/state', timeout=1) as response:
                    return response.status == 200
            wait_ready(preview_ready, server)
            env = {**os.environ, 'BU_NAME': Path(profile).name, 'BU_CDP_URL': f'http://127.0.0.1:{port}', 'BH_NO_BROWSER_COOKIES': '1', 'UNLOCK_ROOT': str(ROOT)}
            env.pop('BU_CDP_WS', None)
            source = "exec(open('apps/web/test/saved-tools.browser.py').read())\n" if saved_tools else "exec(open('apps/web/test/browser-watches.browser.py').read())\nexec(open('apps/web/test/browser-watches-mount.browser.py').read())\n"
            subprocess.run(['browser-harness'], input=source, text=True, cwd=ROOT, env=env, stdout=browser_log, stderr=subprocess.STDOUT, timeout=120, check=True)
            receipt.update(passed=True, status='passed')
    finally:
        for child in reversed(children):
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=5)
        # Chromium may finish profile writes just after its parent exits.
        # Cleanup is bounded and part of the receipt, not an ignored exception.
        for attempt in range(10):
            try:
                shutil.rmtree(profile)
                break
            except FileNotFoundError:
                break
            except OSError:
                if attempt == 9:
                    receipt.update(passed=False, status='cleanup-failed')
                    raise
                time.sleep(.1)
        receipt.update(completedAt=time.time(), processesStopped=all(child.poll() is not None for child in children), profileRemoved=not Path(profile).exists())
        if not receipt['passed']:
            receipt['status'] = 'failed'
        sources = ['src/components/browser-watch-limits.tsx', 'src/components/browser-watches-panel.tsx', 'src/lib/browser-watches.ts', 'src/styles/browser-watches.css', 'src/styles/mini-app.css', 'src/components/connector-onboarding.tsx', 'test/browser-watches.fixture.tsx', 'test/browser-watches.preview.ts', 'test/browser-watches.browser.py', 'test/browser-watches-mount.browser.py']
        if saved_tools:
            sources += ['src/components/saved-tools-panel.tsx', 'src/lib/saved-tools.ts', 'src/styles/saved-tools.css', 'src/lib/connectors.ts', 'src/server/connector-proxy.ts', 'test/saved-tools.fixture-api.ts', 'test/saved-tools.browser.py']
        receipt['sourceSha256'] = {f'apps/web/{name}': hashlib.sha256((ROOT / 'apps/web' / name).read_bytes()).hexdigest() for name in sources}
        receipt_file.write_text(json.dumps(receipt, indent=2))
print(json.dumps(receipt))
