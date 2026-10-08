"""Read-only checks and a foreground launcher; never terminates another process."""
import argparse
import json
import re
import socket
import subprocess
import sys
from importlib import metadata
from pathlib import Path
from urllib.request import ProxyHandler, build_opener

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_API_VERSION = '0.8.0'
REQUIRED_CAPABILITIES = {'configure_line', 'history_configuration'}


def check_item(name, status, detail):
    return dict(name=name, status=status, detail=detail)


def check_local(root=ROOT, version_info=None, package_version=None):
    root = Path(root).resolve()
    version_info = version_info or sys.version_info
    package_version = package_version or metadata.version
    checks = [check_item('Python', 'ok' if version_info[:2] >= (3, 11) else 'error',
                         '.'.join(map(str, version_info[:3])) + ' · требуется 3.11 или новее')]
    requirements = root / 'requirements.txt'
    problems, count = [], 0
    if requirements.is_file():
        for line in requirements.read_text(encoding='utf-8').splitlines():
            if not line.strip() or line.startswith('#'):
                continue
            match = re.fullmatch(r'([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+-]+)', line.strip())
            if not match:
                problems.append('Неподдерживаемая строка requirements.txt')
                continue
            name, expected = match.groups()
            count += 1
            try:
                actual = package_version(name)
                if actual != expected:
                    problems.append(f'{name}: установлен {actual}, нужен {expected}')
            except metadata.PackageNotFoundError:
                problems.append(f'{name}: не установлен')
    else:
        problems.append('Нет requirements.txt')
    if not count and not problems:
        problems.append('Список зависимостей пуст')
    checks.append(check_item('Зависимости', 'error' if problems else 'ok', '; '.join(problems) + '. Выполните setup.cmd.' if problems else f'Совпадают закреплённые версии: {count}'))
    required = ['backend/api.py', 'backend/service.py', 'backend/model.py', 'backend/storage.py', 'backend/analysis.py',
                'backend/history_import.py', 'backend/agent.py', 'src/case-dataset.json', 'backend/__init__.py', 'public/examples/demo-shift.csv', 'package.json']
    missing = [name for name in required if not (root / name).is_file()]
    checks.append(check_item('Файлы приложения', 'error' if missing else 'ok', 'Отсутствуют: ' + ', '.join(missing) if missing else 'Сервер и учебный CSV на месте'))
    index = root / 'dist/index.html'
    if not index.is_file():
        checks.append(check_item('Сборка интерфейса', 'error', 'Нет dist/index.html. Распакуйте полный архив или выполните npm ci и npm run build.'))
    else:
        html = index.read_text(encoding='utf-8')
        assets = re.findall(r'(?:src|href)=[\"\'](/assets/[^\"\'?#]+)', html)
        invalid = []
        for asset in assets:
            path = (root / 'dist' / asset.lstrip('/')).resolve()
            try:
                path.relative_to(root / 'dist')
                inside = True
            except ValueError:
                inside = False
            if not inside or not path.is_file():
                invalid.append(asset)
        has_javascript = any(path.endswith('.js') for path in assets)
        checks.append(check_item('Сборка интерфейса', 'error' if invalid or not has_javascript else 'ok',
                                 'Повреждённая сборка: ' + ', '.join(invalid or ['нет JavaScript']) if invalid or not has_javascript else f'HTML и файлы сборки доступны: {len(assets)}'))
    try:
        package = json.loads((root / 'package.json').read_text(encoding='utf-8'))
        build = json.loads((root / 'dist/build-info.json').read_text(encoding='utf-8'))
        fresh = isinstance(package.get('version'), str) and build.get('version') == package['version']
        checks.append(check_item('Версия сборки', 'ok' if fresh else 'error', f"Интерфейс {build.get('version')}, исходники {package.get('version')}." + ('' if fresh else ' Выполните npm run build или распакуйте свежий комплект.')))
    except (OSError, ValueError, AttributeError):
        checks.append(check_item('Версия сборки', 'error', 'Нет корректного dist/build-info.json или package.json. Выполните npm run build или распакуйте свежий комплект.'))
    return checks


def request_text(base, path, opener):
    with opener.open(base + path, timeout=2) as response:
        raw = response.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError('Ответ слишком большой')
        return raw.decode('utf-8')


def request_json(base, path, opener):
    return json.loads(request_text(base, path, opener))


def inspect_server(port=4173):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=3):
            pass
    except ConnectionRefusedError:
        return dict(kind='stopped', detail='Сервер не запущен. Выполните start.cmd.')
    except OSError:
        return dict(kind='unreachable', detail='Не удалось проверить локальный порт. Проверьте доступ к 127.0.0.1.')
    opener = build_opener(ProxyHandler({}))
    base = f'http://127.0.0.1:{port}'
    try:
        api = request_json(base, '/openapi.json', opener)
        if not isinstance(api, dict) or api.get('info', {}).get('title') != 'Zauyt AI API':
            raise ValueError('Другой сервис')
        version = api['info'].get('version')
        state = request_json(base, '/api/v1/twin', opener)
        capabilities = state.get('capabilities', [])
        if not isinstance(capabilities, list) or not all(isinstance(value, str) for value in capabilities):
            raise ValueError('Неверные capabilities')
        if state.get('schemaVersion') != 2 or not isinstance(state.get('state'), dict) or not isinstance(state.get('controls', {}).get('paused'), bool):
            raise ValueError('Неверный снимок')
        if not isinstance(state.get('runId'), str) or type(state.get('revision')) is not int or type(state['state'].get('elapsedSec')) is not int:
            raise ValueError('Неверное состояние')
        ready = version == EXPECTED_API_VERSION and REQUIRED_CAPABILITIES.issubset(capabilities)
        interface_matches = not ready or request_text(base, '/', opener) == (ROOT / 'dist/index.html').read_text(encoding='utf-8')
        ready = ready and interface_matches
        return dict(kind='ready' if ready else 'outdated', version=version,
                    detail=f'Zauyt AI API {version}. ' + ('API и интерфейс соответствуют этому комплекту.' if ready else ('' if interface_matches else 'Сервер отдаёт другую сборку интерфейса. ') + 'Остановите прежний сервер в его окне (Ctrl+C), затем снова запустите start.cmd. Автоматической остановки нет.'))
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return dict(kind='occupied', detail=f'Порт {port} занят, но готовый Zauyt AI не подтверждён. Проверьте открытые окна сервера; другой процесс автоматически не останавливается.')


def print_checks(checks):
    labels = {'ok': 'OK', 'warn': 'ВНИМАНИЕ', 'error': 'ОШИБКА'}
    for item in checks:
        print(f"[{labels[item['status']]}] {item['name']}: {item['detail']}")


def main(argv=None):
    parser = argparse.ArgumentParser(description='Проверка и запуск Zauyt AI')
    parser.add_argument('mode', choices=['check', 'start'], nargs='?', default='check')
    parser.add_argument('--json', action='store_true', help='Вывести машинный отчёт, только для check')
    args = parser.parse_args(argv)
    if args.json and args.mode != 'check':
        parser.error('--json доступен только для check')
    try:
        checks = check_local()
    except (OSError, UnicodeError) as error:
        checks = [check_item('Локальные файлы', 'error', f'Не удалось прочитать комплект: {error}')]
    server = inspect_server()
    status = 'ok' if server['kind'] == 'ready' else 'warn' if server['kind'] in ('stopped', 'outdated') else 'error'
    server_check = check_item('Сервер на 4173', status, server['detail'])
    if args.mode == 'check':
        all_checks = checks + [server_check]
        code = 1 if any(item['status'] == 'error' for item in all_checks) else 2 if any(item['status'] == 'warn' for item in all_checks) else 0
        if args.json:
            print(json.dumps(dict(checks=all_checks, server=server, exitCode=code), ensure_ascii=False, indent=2))
        else:
            print_checks(all_checks)
            print('\nЭто техническая проверка. Пройдите раздел «Показ» и проверьте проектор вручную.')
        return code
    print_checks(checks)
    if any(item['status'] == 'error' for item in checks):
        return 1
    if server['kind'] != 'stopped':
        print_checks([server_check])
        if server['kind'] == 'ready':
            print('Используйте http://127.0.0.1:4173/#demo и обновите страницу. Вторая копия не запущена.')
            return 0
        return 2
    print('Zauyt AI: http://127.0.0.1:4173/#demo\nОставьте окно открытым. Остановка — Ctrl+C.', flush=True)
    try:
        return subprocess.call([sys.executable, '-m', 'uvicorn', 'backend.api:app', '--host', '127.0.0.1', '--port', '4173', '--workers', '1', '--no-access-log'], cwd=ROOT)
    except KeyboardInterrupt:
        return 0


if __name__ == '__main__':
    raise SystemExit(main())
