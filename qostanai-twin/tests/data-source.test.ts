import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HttpDataSource, ApiError } from '../src/data-source.ts';

const example = JSON.parse(readFileSync(new URL('../docs/snapshot.example.json', import.meta.url), 'utf8'));
const comparison = JSON.parse(readFileSync(new URL('../docs/comparison.example.json', import.meta.url), 'utf8'));

test('HTTP source accepts a real backend snapshot and rejects malformed nested data', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json(example);
    assert.equal((await new HttpDataSource().getSnapshot()).runId, example.runId);
    const broken = structuredClone(example);
    broken.state.stations[0].nominalCycleSec = 0;
    globalThis.fetch = async () => Response.json(broken);
    await assert.rejects(new HttpDataSource().getSnapshot(), /несовместимые/);
  } finally { globalThis.fetch = original; }
});

test('ambiguous network failure retries exactly the same command identifier', async () => {
  const original = globalThis.fetch;
  const bodies: string[] = [];
  try {
    globalThis.fetch = async (_url, init) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) throw new Error('connection lost after sending');
      return Response.json(example);
    };
    await new HttpDataSource().dispatch({ type: 'advance', seconds: 300 }, example.runId);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1]);
    assert.equal(JSON.parse(bodies[0]).runId, example.runId);
    assert.ok(JSON.parse(bodies[0]).commandId);
  } finally { globalThis.fetch = original; }
});

test('business conflict is surfaced without automatic replay under a new key', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return Response.json({ detail: 'Сценарий изменён' }, { status: 409 }); };
    await assert.rejects(new HttpDataSource().dispatch({ type: 'reset' }, example.runId), (e: Error) => e instanceof ApiError && e.status === 409);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('comparison sends a read-only analysis request and accepts real model results', async () => {
  const original = globalThis.fetch;
  const payload = { runId: comparison.runId, stationId: 'P03', delayMinutes: 30 };
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, '/api/v1/analysis/compare');
      assert.equal(init?.method, 'POST');
      assert.deepEqual(JSON.parse(String(init?.body)), payload);
      return Response.json(comparison);
    };
    const report = await new HttpDataSource().compare(payload);
    assert.equal(report.summary.delayLoss, 27);
    assert.deepEqual(report.results.map(r => r.good), [39, 421, 394]);
  } finally { globalThis.fetch = original; }
});

test('comparison rejects broken curves, invalid totals, and mismatched request parameters', async () => {
  const original = globalThis.fetch;
  const payload = { runId: comparison.runId, stationId: 'P03', delayMinutes: 30 };
  try {
    const mutations = [
      (r: typeof comparison) => { r.results[0].series[1].elapsedSec = 0; },
      (r: typeof comparison) => { r.results[0].series.at(-1).good += 1; },
      (r: typeof comparison) => { r.results[1].gainVsBaseline = 999; },
      (r: typeof comparison) => { r.summary.delayLoss = -1; },
      (r: typeof comparison) => { r.results[2].recoveryAtSec = r.shiftDurationSec; },
      (r: typeof comparison) => { r.stationId = 'P04'; },
    ];
    for (const mutate of mutations) {
      const broken = structuredClone(comparison); mutate(broken);
      globalThis.fetch = async () => Response.json(broken);
      await assert.rejects(new HttpDataSource().compare(payload), /несовместимые|не совпадают/);
    }
  } finally { globalThis.fetch = original; }
});
