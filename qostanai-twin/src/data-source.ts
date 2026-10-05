import type { ComparisonRequest, ScenarioComparison, StoredTwinSnapshot, TwinCommand, TwinSnapshot } from './types.ts';
import { configurationFromState, configurationsEqual } from './configuration.ts';

export interface TwinDataSource {
  getSnapshot(): Promise<TwinSnapshot>;
  dispatch(command: TwinCommand, runId: string): Promise<TwinSnapshot>;
  compare(request: ComparisonRequest): Promise<ScenarioComparison>;
}
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function count(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function numeric(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function text(value: unknown): value is string { return typeof value === 'string'; }
function timestamp(value: unknown): boolean { return text(value) && Number.isFinite(Date.parse(value)); }
export function validStoredSnapshot(value: unknown): value is StoredTwinSnapshot {
  if (!record(value) || value.schemaVersion !== 2 || !text(value.runId) || !count(value.revision)
      || !timestamp(value.savedAt)
      || !['simulation', 'historical', 'live'].includes(String(value.source))) return false;
  const { state: s, controls: c, forecast: f } = value;
  if (!record(s) || s.schemaVersion !== 1 || !record(c) || typeof c.paused !== 'boolean'
      || !count(c.speed) || ![20, 60, 120].includes(c.speed) || !record(f)) return false;
  if (![s.elapsedSec, s.shiftDurationSec, s.shiftPlan, s.good, s.rejected, s.released, s.eventSequence, s.nextArrivalSec, s.arrivalIntervalSec].every(count)
      || Number(s.shiftDurationSec) === 0 || Number(s.shiftPlan) === 0 || Number(s.arrivalIntervalSec) === 0
      || Number(s.elapsedSec) > Number(s.shiftDurationSec)) return false;
  if (!Array.isArray(s.stations) || s.stations.length !== 5 || !s.stations.every((p, i) => record(p)
      && p.id === `P0${i + 1}` && text(p.name) && text(p.operation) && count(p.nominalCycleSec) && p.nominalCycleSec > 0
      && ['normal', 'slow', 'stop'].includes(String(p.mode))
      && (p.remainingWorkSec === null || numeric(p.remainingWorkSec) && p.remainingWorkSec >= 0 && p.remainingWorkSec <= p.nominalCycleSec)
      && [p.completed, p.busySec, p.downtimeSec].every(count))) return false;
  if (!Array.isArray(s.buffers) || s.buffers.length !== 4 || !s.buffers.every((b, i) => record(b)
      && b.id === `B0${i + 1}` && b.from === `P0${i + 1}` && b.to === `P0${i + 2}`
      && count(b.count) && count(b.capacity) && b.capacity > 0 && b.count <= b.capacity)) return false;
  if (!Array.isArray(s.incidents) || !s.incidents.every(e => record(e) && text(e.id) && text(e.title) && text(e.detail)
      && (e.stationId === null || text(e.stationId)) && ['info', 'warning', 'critical'].includes(String(e.severity))
      && count(e.startedAtSec) && (e.resolvedAtSec === null || count(e.resolvedAtSec)) && typeof e.acknowledged === 'boolean')) return false;
  if (!Array.isArray(s.history) || !s.history.every(h => record(h) && [h.elapsedSec, h.good, h.rejected].every(count))) return false;
  return count(f.goodAtShiftEnd) && numeric(f.planDelta) && count(f.calculatedAtSec)
    && text(f.explanation) && text(f.assumption)
    && (f.bottleneckId === null || text(f.bottleneckId)) && (f.fillBufferId === null || text(f.fillBufferId))
    && (f.minutesToFill === null || numeric(f.minutesToFill) && f.minutesToFill >= 0);
}
function validSnapshot(value: unknown): value is TwinSnapshot {
  return validStoredSnapshot(value) && record(value) && timestamp(value.receivedAt)
    && (value.capabilities === undefined || Array.isArray(value.capabilities) && value.capabilities.every(text));
}
function validComparison(value: unknown): value is ScenarioComparison {
  if (!record(value) || value.schemaVersion !== 1 || !text(value.runId) || !timestamp(value.calculatedAt)
      || !['simulation', 'historical', 'live'].includes(String(value.source))
      || ![value.baseRevision, value.baseElapsedSec, value.shiftDurationSec, value.plan, value.nominalCycleSec,
        value.delayMinutes, value.initialGood, value.initialRejected].every(count)
      || Number(value.plan) === 0 || Number(value.nominalCycleSec) === 0 || Number(value.shiftDurationSec) === 0
      || Number(value.baseElapsedSec) > Number(value.shiftDurationSec) || Number(value.delayMinutes) > 240
      || !text(value.stationId) || !/^P0[1-5]$/.test(value.stationId) || !text(value.stationName)
      || !['normal', 'slow', 'stop'].includes(String(value.stationMode))) return false;
  if (!Array.isArray(value.stationModes) || value.stationModes.length !== 5 || !value.stationModes.every((s, i) =>
    record(s) && s.id === `P0${i + 1}` && ['normal', 'slow', 'stop'].includes(String(s.mode)))) return false;
  const ids = ['baseline', 'restore_now', 'restore_later'];
  if (!Array.isArray(value.results) || value.results.length !== 3 || !value.results.every((r, index) => {
    if (!record(r) || r.id !== ids[index] || !text(r.title) || ![r.good, r.rejected, r.additionalDowntimeSec].every(count)
        || ![r.planDelta, r.planFulfillmentPct, r.gainVsBaseline].every(numeric)
        || typeof r.recoveryWithinShift !== 'boolean'
        || !(r.recoveryAtSec === null || count(r.recoveryAtSec) && r.recoveryAtSec >= Number(value.baseElapsedSec) && r.recoveryAtSec < Number(value.shiftDurationSec))
        || r.recoveryWithinShift !== (r.recoveryAtSec !== null)
        || r.planDelta !== Number(r.good) - Number(value.plan)
        || !Array.isArray(r.series) || r.series.length === 0) return false;
    const points = r.series;
    if (!points.every((p, i) => record(p) && [p.elapsedSec, p.good, p.rejected].every(count)
        && Number(p.elapsedSec) >= Number(value.baseElapsedSec) && Number(p.elapsedSec) <= Number(value.shiftDurationSec)
        && (i === 0 || Number(p.elapsedSec) > points[i - 1].elapsedSec && Number(p.good) >= points[i - 1].good && Number(p.rejected) >= points[i - 1].rejected))) return false;
    const first = points[0], last = points[points.length - 1];
    return first.elapsedSec === value.baseElapsedSec && first.good === value.initialGood && first.rejected === value.initialRejected
      && last.elapsedSec === value.shiftDurationSec && last.good === r.good && last.rejected === r.rejected;
  })) return false;
  const results = value.results;
  if (!results.every(r => r.gainVsBaseline === r.good - results[0].good)) return false;
  const summary = value.summary;
  const best = Math.max(...results.map(r => r.good));
  return record(summary) && summary.maxGain === best - results[0].good
    && summary.delayLoss === results[1].good - results[2].good
    && Array.isArray(summary.bestScenarioIds)
    && JSON.stringify(summary.bestScenarioIds) === JSON.stringify(results.filter(r => r.good === best).map(r => r.id))
    && Array.isArray(value.assumptions) && value.assumptions.length > 0 && value.assumptions.every(text);
}

export class HttpDataSource implements TwinDataSource {
  private baseUrl: string;
  constructor(baseUrl = '') { this.baseUrl = baseUrl; }
  async getSnapshot(): Promise<TwinSnapshot> { return this.request('/api/v1/twin'); }
  async compare(request: ComparisonRequest): Promise<ScenarioComparison> {
    const result = await this.fetchJson('/api/v1/analysis/compare', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    });
    if (!validComparison(result)) throw new Error('Сервер вернул несовместимые данные расчёта. Обновите приложение.');
    if (result.runId !== request.runId || result.stationId !== request.stationId || result.delayMinutes !== request.delayMinutes)
      throw new Error('Параметры ответа не совпадают с запросом. Повторите расчёт.');
    return result;
  }
  async dispatch(command: TwinCommand, runId: string): Promise<TwinSnapshot> {
    const body = JSON.stringify({ ...command, runId, commandId: crypto.randomUUID() });
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await this.request('/api/v1/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        if (command.type === 'configure_line' && (result.runId === runId
          || !configurationsEqual(configurationFromState(result.state), command.configuration))) {
          throw new Error('Сервер не подтвердил параметры нового сценария. Обновите состояние.');
        }
        return result;
      }
      catch (e) { if (attempt >= 1 || e instanceof ApiError && e.status < 500) throw e; }
    }
  }
  private async request(path: string, init?: RequestInit): Promise<TwinSnapshot> {
    const snapshot = await this.fetchJson(path, init);
    if (!validSnapshot(snapshot)) throw new Error('Сервер вернул несовместимые данные. Обновите приложение.');
    return snapshot;
  }
  private async fetchJson(path: string, init?: RequestInit): Promise<unknown> {
    let response: Response;
    try { response = await fetch(this.baseUrl + path, { ...init, cache: 'no-store', signal: AbortSignal.timeout(5000) }); }
    catch { throw new Error('Нет связи с сервером. Проверьте, что start.cmd запущен.'); }
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new ApiError(typeof body?.detail === 'string' ? body.detail : `Команда не выполнена (${response.status})`, response.status);
    }
    return response.json();
  }
}
