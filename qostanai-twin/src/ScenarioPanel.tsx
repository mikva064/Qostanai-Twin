import { useEffect, useRef, useState } from 'react';
import type { TwinDataSource } from './data-source.ts';
import type { ScenarioComparison, TwinSnapshot } from './types.ts';
import { modelTime } from './simulation.ts';

const modeLabels = { normal: 'нормальный режим', slow: 'цикл увеличен вдвое', stop: 'остановлен' };
const colors = ['#a86b19', '#347553', '#507ba2'];
const format = (n: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(n);
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${format(Math.abs(n))}`;

function ScenarioChart({ report }: { report: ScenarioComparison }) {
  const width = 900, height = 210, left = 44, right = 20, top = 20, bottom = 32;
  const max = Math.ceil(Math.max(report.plan, ...report.results.map(r => r.good)) / 50) * 50;
  const duration = report.shiftDurationSec - report.baseElapsedSec;
  const x = (sec: number) => left + (sec - report.baseElapsedSec) / Math.max(1, duration) * (width - left - right);
  const y = (good: number) => height - bottom - good / max * (height - top - bottom);
  return <svg className="scenario-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Прогноз годного выпуска: ${report.results.map(r => `${r.title} — ${r.good}`).join('; ')}. План ${report.plan}.`}>
    {[0, .5, 1].map(n => <g key={n}><line x1={left} x2={width - right} y1={y(max * n)} y2={y(max * n)} stroke="#e8eeeb"/><text x="4" y={y(max * n) + 4}>{max * n}</text></g>)}
    <line x1={left} x2={width - right} y1={y(report.plan)} y2={y(report.plan)} stroke="#8f9d92" strokeDasharray="5 5"/>
    <text x={width - right} y={y(report.plan) - 6} textAnchor="end">План {report.plan}</text>
    {(duration ? [0, .25, .5, .75, 1] : [0]).map(n => <text key={n} x={x(report.baseElapsedSec + n * duration)} y={height - 6} textAnchor={n === 0 ? 'start' : n === 1 ? 'end' : 'middle'}>{modelTime(report.baseElapsedSec + n * duration)}</text>)}
    {report.results.map((r, i) => <g key={r.id}><polyline points={r.series.map(p => `${x(p.elapsedSec)},${y(p.good)}`).join(' ')} fill="none" stroke={colors[i]} strokeWidth={i === 0 ? 4 : 2.5} strokeDasharray={i === 1 ? '9 5' : i === 2 ? '2 5' : undefined} strokeLinejoin="round"/><circle cx={x(report.shiftDurationSec)} cy={y(r.good)} r={i === 0 ? 5 : 3} fill={colors[i]}/></g>)}
  </svg>;
}

function downloadReport(report: ScenarioComparison) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `zauyt-ai-${report.stationId}-${report.baseElapsedSec}-${report.runId.slice(0, 8)}.json`;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function ScenarioPanel({ snapshot, source, selectedId, onSelect, disabled, demoRequest = 0, onReport }: {
  snapshot: TwinSnapshot; source: TwinDataSource; selectedId: string; onSelect: (id: string) => void; disabled: boolean;
  demoRequest?: number; onReport?: (report: ScenarioComparison | null) => void;
}) {
  const [delay, setDelay] = useState('30');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState<ScenarioComparison | null>(null);
  const requestToken = useRef(0);
  useEffect(() => {
    if (!demoRequest) return;
    requestToken.current++; busyRef.current = false; setBusy(false);
    setDelay('30'); setReport(null); setError(''); onReport?.(null);
  }, [demoRequest, onReport]);
  useEffect(() => () => { requestToken.current++; }, []);
  const delayNumber = Number(delay);
  const validDelay = delay.trim() !== '' && Number.isInteger(delayNumber) && delayNumber >= 0 && delayNumber <= 240;
  const selected = snapshot.state.stations.find(s => s.id === selectedId)!;
  const ended = snapshot.state.elapsedSec === snapshot.state.shiftDurationSec;
  const changed = report && (report.runId !== snapshot.runId || report.stationId !== selectedId || report.delayMinutes !== delayNumber
    || snapshot.state.elapsedSec - report.baseElapsedSec >= 60
    || report.stationModes.some(s => snapshot.state.stations.find(p => p.id === s.id)?.mode !== s.mode));
  const compare = async () => {
    if (busyRef.current || !validDelay || disabled) return;
    const token = ++requestToken.current;
    busyRef.current = true; setBusy(true); setError('');
    try {
      const next = await source.compare({ runId: snapshot.runId, stationId: selectedId, delayMinutes: delayNumber });
      if (requestToken.current === token) { setReport(next); onReport?.(next); }
    }
    catch (e) { if (requestToken.current === token) setError(e instanceof Error ? e.message : 'Не удалось сравнить сценарии'); }
    finally { if (requestToken.current === token) { busyRef.current = false; setBusy(false); } }
  };
  return <section id="scenarios" className="scenario-panel panel" aria-labelledby="scenario-title">
    <div className="panel-heading"><div><span className="section-code">02 /</span><h2 id="scenario-title">Сценарии восстановления</h2></div><span className="scenario-badge">Расчёт по модели</span></div>
    <div className="scenario-body">
      <p className="scenario-intro">Сравните выпуск к концу смены: сохранить текущий режим, восстановить пост сейчас или после ожидания.</p>
      <form className="scenario-form" onSubmit={e => { e.preventDefault(); void compare(); }}>
        <label>Пост для восстановления<select value={selectedId} disabled={busy} onChange={e => onSelect(e.target.value)}>{snapshot.state.stations.map(s => <option key={s.id} value={s.id}>{s.id} · {s.name}</option>)}</select></label>
        <label>Ожидание, мин<input type="number" min="0" max="240" step="1" value={delay} disabled={busy} onChange={e => setDelay(e.target.value)} aria-describedby="delay-hint"/></label>
        <button className="button primary" type="submit" disabled={busy || disabled || !validDelay}>{busy ? 'Считаем варианты…' : 'Сравнить варианты'}<span aria-hidden="true">↗</span></button>
      </form>
      <p id="delay-hint" className="scenario-hint">От 0 до 240 минут до завершения восстановления. {selected.id}: {modeLabels[selected.mode]}. Расчёт не меняет работающую модель.</p>
      {ended ? <p className="scenario-note">Смена завершена: все варианты покажут фактический итог. Новый сценарий можно начать кнопкой «Сбросить».</p>
        : selected.mode === 'normal' && <p className="scenario-note">Этот пост уже работает в нормальном режиме. Его восстановление не даст дополнительного выпуска.</p>}
      {error && <div className="error-banner scenario-error" role="alert">{error}</div>}
      {!report && <div className="scenario-empty"><span aria-hidden="true">↗</span><div><strong>Оцените решение до действия</strong><p>Три варианта стартуют из одного состояния линии. Очереди и изделия в работе участвуют в расчёте.</p></div></div>}
      {report && <div className="scenario-results" aria-busy={busy}>
        <div className="scenario-report-heading"><div><strong>{report.stationId} · {report.stationName}</strong><span>Срез на {modelTime(report.baseElapsedSec, true)} · {modeLabels[report.stationMode]} · ожидание {report.delayMinutes} мин</span></div><button className="button compact" onClick={() => downloadReport(report)}>Скачать расчёт</button></div>
        {changed && <p className="scenario-stale" role="status">Линия или параметры изменились. Ниже сохранён предыдущий расчёт — сравните варианты заново.</p>}
        <div className="scenario-cards">{report.results.map((r, i) => <article className={`scenario-card scenario-${r.id}`} key={r.id}>
          <div className="scenario-card-title"><span style={{ background: colors[i] }}/><h3>{r.title}</h3></div>
          <div className="scenario-value">{format(r.good)}<span>годных изделий</span></div>
          <div className={`scenario-plan ${r.planDelta < 0 ? 'shortfall' : ''}`}>{signed(r.planDelta)} к плану · {format(r.planFulfillmentPct)}%</div>
          <div className="scenario-gain">{i === 0 ? 'База для сравнения' : `${signed(r.gainVsBaseline)} изделий к текущему режиму`}</div>
          {i > 0 && !r.recoveryWithinShift && <small>Восстановление за пределами смены</small>}
        </article>)}</div>
        <div className="scenario-impact" aria-live="polite"><div><span>Потенциал восстановления</span><strong>{signed(report.summary.maxGain)} <small>годных изделий</small></strong></div><div><span>Потери из-за ожидания {report.delayMinutes} мин</span><strong>{format(report.summary.delayLoss)} <small>годных изделий</small></strong></div><p>{report.summary.maxGain === 0 ? 'По выпуску улучшения нет. Проверьте ограничения остальных постов и оставшееся время смены.' : 'Эффект относительно сохранения текущего режима. Возможность и стоимость восстановления требуют отдельной оценки.'}</p></div>
        <div className="scenario-chart-heading"><strong>Как изменится годный выпуск</strong><span>От среза до конца смены · шаг 5 мин</span></div>
        <div className="scenario-chart-legend">{report.results.map((r, i) => <span key={r.id}><i style={{ borderColor: colors[i], borderStyle: i === 0 ? 'solid' : i === 1 ? 'dashed' : 'dotted' }}/>{r.title}</span>)}</div>
        <div className="scenario-chart-scroll" tabIndex={0} aria-label="График сценариев; на узком экране доступна горизонтальная прокрутка"><ScenarioChart report={report}/></div>
        <details className="scenario-assumptions"><summary>Допущения и границы расчёта</summary><ul>{report.assumptions.map(a => <li key={a}>{a}</li>)}</ul></details>
      </div>}
    </div>
  </section>;
}
