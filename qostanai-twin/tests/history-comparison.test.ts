import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareHistoryReports, loadHistoryComparison } from '../src/history-comparison.ts';
import { HistorySource, validHistoryReport } from '../src/history-source.ts';
import type { HistoryReport } from '../src/history-source.ts';
import { defaultConfiguration } from '../src/configuration.ts';

const a: HistoryReport = JSON.parse(readFileSync(new URL('../docs/history.example.json', import.meta.url), 'utf8'));
const b: HistoryReport = JSON.parse(readFileSync(new URL('../docs/history.configured.example.json', import.meta.url), 'utf8'));
const modernDefault = (): HistoryReport => ({ ...structuredClone(a), importId: 'a'.repeat(64), schemaVersion: 2, methodVersion: 'flow-history-v2', configuration: defaultConfiguration() });

test('compares real legacy and configured reports with independently checked deltas', () => {
  const before = JSON.stringify([a, b]);
  const result = compareHistoryReports(a, b);
  assert.deepEqual(result.basis, { rowCount: 33, good: 390, rejected: 16, checkpointCount: 3 });
  assert.deepEqual(result.metrics.map(m => m.delta), [-144, 14.66, 0, 135]);
  assert.deepEqual(result.checkpoints.map(p => p.delta), [-1, -47, 4]);
  assert.deepEqual(result.checkpoints.map(p => p.errorB), [-290, -129, -29]);
  assert.deepEqual(result.checkpoints.map(p => p.rate), [405, 428, 400]);
  assert.equal(result.parameters.length, 11);
  assert.equal(result.parameters.find(p => p.key === 'P03')?.delta, 37);
  assert.equal(result.parameters.find(p => p.key === 'B01')?.delta, -4);
  assert.deepEqual(result.series.at(-1), { elapsedSec: 28800, actual: 390, a: 406, b: 262 });
  assert.equal(JSON.stringify([a, b]), before);
  assert.ok(result.notices.some(n => n.includes('больше')));
  assert.ok(result.notices.some(n => n.includes('независимых')));
  const exported = JSON.parse(JSON.stringify({ ...result, exportedAt: '2026-10-03T00:00:00Z' }));
  assert.deepEqual(exported.reports.a, a);
  assert.deepEqual(exported.reports.b, b);
});

test('reversing A and B reverses differences and preserves the actual shift', () => {
  const forward = compareHistoryReports(a, b), reversed = compareHistoryReports(b, a);
  forward.metrics.forEach((m, i) => assert.equal(reversed.metrics[i].delta, m.delta === 0 ? 0 : -m.delta!));
  forward.parameters.forEach((p, i) => assert.equal(reversed.parameters[i].delta, p.delta === 0 ? 0 : -p.delta));
  assert.deepEqual(reversed.basis, forward.basis);
  assert.ok(reversed.notices.some(n => n.includes('меньше')));
});

test('rejects the same report before making any request', async () => {
  let calls = 0;
  const source = { load: async () => { calls++; return a; } };
  await assert.rejects(loadHistoryComparison(source, a.importId, a.importId), /два разных/);
  await assert.rejects(loadHistoryComparison(source, '', b.importId), /два разных/);
  assert.equal(calls, 0);
  assert.throws(() => compareHistoryReports(a, a), /два разных/);
});

test('compares semantic records independently of file names, CSV line locations and source labels', () => {
  const renamed = modernDefault();
  renamed.fileName = 'same-records-semicolon.csv';
  renamed.source = 'user_csv';
  renamed.observations.forEach(row => { row.csvLine += 10; });
  assert.ok(validHistoryReport(renamed));
  const result = compareHistoryReports(a, renamed);
  assert.ok(result.metrics.every(m => m.delta === 0));
  assert.ok(result.parameters.every(p => p.delta === 0));
  assert.ok(result.notices.some(n => n.includes('параметрами')));
});

test('rejects different intermediate counters, modes, times and sampling even when final totals match', () => {
  const changes: ((report: HistoryReport) => void)[] = [
    report => { report.observations[3].good++; },
    report => { report.observations[3].rejected++; },
    report => { report.observations[3].modes[0] = 'slow'; },
    report => { report.observations[3].elapsedSec++; report.quality.maxGapSec = 901; },
    report => { report.observations.splice(3, 1); report.quality.rowCount--; report.quality.maxGapSec = 1800; },
  ];
  for (const change of changes) {
    const other = modernDefault(); change(other);
    assert.ok(validHistoryReport(other), 'mismatched report must be individually valid');
    assert.throws(() => compareHistoryReports(a, other), /История смены различается/);
  }
});

test('changing only the plan never fabricates a forecast or production gain', () => {
  const changed = modernDefault();
  changed.plan = 500; changed.configuration!.shiftPlan = 500; changed.summary.planDelta = -110;
  const result = compareHistoryReports(a, changed);
  assert.deepEqual(result.metrics.map(m => m.delta), [0, 0, 0, -90]);
  assert.deepEqual(result.parameters.filter(p => p.delta).map(p => p.key), ['plan']);
  assert.ok(result.notices.some(n => n.includes('Изменён только план')));
  assert.ok(result.checkpoints.every(p => p.delta === 0));
});

test('missing checkpoints and zero output remain unscored rather than perfect', () => {
  const zero = modernDefault();
  zero.observations = [0, 27000, 28800].map((elapsedSec, i) => ({ elapsedSec, good: 0, rejected: 0, replayGood: 0, replayRejected: 0, csvLine: i + 2, modes: ['stop', 'stop', 'stop', 'stop', 'stop'] }));
  zero.quality = { rowCount: 3, maxGapSec: 27000, warnings: ['Редкая история.'] };
  zero.checkpoints = [];
  zero.summary = { good: 0, rejected: 0, planDelta: -410, rejectPct: null, replayGood: 0, checkpointCount: 0, flowMae: null, rateMae: null };
  const other = structuredClone(zero); other.importId = 'b'.repeat(64); other.plan = 500; other.configuration!.shiftPlan = 500; other.summary.planDelta = -500;
  assert.ok(validHistoryReport(zero));
  const result = compareHistoryReports(zero, other);
  assert.deepEqual(result.metrics.map(m => m.delta), [0, null, null, -90]);
  assert.deepEqual(result.checkpoints, []);
  assert.ok(result.notices.some(n => n.includes('не означает нулевую ошибку')));
  assert.equal(result.notices.filter(n => n === 'Редкая история.').length, 1);
});

test('rejects reordered or duplicated checkpoints and dishonest observation links and baselines', () => {
  const mutations: ((r: HistoryReport) => void)[] = [
    r => { r.checkpoints.reverse(); },
    r => { r.checkpoints[1] = structuredClone(r.checkpoints[0]); },
    r => { r.checkpoints[0].observedGood++; },
    r => { r.checkpoints[0].replayGood++; },
    r => { r.checkpoints[0].rateWindowSec++; },
    r => { r.checkpoints[0].rateForecast++; r.checkpoints[0].rateError++; r.summary.rateMae = Math.round(r.checkpoints.reduce((sum, p) => sum + Math.abs(p.rateError), 0) / 3 * 100) / 100; },
    r => { r.quality.maxGapSec++; },
    r => { r.summary.rejectPct = 50; },
    r => { r.methodVersion = 'unknown-future-method'; },
    r => { r.observations[4].replayGood = 0; },
  ];
  for (const mutate of mutations) {
    const broken = structuredClone(b); mutate(broken);
    assert.equal(validHistoryReport(broken), false);
    assert.throws(() => compareHistoryReports(a, broken), /повреждён|неподдерживаемый/);
  }
});

test('loads both reports through existing read endpoints without writing or calling the model', async () => {
  const original = globalThis.fetch, calls: string[] = [];
  try {
    globalThis.fetch = async (url, init) => {
      const path = String(url); calls.push(path);
      assert.ok(!init?.method || init.method === 'GET');
      assert.equal(init?.cache, 'no-store');
      if (path === `/api/v1/history/imports/${a.importId}`) return Response.json(a);
      assert.equal(path, `/api/v1/history/imports/${b.importId}`);
      return Response.json(b);
    };
    const result = await loadHistoryComparison(new HistorySource(), a.importId, b.importId);
    assert.equal(calls.length, 2);
    assert.equal(result.metrics[1].delta, 14.66);
    await assert.rejects(loadHistoryComparison({ load: async () => a }, a.importId, b.importId), /другие отчёты/);
    globalThis.fetch = async () => { throw new TypeError('network down'); };
    await assert.rejects(loadHistoryComparison(new HistorySource(), a.importId, b.importId), /Нет связи/);
  } finally { globalThis.fetch = original; }
});
