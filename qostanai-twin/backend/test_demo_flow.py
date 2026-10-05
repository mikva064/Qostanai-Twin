import tempfile
import unittest
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient
from .api import create_app
from .model import default_configuration
from scripts.generate_demo_reference import capture_demo


class DemoFlowTests(unittest.TestCase):
    def test_presentation_route_matches_control_figures_preserves_archive_and_survives_restart(self):
        with tempfile.TemporaryDirectory(prefix='qostanai-demo-test-') as temp:
            database = Path(temp) / 'demo.sqlite3'
            with TestClient(create_app(database, start_ticker=False)) as client:
                before = client.get('/api/v1/twin').json()
                capture = capture_demo(client)
                self.assertNotEqual(capture['initial']['runId'], before['runId'])
                for key, elapsed, good, prediction in [('initial', 2700, 37, 423), ('stopped', 2700, 37, 39),
                                                     ('impact', 3600, 39, 39), ('restored', 3600, 39, 421), ('recovered', 3900, 42, 421)]:
                    point = capture[key]
                    self.assertEqual(point['state']['elapsedSec'], elapsed, key)
                    self.assertEqual(point['state']['good'], good, key)
                    self.assertEqual(point['forecast']['goodAtShiftEnd'], prediction, key)
                    self.assertTrue(point['controls']['paused'], key)
                    self.assertEqual(point['runId'], capture['initial']['runId'])
                self.assertEqual([r['good'] for r in capture['comparison']['results']], [39, 421, 394])
                self.assertEqual(capture['comparison']['summary']['delayLoss'], 27)
                self.assertEqual(capture['comparison']['baseRevision'], capture['impact']['revision'])
                self.assertEqual(client.get('/api/v1/runs/' + before['runId']).json()['state'], before['state'])
                last = capture['recovered']
                stop_event = next(e for e in last['state']['incidents'] if e['severity'] == 'critical')
                self.assertEqual((stop_event['startedAtSec'], stop_event['resolvedAtSec']), (2700, 3600))
            with TestClient(create_app(database, start_ticker=False)) as client:
                after = client.get('/api/v1/twin').json()
                self.assertEqual(after['state'], last['state'])
                self.assertEqual(after['runId'], last['runId'])

    def test_preparing_default_configuration_archives_custom_parameters(self):
        with tempfile.TemporaryDirectory(prefix='qostanai-demo-config-') as temp:
            with TestClient(create_app(Path(temp) / 'demo.sqlite3', start_ticker=False)) as client:
                current = client.get('/api/v1/twin').json()
                def configure(config):
                    nonlocal current
                    response = client.post('/api/v1/commands', json=dict(type='configure_line', commandId=str(uuid4()), runId=current['runId'], configuration=config))
                    self.assertEqual(response.status_code, 200, response.text)
                    current = response.json()
                    return current
                custom = configure(default_configuration() | dict(shiftPlan=275, arrivalIntervalSec=80))
                prepared = configure(default_configuration())
                self.assertEqual((prepared['state']['good'], prepared['forecast']['goodAtShiftEnd']), (37, 423))
                self.assertEqual(client.get('/api/v1/runs/' + custom['runId']).json()['state'], custom['state'])
