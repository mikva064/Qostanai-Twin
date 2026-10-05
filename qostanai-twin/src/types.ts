/** Contract v1. Times are simulation seconds; counts are individual units. */
export type StationStatus = 'running' | 'slowed' | 'stopped' | 'blocked' | 'starved';
export type StationMode = 'normal' | 'slow' | 'stop';
export interface Station {
  id: string;
  name: string;
  operation: string;
  nominalCycleSec: number;
  mode: StationMode;
  remainingWorkSec: number | null;
  completed: number;
  busySec: number;
  downtimeSec: number;
}
export interface BufferState { id: string; from: string; to: string; capacity: number; count: number }
export interface Incident {
  id: string;
  stationId: string | null;
  title: string;
  detail: string;
  severity: 'info' | 'warning' | 'critical';
  startedAtSec: number;
  resolvedAtSec: number | null;
  acknowledged: boolean;
}
export interface HistoryPoint { elapsedSec: number; good: number; rejected: number }
export interface TwinState {
  schemaVersion: 1;
  source: 'simulation' | 'historical' | 'live';
  elapsedSec: number;
  shiftDurationSec: number;
  shiftPlan: number;
  nextArrivalSec: number;
  arrivalIntervalSec: number;
  released: number;
  good: number;
  rejected: number;
  stations: Station[];
  buffers: BufferState[];
  incidents: Incident[];
  history: HistoryPoint[];
  eventSequence: number;
}
export interface Forecast {
  goodAtShiftEnd: number;
  planDelta: number;
  bottleneckId: string | null;
  fillBufferId: string | null;
  minutesToFill: number | null;
  explanation: string;
  calculatedAtSec: number;
  assumption: string;
}
export interface StoredTwinSnapshot {
  schemaVersion: 2;
  source: 'simulation' | 'historical' | 'live';
  runId: string;
  revision: number;
  savedAt: string;
  controls: { paused: boolean; speed: 20 | 60 | 120 };
  state: TwinState;
  forecast: Forecast;
}
export interface LineConfiguration {
  shiftPlan: number;
  arrivalIntervalSec: number;
  stationCyclesSec: number[];
  bufferCapacities: number[];
}
export interface TwinSnapshot extends StoredTwinSnapshot { receivedAt: string; capabilities?: string[] }
export type TwinCommand =
  | { type: 'set_station_mode'; stationId: string; mode: StationMode }
  | { type: 'acknowledge_incident'; incidentId: string }
  | { type: 'advance'; seconds: number }
  | { type: 'set_playback'; paused?: boolean; speed?: 20 | 60 | 120 }
  | { type: 'reset' }
  | { type: 'configure_line'; configuration: LineConfiguration };

export interface ComparisonRequest { runId: string; stationId: string; delayMinutes: number }
export type ScenarioId = 'baseline' | 'restore_now' | 'restore_later';
export interface ScenarioResult {
  id: ScenarioId;
  title: string;
  recoveryAtSec: number | null;
  recoveryWithinShift: boolean;
  good: number;
  rejected: number;
  planDelta: number;
  planFulfillmentPct: number;
  gainVsBaseline: number;
  additionalDowntimeSec: number;
  series: HistoryPoint[];
}
export interface ScenarioComparison {
  schemaVersion: 1;
  source: TwinState['source'];
  runId: string;
  baseRevision: number;
  calculatedAt: string;
  baseElapsedSec: number;
  shiftDurationSec: number;
  plan: number;
  stationId: string;
  stationName: string;
  stationMode: StationMode;
  nominalCycleSec: number;
  delayMinutes: number;
  initialGood: number;
  initialRejected: number;
  stationModes: { id: string; mode: StationMode }[];
  results: ScenarioResult[];
  summary: { bestScenarioIds: ScenarioId[]; maxGain: number; delayLoss: number };
  assumptions: string[];
}
