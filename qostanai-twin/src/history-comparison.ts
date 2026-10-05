import { configurationForReport, validHistoryReport } from './history-source.ts';
import type { HistoryReport, HistorySource, ImportEntry } from './history-source.ts';

export interface ParameterDifference { key: string; label: string; unit: string; a: number; b: number; delta: number }
export interface ComparisonMetric { key: string; label: string; a: number | null; b: number | null; delta: number | null }
export interface HistoryComparison {
  schemaVersion: 1;
  kind: 'history_report_comparison';
  reports: { a: HistoryReport; b: HistoryReport };
  basis: { rowCount: number; good: number; rejected: number; checkpointCount: number };
  parameters: ParameterDifference[];
  metrics: ComparisonMetric[];
  series: { elapsedSec: number; actual: number; a: number; b: number }[];
  checkpoints: { elapsedSec: number; actual: number; a: number; b: number; delta: number; errorA: number; errorB: number; rate: number }[];
  notices: string[];
}
export class HistoryComparisonError extends Error {}

export function importLabel(entry: ImportEntry): string {
  return `${entry.fileName} · план ${entry.summary.good - entry.summary.planDelta} · ${new Date(entry.createdAt).toLocaleString('ru-RU')} · ${entry.importId.slice(0, 6)}`;
}

export function compareHistoryReports(a: HistoryReport, b: HistoryReport): HistoryComparison {
  if (!validHistoryReport(a) || !validHistoryReport(b)) throw new HistoryComparisonError('Один из отчётов повреждён или использует неподдерживаемый метод. Обновите список и выберите другой отчёт.');
  if (a.importId === b.importId) throw new HistoryComparisonError('Для сравнения выберите два разных сохранённых отчёта.');
  const sameHistory = a.shiftDurationSec === b.shiftDurationSec && a.observations.length === b.observations.length
    && a.observations.every((row, i) => {
      const other = b.observations[i];
      return row.elapsedSec === other.elapsedSec && row.good === other.good && row.rejected === other.rejected
        && row.modes.every((mode, j) => mode === other.modes[j]);
    });
  if (!sameHistory) throw new HistoryComparisonError('История смены различается: время, выпуск, брак или режимы постов не совпадают. Для оценки влияния нормативов импортируйте одну и ту же историю с разными параметрами.');
  const configA = configurationForReport(a), configB = configurationForReport(b);
  const parameter = (key: string, label: string, unit: string, left: number, right: number): ParameterDifference => ({ key, label, unit, a: left, b: right, delta: right - left });
  const parameters = [
    parameter('plan', 'План смены', 'изд.', configA.shiftPlan, configB.shiftPlan),
    parameter('arrival', 'Интервал подачи', 'с', configA.arrivalIntervalSec, configB.arrivalIntervalSec),
    ...configA.stationCyclesSec.map((n, i) => parameter(`P0${i+1}`, `Цикл P0${i+1}`, 'с', n, configB.stationCyclesSec[i])),
    ...configA.bufferCapacities.map((n, i) => parameter(`B0${i+1}`, `Буфер B0${i+1}`, 'мест', n, configB.bufferCapacities[i])),
  ];
  const metric = (key: string, label: string, left: number | null, right: number | null): ComparisonMetric => ({ key, label, a: left, b: right, delta: left === null || right === null ? null : Math.round((right - left) * 100) / 100 });
  const metrics = [
    metric('replayGood', 'Выпуск при воспроизведении', a.summary.replayGood, b.summary.replayGood),
    metric('flowMae', 'Ошибка модели · MAE', a.summary.flowMae, b.summary.flowMae),
    metric('rateMae', 'Ошибка по темпу · MAE', a.summary.rateMae, b.summary.rateMae),
    metric('planDelta', 'Отклонение факта от плана', a.summary.planDelta, b.summary.planDelta),
  ];
  const changes = parameters.filter(p => p.delta !== 0);
  const notices = [...new Set([...a.quality.warnings, ...b.quality.warnings])];
  if (!changes.length) notices.push('План и нормативы совпадают. Здесь сравниваются два сохранённых расчёта с одинаковыми параметрами.');
  else if (changes.every(p => p.key === 'plan')) notices.push('Изменён только план: меняется отклонение от него, а воспроизведение и прогнозы остаются прежними.');
  if (a.schemaVersion === 1 || b.schemaVersion === 1) notices.push('Для прежнего отчёта использованы известные учебные нормативы его метода. Сохранённые результаты не пересчитываются.');
  const flowDelta = metrics[1].delta;
  if (flowDelta === null) notices.push('Пригодных срезов для оценки MAE нет. Отсутствие оценки не означает нулевую ошибку.');
  else if (flowDelta === 0) notices.push('На срезах этой смены средние ошибки модели в A и B совпали.');
  else notices.push(`На срезах этой смены средняя ошибка модели в B ${flowDelta < 0 ? 'меньше' : 'больше'}, чем в A. Меньшая MAE означает более близкий прогноз на этих срезах.`);
  notices.push('Изменение расчётного выпуска не является приростом производства. Подбор параметров по этой смене требует последующей проверки на независимых сменах.');
  return {
    schemaVersion: 1, kind: 'history_report_comparison', reports: { a, b },
    basis: { rowCount: a.observations.length, good: a.summary.good, rejected: a.summary.rejected, checkpointCount: a.checkpoints.length },
    parameters, metrics, notices,
    series: a.observations.map((row, i) => ({ elapsedSec: row.elapsedSec, actual: row.good, a: row.replayGood, b: b.observations[i].replayGood })),
    checkpoints: a.checkpoints.map((point, i) => ({ elapsedSec: point.elapsedSec, actual: point.actualGood, a: point.flowForecast,
      b: b.checkpoints[i].flowForecast, delta: b.checkpoints[i].flowForecast - point.flowForecast,
      errorA: point.flowError, errorB: b.checkpoints[i].flowError, rate: point.rateForecast })),
  };
}

export async function loadHistoryComparison(source: Pick<HistorySource, 'load'>, aId: string, bId: string): Promise<HistoryComparison> {
  if (!aId || !bId || aId === bId) throw new HistoryComparisonError('Для сравнения выберите два разных сохранённых отчёта.');
  const [a, b] = await Promise.all([source.load(aId), source.load(bId)]);
  if (a.importId !== aId || b.importId !== bId) throw new HistoryComparisonError('Получены другие отчёты. Повторите сравнение выбранной пары.');
  return compareHistoryReports(a, b);
}
