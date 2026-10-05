import json
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient

from .api import create_app
from .history_import import analyze_history
from .model import default_configuration, initial_state, advance_in_place
from .test_history import EXAMPLE, mutate

ROOT = Path(__file__).parents[1]
CUSTOM = dict(shiftPlan=275, arrivalIntervalSec=80, stationCyclesSec=[45, 60, 95, 40, 65], bufferCapacities=[2, 3, 4, 5])


class ConfiguredHistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='qostanai-history-config-')
        self.db = Path(self.temp.name) / 'twin.sqlite3'
        self.start()

    def start(self):
        self.app = create_app(self.db, start_ticker=False)
        self.client = TestClient(self.app)
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.temp.cleanup()

    def submit(self, config=CUSTOM, **kwargs):
        return self.client.post('/api/v1/history/import', json=dict(fileName='demo.csv', csvText=EXAMPLE, configuration=deepcopy(config)) | kwargs)

    def test_configuration_controls_replay_and_forecast_without_changing_observations_or_live_state(self):
        before = deepcopy(self.app.state.twin.current)
        response = self.submit()
        self.assertEqual(response.status_code, 200, response.text)
        report = response.json()
        self.assertEqual(report['configuration'], CUSTOM)
        self.assertEqual(report['schemaVersion'], 2)
        self.assertEqual(report['methodVersion'], 'flow-history-v2')
        self.assertEqual(report['plan'], 275)  # omitted outer plan inherits configuration
        self.assertEqual(report['summary']['planDelta'], 115)
        reference = initial_state(warmup_seconds=0, configuration=CUSTOM)
        for row in report['observations']:
            advance_in_place(reference, row['elapsedSec'] - reference['elapsedSec'], record_history=False)
            self.assertEqual(row['replayGood'], reference['good'])
            self.assertEqual(row['replayRejected'], reference['rejected'])
            for station, mode in zip(reference['stations'], row['modes']):
                station['mode'] = mode
        default = self.submit(default_configuration()).json()
        self.assertNotEqual(report['summary']['replayGood'], default['summary']['replayGood'])
        self.assertNotEqual([p['flowForecast'] for p in report['checkpoints']], [p['flowForecast'] for p in default['checkpoints']])
        self.assertEqual([p['rateForecast'] for p in report['checkpoints']], [p['rateForecast'] for p in default['checkpoints']])
        self.assertEqual(report['summary']['good'], 390)
        self.assertEqual(report['summary']['rejected'], 16)
        self.assertEqual(report['source'], 'synthetic_example')
        self.assertEqual(self.app.state.twin.current, before)
        self.assertIn('history_configuration', self.client.get('/api/v1/twin').json()['capabilities'])

    def test_each_parameter_is_part_of_identity_and_key_order_filename_crlf_are_not(self):
        first = self.submit().json()
        reordered = dict(reversed(list(CUSTOM.items())))
        self.assertEqual(self.submit(reordered, fileName='renamed.csv', csvText='\ufeff' + EXAMPLE.replace('\n', '\r\n')).json(), first)
        for key in CUSTOM:
            changed = deepcopy(CUSTOM)
            if isinstance(changed[key], list):
                changed[key][0] += 1
            else:
                changed[key] += 1
            result = self.submit(changed)
            self.assertEqual(result.status_code, 200, result.text)
            self.assertNotEqual(result.json()['importId'], first['importId'], key)
        implicit = self.client.post('/api/v1/history/import', json=dict(fileName='implicit.csv', csvText=EXAMPLE, shiftPlan=410)).json()
        self.assertEqual(self.submit(default_configuration()).json(), implicit)

    def test_restart_and_new_live_configuration_do_not_change_saved_report(self):
        report = self.submit().json()
        before = deepcopy(self.app.state.twin.current)
        response = self.client.post('/api/v1/commands', json=dict(type='configure_line', commandId=str(uuid4()), runId=before['runId'], configuration=CUSTOM))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.submit().json(), report)
        self.client.__exit__(None, None, None)
        self.start()
        self.assertEqual(self.client.get('/api/v1/history/imports/' + report['importId']).json(), report)
        listing = self.client.get('/api/v1/history/imports').json()['imports']
        self.assertEqual(listing[0]['configuration'], CUSTOM)

    def test_invalid_or_conflicting_configuration_is_atomic(self):
        before = deepcopy(self.app.state.twin.current)
        for change in [dict(shiftPlan=0), dict(arrivalIntervalSec=4), dict(arrivalIntervalSec='80'),
                       dict(stationCyclesSec=[50] * 4), dict(stationCyclesSec=[50, 50, True, 50, 50]),
                       dict(bufferCapacities=[1, 1, 1, 101]), dict(bufferCapacities=[1, 1, 1, 0]), dict(extra=1)]:
            response = self.submit(CUSTOM | change)
            self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.submit(shiftPlan=410).status_code, 422)
        self.assertEqual(self.client.get('/api/v1/history/imports').json()['imports'], [])
        self.assertEqual(self.app.state.twin.current, before)
        self.assertEqual(self.submit(shiftPlan=275).status_code, 200)

    def test_legacy_report_stays_readable_and_is_not_overwritten_by_v2(self):
        legacy = json.loads((ROOT / 'docs/history.example.json').read_text(encoding='utf-8'))
        self.app.state.twin.store.save_import(legacy, EXAMPLE)
        modern = self.submit(default_configuration()).json()
        self.assertNotEqual(modern['importId'], legacy['importId'])
        self.assertEqual(modern['checkpoints'], legacy['checkpoints'])
        self.assertEqual(modern['observations'], legacy['observations'])
        self.assertEqual(self.client.get('/api/v1/history/imports/' + legacy['importId']).json(), legacy)
        listing = self.client.get('/api/v1/history/imports').json()['imports']
        old_entry = next(e for e in listing if e['importId'] == legacy['importId'])
        self.assertEqual(old_entry['methodVersion'], 'flow-history-v1')
        self.assertNotIn('configuration', old_entry)

    def test_custom_configuration_still_cannot_see_future_rows(self):
        original = analyze_history(EXAMPLE, 'original.csv', 275, configuration=CUSTOM)
        def change_future(rows):
            for row in rows[1:]:
                if int(row[0]) > 14400:
                    row[1] = str(int(row[1]) + 50)
                    row[3:] = ['stop'] * 5
        changed = analyze_history(mutate(change_future), 'changed.csv', 275, configuration=CUSTOM)
        for a, b in zip(original['checkpoints'][:2], changed['checkpoints'][:2]):
            for key in ('flowForecast', 'rateForecast', 'observedGood', 'replayGood', 'rateWindowSec'):
                self.assertEqual(a[key], b[key], key)
            self.assertNotEqual(a['flowError'], b['flowError'])

    def test_report_owns_configuration_and_model_parameters_are_not_fitted(self):
        config = deepcopy(CUSTOM)
        report = analyze_history(EXAMPLE, 'demo.csv', 275, configuration=config)
        self.assertEqual(config, CUSTOM)
        config['stationCyclesSec'][0] = 999
        config['bufferCapacities'][0] = 99
        self.assertEqual(report['configuration'], CUSTOM)
        with self.assertRaises(ValueError):
            analyze_history(EXAMPLE, 'bad.csv', 410, configuration=CUSTOM)


if __name__ == '__main__':
    unittest.main()
