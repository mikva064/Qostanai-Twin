export const SECTION_LABELS = { welding: 'Сварка', painting: 'Окраска', assembly: 'Сборка' } as const;
export type CaseSection = keyof typeof SECTION_LABELS;
export const CASE_SECTIONS = Object.keys(SECTION_LABELS) as CaseSection[];
export interface ProductionRow { date: string; section: CaseSection; line: string; plan: number; actual: number; operatingHours: number; utilizationPct: number }
export interface QualityRow { date: string; section: CaseSection; produced: number; rejected: number; reportedDefectPct: number }
export interface DowntimeRow { date: string; section: CaseSection; equipment: string; reason: string; minutes: number; critical: boolean | null }
export interface CaseDataset {
  schemaVersion: 1;
  provenance: { kind: 'provided-test-data'; fileName: string; sha256: string; title: string; productionPeriod: 'unspecified'; monthlyPlanPeriod: 'unspecified' };
  production: ProductionRow[]; quality: QualityRow[]; downtime: DowntimeRow[];
  monthlyPlans: { model: string; plan: number }[]; topology: string[];
  rules: { schedule: { shiftsPerDay: number; hoursPerShift: number }; oeeTargetPct: number; maxDefectPct: number; criticalDowntimeMinutesPerDay: number; monthlyTarget: number };
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const numeric = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const integer = (v: unknown, min = 0) => numeric(v, min) && Number.isSafeInteger(v);
const dateValid = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const sectionValid = (v: unknown) => typeof v === 'string' && CASE_SECTIONS.includes(v as CaseSection);
const unique = (values: string[]) => new Set(values).size === values.length;
export const caseRate = (rejected: number, produced: number): number | null => produced ? rejected / produced * 100 : null;

/** Validate source consistency before presenting analytical claims. Never fills missing observations. */
export function parseCaseDataset(value: unknown): CaseDataset {
  const fail = (): never => { throw new Error('Данные кейса повреждены или несовместимы. Проверьте исходные таблицы.'); };
  if (!object(value) || value.schemaVersion !== 1 || !object(value.provenance) || !object(value.rules)) return fail();
  const p = value.provenance, r = value.rules;
  if (p.kind !== 'provided-test-data' || !text(p.fileName) || !text(p.title) || typeof p.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.sha256) || p.productionPeriod !== 'unspecified' || p.monthlyPlanPeriod !== 'unspecified') return fail();
  if (!object(r.schedule) || !integer(r.schedule.shiftsPerDay, 1) || !numeric(r.schedule.hoursPerShift, 0.1, 24) || Number(r.schedule.shiftsPerDay) * r.schedule.hoursPerShift > 24 || !numeric(r.oeeTargetPct, 0, 100) || !numeric(r.maxDefectPct, 0, 100) || !integer(r.criticalDowntimeMinutesPerDay, 1) || !integer(r.monthlyTarget, 1)) return fail();
  for (const key of ['production', 'quality', 'downtime', 'monthlyPlans', 'topology']) if (!Array.isArray(value[key])) return fail();
  const production = value.production as unknown[], quality = value.quality as unknown[], downtime = value.downtime as unknown[], plans = value.monthlyPlans as unknown[], topology = value.topology as unknown[];
  if (!production.length || !plans.length || !topology.length || !topology.every(text)) return fail();
  for (const row of production) if (!object(row) || !dateValid(row.date) || !sectionValid(row.section) || !text(row.line) || !integer(row.plan, 1) || !integer(row.actual) || !numeric(row.operatingHours, 0, 24) || !numeric(row.utilizationPct, 0, 100)) return fail();
  for (const row of quality) if (!object(row) || !dateValid(row.date) || !sectionValid(row.section) || !integer(row.produced) || !integer(row.rejected) || Number(row.rejected) > Number(row.produced) || !numeric(row.reportedDefectPct, 0, 100) || Math.abs((caseRate(Number(row.rejected), Number(row.produced)) ?? 0) - row.reportedDefectPct) > 0.050001) return fail();
  for (const row of downtime) if (!object(row) || !dateValid(row.date) || !sectionValid(row.section) || !text(row.equipment) || !text(row.reason) || !integer(row.minutes, 1) || Number(row.minutes) > 1440 || !(row.critical === null || typeof row.critical === 'boolean')) return fail();
  for (const row of plans) if (!object(row) || !text(row.model) || !integer(row.plan, 1)) return fail();
  const d = value as unknown as CaseDataset;
  const key = (row: { date: string; section: CaseSection }) => row.date + '/' + row.section;
  if (!unique(d.production.map(key)) || !unique(d.quality.map(key)) || !unique(d.monthlyPlans.map(row => row.model))) return fail();
  // Every quality row must refer to the same observed output. Missing quality remains unknown.
  for (const row of d.quality) if (d.production.find(item => key(item) === key(row))?.actual !== row.produced) return fail();
  return d;
}

export const caseDates = (data: CaseDataset) => [...new Set(data.production.map(row => row.date))].sort();
export const caseDateLabel = (date: string) => date.split('-').reverse().join('.');
const number = (n: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n);
export interface CaseInsight { id: string; severity: 'alert' | 'attention' | 'info'; title: string; evidence: string; action: string; source: string }

export function analyzeCase(data: CaseDataset, date: string) {
  const dates = caseDates(data);
  if (!dates.includes(date)) throw new Error('На эту дату нет данных.');
  const previousDate = dates.filter(day => day < date).at(-1) ?? null;
  const rows = data.production.filter(row => row.date === date).map(row => {
    const quality = data.quality.find(q => q.date === date && q.section === row.section) ?? null;
    const previous = previousDate ? data.production.find(p => p.date === previousDate && p.section === row.section) ?? null : null;
    const previousQuality = previousDate ? data.quality.find(q => q.date === previousDate && q.section === row.section) ?? null : null;
    const defectPct = quality ? caseRate(quality.rejected, quality.produced) : null;
    const previousPct = previousQuality ? caseRate(previousQuality.rejected, previousQuality.produced) : null;
    return { ...row, quality, previous, defectPct, planPct: row.actual / row.plan * 100,
      planGap: Math.max(0, row.plan - row.actual), defectDeltaPp: defectPct !== null && previousPct !== null ? defectPct - previousPct : null };
  });
  const qualityBreaches = rows.filter(row => row.defectPct !== null && row.defectPct > data.rules.maxDefectPct).sort((a, b) => b.defectPct! - a.defectPct!);
  const insights: CaseInsight[] = qualityBreaches.map(row => ({
    id: 'quality-' + row.section, severity: 'alert', title: `${SECTION_LABELS[row.section]}: брак выше ${number(data.rules.maxDefectPct)}%`,
    evidence: `${row.quality!.rejected} / ${row.quality!.produced} × 100 = ${number(row.defectPct!)}%. Превышение: ${number(row.defectPct! - data.rules.maxDefectPct)} п.п.${row.defectDeltaPp !== null ? ` Изменение к ${caseDateLabel(previousDate!)}: ${row.defectDeltaPp > 0 ? '+' : ''}${number(row.defectDeltaPp)} п.п.` : ''}`,
    action: 'Проверить виды дефектов и результаты контроля по партиям. Причина брака в документе не указана.',
    source: `Таблица «Показатели качества» · ${caseDateLabel(date)} · ${SECTION_LABELS[row.section]}`,
  }));
  for (const row of [...rows].sort((a, b) => b.planGap - a.planGap)) if (row.planGap > 0) insights.push({
    id: 'plan-' + row.section, severity: 'attention', title: `${SECTION_LABELS[row.section]}: до плана ${row.planGap}`,
    evidence: `Факт ${row.actual}, план ${row.plan}; выполнение ${number(row.planPct)}%.`,
    action: 'Уточнить период плана и последовательность событий. Итоги по датам не доказывают, какой участок ограничивал общий поток.',
    source: `Таблица «Работа производственных линий» · ${caseDateLabel(date)} · ${row.line}`,
  });
  const downtime = data.downtime.filter(row => row.date === date);
  // Daily totals are grouped by equipment; overlapping intervals cannot be checked without timestamps.
  const equipment = [...new Set(downtime.map(row => row.equipment))].map(name => {
    const events = downtime.filter(row => row.equipment === name);
    return { name, minutes: events.reduce((sum, row) => sum + row.minutes, 0), events, critical: events.every(row => row.critical === true) ? true : events.every(row => row.critical === false) ? false : null };
  });
  for (const item of equipment) if (item.critical !== false && item.minutes >= data.rules.criticalDowntimeMinutesPerDay * 0.9) insights.push({
    id: 'downtime-' + item.name, severity: 'attention', title: `${item.name}: ${item.minutes} мин в журнале`,
    evidence: item.critical === null ? `Критичность не указана. Если оборудование критическое, лимит — ${data.rules.criticalDowntimeMinutesPerDay} мин/сутки; до него ${Math.max(0, data.rules.criticalDowntimeMinutesPerDay - item.minutes)} мин.` : `Лимит критического оборудования — ${data.rules.criticalDowntimeMinutesPerDay} мин/сутки.`,
    action: 'Уточнить критичность и интервалы событий. Порог внимания помощника — 90% лимита; это правило интерфейса, не прогноз отказа.',
    source: `Таблица «Статистика простоев оборудования» · ${caseDateLabel(date)}`,
  });
  const monthlyPlan = data.monthlyPlans.reduce((sum, row) => sum + row.plan, 0);
  return { date, previousDate, rows, qualityBreaches, insights, downtime, equipment, monthlyPlan,
    monthlyGap: Math.max(0, data.rules.monthlyTarget - monthlyPlan), assembly: rows.find(row => row.section === 'assembly') ?? null,
    oee: null, forecast: null, trainingStatus: 'insufficient-data' as const };
}

export function caseExport(data: CaseDataset, date: string) {
  return { schemaVersion: 1, method: 'case-rules-v1', source: data, analysis: analyzeCase(data, date),
    limitations: ['Тестовый набор, не поток телеметрии.', 'Выпуск последовательных участков не суммируется в выпуск завода.', 'OEE и прогноз не рассчитаны. Модель ML не обучалась.', 'Период рабочего времени, месяц плана и критичность оборудования не указаны.'] };
}
