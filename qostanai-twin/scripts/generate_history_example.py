"""Reproducible software fixture, not factory data. Run from the project root."""
import csv
from pathlib import Path
from backend.model import initial_state, advance_in_place
from backend.history_import import HEADERS

state = initial_state(warmup_seconds=0)
# Deliberately different from the predictor's 65s assumption.
state['arrivalIntervalSec'] = 68
changes = {7200: (2, 'stop'), 9000: (2, 'normal'), 14400: (2, 'slow'),
           16200: (2, 'normal'), 21600: (3, 'slow'), 22500: (3, 'normal')}
destination = Path('public/examples/demo-shift.csv')
destination.parent.mkdir(parents=True, exist_ok=True)
with destination.open('w', encoding='utf-8', newline='') as stream:
    writer = csv.writer(stream, lineterminator='\n')
    writer.writerow(HEADERS)
    for second in range(0, 28801, 900):
        advance_in_place(state, second - state['elapsedSec'], record_history=False)
        if second in changes:
            index, mode = changes[second]
            state['stations'][index]['mode'] = mode
        writer.writerow([second, state['good'], state['rejected'], *[s['mode'] for s in state['stations']]])
print(f'{destination}: synthetic, 33 observations, {state["good"]} good units')
