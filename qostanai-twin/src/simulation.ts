import type { Forecast, LineConfiguration, Station, StationMode, StationStatus, TwinCommand, TwinState } from './types.ts';
import { configurationFromState, defaultConfiguration } from './configuration.ts';

export const STATUS_LABEL: Record<StationStatus, string> = {
  running: 'В работе', slowed: 'Замедление', stopped: 'Остановлен', blocked: 'Буфер заполнен', starved: 'Ожидание изделия',
};
export function stationStatus(s: Station): StationStatus {
  if (s.mode === 'stop') return 'stopped';
  if (s.remainingWorkSec === null) return 'starved';
  if (s.remainingWorkSec === 0) return 'blocked';
  return s.mode === 'slow' ? 'slowed' : 'running';
}
export function cycleSec(s: Station): number { return s.nominalCycleSec * (s.mode === 'slow' ? 2 : 1); }
export function progressPercent(s: Station): number {
  return s.remainingWorkSec === null ? 0 : 100 * (1 - s.remainingWorkSec / s.nominalCycleSec);
}
export function modelTime(seconds: number, withSeconds = false): string {
  const total = 8 * 3600 + Math.floor(seconds);
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor(total / 60) % 60).padStart(2, '0');
  return `${h}:${m}${withSeconds ? ':' + String(total % 60).padStart(2, '0') : ''}`;
}

function freshState(config: LineConfiguration): TwinState {
  const specs: [string, string, number][] = [
    ['Подача', 'Подача комплектующих', 48],
    ['Сборка', 'Основная сборочная операция', 52],
    ['Установка', 'Установка узла', 58],
    ['Проверка', 'Проверка комплектности', 50],
    ['Выход', 'Приёмка готового изделия', 55],
  ];
  return {
    schemaVersion: 1, source: 'simulation', elapsedSec: 0,
    shiftDurationSec: 8 * 3600, shiftPlan: config.shiftPlan, arrivalIntervalSec: config.arrivalIntervalSec, nextArrivalSec: 0,
    released: 0, good: 0, rejected: 0, eventSequence: 1,
    stations: specs.map(([name, operation, nominalCycleSec], i) => ({
      id: `P0${i + 1}`, name, operation, nominalCycleSec: config.stationCyclesSec[i],
      mode: 'normal', remainingWorkSec: null, completed: 0, busySec: 0, downtimeSec: 0,
    })),
    buffers: [1, 2, 3, 4].map(n => ({ id: `B0${n}`, from: `P0${n}`, to: `P0${n + 1}`, count: 0, capacity: config.bufferCapacities[n-1] })),
    incidents: [{ id: 'event-1', stationId: null, title: 'Смена запущена', detail: `Демонстрационная линия · подача каждые ${config.arrivalIntervalSec} секунд`, severity: 'info', startedAtSec: 0, resolvedAtSec: 0, acknowledged: false }],
    history: [{ elapsedSec: 0, good: 0, rejected: 0 }],
  };
}

/** Finite-buffer serial line. Move finished jobs downstream, then load free stations.
 * A stopped station holds its job. Output quality is deterministic: every 25th is rejected.
 * No random display values; conservation: released = WIP + good + rejected.
 */
function runMutable(state: TwinState, seconds: number, recordHistory: boolean): void {
  const count = Math.min(Math.max(0, Math.floor(seconds)), state.shiftDurationSec - state.elapsedSec);
  for (let tick = 0; tick < count; tick++) {
    state.elapsedSec++;
    for (const s of state.stations) {
      if (s.mode === 'stop') { s.downtimeSec++; continue; }
      if (s.remainingWorkSec !== null && s.remainingWorkSec > 0) {
        s.busySec++;
        s.remainingWorkSec = Math.max(0, s.remainingWorkSec - (s.mode === 'slow' ? 0.5 : 1));
      }
    }
    for (let i = state.stations.length - 1; i >= 0; i--) {
      const s = state.stations[i];
      if (s.mode === 'stop' || s.remainingWorkSec !== 0) continue;
      if (i === state.stations.length - 1) {
        s.completed++;
        if (s.completed % 25 === 0) state.rejected++; else state.good++;
        s.remainingWorkSec = null;
      } else if (state.buffers[i].count < state.buffers[i].capacity) {
        state.buffers[i].count++;
        s.completed++;
        s.remainingWorkSec = null;
      }
    }
    for (let i = state.stations.length - 1; i >= 0; i--) {
      const s = state.stations[i];
      if (s.mode === 'stop' || s.remainingWorkSec !== null) continue;
      if (i === 0 && state.elapsedSec >= state.nextArrivalSec) {
        s.remainingWorkSec = s.nominalCycleSec;
        state.released++;
        state.nextArrivalSec = state.elapsedSec + state.arrivalIntervalSec;
      } else if (i > 0 && state.buffers[i - 1].count > 0) {
        state.buffers[i - 1].count--;
        s.remainingWorkSec = s.nominalCycleSec;
      }
    }
    if (recordHistory && (state.elapsedSec % 120 === 0 || state.elapsedSec === state.shiftDurationSec)) {
      state.history.push({ elapsedSec: state.elapsedSec, good: state.good, rejected: state.rejected });
    }
  }
}
export function createInitialState(configuration: LineConfiguration = defaultConfiguration()): TwinState {
  const state = freshState(configuration);
  runMutable(state, 45 * 60, true);
  return state;
}
export function advance(state: TwinState, seconds: number): TwinState {
  const next = structuredClone(state);
  runMutable(next, seconds, true);
  return next;
}
export function setStationMode(state: TwinState, stationId: string, mode: StationMode): TwinState {
  const next = structuredClone(state);
  const s = next.stations.find(s => s.id === stationId);
  if (!s || s.mode === mode || state.elapsedSec >= state.shiftDurationSec) return state;
  for (const incident of next.incidents) {
    if (incident.stationId === s.id && incident.resolvedAtSec === null) incident.resolvedAtSec = next.elapsedSec;
  }
  s.mode = mode;
  next.incidents.unshift({
    id: `event-${++next.eventSequence}`, stationId,
    title: mode === 'stop' ? 'Пост остановлен' : mode === 'slow' ? 'Время цикла увеличено' : 'Нормальный режим восстановлен',
    detail: mode === 'slow' ? `${s.id} · цикл ${s.nominalCycleSec} → ${cycleSec(s)} с` : `${s.id} · ${s.operation}`,
    severity: mode === 'stop' ? 'critical' : mode === 'slow' ? 'warning' : 'info',
    startedAtSec: next.elapsedSec, resolvedAtSec: mode === 'normal' ? next.elapsedSec : null, acknowledged: false,
  });
  return next;
}
export function applyCommand(state: TwinState, command: TwinCommand): TwinState {
  switch (command.type) {
    case 'set_playback': return state; // Playback is owned by the Python service.
    case 'reset': return createInitialState(configurationFromState(state));
    case 'configure_line': return createInitialState(command.configuration);
    case 'advance': return advance(state, command.seconds);
    case 'set_station_mode': return setStationMode(state, command.stationId, command.mode);
    case 'acknowledge_incident': {
      const next = structuredClone(state);
      const incident = next.incidents.find(i => i.id === command.incidentId);
      if (incident) incident.acknowledged = true;
      return next;
    }
  }
}
export function forecast(state: TwinState): Forecast {
  const projected = structuredClone(state);
  runMutable(projected, state.shiftDurationSec - state.elapsedSec, false);
  let bottleneckId: string | null = null;
  let fillBufferId: string | null = null;
  let minutesToFill: number | null = null;
  let explanation = `При текущем режиме линия обеспечивает план. Ограничение потока — интервал подачи ${state.arrivalIntervalSec} с.`;
  const constrained = state.stations.find(s => s.mode === 'stop') ?? [...state.stations].filter(s => cycleSec(s) > state.arrivalIntervalSec).sort((a, b) => cycleSec(b) - cycleSec(a))[0];
  if (constrained) {
    bottleneckId = constrained.id;
    const index = state.stations.indexOf(constrained);
    if (index > 0) {
      const buffer = state.buffers[index - 1];
      const upstream = state.stations.slice(0, index);
      const inflow = upstream.some(s => s.mode === 'stop') ? 0 : 60 / Math.max(state.arrivalIntervalSec, ...upstream.map(cycleSec));
      const outflow = constrained.mode === 'stop' ? 0 : 60 / cycleSec(constrained);
      if (inflow > outflow) {
        fillBufferId = buffer.id;
        minutesToFill = (buffer.capacity - buffer.count) / (inflow - outflow);
      }
    }
    explanation = constrained.mode === 'stop'
      ? `${constrained.id} остановлен. Изделия перед ним накапливаются; следующие посты исчерпывают запас.`
      : `${constrained.id}: цикл ${cycleSec(constrained)} с при подаче каждые ${state.arrivalIntervalSec} с. Перед постом растёт очередь.`;
  } else if (projected.good < state.shiftPlan) {
    explanation = 'При текущих параметрах и режиме прогноз ниже плана. Проверьте план, интервал подачи и накопленные потери.';
  }
  return {
    goodAtShiftEnd: projected.good, planDelta: projected.good - state.shiftPlan,
    bottleneckId, fillBufferId, minutesToFill, explanation, calculatedAtSec: state.elapsedSec,
    assumption: 'Расчёт модели при сохранении текущих режимов до 16:00. Время заполнения буфера — оценка по средним скоростям.',
  };
}
