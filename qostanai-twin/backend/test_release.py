import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from importlib.metadata import PackageNotFoundError
from pathlib import Path
from unittest.mock import patch, MagicMock
from zipfile import ZipFile

from scripts import runtime_check as runtime
from scripts import package_release as release


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'qostanai-twin'
        self.root.mkdir()
        for name in release.ROOT_FILES:
            (self.root / name).write_text('{}', encoding='utf-8')
        for name in ['backend/api.py', 'backend/service.py', 'backend/model.py', 'backend/storage.py',
                     'backend/analysis.py', 'backend/history_import.py', 'backend/agent.py', 'src/case-dataset.json', 'backend/__init__.py',
                     'public/examples/demo-shift.csv', 'docs/START_HERE.txt', 'dist/assets/app.js']:
            self.write(name, 'fixture')
        self.write('package.json', '{"version":"0.10.0"}')
        self.write('dist/build-info.json', '{"version":"0.10.0"}')
        self.write('dist/index.html', '<script src="/assets/app.js"></script>')
        self.write('requirements.txt', 'fastapi==1.2.3\n')
        self.pitch = Path(self.temp.name) / release.PITCH_NAME
        self.pitch.write_bytes(b'presentation fixture')
        self.zip = Path(self.temp.name) / 'release.zip'

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')

    def local(self, **kwargs):
        return runtime.check_local(self.root, version_info=(3, 12, 14), package_version=lambda name: '1.2.3', **kwargs)

    def test_local_accepts_complete_bundle_and_rejects_stale_build(self):
        self.assertTrue(all(c['status'] == 'ok' for c in self.local()))
        self.write('dist/build-info.json', '{"version":"0.9.0"}')
        errors = [c['name'] for c in self.local() if c['status'] == 'error']
        self.assertEqual(errors, ['Версия сборки'])

    def test_local_detects_old_python_missing_package_and_missing_source(self):
        def missing(_):
            raise PackageNotFoundError('fastapi')
        (self.root / 'backend/api.py').unlink()
        checks = runtime.check_local(self.root, version_info=(3, 10, 0), package_version=missing)
        self.assertEqual([c['name'] for c in checks if c['status'] == 'error'], ['Python', 'Зависимости', 'Файлы приложения'])
        self.assertIn('setup.cmd', checks[1]['detail'])

    def test_local_detects_incomplete_or_escaping_build_assets(self):
        for asset in ['/assets/missing.js', '/assets/../../start.cmd']:
            with self.subTest(asset=asset):
                self.write('dist/index.html', f'<script src="{asset}"></script>')
                self.assertEqual(next(c for c in self.local() if c['name'] == 'Сборка интерфейса')['status'], 'error')

    def test_local_rejects_dependency_mismatch_and_invalid_requirement(self):
        self.write('requirements.txt', 'fastapi==2.0\n-r other.txt\n')
        check = next(c for c in self.local() if c['name'] == 'Зависимости')
        self.assertEqual(check['status'], 'error')
        self.assertIn('установлен 1.2.3', check['detail'])
        self.assertIn('Неподдерживаемая', check['detail'])

    def test_manifest_hashes_and_exclusion_of_environment_database_and_hidden_files(self):
        for name in ['data/twin.sqlite3', '.venv/config.json', 'node_modules/library.js', 'src/.env', 'src/.cache/cache.json', 'backend/__pycache__/data.pyc']:
            self.write(name, 'do not ship')
        result = release.build_release(self.root, self.pitch, self.zip)
        self.assertEqual(result['version'], '0.10.0')
        self.assertEqual(result, release.verify_release(self.zip))
        with ZipFile(self.zip) as archive:
            names = archive.namelist()
            self.assertEqual(archive.read('pitch-oct09/' + release.PITCH_NAME), self.pitch.read_bytes())
            self.assertIn('qostanai-twin/.env.example', names)
            self.assertFalse(any(part in name for name in names if not name.endswith('/.env.example') for part in ('.env', '.venv', 'node_modules', '__pycache__', 'data/twin')))
        previous = self.zip.read_bytes()
        with self.assertRaises(FileExistsError):
            release.build_release(self.root, self.pitch, self.zip)
        self.assertEqual(previous, self.zip.read_bytes())

    def test_release_rejects_stale_build_before_creating_zip(self):
        self.write('dist/build-info.json', '{"version":"0.9.0"}')
        with self.assertRaisesRegex(ValueError, 'пересоберите'):
            release.build_release(self.root, self.pitch, self.zip)
        self.assertFalse(self.zip.exists())

    def test_manifest_detects_modified_bytes(self):
        release.build_release(self.root, self.pitch, self.zip)
        modified = Path(self.temp.name) / 'modified.zip'
        with ZipFile(self.zip) as original, ZipFile(modified, 'w') as destination:
            for name in original.namelist():
                destination.writestr(name, b'changed' if name == 'qostanai-twin/start.cmd' else original.read(name))
        with self.assertRaisesRegex(ValueError, 'Контрольная сумма'):
            release.verify_release(modified)


class RuntimeServerTests(unittest.TestCase):
    def test_port_refused_is_stopped_and_other_network_failures_are_not_free(self):
        for error, expected in [(ConnectionRefusedError(), 'stopped'), (TimeoutError(), 'unreachable')]:
            with self.subTest(kind=expected), patch.object(runtime.socket, 'create_connection', side_effect=error):
                self.assertEqual(runtime.inspect_server()['kind'], expected)

    def test_server_identity_version_and_capabilities_are_all_required(self):
        state = dict(schemaVersion=2, runId='test-run', revision=1, controls={'paused': True},
                     state={'elapsedSec': 2700}, capabilities=['configure_line', 'history_configuration'])
        for version, capabilities, title, expected in [
            ('0.8.0', state['capabilities'], 'Qostanai Twin API', 'ready'),
            ('0.4.0', [], 'Qostanai Twin API', 'outdated'),
            ('0.8.0', [], 'Qostanai Twin API', 'outdated'),
            ('0.8.0', state['capabilities'], 'Other service', 'occupied'),
        ]:
            with self.subTest(expected=expected), patch.object(runtime.socket, 'create_connection', return_value=MagicMock()), patch.object(runtime, 'request_text', return_value=(runtime.ROOT / 'dist/index.html').read_text(encoding='utf-8')), patch.object(runtime, 'request_json', side_effect=[
                {'info': {'title': title, 'version': version}}, {**state, 'capabilities': capabilities},
            ]) as read:
                self.assertEqual(runtime.inspect_server()['kind'], expected)
                self.assertTrue(all(call.args[1] in ('/openapi.json', '/api/v1/twin') for call in read.call_args_list))

    def test_same_api_with_different_served_interface_requires_restart(self):
        with patch.object(runtime.socket, 'create_connection', return_value=MagicMock()), patch.object(runtime, 'request_text', return_value='<html>older interface</html>'), patch.object(runtime, 'request_json', side_effect=[
            {'info': {'title': 'Qostanai Twin API', 'version': '0.8.0'}},
            dict(schemaVersion=2, runId='test-run', revision=1, controls={'paused': True}, state={'elapsedSec': 2700}, capabilities=['configure_line', 'history_configuration']),
        ]):
            result = runtime.inspect_server()
            self.assertEqual(result['kind'], 'outdated')
            self.assertIn('другую сборку', result['detail'])

    def test_start_never_launches_over_an_existing_process(self):
        for kind, expected in [('ready', 0), ('outdated', 2), ('occupied', 2), ('unreachable', 2)]:
            with self.subTest(kind=kind), patch.object(runtime, 'check_local', return_value=[]), patch.object(runtime, 'inspect_server', return_value={'kind': kind, 'detail': 'test'}), patch.object(runtime.subprocess, 'call') as launch, redirect_stdout(io.StringIO()):
                self.assertEqual(runtime.main(['start']), expected)
                launch.assert_not_called()

    def test_start_launches_only_valid_bundle_on_free_port_and_returns_process_code(self):
        with patch.object(runtime, 'check_local', return_value=[{'status': 'ok', 'name': 'test', 'detail': 'ok'}]), patch.object(runtime, 'inspect_server', return_value={'kind': 'stopped', 'detail': 'test'}), patch.object(runtime.subprocess, 'call', return_value=7) as launch, redirect_stdout(io.StringIO()):
            self.assertEqual(runtime.main(['start']), 7)
            args = launch.call_args.args[0]
            self.assertEqual(args[:4], [runtime.sys.executable, '-m', 'uvicorn', 'backend.api:app'])
            self.assertEqual(args[args.index('--host') + 1], '127.0.0.1')
            self.assertEqual(args[args.index('--workers') + 1], '1')
        with patch.object(runtime, 'check_local', return_value=[{'status': 'error', 'name': 'test', 'detail': 'missing files'}]), patch.object(runtime, 'inspect_server', return_value={'kind': 'stopped', 'detail': 'test'}), patch.object(runtime.subprocess, 'call') as launch, redirect_stdout(io.StringIO()):
            self.assertEqual(runtime.main(['start']), 1)
            launch.assert_not_called()

    def test_check_json_exit_codes_distinguish_ok_warning_and_error(self):
        for kind, expected in [('ready', 0), ('stopped', 2), ('outdated', 2), ('occupied', 1)]:
            with self.subTest(kind=kind), patch.object(runtime, 'check_local', return_value=[]), patch.object(runtime, 'inspect_server', return_value={'kind': kind, 'detail': 'test'}), redirect_stdout(io.StringIO()) as out:
                self.assertEqual(runtime.main(['check', '--json']), expected)
                self.assertEqual(json.loads(out.getvalue())['exitCode'], expected)


if __name__ == '__main__':
    unittest.main()
