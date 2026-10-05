import type { LineConfiguration, StationMode } from './types.ts';
import { configurationsEqual, defaultConfiguration, validConfiguration } from './configuration.ts';

export interface CsvIssue { row: number; column: string; message: string }
export interface HistorySummary {
  good: number; rejected: number; planDelta: number; rejectPct: number | null;
  replayGood: number; checkpointCount: number; flowMae: number | null; rateMae: number | null;
}
export interface ImportEntry {
  importId: string; createdAt: string; fileName: string; source: 'synthetic_example' | 'user_csv'; summary: HistorySummary;
  schemaVersion?: 1 | 2; methodVersion?: string; configuration?: LineConfiguration;
}
export interface HistoryReport extends ImportEntry {
  schemaVersion: 1 | 2; methodVersion: string; shiftDurationSec: number; plan: number;
  quality: { rowCount: number; maxGapSec: number; warnings: string[] };
  observations: { elapsedSec: number; good: number; rejected: number; modes: StationMode[]; csvLine: number; replayGood: number; replayRejected: number }[];
  checkpoints: { elapsedSec: number; observedGood: number; replayGood: number; flowForecast: number; rateForecast: number; rateWindowSec: number; actualGood: number; flowError: number; rateError: number }[];
  assumptions: string[];
}
export function configurationForReport(report: HistoryReport): LineConfiguration {
  const value = report.configuration ?? { ...defaultConfiguration(), shiftPlan: report.plan };
  return { ...value, stationCyclesSec: [...value.stationCyclesSec], bufferCapacities: [...value.bufferCapacities] };
}
export class HistoryError extends Error {
  issues: CsvIssue[];
  totalIssues: number;
  constructor(message: string, issues: CsvIssue[] = [], totalIssues = issues.length) {
    super(message); this.issues = issues; this.totalIssues = totalIssues;
  }
}
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const count = (v: unknown): v is number => num(v) && Number.isSafeInteger(v) && v >= 0;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string');
const nullable = (v: unknown): boolean => v === null || num(v) && v >= 0;
const summary = (s: unknown): s is HistorySummary => obj(s)
  && [s.good, s.rejected, s.replayGood, s.checkpointCount].every(count) && num(s.planDelta)
  && [s.rejectPct, s.flowMae, s.rateMae].every(nullable);
function entry(v: unknown): v is ImportEntry {
  return obj(v) && typeof v.importId === 'string' && /^[a-f0-9]{64}$/.test(v.importId)
    && typeof v.fileName === 'string' && typeof v.createdAt === 'string' && Number.isFinite(Date.parse(v.createdAt))
    && ['synthetic_example', 'user_csv'].includes(String(v.source)) && summary(v.summary)
    && ((v.schemaVersion === undefined && v.methodVersion === undefined && v.configuration === undefined)
      || (v.schemaVersion === 1 && v.methodVersion === 'flow-history-v1' && v.configuration === undefined)
      || (v.schemaVersion === 2 && v.methodVersion === 'flow-history-v2' && validConfiguration(v.configuration)
        && v.configuration.shiftPlan === v.summary.good - v.summary.planDelta));
}
export function validHistoryReport(v: unknown): v is HistoryReport {
  if (!entry(v) || !obj(v) || ![1, 2].includes(Number(v.schemaVersion))
    || v.shiftDurationSec !== 28800 || !count(v.plan) || v.plan === 0 || v.plan > 100000
    || !obj(v.quality) || !count(v.quality.rowCount) || !count(v.quality.maxGapSec) || !strings(v.quality.warnings)
    || !strings(v.assumptions) || !Array.isArray(v.observations) || v.observations.length < 3 || v.observations.length > 6000
    || v.quality.rowCount !== v.observations.length || !Array.isArray(v.checkpoints)) return false;
  const rows = v.observations;
  if (!rows.every((r, i) => obj(r) && [r.elapsedSec, r.good, r.rejected, r.csvLine, r.replayGood, r.replayRejected].every(count)
      && Number(r.elapsedSec) <= 28800 && Array.isArray(r.modes) && r.modes.length === 5
      && r.modes.every(m => ['normal', 'slow', 'stop'].includes(String(m)))
      && (i === 0 || Number(r.elapsedSec) > rows[i - 1].elapsedSec && Number(r.good) >= rows[i - 1].good && Number(r.rejected) >= rows[i - 1].rejected
        && Number(r.replayGood) >= rows[i - 1].replayGood && Number(r.replayRejected) >= rows[i - 1].replayRejected))) return false;
  const last = rows[rows.length - 1];
  if (rows[0].elapsedSec !== 0 || rows[0].good !== 0 || rows[0].rejected !== 0 || last.elapsedSec !== 28800 || last.good !== v.summary.good
      || last.rejected !== v.summary.rejected || v.summary.planDelta !== last.good - v.plan
      || last.replayGood !== v.summary.replayGood
      || v.summary.checkpointCount !== v.checkpoints.length) return false;
  const maxGap = Math.max(...rows.slice(1).map((r, i) => r.elapsedSec - rows[i].elapsedSec));
  if (v.quality.maxGapSec !== maxGap || rows[0].replayGood !== 0 || rows[0].replayRejected !== 0) return false;
  const total = last.good + last.rejected;
  if (total === 0 ? v.summary.rejectPct !== null : !num(v.summary.rejectPct) || Math.abs(v.summary.rejectPct - last.rejected / total * 100) >= .0051) return false;
  const indices = [...new Set([7200, 14400, 21600].map(t => rows.reduce((selected, r, i) => r.elapsedSec <= t ? i : selected, 0)))].filter(i => rows[i].elapsedSec > 0 && rows[i].elapsedSec < 28800);
  if (v.checkpoints.length !== indices.length || !v.checkpoints.every((p, i) => {
    if (!obj(p) || ![p.elapsedSec, p.observedGood, p.replayGood, p.flowForecast, p.rateForecast, p.rateWindowSec, p.actualGood].every(count)) return false;
    const row = rows[indices[i]];
    const anchor = rows.slice(0, indices[i]).filter(r => r.elapsedSec <= row.elapsedSec - 3600).pop() ?? rows[0];
    const window = row.elapsedSec - anchor.elapsedSec;
    const baseline = row.good + Math.floor((row.good - anchor.good) / window * (28800 - row.elapsedSec) + .5);
    return p.elapsedSec === row.elapsedSec && p.observedGood === row.good && p.replayGood === row.replayGood
      && p.rateWindowSec === window && p.rateForecast === baseline && p.actualGood === last.good
      && p.flowError === Number(p.flowForecast) - last.good && p.rateError === Number(p.rateForecast) - last.good;
  })) return false;
  if (!v.checkpoints.length) return v.summary.flowMae === null && v.summary.rateMae === null;
  return num(v.summary.flowMae) && num(v.summary.rateMae)
    && Math.abs(v.summary.flowMae - v.checkpoints.reduce((sum,p)=>sum+Math.abs(p.flowError),0)/v.checkpoints.length) < .0051
    && Math.abs(v.summary.rateMae - v.checkpoints.reduce((sum,p)=>sum+Math.abs(p.rateError),0)/v.checkpoints.length) < .0051;
}
export class HistorySource {
  private async request(path: string, init?: RequestInit): Promise<unknown> {
    let response: Response;
    try { response = await fetch(path, { ...init, cache: 'no-store', signal: AbortSignal.timeout(15000) }); }
    catch { throw new HistoryError('Нет связи с сервером. Файл не подтверждён как импортированный; повторите после подключения.'); }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 404) throw new HistoryError('Импорт или отчёт недоступен. Проверьте список импортов и запустите актуальный сервер через start.cmd.');
      const issues = obj(body) && Array.isArray(body.issues) ? body.issues.filter((i): i is CsvIssue => obj(i) && count(i.row) && typeof i.column === 'string' && typeof i.message === 'string') : [];
      throw new HistoryError(obj(body) && typeof body.detail === 'string' ? body.detail : `Запрос не выполнен (${response.status}). Проверьте файл, план и параметры смены.`, issues, obj(body) && count(body.totalIssues) ? body.totalIssues : issues.length);
    }
    return body;
  }
  async list(): Promise<ImportEntry[]> {
    const data = await this.request('/api/v1/history/imports');
    if (!obj(data) || !Array.isArray(data.imports) || !data.imports.every(entry)) throw new HistoryError('Несовместимый список импортов.');
    return data.imports;
  }
  async load(id: string): Promise<HistoryReport> {
    const data = await this.request(`/api/v1/history/imports/${encodeURIComponent(id)}`);
    if (!validHistoryReport(data) || data.importId !== id) throw new HistoryError('Сервер вернул несовместимый отчёт истории.');
    return data;
  }
  async import(fileName: string, csvText: string, shiftPlan: number, configuration?: LineConfiguration): Promise<HistoryReport> {
    if (configuration && (!validConfiguration(configuration) || configuration.shiftPlan !== shiftPlan)) throw new HistoryError('Проверьте параметры: план конфигурации должен совпадать с планом смены.');
    const data = await this.request('/api/v1/history/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({fileName, csvText, shiftPlan, ...(configuration ? {configuration} : {})}) });
    if (!validHistoryReport(data) || data.plan !== shiftPlan || (configuration && (data.schemaVersion !== 2 || !data.configuration || !configurationsEqual(configuration, data.configuration)))) throw new HistoryError('Сервер вернул несовместимый отчёт истории или не подтвердил выбранные параметры.');
    return data;
  }
}
