import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ArchiveSource, archiveSeries, summarizeRun } from '../src/archive-source.ts';
import { HttpDataSource } from '../src/data-source.ts';
import type { TwinSnapshot } from '../src/types.ts';

const live: TwinSnapshot = JSON.parse(readFileSync(new URL('../docs/snapshot.example.json', import.meta.url), 'utf8'));
const { receivedAt: _, ...stored } = live;
const catalog = { currentRunId: stored.runId, runs: [{ runId: stored.runId, createdAt: stored.savedAt, updatedAt: stored.savedAt, good: stored.state.good }] };

test('archive accepts the existing API without receivedAt and uses only reads', async () => {
  const original = globalThis.fetch, before = JSON.stringify(stored);
  try {
    globalThis.fetch = async (url, init) => {
      assert.ok(!init?.method || init.method === 'GET');
      assert.equal(init?.cache, 'no-store');
      if (url === '/api/v1/runs') return Response.json(catalog);
      assert.equal(url, `/api/v1/runs/${stored.runId}`);
      return Response.json(stored);
    };
    const source = new ArchiveSource();
    assert.deepEqual(await source.list(), catalog);
    const result = await source.load(stored.runId);
    assert.equal(result.state.good, stored.state.good);
    assert.ok(!('receivedAt' in result));
    assert.equal(JSON.stringify(stored), before);
  } finally { globalThis.fetch = original; }
});

test('archive rejects another run, impossible timelines and equipment totals', async () => {
  const original = globalThis.fetch;
  try {
    for (const mutate of [
      (r: typeof stored) => { r.runId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; },
      (r: typeof stored) => { r.state.history.push({ elapsedSec: r.state.elapsedSec + 1, good: r.state.good, rejected: 0 }); },
      (r: typeof stored) => { r.state.history = [{ elapsedSec: 1, good: 2, rejected: 0 }, { elapsedSec: 2, good: 1, rejected: 0 }]; },
      (r: typeof stored) => { r.state.history = [{ elapsedSec: 1, good: 0, rejected: 0 }, { elapsedSec: 1, good: 0, rejected: 0 }]; },
      (r: typeof stored) => { r.state.stations[0].downtimeSec = r.state.elapsedSec + 1; },
      (r: typeof stored) => { r.state.incidents[0].resolvedAtSec = r.state.elapsedSec + 1; },
      (r: typeof stored) => { r.state.source = 'live'; },
      (r: typeof stored) => { r.forecast.calculatedAtSec = r.state.elapsedSec + 1; },
    ]) {
      const broken = structuredClone(stored); mutate(broken);
      globalThis.fetch = async () => Response.json(broken);
      await assert.rejects(new ArchiveSource().load(stored.runId), /несовместимый/);
    }
  } finally { globalThis.fetch = original; }
});

test('run list validates identities and dates but accepts an empty archive', async () => {
  const original = globalThis.fetch;
  try {
    for (const bad of [
      { ...catalog, runs: [catalog.runs[0], catalog.runs[0]] },
      { ...catalog, runs: [{ ...catalog.runs[0], good: -1 }] },
      { ...catalog, runs: [{ ...catalog.runs[0], updatedAt: 'invalid' }] },
      { ...catalog, runs: [{ ...catalog.runs[0], updatedAt: '2000-01-01T00:00:00Z' }] },
      { ...catalog, currentRunId: 'not-an-id' },
    ]) {
      globalThis.fetch = async () => Response.json(bad);
      await assert.rejects(new ArchiveSource().list(), /несовместимый/);
    }
    globalThis.fetch = async () => Response.json({ ...catalog, runs: [] });
    assert.deepEqual((await new ArchiveSource().list()).runs, []);
  } finally { globalThis.fetch = original; }
});

test('failed reads report connection and missing-run errors without changing the server', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; throw new Error('offline'); };
    await assert.rejects(new ArchiveSource().load(stored.runId), /подключение/);
    assert.equal(calls, 1);
    await assert.rejects(new ArchiveSource().load('../commands'), /идентификатор/);
    assert.equal(calls, 1);
    globalThis.fetch = async () => Response.json({ detail: 'Not found' }, { status: 404 });
    await assert.rejects(new ArchiveSource().load(stored.runId), /не найден/);
  } finally { globalThis.fetch = original; }
});

test('report distinguishes partial results, sums equipment downtime and excludes information events', () => {
  const sample = structuredClone(stored), s = sample.state;
  s.elapsedSec = 3600; s.shiftPlan = 410; s.good = 80; s.rejected = 20;
  s.stations.forEach(p => { p.downtimeSec = 0; p.remainingWorkSec = null; });
  s.buffers.forEach(b => { b.count = 0; });
  s.stations[0].downtimeSec = 60; s.stations[2].downtimeSec = 300;
  s.stations[2].remainingWorkSec = 0; s.buffers[0].count = 4;
  s.incidents = [
    { id: 'info', stationId: null, title: '', detail: '', severity: 'info', startedAtSec: 0, resolvedAtSec: null, acknowledged: false },
    { id: 'closed', stationId: 'P01', title: '', detail: '', severity: 'critical', startedAtSec: 10, resolvedAtSec: 70, acknowledged: true },
    { id: 'open', stationId: 'P03', title: '', detail: '', severity: 'critical', startedAtSec: 100, resolvedAtSec: null, acknowledged: true },
  ];
  const before = JSON.stringify(sample), result = summarizeRun(sample);
  assert.equal(result.ended, false);
  assert.equal(result.planDelta, -330);
  assert.equal(result.rejectPct, 20);
  assert.equal(result.downtimeSec, 360);
  assert.equal(result.worstStation?.id, 'P03');
  assert.equal(result.incidentCount, 2); assert.equal(result.unresolvedCount, 1);
  assert.equal(result.wip, 5);
  assert.equal(JSON.stringify(sample), before);
});

test('zero-output and completed reports do not create NaN or false downtime leaders', () => {
  const sample = structuredClone(stored);
  sample.state.elapsedSec = sample.state.shiftDurationSec;
  sample.state.good = 0; sample.state.rejected = 0;
  sample.state.stations.forEach(p => { p.downtimeSec = 0; });
  const summary = summarizeRun(sample);
  assert.equal(summary.ended, true); assert.equal(summary.rejectPct, null);
  assert.equal(summary.planPct, 0); assert.equal(summary.worstStation, null);
});

test('archive chart ends at the saved fact without duplicate timestamps or forecast extensions', () => {
  const sample = structuredClone(stored);
  sample.state.elapsedSec = 600; sample.state.good = 8; sample.state.rejected = 1;
  sample.state.history = [{ elapsedSec: 0, good: 0, rejected: 0 }, { elapsedSec: 600, good: 7, rejected: 0 }];
  assert.deepEqual(archiveSeries(sample), [{ elapsedSec: 0, good: 0, rejected: 0 }, { elapsedSec: 600, good: 8, rejected: 1 }]);
});

test('live polling still rejects an archived response without a received timestamp', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json(stored);
    await assert.rejects(new HttpDataSource().getSnapshot(), /несовместимые/);
    globalThis.fetch = async () => Response.json(live);
    assert.equal((await new HttpDataSource().getSnapshot()).runId, live.runId);
  } finally { globalThis.fetch = original; }
});
