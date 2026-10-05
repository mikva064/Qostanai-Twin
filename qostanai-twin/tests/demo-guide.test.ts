import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { demoChecks, demoCommand, matchesDemoComparison, matchesDemoStage } from '../src/demo-guide.ts';
import type { DemoStage } from '../src/demo-guide.ts';
import type { ScenarioComparison, TwinSnapshot } from '../src/types.ts';
import { defaultConfiguration } from '../src/configuration.ts';

const reference: Record<DemoStage, TwinSnapshot> & { comparison: ScenarioComparison } = JSON.parse(readFileSync(new URL('../docs/demo.reference.json', import.meta.url), 'utf8'));

test('all five control states match real Python API snapshots without changing them', () => {
  const before = JSON.stringify(reference);
  for (const stage of ['initial', 'stopped', 'impact', 'restored', 'recovered'] as const) {
    assert.ok(matchesDemoStage(reference[stage], stage), stage);
    assert.ok(demoChecks(reference[stage], stage).every(c => c.ok), stage);
  }
  assert.equal(JSON.stringify(reference), before);
  assert.equal(reference.recovered.state.good, 42);
});

test('prepare uses one existing reset on old servers and explicit defaults for a custom line', () => {
  const old = structuredClone(reference.recovered); delete old.capabilities;
  assert.deepEqual(demoCommand('prepare', old), { type: 'reset' });
  const custom = structuredClone(old); custom.state.shiftPlan = 275;
  assert.throws(() => demoCommand('prepare', custom), /обновлённый сервер/);
  custom.capabilities = ['configure_line'];
  assert.deepEqual(demoCommand('prepare', custom), { type: 'configure_line', configuration: defaultConfiguration() });
  assert.equal(custom.state.shiftPlan, 275);
});

test('each explicit action produces exactly one correctly scoped command', () => {
  const run = reference.initial.runId;
  assert.deepEqual(demoCommand('stop', reference.initial, run), { type: 'set_station_mode', stationId: 'P03', mode: 'stop' });
  assert.deepEqual(demoCommand('advance15', reference.stopped, run), { type: 'advance', seconds: 900 });
  assert.deepEqual(demoCommand('restore', reference.impact, run, reference.comparison), { type: 'set_station_mode', stationId: 'P03', mode: 'normal' });
  assert.deepEqual(demoCommand('advance5', reference.restored, run), { type: 'advance', seconds: 300 });
});

test('guard rejects another run, playing clock, wrong time, changed settings and hidden flow differences', () => {
  assert.throws(() => demoCommand('stop', reference.initial, 'another-run'), /сценарий сменился/);
  for (const mutate of [
    (s: TwinSnapshot) => { s.controls.paused = false; },
    (s: TwinSnapshot) => { s.state.elapsedSec++; },
    (s: TwinSnapshot) => { s.state.arrivalIntervalSec++; },
    (s: TwinSnapshot) => { s.state.stations[1].mode = 'slow'; },
    (s: TwinSnapshot) => { s.state.stations[2].remainingWorkSec!++; },
    (s: TwinSnapshot) => { s.state.buffers[1].count++; },
    (s: TwinSnapshot) => { s.state.stations[3].downtimeSec++; },
    (s: TwinSnapshot) => { s.forecast.goodAtShiftEnd++; },
  ]) {
    const changed = structuredClone(reference.initial); mutate(changed);
    assert.equal(matchesDemoStage(changed, 'initial'), false);
    assert.throws(() => demoCommand('stop', changed, changed.runId), /Состояние линии отличается/);
  }
  assert.throws(() => demoCommand('advance15', reference.impact, reference.impact.runId), /Состояние линии отличается/);
});

test('no demo command can target live or historical data', () => {
  for (const source of ['live', 'historical'] as const) {
    const changed = structuredClone(reference.initial); changed.source = source;
    assert.throws(() => demoCommand('prepare', changed), /учебной моделью/);
    changed.source = 'simulation'; changed.state.source = source;
    assert.throws(() => demoCommand('stop', changed, changed.runId), /учебной моделью/);
  }
});

test('comparison is confirmed only for the exact current revision and control scenario', () => {
  assert.ok(matchesDemoComparison(reference.comparison, reference.impact));
  for (const mutate of [
    (r: ScenarioComparison) => { r.runId = 'another-run'; },
    (r: ScenarioComparison) => { r.baseRevision--; },
    (r: ScenarioComparison) => { r.baseElapsedSec++; },
    (r: ScenarioComparison) => { r.delayMinutes = 15; },
    (r: ScenarioComparison) => { r.stationId = 'P02'; },
    (r: ScenarioComparison) => { r.initialGood++; },
    (r: ScenarioComparison) => { r.results[1].good++; },
    (r: ScenarioComparison) => { r.summary.delayLoss--; },
    (r: ScenarioComparison) => { r.stationModes[1].mode = 'stop'; },
  ]) {
    const other = structuredClone(reference.comparison); mutate(other);
    assert.equal(matchesDemoComparison(other, reference.impact), false);
    assert.throws(() => demoCommand('restore', reference.impact, reference.impact.runId, other), /актуальное сравнение/);
  }
  assert.throws(() => demoCommand('restore', reference.impact, reference.impact.runId), /актуальное сравнение/);
  assert.equal(matchesDemoComparison(reference.comparison, reference.restored), false);
  assert.equal(matchesDemoComparison(reference.comparison, reference.recovered), false);
});

test('acknowledging an incident preserves flow checks but requires a fresh comparison', () => {
  const acknowledged = structuredClone(reference.impact);
  acknowledged.state.incidents[0].acknowledged = true; acknowledged.revision++;
  assert.ok(matchesDemoStage(acknowledged, 'impact'));
  assert.equal(matchesDemoComparison(reference.comparison, acknowledged), false);
});
