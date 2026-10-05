import csv
import io
import json
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from fastapi.testclient import TestClient

from .api import create_app
from .history_import import parse_csv, analyze_history, CsvValidationError, HEADERS

EXAMPLE = (Path(__file__).parents[1] / 'public/examples/demo-shift.csv').read_text(encoding='utf-8')


def mutate(change, delimiter=',', bom=False):
    rows = list(csv.reader(io.StringIO(EXAMPLE)))
    change(rows)
    stream = io.StringIO()
    writer = csv.writer(stream, delimiter=delimiter, lineterminator='\n')
    writer.writerows(rows)
    return ('\ufeff' if bom else '') + stream.getvalue()


class HistoryTests(unittest.TestCase):
    def test_accepts_semicolon_bom_and_reordered_headers(self):
        reordered = mutate(lambda rows: [row.reverse() for row in rows], delimiter=';', bom=True)
        self.assertEqual(parse_csv(EXAMPLE), parse_csv(reordered))
        self.assertEqual(len(parse_csv(EXAMPLE)), 33)

    def test_rejects_invalid_cells_order_duplicates_and_incomplete_shifts(self):
        cases = [lambda r: r[0].__setitem__(0, 'wrong'), lambda r: r[0].__setitem__(1, 'elapsed_sec'),
                 lambda r: r[3].__setitem__(0,r[2][0]), lambda r: r[3].__setitem__(0,'1'),
                 lambda r: r[3].__setitem__(1,'-1'), lambda r: r[3].__setitem__(1,'1.5'),
                 lambda r: r[3].__setitem__(1,'=1+1'), lambda r: r[4].__setitem__(1,'0'),
                 lambda r: r[4].__setitem__(2,'-1'), lambda r: r[3].__setitem__(4,'offline'),
                 lambda r: r[3].pop(), lambda r: r.pop(), lambda r: r[1].__setitem__(1,'1'),
                 lambda r: r[1].__setitem__(0,'100'), lambda r: r.insert(3,[])]
        for case in cases:
            with self.subTest(case=case):
                with self.assertRaises(CsvValidationError) as caught:
                    parse_csv(mutate(case))
                self.assertTrue(caught.exception.issues)
                self.assertTrue(all('row' in e and 'column' in e for e in caught.exception.issues))

    def test_size_and_row_limits(self):
        for content in ('a' * (512*1024+1), ','.join(HEADERS)+'\n'+('0,0,0,normal,normal,normal,normal,normal\n'*6001)):
            with self.assertRaises(CsvValidationError):
                parse_csv(content)

    def test_metrics_match_independent_arithmetic_and_example_is_labelled(self):
        report = analyze_history(EXAMPLE, 'demo.csv', 410, EXAMPLE)
        self.assertEqual(report['source'], 'synthetic_example')
        self.assertEqual(report['summary']['good'], 390)
        self.assertEqual(report['summary']['planDelta'], -20)
        self.assertEqual(report['summary']['checkpointCount'], 3)
        points = report['checkpoints']
        self.assertEqual(report['summary']['flowMae'], round(sum(abs(p['flowForecast']-390) for p in points)/3,2))
        self.assertEqual(report['summary']['rateMae'], round(sum(abs(p['rateForecast']-390) for p in points)/3,2))
        self.assertEqual([p['elapsedSec'] for p in points], [7200,14400,21600])
        self.assertNotEqual(report['summary']['replayGood'], report['summary']['good'])

    def test_future_rows_never_change_an_earlier_forecast(self):
        original = analyze_history(EXAMPLE, 'first.csv', 410)
        def change_future(rows):
            for row in rows[1:]:
                if int(row[0]) > 14400:
                    row[1] = str(int(row[1]) + 50)
                    row[3:] = ['stop']*5
        changed = analyze_history(mutate(change_future), 'changed.csv', 410)
        for a,b in zip(original['checkpoints'][:2],changed['checkpoints'][:2]):
            for field in ('elapsedSec','flowForecast','rateForecast','observedGood','replayGood','rateWindowSec'):
                self.assertEqual(a[field], b[field], field)
            self.assertNotEqual(a['flowError'],b['flowError'])

    def test_mode_applies_from_its_timestamp_and_not_before(self):
        base = analyze_history(EXAMPLE, 'base.csv',410)
        other = analyze_history(mutate(lambda rows: rows[9].__setitem__(5,'normal')), 'other.csv',410)
        self.assertEqual(base['observations'][8]['elapsedSec'],7200)
        self.assertEqual(base['observations'][8]['replayGood'],other['observations'][8]['replayGood'])
        self.assertNotEqual(base['checkpoints'][0]['flowForecast'],other['checkpoints'][0]['flowForecast'])

    def test_sparse_data_does_not_duplicate_checkpoints_and_warns(self):
        sparse = mutate(lambda rows: rows.__setitem__(slice(None),[rows[0],rows[1],rows[2],rows[-1]]))
        report = analyze_history(sparse,'sparse.csv',410)
        self.assertEqual(report['summary']['checkpointCount'],1)
        self.assertEqual(report['quality']['maxGapSec'],27900)
        self.assertTrue(report['quality']['warnings'])

    def test_zero_output_and_no_eligible_checkpoints_are_explicit(self):
        text = ','.join(HEADERS)+'\n'+'\n'.join(f'{t},0,0,stop,stop,stop,stop,stop' for t in (0,27000,28800))
        report = analyze_history(text,'zero.csv',410)
        self.assertIsNone(report['summary']['rejectPct'])
        self.assertIsNone(report['summary']['flowMae'])
        self.assertEqual(report['checkpoints'],[])
        self.assertTrue(report['quality']['warnings'])


class HistoryApiTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='qostanai-history-')
        self.db=Path(self.temp.name)/'twin.sqlite3'
        self.app=create_app(self.db,start_ticker=False)
        self.client=TestClient(self.app)
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None,None,None)
        self.temp.cleanup()

    def submit(self, content=EXAMPLE, **kwargs):
        return self.client.post('/api/v1/history/import',json=dict(fileName='demo-shift.csv',csvText=content,shiftPlan=410)|kwargs)

    def test_valid_import_persists_without_changing_live_state_and_deduplicates(self):
        before=deepcopy(self.app.state.twin.current)
        first=self.submit()
        self.assertEqual(first.status_code,200,first.text)
        again=self.submit(fileName='renamed.csv')
        self.assertEqual(first.json(),again.json())
        self.assertEqual(len(self.client.get('/api/v1/history/imports').json()['imports']),1)
        self.assertEqual(self.app.state.twin.current,before)
        self.client.__exit__(None,None,None)
        self.app=create_app(self.db,start_ticker=False)
        self.client=TestClient(self.app)
        self.client.__enter__()
        self.assertEqual(self.client.get('/api/v1/history/imports/'+first.json()['importId']).json(),first.json())
        self.assertEqual(self.app.state.twin.current,before)

    def test_bad_import_is_atomic_and_returns_line_errors(self):
        response=self.submit(mutate(lambda rows: rows[4].__setitem__(5,'bad')))
        self.assertEqual(response.status_code,422)
        self.assertEqual(response.json()['issues'][0]['row'],5)
        self.assertEqual(response.json()['issues'][0]['column'],'P03_mode')
        self.assertEqual(self.client.get('/api/v1/history/imports').json()['imports'],[])

    def test_plan_validation_file_size_unknown_report_and_origin(self):
        for value in (0,-1,100001,True,'410',410.5):
            self.assertEqual(self.submit(shiftPlan=value).status_code,422)
        self.assertEqual(self.submit('a'*524289).status_code,422)
        self.assertEqual(self.client.get('/api/v1/history/imports/'+'a'*64).status_code,404)
        self.assertEqual(self.client.get('/api/v1/history/imports/not-a-hash').status_code,422)
        response=self.client.post('/api/v1/history/import',json=dict(fileName='x.csv',csvText=EXAMPLE,shiftPlan=410),headers={'Origin':'https://outside.example'})
        self.assertEqual(response.status_code,403)
        self.assertEqual(self.client.get('/api/v1/history/example.csv').text,EXAMPLE)

    def test_new_plan_creates_distinct_report_without_changing_forecasts(self):
        first=self.submit().json()
        second=self.submit(shiftPlan=500).json()
        self.assertNotEqual(first['importId'],second['importId'])
        self.assertEqual(first['checkpoints'],second['checkpoints'])
        self.assertEqual(second['summary']['planDelta'],-110)


if __name__ == '__main__':
    unittest.main()
