"""Regression checks for refusing stale, failed, mixed-source or altered evidence."""
import copy
import datetime as dt
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
import shutil
import sys
from verification_evidence import CHECKS, MANIFEST, digest, now, source_identity, validate


class EvidenceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        subprocess.run(['git', 'init', '-q'], cwd=self.root, check=True)
        subprocess.run(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], cwd=self.root, check=True)
        (self.root / '.gitignore').write_text('artifacts/\n')
        (self.root / 'source.ts').write_text('export const value = 1;\n')
        self.source = source_identity(self.root)
        self.started = now()
        self.file = self.root / 'artifacts/csv-qa/unit-results.json'
        self.file.parent.mkdir(parents=True)
        self.file.write_text('{"success": true}')
        self.run = {'schemaVersion': 1, 'runId': 'fixture-run', 'source': self.source, 'startedAt': self.started,
                    'scope': 'development-demo', 'origin': 'http://127.0.0.1:4173', 'completedAt': now(), 'files': {'artifacts/csv-qa/unit-results.json': digest(self.file)},
                    'checks': {name: {'exitCode': 0, 'runId': 'fixture-run', 'source': self.source,
                                     'startedAt': self.started, 'completedAt': now()} for name in CHECKS}}
        self.run['completedAt'] = now()

    def write(self):
        (self.root / MANIFEST).write_text(json.dumps(self.run))

    def test_accepts_same_source_fresh_completed_checks(self):
        self.write()
        self.assertEqual(validate(self.root)['runId'], 'fixture-run')

    def test_rejects_failed_check_despite_success_text(self):
        self.run['checks']['http-dev']['exitCode'] = 1
        self.write()
        with self.assertRaisesRegex(ValueError, 'http-dev failed'):
            validate(self.root)

    def test_rejects_stale_run_and_stale_artifact(self):
        original = copy.deepcopy(self.run)
        self.run['startedAt'] = self.run['completedAt'] = '2000-01-01T00:00:00+00:00'
        self.write()
        with self.assertRaisesRegex(ValueError, 'stale'):
            validate(self.root)
        self.run = original
        os.utime(self.file, (946684800, 946684800))
        self.write()
        with self.assertRaisesRegex(ValueError, 'not produced'):
            validate(self.root)

    def test_rejects_modified_dirty_source_without_commit(self):
        self.write()
        (self.root / 'source.ts').write_text('export const value = 2;\n')
        with self.assertRaisesRegex(ValueError, 'current source'):
            validate(self.root)

    def test_rejects_altered_artifact(self):
        self.write()
        self.file.write_text('{"success": false}')
        with self.assertRaisesRegex(ValueError, 'changed after'):
            validate(self.root)

    def test_rejects_mixed_runs_missing_checks_and_invalid_times(self):
        original = copy.deepcopy(self.run)
        for mutate in [lambda r: r['checks']['unit'].update(runId='other'),
                       lambda r: r['checks'].pop('build'),
                       lambda r: r['checks']['unit'].update(completedAt='2100-01-01T00:00:00+00:00')]:
            self.run = copy.deepcopy(original)
            mutate(self.run)
            self.write()
            with self.assertRaises(ValueError):
                validate(self.root)

    def renderer_fixture(self, failed=0, mutate=None, optimized=False):
        scripts = self.root / 'scripts'
        scripts.mkdir()
        for name in ['verification_evidence.py', 'write-verification.py']:
            shutil.copy2(pathlib.Path(__file__).parent / name, scripts / name)
        (self.root / 'docs').mkdir()
        (self.root / '.hallmark').mkdir()
        (self.root / 'docs/verification.html').write_text('historical report')
        self.run['source'] = source_identity(self.root)
        for check in self.run['checks'].values():
            check['source'] = self.run['source']
        files = {
            'csv-qa/unit-results.json': {'success': True, 'numFailedTests': 0, 'numFailedTestSuites': 0, 'numPassedTests': 2},
            'csv-qa/http-dev.txt': {'origin':'http://127.0.0.1:4173', 'passed': 2, 'failed': failed, 'checks': ['one', 'two']},
            'vault-qa/browser-results.json': {'origin': 'http://127.0.0.1:4173', 'checks': [{'check': 'vault', 'passed': True}]},
            'csv-qa/browser-results.json': {'origin': 'http://127.0.0.1:4173', 'checks': [{'check': 'csv', 'passed': True}]},
            'vault-qa/test-axe.json': [],
        }
        if mutate:
            mutate(files)
        for name, value in files.items():
            path = self.root / 'artifacts' / name
            path.parent.mkdir(exist_ok=True)
            path.write_text(json.dumps(value))
        for name in ['vault-qa/final-desktop.png', 'vault-qa/profile-picker-desktop.png', 'vault-qa/vault-375.png',
                     'vault-qa/login-375.png', 'vault-qa/profile-form-mobile.png', 'csv-qa/preview-desktop.png', 'csv-qa/preview-375.png']:
            (self.root / 'artifacts' / name).write_bytes(b'synthetic image bytes')
        self.run['files'] = {str(p.relative_to(self.root)): digest(p) for p in (self.root / 'artifacts').glob('*/*')}
        self.run['completedAt'] = now()
        self.write()
        return subprocess.run([sys.executable, *(['-O'] if optimized else []), str(scripts / 'write-verification.py')], capture_output=True, text=True)

    def test_renderer_rejects_failed_http_counts_and_preserves_report(self):
        result = self.renderer_fixture(failed=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('http-dev.txt must pass', result.stderr)
        self.assertEqual((self.root / 'docs/verification.html').read_text(), 'historical report')

    def test_optimized_python_still_rejects_failed_report(self):
        result = self.renderer_fixture(failed=5, optimized=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.root / 'docs/verification.html').read_text(), 'historical report')

    def test_renderer_rejects_negative_http_count(self):
        result = self.renderer_fixture(failed=-1)
        self.assertNotEqual(result.returncode, 0)

    def test_renderer_rejects_empty_browser_suite(self):
        result = self.renderer_fixture(mutate=lambda f: f['csv-qa/browser-results.json'].update(checks=[]))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Browser evidence must pass', result.stderr)

    def test_renderer_rejects_failed_unit_report(self):
        result = self.renderer_fixture(mutate=lambda f: f['csv-qa/unit-results.json'].update(numFailedTests=1))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Unit evidence must pass', result.stderr)

    def test_renderer_rejects_boolean_success_count(self):
        result = self.renderer_fixture(mutate=lambda f: f['csv-qa/unit-results.json'].update(numPassedTests=True))
        self.assertNotEqual(result.returncode, 0)

    def test_renderer_rejects_failed_browser_report(self):
        result = self.renderer_fixture(mutate=lambda f: f['csv-qa/browser-results.json']['checks'][0].update(passed=False))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Browser evidence must pass', result.stderr)

    def test_renderer_keeps_execution_and_generation_times_distinct(self):
        result = self.renderer_fixture()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads((self.root / '.hallmark/log.json').read_text())
        self.assertEqual(report['verifiedAt'], self.run['completedAt'])
        self.assertGreaterEqual(report['generatedAt'], report['verifiedAt'])
        self.assertEqual(report['runId'], 'fixture-run')
        page = (self.root / 'docs/verification.html').read_text()
        self.assertIn('2 browser checks passed', page)
        self.assertIn('http://127.0.0.1:4173', page)
        self.assertNotIn('1,000 rows', page)
        self.assertNotIn('Five views were checked', page)
        self.assertNotIn('127.0.0.1:4174', page)
        self.assertEqual(report['scope'], 'development-demo')

    def test_renderer_rejects_http_from_another_preview(self):
        result = self.renderer_fixture(mutate=lambda f: f['csv-qa/http-dev.txt'].update(origin='http://127.0.0.1:4999'))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('different preview', result.stderr)


if __name__ == '__main__':
    unittest.main()
