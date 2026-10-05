import { validStoredSnapshot } from './data-source.ts';
import type { StoredTwinSnapshot } from './types.ts';

export interface RunEntry { runId: string; createdAt: string; updatedAt: string; good: number }
export interface RunCatalog { currentRunId: string; runs: RunEntry[] }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const date = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export class ArchiveSource {
  private async read(path: string): Promise<unknown> {
    let response: Response;
    try { response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(10000) }); }
    catch { throw new Error('Не удалось загрузить архив. Проверьте подключение и повторите запрос.'); }
    if (response.status === 404) throw new Error('Сохранённый сценарий не найден. Обновите список архива.');
    if (!response.ok) throw new Error(`Архив временно недоступен (${response.status}). Повторите запрос.`);
    return response.json().catch(() => { throw new Error('Сервер вернул нечитаемые данные архива.'); });
  }
  async list(): Promise<RunCatalog> {
    const value = await this.read('/api/v1/runs');
    if (!object(value) || !uuid(value.currentRunId) || !Array.isArray(value.runs) || value.runs.length > 50
      || !value.runs.every((r): r is RunEntry => object(r) && uuid(r.runId) && date(r.createdAt) && date(r.updatedAt)
        && Date.parse(r.updatedAt) >= Date.parse(r.createdAt) && count(r.good))
      || new Set(value.runs.map(r => r.runId)).size !== value.runs.length) {
      throw new Error('Сервер вернул несовместимый список сценариев.');
    }
    return { currentRunId: value.currentRunId, runs: value.runs };
  }
  async load(id: string): Promise<StoredTwinSnapshot> {
    if (!uuid(id)) throw new Error('Некорректный идентификатор сценария.');
    const value = await this.read(`/api/v1/runs/${encodeURIComponent(id)}`);
    if (!validStoredSnapshot(value) || value.runId !== id || !validArchiveHistory(value)) {
      throw new Error('Сервер вернул несовместимый снимок сценария.');
    }
    return value;
  }
}

// Archive charts must never join future points or decreasing cumulative totals.
function validArchiveHistory(snapshot: StoredTwinSnapshot): boolean {
  const s = snapshot.state;
  return s.source === snapshot.source && s.history.every((p, i, rows) => p.elapsedSec <= s.elapsedSec
    && p.good <= s.good && p.rejected <= s.rejected
    && (i === 0 || p.elapsedSec > rows[i - 1].elapsedSec && p.good >= rows[i - 1].good && p.rejected >= rows[i - 1].rejected))
    && s.stations.every(p => p.busySec + p.downtimeSec <= s.elapsedSec)
    && s.incidents.every(e => e.startedAtSec <= s.elapsedSec
      && (e.resolvedAtSec === null || e.resolvedAtSec >= e.startedAtSec && e.resolvedAtSec <= s.elapsedSec))
    && snapshot.forecast.calculatedAtSec <= s.elapsedSec;
}

export function summarizeRun(snapshot: StoredTwinSnapshot) {
  const s = snapshot.state;
  const total = s.good + s.rejected;
  const incidents = s.incidents.filter(e => e.severity !== 'info');
  const worst = [...s.stations].sort((a, b) => b.downtimeSec - a.downtimeSec)[0];
  return {
    ended: s.elapsedSec === s.shiftDurationSec,
    planPct: s.good / s.shiftPlan * 100,
    planDelta: s.good - s.shiftPlan,
    rejectPct: total ? s.rejected / total * 100 : null,
    downtimeSec: s.stations.reduce((sum, p) => sum + p.downtimeSec, 0),
    incidentCount: incidents.length,
    unresolvedCount: incidents.filter(e => e.resolvedAtSec === null).length,
    worstStation: worst?.downtimeSec ? worst : null,
    wip: s.buffers.reduce((sum, b) => sum + b.count, 0) + s.stations.filter(p => p.remainingWorkSec !== null).length,
  };
}

export function archiveSeries(snapshot: StoredTwinSnapshot) {
  const s = snapshot.state;
  return [...s.history.filter(p => p.elapsedSec < s.elapsedSec), { elapsedSec: s.elapsedSec, good: s.good, rejected: s.rejected }];
}
