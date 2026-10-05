import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { configurationDraft, configurationFromState, defaultConfiguration, validateConfiguration } from '../src/configuration.ts';
import { createInitialState, applyCommand, advance, forecast } from '../src/simulation.ts';
import { HttpDataSource } from '../src/data-source.ts';
import type { TwinSnapshot } from '../src/types.ts';
const live: TwinSnapshot = JSON.parse(readFileSync(new URL('../docs/snapshot.example.json', import.meta.url), 'utf8'));
const custom = { shiftPlan: 275, arrivalIntervalSec: 80, stationCyclesSec: [45, 60, 95, 40, 65], bufferCapacities: [2, 3, 4, 5] };

test('configuration form rejects incomplete, fractional, exponential and out-of-range inputs', () => {
  const draft = configurationDraft(custom);
  assert.deepEqual(validateConfiguration(draft).value, custom);
  for (const v of ['', ' ', '0', '-1', '1.5', '1e3', '100001']) {
    const result = validateConfiguration({ ...draft, shiftPlan: v });
    assert.equal(result.value, null); assert.ok(result.errors.shiftPlan);
  }
  assert.ok(validateConfiguration({ ...draft, stationCyclesSec: ['5', '5', '4', '5', '3601'] }).errors.P03);
  assert.ok(validateConfiguration({ ...draft, bufferCapacities: ['1', '101', '0', '1'] }).errors.B02);
  assert.ok(validateConfiguration({ ...draft, stationCyclesSec: [] }).errors.structure);
});

test('extracting and restoring settings does not alias live state or change the demo defaults', () => {
  const config = configurationFromState(live.state);
  config.stationCyclesSec[0] = 700; config.bufferCapacities[0] = 80;
  assert.equal(live.state.stations[0].nominalCycleSec, 48);
  assert.equal(live.state.buffers[0].capacity, 6);
  const defaults = defaultConfiguration(); defaults.stationCyclesSec[0] = 999;
  assert.equal(defaultConfiguration().stationCyclesSec[0], 48);
});

test('custom reference simulation affects throughput and reset retains configuration', () => {
  const s = createInitialState(custom);
  assert.deepEqual(configurationFromState(s), custom);
  assert.ok(forecast(s).goodAtShiftEnd < forecast(createInitialState()).goodAtShiftEnd);
  const reset = applyCommand(advance(s, 600), { type: 'reset' });
  assert.deepEqual(reset, s);
  assert.deepEqual(applyCommand(s, { type: 'configure_line', configuration: defaultConfiguration() }), createInitialState());
});

test('retry of configuration sends identical request id and original expected run', async () => {
  const original = globalThis.fetch, bodies: string[] = [];
  const response = { ...live, runId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', state: createInitialState(custom), capabilities: ['configure_line'] };
  response.forecast = forecast(response.state);
  try {
    globalThis.fetch = async (_url, init) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) throw new Error('lost response');
      return Response.json(response);
    };
    const reordered = { bufferCapacities: custom.bufferCapacities, stationCyclesSec: custom.stationCyclesSec, arrivalIntervalSec: 80, shiftPlan: 275 };
    const result = await new HttpDataSource().dispatch({ type: 'configure_line', configuration: reordered }, live.runId);
    assert.equal(result.runId, response.runId);
    assert.equal(bodies[0], bodies[1]);
    assert.equal(JSON.parse(bodies[0]).runId, live.runId);
    assert.deepEqual(JSON.parse(bodies[0]).configuration, custom);
  } finally { globalThis.fetch = original; }
});

test('configuration never silently succeeds with an unchanged run or wrong parameters', async () => {
  const original = globalThis.fetch;
  try {
    for (const response of [live, { ...live, runId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }]) {
      globalThis.fetch = async () => Response.json(response);
      await assert.rejects(new HttpDataSource().dispatch({ type: 'configure_line', configuration: custom }, live.runId), /не подтвердил/);
    }
  } finally { globalThis.fetch = original; }
});
