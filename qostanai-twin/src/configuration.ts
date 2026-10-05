import type { LineConfiguration, TwinState } from './types.ts';

export interface ConfigurationDraft { shiftPlan: string; arrivalIntervalSec: string; stationCyclesSec: string[]; bufferCapacities: string[] }
export function defaultConfiguration(): LineConfiguration {
  return { shiftPlan: 410, arrivalIntervalSec: 65, stationCyclesSec: [48, 52, 58, 50, 55], bufferCapacities: [6, 6, 6, 6] };
}
export function configurationFromState(state: TwinState): LineConfiguration {
  return { shiftPlan: state.shiftPlan, arrivalIntervalSec: state.arrivalIntervalSec,
    stationCyclesSec: state.stations.map(s => s.nominalCycleSec), bufferCapacities: state.buffers.map(b => b.capacity) };
}
export function configurationDraft(value: LineConfiguration): ConfigurationDraft {
  return { shiftPlan: String(value.shiftPlan), arrivalIntervalSec: String(value.arrivalIntervalSec),
    stationCyclesSec: value.stationCyclesSec.map(String), bufferCapacities: value.bufferCapacities.map(String) };
}
export function configurationsEqual(a: LineConfiguration, b: LineConfiguration): boolean {
  return a.shiftPlan === b.shiftPlan && a.arrivalIntervalSec === b.arrivalIntervalSec
    && a.stationCyclesSec.length === b.stationCyclesSec.length && a.stationCyclesSec.every((n, i) => n === b.stationCyclesSec[i])
    && a.bufferCapacities.length === b.bufferCapacities.length && a.bufferCapacities.every((n, i) => n === b.bufferCapacities[i]);
}
export function validConfiguration(value: unknown): value is LineConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const integer = (n: unknown, min: number, max: number) => typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
  return integer(v.shiftPlan, 1, 100000) && integer(v.arrivalIntervalSec, 5, 3600)
    && Array.isArray(v.stationCyclesSec) && v.stationCyclesSec.length === 5 && v.stationCyclesSec.every(n => integer(n, 5, 3600))
    && Array.isArray(v.bufferCapacities) && v.bufferCapacities.length === 4 && v.bufferCapacities.every(n => integer(n, 1, 100));
}
export function validateConfiguration(draft: ConfigurationDraft): { value: LineConfiguration | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const parse = (text: string, key: string, min: number, max: number) => {
    const value = Number(text);
    if (!/^\d+$/.test(text.trim()) || !Number.isSafeInteger(value) || value < min || value > max) {
      errors[key] = `Целое число от ${min} до ${max}`;
    }
    return value;
  };
  if (draft.stationCyclesSec.length !== 5 || draft.bufferCapacities.length !== 4) errors.structure = 'Нужны 5 постов и 4 буфера';
  const value = {
    shiftPlan: parse(draft.shiftPlan, 'shiftPlan', 1, 100000),
    arrivalIntervalSec: parse(draft.arrivalIntervalSec, 'arrivalIntervalSec', 5, 3600),
    stationCyclesSec: draft.stationCyclesSec.map((v, i) => parse(v, `P0${i+1}`, 5, 3600)),
    bufferCapacities: draft.bufferCapacities.map((v, i) => parse(v, `B0${i+1}`, 1, 100)),
  };
  return { value: Object.keys(errors).length ? null : value, errors };
}
