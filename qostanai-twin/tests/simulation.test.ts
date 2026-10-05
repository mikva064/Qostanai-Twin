import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, advance, setStationMode, forecast, stationStatus, applyCommand } from '../src/simulation.ts';
import type { TwinState } from '../src/types.ts';

function checkConservation(state: TwinState) {
  const inProcess = state.stations.filter(s => s.remainingWorkSec !== null).length;
  const waiting = state.buffers.reduce((n, b) => n + b.count, 0);
  assert.equal(state.released, state.good + state.rejected + inProcess + waiting, 'No item may be lost or counted twice');
  assert.equal(state.good + state.rejected, state.stations.at(-1)!.completed, 'Only final output counts as production');
  for (const b of state.buffers) assert.ok(b.count >= 0 && b.count <= b.capacity);
}

test('initial state is a reproducible warm-up of 45 minutes', () => {
  const state = createInitialState();
  assert.deepEqual(state, createInitialState());
  assert.equal(state.elapsedSec, 2700);
  assert.ok(state.good > 0);
  checkConservation(state);
});

test('normal shift conserves every item and stops exactly at the end', () => {
  const state = advance(createInitialState(), 1_000_000);
  assert.equal(state.elapsedSec, state.shiftDurationSec);
  checkConservation(state);
  assert.equal(state.rejected, Math.floor(state.stations.at(-1)!.completed / 25));
  assert.deepEqual(advance(state, 300), state);
});

test('stopped P03 blocks upstream and starves downstream after buffers are exhausted', () => {
  const initial = createInitialState();
  const stopped = setStationMode(initial, 'P03', 'stop');
  const heldWork = stopped.stations[2].remainingWorkSec;
  const after = advance(stopped, 1200);
  assert.equal(after.stations[2].remainingWorkSec, heldWork);
  assert.equal(after.stations[2].downtimeSec, 1200);
  assert.equal(after.buffers[1].count, after.buffers[1].capacity);
  assert.equal(stationStatus(after.stations[1]), 'blocked');
  assert.equal(stationStatus(after.stations[3]), 'starved');
  const later = advance(after, 300);
  assert.equal(later.good, after.good);
  checkConservation(after);
  assert.equal(initial.stations[2].mode, 'normal', 'Commands must not mutate prior snapshots');
});

test('recovery resumes output, resolves the incident and preserves accumulated downtime', () => {
  const stopped = advance(setStationMode(createInitialState(), 'P03', 'stop'), 1200);
  const recovered = advance(setStationMode(stopped, 'P03', 'normal'), 1200);
  assert.ok(recovered.good > stopped.good);
  assert.equal(recovered.stations[2].downtimeSec, 1200);
  assert.equal(recovered.incidents.filter(i => i.resolvedAtSec === null).length, 0);
  checkConservation(recovered);
});

test('slowing a station reduces forecast and produces a finite fill estimate', () => {
  const baseline = createInitialState();
  const slow = setStationMode(baseline, 'P03', 'slow');
  const normalForecast = forecast(baseline);
  const slowForecast = forecast(slow);
  assert.ok(slowForecast.goodAtShiftEnd < normalForecast.goodAtShiftEnd);
  assert.equal(slowForecast.bottleneckId, 'P03');
  assert.equal(slowForecast.fillBufferId, 'B02');
  assert.ok(slowForecast.minutesToFill !== null && slowForecast.minutesToFill > 0);
  const slowEnd = advance(slow, slow.shiftDurationSec);
  assert.equal(slowEnd.good, slowForecast.goodAtShiftEnd);
  assert.equal(baseline.elapsedSec, 2700, 'Forecast may not advance the observed state');
  checkConservation(slowEnd);
});

test('repeated mode commands do not duplicate incidents; acknowledge keeps incident active', () => {
  const stopped = setStationMode(createInitialState(), 'P02', 'stop');
  const repeated = setStationMode(stopped, 'P02', 'stop');
  assert.equal(repeated.incidents.length, stopped.incidents.length);
  const acknowledged = applyCommand(repeated, { type: 'acknowledge_incident', incidentId: repeated.incidents[0].id });
  assert.equal(acknowledged.incidents[0].acknowledged, true);
  assert.equal(acknowledged.incidents[0].resolvedAtSec, null);
});

test('mixed scenarios conserve inventory and reset restores the original state', () => {
  let state = createInitialState();
  for (const [id, mode, seconds] of [['P03', 'slow', 700], ['P02', 'stop', 900], ['P03', 'normal', 300], ['P02', 'normal', 1000], ['P05', 'stop', 500], ['P05', 'normal', 500]] as const) {
    state = advance(setStationMode(state, id, mode), seconds);
    checkConservation(state);
  }
  assert.deepEqual(applyCommand(state, { type: 'reset' }), createInitialState());
});
