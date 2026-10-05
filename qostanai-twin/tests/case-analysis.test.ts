import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeCase, caseDates, caseExport, caseRate, parseCaseDataset } from '../src/case-analysis.ts';

const source = JSON.parse(readFileSync(new URL('../src/case-dataset.json', import.meta.url), 'utf8'));
const data = parseCaseDataset(source);

test('all source tables, provenance and stated thresholds are preserved', () => {
  assert.deepEqual(caseDates(data), ['2026-10-01', '2026-10-02']);
  assert.deepEqual([data.production.length, data.downtime.length, data.monthlyPlans.length, data.quality.length], [6, 4, 3, 6]);
  assert.equal(data.provenance.sha256, '1c46c836dd2907a5c6c9e505c4c751155c6c7fc639ceb191882295a5e2e81e76');
  assert.equal(data.topology.length, 6);
  assert.deepEqual(data.rules, { schedule: { shiftsPerDay: 2, hoursPerShift: 8 }, oeeTargetPct: 85, maxDefectPct: 2, criticalDowntimeMinutesPerDay: 60, monthlyTarget: 5500 });
  assert.ok(data.downtime.every(event => event.critical === null));
});

test('latest date produces independent exact quality arithmetic, no sum of consecutive-stage output', () => {
  const report = analyzeCase(data, '2026-10-02');
  assert.equal(report.assembly!.actual, 119);
  assert.equal(report.assembly!.plan, 120);
  assert.deepEqual(report.qualityBreaches.map(row => row.section), ['painting', 'welding']);
  const painting = report.rows.find(row => row.section === 'painting')!;
  assert.equal(painting.defectPct, 6 / 116 * 100);
  assert.equal(painting.defectDeltaPp, 6 / 116 * 100 - 4 / 115 * 100);
  assert.equal(painting.planGap, 4);
  assert.equal(report.insights[0].id, 'quality-painting');
  assert.match(report.insights[0].evidence, /5,17%/);
  assert.equal('totalFactoryOutput' in report, false);
});

test('first date cannot use future observations or blame a recorded downtime for defects', () => {
  const before = JSON.stringify(data);
  const report = analyzeCase(data, '2026-10-01');
  assert.equal(report.previousDate, null);
  assert.deepEqual(report.qualityBreaches.map(row => row.section), ['painting']);
  assert.ok(report.rows.every(row => row.previous === null && row.defectDeltaPp === null));
  assert.equal(report.assembly!.actual, 121);
  assert.equal(report.assembly!.planGap, 0);
  assert.ok(report.insights.every(item => !item.id.includes('plan-assembly')));
  assert.equal(report.downtime.length, 2);
  assert.ok(report.insights.every(item => !item.evidence.includes('02.10.2026')));
  assert.match(report.insights[0].action, /Причина брака.*не указана/);
  assert.equal(JSON.stringify(data), before);
});

test('monthly plan discrepancy stays explicit, without OEE or a fabricated forecast', () => {
  const report = analyzeCase(data, '2026-10-02');
  assert.equal(report.monthlyPlan, 4800);
  assert.equal(report.monthlyGap, 700);
  assert.equal(report.oee, null); assert.equal(report.forecast, null);
  assert.equal(report.trainingStatus, 'insufficient-data');
  assert.equal(data.provenance.monthlyPlanPeriod, 'unspecified');
});

test('equipment threshold is conditional on criticality; missing records are not zero downtime', () => {
  const report = analyzeCase(data, '2026-10-02');
  const conveyor = report.insights.find(row => row.id === 'downtime-Конвейер-03')!;
  assert.match(conveyor.evidence, /Критичность не указана/);
  assert.match(conveyor.evidence, /до него 5 мин/);
  assert.match(conveyor.action, /90%/);
  const changed = structuredClone(data);
  changed.downtime = changed.downtime.map(row => ({ ...row, critical: false }));
  assert.ok(analyzeCase(changed, '2026-10-02').insights.every(row => !row.id.startsWith('downtime-')));
  changed.downtime = [];
  assert.deepEqual(analyzeCase(changed, '2026-10-02').equipment, []);
});

test('quality breach uses exact counts and is strictly greater than the permitted percentage', () => {
  const changed = structuredClone(data);
  const p = changed.production.find(row => row.date === '2026-10-02' && row.section === 'painting')!;
  const q = changed.quality.find(row => row.date === p.date && row.section === p.section)!;
  p.actual = 100; q.produced = 100; q.rejected = 2; q.reportedDefectPct = 2;
  assert.ok(!analyzeCase(parseCaseDataset(changed), p.date).qualityBreaches.some(row => row.section === 'painting'));
  q.rejected = 3; q.reportedDefectPct = 3;
  assert.ok(analyzeCase(parseCaseDataset(changed), p.date).qualityBreaches.some(row => row.section === 'painting'));
});

test('unknown and zero quality do not become perfect measured performance', () => {
  const changed = structuredClone(data);
  changed.quality = [];
  assert.ok(analyzeCase(parseCaseDataset(changed), '2026-10-02').rows.every(row => row.defectPct === null));
  assert.equal(caseRate(0, 0), null);
});

test('corrupt dates, duplicates, inconsistent totals and rounded rates are rejected', () => {
  for (const mutate of [
    (d: typeof source) => { d.production[0].date = '2026-02-30'; },
    (d: typeof source) => { d.production.push(d.production[0]); },
    (d: typeof source) => { d.quality[0].produced++; },
    (d: typeof source) => { d.quality[0].rejected = 119; },
    (d: typeof source) => { d.quality[0].reportedDefectPct = 2; },
    (d: typeof source) => { d.downtime[0].minutes = -1; },
    (d: typeof source) => { d.downtime[0].critical = 'yes'; },
    (d: typeof source) => { d.production[0].utilizationPct = 101; },
    (d: typeof source) => { d.monthlyPlans.push(d.monthlyPlans[0]); },
    (d: typeof source) => { d.rules.schedule.shiftsPerDay = 4; },
  ]) {
    const copy = structuredClone(source); mutate(copy);
    assert.throws(() => parseCaseDataset(copy), /повреждены/);
  }
  assert.throws(() => analyzeCase(data, '2026-10-03'), /нет данных/);
});

test('export includes reproducible inputs, rounded source values and selected date', () => {
  const exported = JSON.parse(JSON.stringify(caseExport(data, '2026-10-01')));
  assert.equal(exported.method, 'case-rules-v1');
  assert.equal(exported.analysis.date, '2026-10-01');
  assert.equal(exported.source.quality[0].reportedDefectPct, 1.7);
  assert.deepEqual(analyzeCase(parseCaseDataset(exported.source), exported.analysis.date), exported.analysis);
  assert.equal(exported.analysis.forecast, null);
});
