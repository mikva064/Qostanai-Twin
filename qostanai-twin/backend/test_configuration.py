import json
import sqlite3
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4
from fastapi.testclient import TestClient

from .api import create_app
from .model import default_configuration, configuration_from_state, initial_state, advance_in_place, forecast

CUSTOM = dict(shiftPlan=275, arrivalIntervalSec=80, stationCyclesSec=[45, 60, 95, 40, 65], bufferCapacities=[2, 3, 4, 5])


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='qostanai-config-')
        self.path = Path(self.temp.name) / 'twin.sqlite3'
        self.app = create_app(self.path, start_ticker=False)
        self.client = TestClient(self.app)
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.temp.cleanup()

    def snapshot(self):
        return self.client.get('/api/v1/twin').json()

    def payload(self, configuration=None):
        return dict(type='configure_line', commandId=str(uuid4()), runId=self.snapshot()['runId'],
                    configuration=deepcopy(CUSTOM if configuration is None else configuration))

    def restart(self):
        self.client.__exit__(None, None, None)
        self.app = create_app(self.path, start_ticker=False)
        self.client = TestClient(self.app)
        self.client.__enter__()

    def test_custom_configuration_creates_run_and_keeps_old_snapshot(self):
        before = self.snapshot()
        response = self.client.post('/api/v1/commands', json=self.payload())
        self.assertEqual(response.status_code, 200, response.text)
        after = response.json()
        self.assertNotEqual(after['runId'], before['runId'])
        self.assertEqual(after['controls'], dict(paused=True, speed=20))
        self.assertEqual(after['state']['elapsedSec'], 2700)
        self.assertEqual(configuration_from_state(after['state']), CUSTOM)
        self.assertIn('configure_line', after['capabilities'])
        self.assertEqual(after['forecast'], forecast(after['state']))
        old = self.client.get('/api/v1/runs/' + before['runId']).json()
        for key in ('state', 'forecast', 'runId', 'revision', 'savedAt'):
            self.assertEqual(old[key], before[key])
        self.assertEqual(len(self.client.get('/api/v1/runs').json()['runs']), 2)

    def test_retry_after_restart_returns_original_run_without_creating_third(self):
        payload = self.payload()
        first = self.client.post('/api/v1/commands', json=payload).json()
        self.restart()
        retry = self.client.post('/api/v1/commands', json=payload)
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(retry.json()['runId'], first['runId'])
        self.assertEqual(configuration_from_state(self.snapshot()['state']), CUSTOM)
        self.assertIn('configure_line', retry.json()['capabilities'])
        self.assertEqual(len(self.client.get('/api/v1/runs').json()['runs']), 2)

    def test_reset_repeats_custom_configuration_and_defaults_restore_demo(self):
        custom = self.client.post('/api/v1/commands', json=self.payload()).json()
        reset = self.client.post('/api/v1/commands', json=dict(type='reset', commandId=str(uuid4()), runId=custom['runId'])).json()
        self.assertNotEqual(reset['runId'], custom['runId'])
        self.assertEqual(reset['state'], custom['state'])
        default = self.client.post('/api/v1/commands', json=self.payload(default_configuration())).json()
        reference = json.loads((Path(__file__).parents[1] / 'docs/model-v1-reference.json').read_text(encoding='utf-8'))
        self.assertEqual(default['state'], reference['state'])
        self.assertEqual(default['forecast'], reference['forecast'])

    def test_invalid_configuration_cannot_write_or_create_runs(self):
        before = self.snapshot()
        variants = []
        for key, invalids in [('shiftPlan', [0, 100001, True, '410', 1.5]),
                              ('arrivalIntervalSec', [4, 3601, None]),
                              ('stationCyclesSec', [[48]*4, [48]*6, [48, 52, 0, 50, 55], [48, 52, True, 50, 55], [48, 52, 3601, 50, 55]]),
                              ('bufferCapacities', [[6]*3, [6]*5, [6, 0, 6, 6], [6, 101, 6, 6], [6, 1.5, 6, 6]])]:
            for value in invalids:
                config = deepcopy(CUSTOM); config[key] = value; variants.append(config)
        variants.append({**CUSTOM, 'extra': 'bad'})
        del_missing = deepcopy(CUSTOM); del del_missing['arrivalIntervalSec']; variants.append(del_missing)
        for config in variants:
            response = self.client.post('/api/v1/commands', json=self.payload(config))
            self.assertEqual(response.status_code, 422, (config, response.text))
        self.assertEqual(self.snapshot()['state'], before['state'])
        self.assertEqual(self.snapshot()['revision'], before['revision'])
        self.assertEqual(len(self.client.get('/api/v1/runs').json()['runs']), 1)

    def test_old_tab_and_reused_key_cannot_replace_another_configuration(self):
        late = self.payload()
        good = self.payload()
        next_run = self.client.post('/api/v1/commands', json=good).json()
        self.assertEqual(self.client.post('/api/v1/commands', json=late).status_code, 409)
        changed = deepcopy(good); changed['configuration']['shiftPlan'] += 1
        self.assertEqual(self.client.post('/api/v1/commands', json=changed).status_code, 409)
        self.assertEqual(self.snapshot()['runId'], next_run['runId'])

    def test_failed_save_does_not_replace_run_and_command_can_be_retried(self):
        service, command, before = self.app.state.twin, self.payload(), self.snapshot()
        with patch.object(service.store, 'save', side_effect=sqlite3.OperationalError('test disk failure')):
            with self.assertRaises(sqlite3.OperationalError):
                service.dispatch(command)
        self.assertEqual(service.snapshot()['runId'], before['runId'])
        self.assertEqual(configuration_from_state(service.snapshot()['state']), default_configuration())
        self.assertIsNone(service.store.command(command['commandId']))
        self.assertEqual(configuration_from_state(service.dispatch(command)['state']), CUSTOM)

    def test_model_uses_boundaries_preserves_inventory_and_comparison_parameters(self):
        for config in [CUSTOM, dict(shiftPlan=1, arrivalIntervalSec=5, stationCyclesSec=[5]*5, bufferCapacities=[1]*4),
                       dict(shiftPlan=100000, arrivalIntervalSec=3600, stationCyclesSec=[3600]*5, bufferCapacities=[100]*4)]:
            s = initial_state(configuration=config)
            advance_in_place(s, 28800)
            wip = sum(b['count'] for b in s['buffers']) + sum(p['remainingWorkSec'] is not None for p in s['stations'])
            self.assertEqual(s['released'], s['good'] + s['rejected'] + wip)
            self.assertTrue(all(0 <= b['count'] <= b['capacity'] for b in s['buffers']))
            self.assertEqual(s['elapsedSec'], 28800)
        custom = self.client.post('/api/v1/commands', json=self.payload()).json()
        response = self.client.post('/api/v1/analysis/compare', json=dict(runId=custom['runId'], stationId='P03', delayMinutes=30)).json()
        self.assertEqual(response['plan'], 275)
        self.assertEqual(response['nominalCycleSec'], 95)
        self.assertEqual(response['results'][0]['good'], custom['forecast']['goodAtShiftEnd'])
        self.assertEqual(configuration_from_state(self.snapshot()['state']), CUSTOM)

    def test_configuration_does_not_change_csv_import_method_or_existing_report(self):
        content = (Path(__file__).parents[1] / 'public/examples/demo-shift.csv').read_text(encoding='utf-8')
        body = dict(fileName='demo-shift.csv', csvText=content, shiftPlan=410)
        before = self.client.post('/api/v1/history/import', json=body).json()
        self.client.post('/api/v1/commands', json=self.payload())
        after = self.client.post('/api/v1/history/import', json=body).json()
        self.assertEqual(before, after)


if __name__ == '__main__':
    unittest.main()
