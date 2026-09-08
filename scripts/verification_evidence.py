"""Capture and validate local vault-demo evidence; never infer success from log snippets."""
import datetime as dt
import hashlib
import json
import pathlib
import subprocess
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = pathlib.Path('artifacts/csv-qa/verification-run.json')
CHECKS = ('unit', 'typecheck', 'format', 'build', 'http-dev', 'http-production', 'vault-browser', 'csv-browser')


def require(condition, message):
    # Evidence gates must stay enabled even under python -O.
    if not condition:
        raise ValueError(message)


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_identity(root):
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    paths = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=root).split(b'\0')
    fingerprint = hashlib.sha256()
    for raw in sorted(set(paths)):
        if not raw:
            continue
        name = raw.decode()
        if name.startswith(('artifacts/', '.agent-grid/', '.claude/', '.hallmark/')) or name == 'docs/verification.html' or '__pycache__' in pathlib.PurePath(name).parts:
            continue
        path = root / name
        fingerprint.update(raw + b'\0')
        fingerprint.update(path.read_bytes() if path.is_file() else b'<deleted>')
        fingerprint.update(b'\0')
    return {'revision': revision, 'contentSha256': fingerprint.hexdigest()}


def validate(root=ROOT):
    run = json.loads((root / MANIFEST).read_text())
    require(run['schemaVersion'] == 1 and isinstance(run['runId'], str) and run['runId'], 'Missing run identity')
    require(run['source'] == source_identity(root), 'Evidence does not match current source')
    start = dt.datetime.fromisoformat(run['startedAt']).timestamp()
    finish = dt.datetime.fromisoformat(run['completedAt']).timestamp()
    require(start <= finish <= time.time() + 5 and time.time() - start <= 86400, 'Evidence is stale or has invalid timestamps')
    require(set(run['checks']) == set(CHECKS), 'Missing required checks')
    for name, check in run['checks'].items():
        require(type(check['exitCode']) is int and check['exitCode'] == 0, f'{name} failed')
        require(check['runId'] == run['runId'] and check['source'] == run['source'], f'{name} has different provenance')
        began = dt.datetime.fromisoformat(check['startedAt']).timestamp()
        ended = dt.datetime.fromisoformat(check['completedAt']).timestamp()
        require(start <= began <= ended <= finish, f'{name} has invalid execution times')
    require(run['files'], 'Missing evidence files')
    for name, expected in run['files'].items():
        path = root / name
        require(name.startswith(('artifacts/vault-qa/', 'artifacts/csv-qa/')) and '..' not in pathlib.PurePath(name).parts and path.resolve().is_relative_to((root / 'artifacts').resolve()), 'Invalid evidence path')
        require(path.is_file() and digest(path) == expected, f'{name} changed after execution')
        require(start - 1 <= path.stat().st_mtime <= finish + 1, f'{name} was not produced during this run')
    return run


def capture(root=ROOT):
    """Requires explicit local demo dev/production servers and isolated browser CDP."""
    import os
    env = dict(os.environ)
    dev = env.get('UNLOCK_DEMO_DEV_URL', 'http://127.0.0.1:4173')
    production = env.get('UNLOCK_DEMO_PREVIEW_URL', 'http://127.0.0.1:4174')
    from urllib.parse import urlparse
    for origin in (dev, production):
        require(urlparse(origin).hostname in ('localhost', '127.0.0.1', '::1'), 'Demo checks require loopback servers')
    run = {'schemaVersion': 1, 'runId': str(uuid.uuid4()), 'source': source_identity(root), 'startedAt': now(), 'checks': {}, 'files': {}}
    qa = root / 'artifacts/csv-qa'
    qa.mkdir(parents=True, exist_ok=True)
    # Delete only this generator's manifest. A failed refresh cannot validate an old run.
    (root / MANIFEST).unlink(missing_ok=True)
    commands = [
        ('unit', ['pnpm', 'exec', 'vitest', 'run', 'tests', '--maxWorkers=2', '--reporter=json', '--outputFile=artifacts/csv-qa/unit-results.json'], None),
        ('typecheck', ['pnpm', 'typecheck'], None),
        ('format', ['pnpm', 'format:check'], None),
        ('build', ['pnpm', 'build'], None),
        ('http-dev', ['node', 'scripts/http-smoke.mjs', '--json'], dev),
        ('http-production', ['node', 'scripts/http-smoke.mjs', '--json'], production),
        ('vault-browser', ['node', 'scripts/browser-qa.mjs'], production),
        ('csv-browser', ['node', 'scripts/browser-qa.mjs', '--csv'], production),
    ]
    for name, command, origin in commands:
        started = now()
        check_env = dict(env, **({'UNLOCK_BASE_URL': origin} if origin else {}))
        with (qa / (name + '.txt')).open('w') as output:
            result = subprocess.run(command, cwd=root, env=check_env, stdout=output, stderr=subprocess.STDOUT)
        run['checks'][name] = {'command': command, 'exitCode': result.returncode, 'runId': run['runId'], 'source': run['source'], 'startedAt': started, 'completedAt': now()}
        if result.returncode:
            raise RuntimeError(f'{name} failed; see {qa / (name + ".txt")}')
        require(source_identity(root) == run['source'], 'Source changed during verification; rerun against a stable checkout')
    files = [qa / (name + '.txt') for name in CHECKS] + [qa / 'unit-results.json']
    for directory in (root / 'artifacts/vault-qa', qa):
        files += [directory / 'browser-results.json']
        # Ignore old screenshots/axe scans: the report requires each screenshot it uses below.
        files += [p for p in directory.glob('*-axe.json') if p.stat().st_mtime >= dt.datetime.fromisoformat(run['startedAt']).timestamp() - 1]
    files += [root / name for name in (
        'artifacts/vault-qa/final-desktop.png', 'artifacts/vault-qa/profile-picker-desktop.png',
        'artifacts/vault-qa/vault-375.png', 'artifacts/vault-qa/login-375.png', 'artifacts/vault-qa/profile-form-mobile.png',
        'artifacts/csv-qa/preview-desktop.png', 'artifacts/csv-qa/preview-375.png')]
    run['files'] = {str(p.relative_to(root)): digest(p) for p in files}
    run['completedAt'] = now()
    (root / MANIFEST).write_text(json.dumps(run, indent=2) + '\n')
    validate(root)
    return run


if __name__ == '__main__':
    capture()
    print('Fresh local demo evidence captured. Run python3 scripts/write-verification.py to render it.')
