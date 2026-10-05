"""Transactional snapshots, run history and durable command deduplication."""
import json
import os
import sqlite3
from pathlib import Path


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True)


class Store:
    def __init__(self, path):
        self.path = Path(path).resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # One simulator per database, even if a second server/process is started.
        self.lock_file = open(str(self.path) + '.lock', 'a+b')
        self.lock_file.seek(0, 2)
        if self.lock_file.tell() == 0:
            self.lock_file.write(b'0')
            self.lock_file.flush()
        self.lock_file.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(self.lock_file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.lock_file.close()
            raise RuntimeError('Эта база уже открыта другим сервером. Используйте один процесс Uvicorn.') from None
        try:
            self.db = sqlite3.connect(self.path, check_same_thread=False)
            self.db.row_factory = sqlite3.Row
            self.db.execute('PRAGMA journal_mode=WAL')
            self.db.execute('PRAGMA synchronous=FULL')
            version = self.db.execute('PRAGMA user_version').fetchone()[0]
            if version not in (0, 1):
                raise RuntimeError(f'Неподдерживаемая версия базы: {version}')
            self.db.executescript('''
                CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS runs (
                    run_id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL, snapshot TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS incidents (
                    run_id TEXT NOT NULL, event_id TEXT NOT NULL, payload TEXT NOT NULL,
                    PRIMARY KEY(run_id, event_id));
                CREATE TABLE IF NOT EXISTS history (
                    run_id TEXT NOT NULL, elapsed_sec INTEGER NOT NULL,
                    good INTEGER NOT NULL, rejected INTEGER NOT NULL,
                    PRIMARY KEY(run_id, elapsed_sec));
                CREATE TABLE IF NOT EXISTS commands (
                    command_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, created_at TEXT NOT NULL,
                    request TEXT NOT NULL, response TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS history_imports (
                    import_id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
                    file_name TEXT NOT NULL, csv_text TEXT NOT NULL, report TEXT NOT NULL);
                PRAGMA user_version=1;
            ''')
        except Exception:
            if hasattr(self, 'db'):
                self.db.close()
            self.lock_file.close()
            raise

    def load(self):
        row = self.db.execute("SELECT snapshot FROM runs WHERE run_id=(SELECT value FROM meta WHERE key='current_run')").fetchone()
        return json.loads(row['snapshot']) if row else None

    def command(self, command_id):
        return self.db.execute('SELECT request,response FROM commands WHERE command_id=?', (command_id,)).fetchone()

    def save(self, snapshot, command=None):
        run_id, stamp, state = snapshot['runId'], snapshot['savedAt'], snapshot['state']
        with self.db:
            self.db.execute('''INSERT INTO runs VALUES(?,?,?,?) ON CONFLICT(run_id)
                DO UPDATE SET updated_at=excluded.updated_at,snapshot=excluded.snapshot''',
                (run_id, stamp, stamp, encode(snapshot)))
            self.db.execute("INSERT INTO meta VALUES('current_run',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (run_id,))
            self.db.executemany('''INSERT INTO incidents VALUES(?,?,?) ON CONFLICT(run_id,event_id)
                DO UPDATE SET payload=excluded.payload''', [(run_id, e['id'], encode(e)) for e in state['incidents']])
            self.db.executemany('''INSERT INTO history VALUES(?,?,?,?) ON CONFLICT(run_id,elapsed_sec)
                DO UPDATE SET good=excluded.good,rejected=excluded.rejected''',
                [(run_id, h['elapsedSec'], h['good'], h['rejected']) for h in state['history']])
            if command:
                self.db.execute('INSERT INTO commands VALUES(?,?,?,?,?)',
                                (command['commandId'], command['runId'], stamp, encode(command), encode(snapshot)))

    def run_list(self, limit=50):
        rows = self.db.execute('SELECT run_id,created_at,updated_at,snapshot FROM runs ORDER BY created_at DESC LIMIT ?', (limit,))
        return [dict(runId=r['run_id'], createdAt=r['created_at'], updatedAt=r['updated_at'],
                     good=json.loads(r['snapshot'])['state']['good']) for r in rows]

    def archived(self, run_id):
        row = self.db.execute('SELECT snapshot FROM runs WHERE run_id=?', (run_id,)).fetchone()
        return json.loads(row['snapshot']) if row else None

    def save_import(self, report, content):
        with self.db:
            self.db.execute('INSERT OR IGNORE INTO history_imports VALUES(?,?,?,?,?)',
                            (report['importId'], report['createdAt'], report['fileName'], content, encode(report)))
        return self.import_report(report['importId'])

    def import_report(self, import_id):
        row = self.db.execute('SELECT report FROM history_imports WHERE import_id=?', (import_id,)).fetchone()
        return json.loads(row['report']) if row else None

    def import_list(self):
        rows = self.db.execute('SELECT report FROM history_imports ORDER BY created_at DESC LIMIT 20')
        return [{k: report[k] for k in ('importId', 'createdAt', 'fileName', 'source', 'summary', 'schemaVersion', 'methodVersion', 'configuration') if k in report}
                for report in (json.loads(row['report']) for row in rows)]

    def close(self):
        self.db.close()
        # OS releases the byte/flock lock even after a crash.
        self.lock_file.close()
