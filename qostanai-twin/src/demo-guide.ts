import { configurationFromState, configurationsEqual, defaultConfiguration } from './configuration.ts';
import { advance, createInitialState, forecast, modelTime, setStationMode } from './simulation.ts';
import type { ScenarioComparison, TwinCommand, TwinSnapshot, TwinState } from './types.ts';

export type DemoStage = 'initial' | 'stopped' | 'impact' | 'restored' | 'recovered';
export type DemoAction = 'prepare' | 'stop' | 'advance15' | 'restore' | 'advance5';
const initial = createInitialState();
const stopped = setStationMode(initial, 'P03', 'stop');
const impact = advance(stopped, 900);
const restored = setStationMode(impact, 'P03', 'normal');
const recovered = advance(restored, 300);
const references: Record<DemoStage, TwinState> = { initial, stopped, impact, restored, recovered };
const forecasts = Object.fromEntries(Object.entries(references).map(([stage, state]) => [stage, forecast(state).goodAtShiftEnd])) as Record<DemoStage, number>;

// Production state only: acknowledging an incident does not change the flow.
function flowSignature(s: TwinState): string {
  return JSON.stringify([s.elapsedSec, s.shiftDurationSec, s.shiftPlan, s.arrivalIntervalSec, s.nextArrivalSec, s.released, s.good, s.rejected,
    s.stations.map(p => [p.id, p.nominalCycleSec, p.mode, p.remainingWorkSec, p.completed, p.busySec, p.downtimeSec]),
    s.buffers.map(b => [b.id, b.from, b.to, b.capacity, b.count])]);
}
export interface DemoCheck { label: string; expected: string; actual: string; ok: boolean }
export function demoChecks(snapshot: TwinSnapshot, stage: DemoStage): DemoCheck[] {
  const expected = references[stage], current = snapshot.state;
  return [
    { label: 'Источник', expected: 'Учебная модель', actual: snapshot.source === 'simulation' && current.source === 'simulation' ? 'Учебная модель' : 'Другой источник', ok: snapshot.source === 'simulation' && current.source === 'simulation' },
    { label: 'Время и пауза', expected: `${modelTime(expected.elapsedSec)} · пауза`, actual: `${modelTime(current.elapsedSec, true)} · ${snapshot.controls.paused ? 'пауза' : 'идёт время'}`, ok: snapshot.controls.paused && current.elapsedSec === expected.elapsedSec },
    { label: 'Годный выпуск', expected: String(expected.good), actual: String(current.good), ok: current.good === expected.good },
    { label: 'Прогноз к 16:00', expected: String(forecasts[stage]), actual: String(snapshot.forecast.goodAtShiftEnd), ok: snapshot.forecast.goodAtShiftEnd === forecasts[stage] },
    { label: 'Параметры и поток', expected: 'Контрольный сценарий', actual: flowSignature(current) === flowSignature(expected) ? 'Совпадают' : 'Отличаются', ok: flowSignature(current) === flowSignature(expected) },
  ];
}
export function matchesDemoStage(snapshot: TwinSnapshot, stage: DemoStage): boolean { return demoChecks(snapshot, stage).every(check => check.ok); }
export function matchesDemoComparison(report: ScenarioComparison | null, snapshot: TwinSnapshot): boolean {
  return !!report && matchesDemoStage(snapshot, 'impact') && report.runId === snapshot.runId
    && report.baseRevision === snapshot.revision && report.baseElapsedSec === 3600 && report.stationId === 'P03'
    && report.source === 'simulation' && report.stationMode === 'stop' && report.delayMinutes === 30 && report.plan === 410
    && report.initialGood === 39 && report.initialRejected === snapshot.state.rejected
    && report.stationModes.every((p, i) => p.id === snapshot.state.stations[i]?.id && p.mode === snapshot.state.stations[i]?.mode)
    && report.stationModes.length === 5 && report.results.length === 3
    && report.results.every((r, i) => r.id === ['baseline', 'restore_now', 'restore_later'][i] && r.good === [39, 421, 394][i])
    && report.summary.delayLoss === 27;
}
export const demoActionStages: Record<Exclude<DemoAction, 'prepare'>, { before: DemoStage; after: DemoStage }> = {
  stop: { before: 'initial', after: 'stopped' }, advance15: { before: 'stopped', after: 'impact' },
  restore: { before: 'impact', after: 'restored' }, advance5: { before: 'restored', after: 'recovered' },
};
export function demoCommand(action: DemoAction, snapshot: TwinSnapshot, sessionRunId?: string, report: ScenarioComparison | null = null): TwinCommand {
  if (snapshot.source !== 'simulation' || snapshot.state.source !== 'simulation') throw new Error('Показ управляет только учебной моделью. Другой источник данных не изменяется.');
  if (action === 'prepare') {
    if (configurationsEqual(configurationFromState(snapshot.state), defaultConfiguration())) return { type: 'reset' };
    if (snapshot.capabilities?.includes('configure_line')) return { type: 'configure_line', configuration: defaultConfiguration() };
    throw new Error('Для возврата учебных нормативов запустите обновлённый сервер через start.cmd. Текущая конфигурация отличается от сценария показа.');
  }
  if (snapshot.runId !== sessionRunId) throw new Error('Рабочий сценарий сменился. Начните учебный показ заново.');
  if (!matchesDemoStage(snapshot, demoActionStages[action].before)) throw new Error('Состояние линии отличается от ожидаемого шага. Проверьте время, паузу и параметры; при необходимости начните показ заново.');
  if (action === 'restore' && !matchesDemoComparison(report, snapshot)) throw new Error('Сначала получите актуальное сравнение P03 с ожиданием 30 минут.');
  if (action === 'stop' || action === 'restore') return { type: 'set_station_mode', stationId: 'P03', mode: action === 'stop' ? 'stop' : 'normal' };
  return { type: 'advance', seconds: action === 'advance15' ? 900 : 300 };
}
