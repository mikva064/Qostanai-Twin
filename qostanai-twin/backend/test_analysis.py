import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient
from .api import create_app
from .analysis import compare_scenarios
from .model import initial_state, advance_in_place, forecast, set_station_mode


class AnalysisTests(unittest.TestCase):
    def setUp(self):
        self.base = dict(runId=str(uuid4()), revision=42, state=initial_state())

    def report(self, delay=30):
        return compare_scenarios(self.base, 'P03', delay)

    def test_stopped_station_comparison_is_pure_and_matches_direct_simulation(self):
        state = self.base['state']
        set_station_mode(state, 'P03', 'stop')
        advance_in_place(state, 900)
        before = deepcopy(self.base)
        report = self.report()
        baseline, now, later = report['results']
        self.assertEqual(self.base, before)
        self.assertEqual(baseline['good'], forecast(state)['goodAtShiftEnd'])
        restored = deepcopy(state)
        set_station_mode(restored, 'P03', 'normal')
        advance_in_place(restored, 28800)
        self.assertEqual(now['good'], restored['good'])
        delayed = deepcopy(state)
        advance_in_place(delayed, 1800)
        set_station_mode(delayed, 'P03', 'normal')
        advance_in_place(delayed, 28800)
        self.assertEqual(later['good'], delayed['good'])
        self.assertGreater(now['good'], later['good'])
        self.assertGreater(later['good'], baseline['good'])
        self.assertEqual(now['additionalDowntimeSec'], 0)
        self.assertEqual(later['additionalDowntimeSec'], 1800)
        self.assertEqual(report['summary']['delayLoss'], now['good'] - later['good'])

    def test_zero_delay_equals_immediate_recovery(self):
        set_station_mode(self.base['state'], 'P03', 'slow')
        report = self.report(0)
        self.assertEqual(report['results'][1]['series'], report['results'][2]['series'])
        self.assertEqual(report['summary']['delayLoss'], 0)

    def test_recovery_at_or_after_shift_end_equals_baseline(self):
        advance_in_place(self.base['state'], 25200)
        set_station_mode(self.base['state'], 'P03', 'stop')
        for delay in (15, 16, 240):
            with self.subTest(delay=delay):
                report = self.report(delay)
                baseline, _, later = report['results']
                self.assertEqual(later['series'], baseline['series'])
                self.assertFalse(later['recoveryWithinShift'])
                self.assertIsNone(later['recoveryAtSec'])

    def test_normal_station_has_no_fabricated_gain(self):
        report = self.report()
        self.assertEqual([r['good'] for r in report['results']], [423] * 3)
        self.assertEqual(report['summary']['maxGain'], 0)
        self.assertEqual(len(report['summary']['bestScenarioIds']), 3)

    def test_other_stopped_station_still_limits_final_output(self):
        for station_id in ('P03', 'P05'):
            set_station_mode(self.base['state'], station_id, 'stop')
        report = self.report()
        self.assertEqual(report['summary']['maxGain'], 0)
        self.assertTrue(all(r['good'] == self.base['state']['good'] for r in report['results']))

    def test_completed_shift_has_single_actual_point(self):
        advance_in_place(self.base['state'], 28800)
        report = self.report()
        self.assertTrue(all(len(r['series']) == 1 for r in report['results']))
        self.assertTrue(all(r['good'] == 423 and not r['recoveryWithinShift'] for r in report['results']))

    def test_curves_have_common_start_and_consistent_monotonic_endpoints(self):
        set_station_mode(self.base['state'], 'P03', 'slow')
        report = self.report(17)
        for r in report['results']:
            points = r['series']
            self.assertEqual(points[0], dict(elapsedSec=2700, good=37, rejected=1))
            self.assertEqual(points[-1], dict(elapsedSec=28800, good=r['good'], rejected=r['rejected']))
            self.assertTrue(all(a['elapsedSec'] < b['elapsedSec'] and a['good'] <= b['good']
                                and a['rejected'] <= b['rejected'] for a, b in zip(points, points[1:])))
            self.assertEqual(r['gainVsBaseline'], r['good'] - report['results'][0]['good'])
        self.assertIn(2700 + 17 * 60, [p['elapsedSec'] for p in report['results'][2]['series']])


class ComparisonApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='qostanai-analysis-')
        self.app = create_app(Path(self.temp.name) / 'twin.sqlite3', start_ticker=False, clock=lambda: 0)
        self.client = TestClient(self.app)
        self.client.__enter__()
        self.before = self.app.state.twin.snapshot()
        self.payload = dict(runId=self.before['runId'], stationId='P03', delayMinutes=30)

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.temp.cleanup()

    def test_comparison_does_not_write_database_or_advance_clock(self):
        service = self.app.state.twin
        db_before = service.store.load()
        response = self.client.post('/api/v1/analysis/compare', json=self.payload)
        self.assertEqual(response.status_code, 200, response.text)
        report = response.json()
        self.assertEqual(report['baseRevision'], self.before['revision'])
        self.assertEqual(report['runId'], self.before['runId'])
        self.assertEqual(service.store.load(), db_before)
        self.assertEqual(service.current, db_before)

    def test_invalid_and_stale_requests_are_rejected(self):
        for patch in [dict(delayMinutes=-1), dict(delayMinutes=241), dict(delayMinutes=1.5),
                      dict(delayMinutes=True), dict(delayMinutes='30'), dict(stationId='P99'), dict(extra=True)]:
            with self.subTest(patch=patch):
                response = self.client.post('/api/v1/analysis/compare', json=self.payload | patch)
                self.assertEqual(response.status_code, 422)
        response = self.client.post('/api/v1/analysis/compare', json=self.payload | dict(runId=str(uuid4())))
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.app.state.twin.current['revision'], self.before['revision'])

    def test_server_can_tick_while_copy_is_being_analyzed(self):
        from unittest.mock import patch
        from concurrent.futures import ThreadPoolExecutor
        service = self.app.state.twin
        original = deepcopy(service.current)

        def independent_analysis(base, station, delay):
            # A second thread must be able to acquire the live-state lock.
            def get_live():
                with service.lock:
                    return service.snapshot()
            with ThreadPoolExecutor(max_workers=1) as pool:
                pool.submit(get_live).result(timeout=2)
            self.assertIsNot(base['state'], service.current['state'])
            return compare_scenarios(base, station, delay)

        with patch('backend.service.compare_scenarios', side_effect=independent_analysis):
            service.compare(self.payload['runId'], 'P03', 30)
        self.assertEqual(service.current, original)


if __name__ == '__main__':
    unittest.main()
