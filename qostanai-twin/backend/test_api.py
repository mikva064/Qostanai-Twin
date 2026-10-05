import json
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4
from unittest.mock import patch

from fastapi.testclient import TestClient
from .api import create_app
from .service import TwinService


class Clock:
    now = 0.0
    def __call__(self):
        return self.now


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='qostanai-test-')
        self.db = Path(self.temp.name) / 'twin.sqlite3'
        self.clock = Clock()
        self.app = create_app(self.db, start_ticker=False, clock=self.clock)
        self.client = TestClient(self.app)
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.temp.cleanup()

    def snapshot(self):
        response = self.client.get('/api/v1/twin')
        self.assertEqual(response.status_code, 200)
        return response.json()

    def payload(self, kind, **kwargs):
        return dict(type=kind, runId=self.snapshot()['runId'], commandId=str(uuid4()), **kwargs)

    def send(self, kind, **kwargs):
        response = self.client.post('/api/v1/commands', json=self.payload(kind, **kwargs))
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def restart(self):
        self.client.__exit__(None, None, None)
        self.clock.now += 5000  # Server downtime must not produce a simulated catch-up.
        self.app = create_app(self.db, start_ticker=False, clock=self.clock)
        self.client = TestClient(self.app)
        self.client.__enter__()

    def test_python_initial_model_matches_original_frontend(self):
        example = json.loads((Path(__file__).parents[1] / 'docs' / 'model-v1-reference.json').read_text(encoding='utf-8'))
        got = self.snapshot()
        self.assertEqual(got['state'], example['state'])
        self.assertEqual(got['forecast'], example['forecast'])

    def test_restart_restores_state_incidents_and_controls(self):
        self.send('set_station_mode', stationId='P03', mode='stop')
        self.send('advance', seconds=900)
        before = self.send('set_playback', speed=60, paused=True)
        self.restart()
        after = self.snapshot()
        for field in ('state', 'controls', 'forecast', 'revision', 'runId'):
            self.assertEqual(after[field], before[field])
        self.assertEqual(after['state']['buffers'][1]['count'], 6)

    def test_duplicate_command_survives_restart(self):
        command = self.payload('advance', seconds=300)
        first = self.client.post('/api/v1/commands', json=command).json()
        self.restart()
        duplicate = self.client.post('/api/v1/commands', json=command)
        self.assertEqual(duplicate.status_code, 200)
        self.assertEqual(duplicate.json()['state'], first['state'])
        self.assertEqual(self.snapshot()['state']['elapsedSec'], 3000)

    def test_concurrent_retries_only_advance_once(self):
        command = self.payload('advance', seconds=300)
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.client.post('/api/v1/commands', json=command), range(4)))
        self.assertTrue(all(r.status_code == 200 for r in results))
        self.assertEqual(self.snapshot()['state']['elapsedSec'], 3000)

    def test_reused_key_with_changed_payload_is_rejected(self):
        command = self.payload('advance', seconds=300)
        self.client.post('/api/v1/commands', json=command)
        command['seconds'] = 600
        self.assertEqual(self.client.post('/api/v1/commands', json=command).status_code, 409)
        self.assertEqual(self.snapshot()['state']['elapsedSec'], 3000)

    def test_readers_do_not_advance_server_clock(self):
        self.send('set_playback', paused=False, speed=20)
        self.clock.now = 5
        for _ in range(20):
            self.assertEqual(self.snapshot()['state']['elapsedSec'], 2700)
        self.app.state.twin.tick()
        self.assertEqual(self.snapshot()['state']['elapsedSec'], 2800)
        for _ in range(20):
            self.assertEqual(self.snapshot()['state']['elapsedSec'], 2800)
        self.app.state.twin.tick()
        self.assertEqual(self.snapshot()['state']['elapsedSec'], 2800)

    def test_pause_and_speed_changes_use_server_clock(self):
        self.send('set_playback', paused=False, speed=20)
        self.clock.now = 1.25
        self.send('set_playback', paused=True)
        self.assertEqual(self.snapshot()['state']['elapsedSec'], 2725)
        self.clock.now = 12
        self.app.state.twin.tick()
        self.assertEqual(self.snapshot()['state']['elapsedSec'], 2725)
        self.send('set_playback', paused=False, speed=60)
        self.clock.now = 13
        self.app.state.twin.tick()
        self.assertEqual(self.snapshot()['state']['elapsedSec'], 2785)

    def test_reset_archives_previous_run_and_rejects_stale_tab(self):
        old = self.send('set_station_mode', stationId='P03', mode='stop')
        late = self.payload('advance', seconds=300)
        fresh = self.send('reset')
        self.assertNotEqual(old['runId'], fresh['runId'])
        self.assertGreater(fresh['revision'], old['revision'])
        self.assertEqual(self.client.post('/api/v1/commands', json=late).status_code, 409)
        archived = self.client.get('/api/v1/runs/' + old['runId']).json()
        self.assertEqual(archived['state'], old['state'])
        self.assertEqual(len(self.client.get('/api/v1/runs').json()['runs']), 2)

    def test_invalid_commands_cannot_change_state(self):
        before = self.snapshot()['state']
        invalid = [dict(type='advance', seconds=-1), dict(type='advance', seconds=1.5),
                   dict(type='advance', seconds=True), dict(type='advance', seconds=3601),
                   dict(type='set_station_mode', stationId='P99', mode='stop'),
                   dict(type='set_playback', speed=999), dict(type='set_playback', paused='false'),
                   dict(type='reset', extraField='not allowed')]
        for item in invalid:
            payload = dict(runId=self.snapshot()['runId'], commandId=str(uuid4()), **item)
            self.assertEqual(self.client.post('/api/v1/commands', json=payload).status_code, 422)
        self.assertEqual(self.snapshot()['state'], before)

    def test_acknowledgement_and_recovery_are_persistent(self):
        stopped = self.send('set_station_mode', stationId='P03', mode='stop')
        event_id = stopped['state']['incidents'][0]['id']
        acknowledged = self.send('acknowledge_incident', incidentId=event_id)
        self.assertTrue(acknowledged['state']['incidents'][0]['acknowledged'])
        self.assertIsNone(acknowledged['state']['incidents'][0]['resolvedAtSec'])
        self.send('advance', seconds=900)
        self.send('set_station_mode', stationId='P03', mode='normal')
        self.restart()
        self.assertFalse(any(e['resolvedAtSec'] is None for e in self.snapshot()['state']['incidents']))

    def test_failed_transaction_does_not_change_memory_or_deduplication(self):
        service = self.app.state.twin
        before = service.snapshot()
        command = self.payload('advance', seconds=300)
        with patch.object(service.store, 'save', side_effect=sqlite3.OperationalError('test disk failure')):
            with self.assertRaises(sqlite3.OperationalError):
                service.dispatch(command)
        self.assertEqual(service.snapshot()['state'], before['state'])
        self.assertIsNone(service.store.command(command['commandId']))
        self.assertEqual(service.dispatch(command)['state']['elapsedSec'], 3000)

    def test_second_writer_and_external_browser_origin_are_rejected(self):
        with self.assertRaises(RuntimeError):
            TwinService(self.db)
        response = self.client.post('/api/v1/commands', json=self.payload('reset'), headers={'Origin': 'https://external.example'})
        self.assertEqual(response.status_code, 403)


if __name__ == '__main__':
    unittest.main()
