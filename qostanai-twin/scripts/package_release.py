"""Build a clean demo ZIP with content hashes; no environments or user database."""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from zipfile import ZipFile, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
DIRECTORIES = ('backend', 'src', 'public', 'dist', 'docs', 'tests', 'scripts')
ROOT_FILES = ('package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.mjs', 'index.html', 'start.cmd', 'setup.cmd', 'check.cmd', 'requirements.txt', 'README.md', '.gitignore', '.env.example')
ALLOWED_SUFFIXES = {'.py', '.ts', '.tsx', '.js', '.mjs', '.css', '.svg', '.json', '.md', '.html', '.csv', '.txt'}
PITCH_NAME = 'Qostanai-Twin-Selection-09-Oct-2026-v3.pptx'


def release_files(project, pitch):
    project, pitch = Path(project).resolve(), Path(pitch).resolve()
    version = json.loads((project / 'package.json').read_text(encoding='utf-8'))['version']
    build_version = json.loads((project / 'dist/build-info.json').read_text(encoding='utf-8'))['version']
    if version != build_version:
        raise ValueError('Сначала пересоберите интерфейс: версия dist не совпадает с package.json')
    files = {}
    for directory in DIRECTORIES:
        for path in sorted((project / directory).rglob('*')):
            relative = path.relative_to(project)
            if any(part.startswith('.') or part in ('__pycache__', 'node_modules', 'data') for part in relative.parts):
                continue
            if path.is_symlink():
                raise ValueError(f'Символическая ссылка не допускается: {relative}')
            if path.is_file() and path.suffix in ALLOWED_SUFFIXES:
                path.resolve().relative_to(project)
                files['qostanai-twin/' + relative.as_posix()] = path.read_bytes()
    for name in ROOT_FILES:
        path = project / name
        if path.is_symlink():
            raise ValueError(f'Символическая ссылка не допускается: {name}')
        files['qostanai-twin/' + name] = path.read_bytes()
    files['pitch-oct09/' + PITCH_NAME] = pitch.read_bytes()
    files['START-HERE.txt'] = (project / 'docs/START_HERE.txt').read_bytes()
    return version, files


def verify_release(path):
    with ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or archive.testzip() is not None:
            raise ValueError('Повреждённый ZIP или повтор имён')
        manifest = json.loads(archive.read('MANIFEST.json'))
        expected = {entry['path']: entry for entry in manifest['files']}
        if set(names) != set(expected) | {'MANIFEST.json'}:
            raise ValueError('Состав ZIP не совпадает с манифестом')
        for name, entry in expected.items():
            parts = PurePosixPath(name).parts
            if PurePosixPath(name).is_absolute() or '..' in parts or '\\' in name or any(part in ('.venv', 'node_modules', 'data', '__pycache__') for part in parts):
                raise ValueError(f'Недопустимый путь в архиве: {name}')
            data = archive.read(name)
            if len(data) != entry['bytes'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
                raise ValueError(f'Контрольная сумма не совпала: {name}')
        for required in ('qostanai-twin/start.cmd', 'qostanai-twin/check.cmd', 'qostanai-twin/backend/api.py', 'qostanai-twin/dist/index.html', 'qostanai-twin/dist/build-info.json', 'qostanai-twin/public/examples/demo-shift.csv', 'START-HERE.txt', 'pitch-oct09/' + PITCH_NAME):
            if required not in expected:
                raise ValueError(f'Нет обязательного файла: {required}')
        package = json.loads(archive.read('qostanai-twin/package.json'))
        build = json.loads(archive.read('qostanai-twin/dist/build-info.json'))
        if manifest['version'] != package['version'] or build['version'] != package['version']:
            raise ValueError('Версии в архиве различаются')
        return dict(version=manifest['version'], files=len(names), bytes=Path(path).stat().st_size)


def build_release(project, pitch, destination):
    version, files = release_files(project, pitch)
    manifest = dict(version=version, builtAt=datetime.now(timezone.utc).isoformat(),
                    files=[dict(path=name, bytes=len(data), sha256=hashlib.sha256(data).hexdigest()) for name, data in sorted(files.items())])
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(destination, 'x', ZIP_DEFLATED) as archive:
        for name, data in sorted(files.items()):
            archive.writestr(name, data)
        archive.writestr('MANIFEST.json', json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    return verify_release(destination)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Собрать переносимый комплект Qostanai Twin')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--pitch', type=Path, default=ROOT.parent / 'pitch-oct09' / PITCH_NAME)
    parser.add_argument('--verify', type=Path)
    args = parser.parse_args()
    if args.verify:
        print(json.dumps(verify_release(args.verify), ensure_ascii=False))
    else:
        version = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
        target = args.output or ROOT.parent / f'qostanai-twin-v{version}-demo.zip'
        print(json.dumps(dict(path=str(target), **build_release(ROOT, args.pitch, target)), ensure_ascii=False))
