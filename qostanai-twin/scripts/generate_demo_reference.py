"""Capture the presentation workflow through a temporary API, never the live database."""
import json
import tempfile
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient
from backend.api import create_app


def capture_demo(client):
    snapshot = client.get('/api/v1/twin').json()
    def command(kind, **fields):
        nonlocal snapshot
        payload = dict(type=kind, runId=snapshot['runId'], commandId=str(uuid4()), **fields)
        response = client.post('/api/v1/commands', json=payload)
        response.raise_for_status()
        snapshot = response.json()
        return snapshot
    initial = command('reset')
    stopped = command('set_station_mode', stationId='P03', mode='stop')
    impact = command('advance', seconds=900)
    response = client.post('/api/v1/analysis/compare', json=dict(runId=impact['runId'], stationId='P03', delayMinutes=30))
    response.raise_for_status()
    comparison = response.json()
    after_compare = client.get('/api/v1/twin').json()
    assert after_compare['state'] == impact['state'] and after_compare['revision'] == impact['revision']
    restored = command('set_station_mode', stationId='P03', mode='normal')
    recovered = command('advance', seconds=300)
    return dict(initial=initial, stopped=stopped, impact=impact, comparison=comparison, restored=restored, recovered=recovered)


if __name__ == '__main__':
    with tempfile.TemporaryDirectory(prefix='qostanai-demo-reference-') as temp:
        with TestClient(create_app(Path(temp) / 'demo.sqlite3', start_ticker=False)) as client:
            result = capture_demo(client)
    path = Path(__file__).resolve().parents[1] / 'docs/demo.reference.json'
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({key: dict(good=value['state']['good'], seconds=value['state']['elapsedSec'], forecast=value['forecast']['goodAtShiftEnd']) for key, value in result.items() if key != 'comparison'}))
