import { useCallback, useEffect, useRef, useState } from 'react';
import { ArchiveSource, archiveSeries, summarizeRun } from './archive-source.ts';
import type { RunCatalog } from './archive-source.ts';
import type { StoredTwinSnapshot } from './types.ts';
import { modelTime, stationStatus, STATUS_LABEL } from './simulation.ts';
import './archive.css';

const source = new ArchiveSource();
const format = (n: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(n);
const realTime = (s: string) => new Date(s).toLocaleString('ru-RU');
const sourceNames = { simulation: 'Демонстрационная модель', historical: 'Исторические данные', live: 'Данные оборудования' };

function RunChart({ snapshot }: { snapshot: StoredTwinSnapshot }) {
  const s = snapshot.state, width = 900, height = 220, left = 42, bottom = 34;
  const max = Math.max(100, Math.ceil(Math.max(s.good, s.shiftPlan) / 100) * 100);
  const x = (t: number) => left + t / s.shiftDurationSec * (width - left - 18);
  const y = (n: number) => height - bottom - n / max * (height - bottom - 18);
  return <svg className="archive-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Накопленный выпуск: ${s.good} годных к ${modelTime(s.elapsedSec)}, план всей смены ${s.shiftPlan}`}>
    {[0, .5, 1].map(v => <g key={v}><line x1={left} x2={width - 18} y1={y(v * max)} y2={y(v * max)} stroke="#e0e7e1"/><text x="2" y={y(v * max) + 4}>{format(v * max)}</text></g>)}
    {[0, .25, .5, .75, 1].map(v => <text key={v} x={x(v * s.shiftDurationSec)} y={height - 5} textAnchor={v === 0 ? 'start' : v === 1 ? 'end' : 'middle'}>{modelTime(v * s.shiftDurationSec)}</text>)}
    <line x1={x(0)} y1={y(0)} x2={x(s.shiftDurationSec)} y2={y(s.shiftPlan)} stroke="#879482" strokeWidth="2" strokeDasharray="6 5"/>
    <polyline points={archiveSeries(snapshot).map(p => `${x(p.elapsedSec)},${y(p.good)}`).join(' ')} fill="none" stroke="#347553" strokeWidth="3"/>
    <circle cx={x(s.elapsedSec)} cy={y(s.good)} r="5" fill="#347553"/>
  </svg>;
}

function download(snapshot: StoredTwinSnapshot) {
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = `qostanai-run-${snapshot.runId}.json`; a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function ArchivePanel({ currentRunId, currentRevision }: { currentRunId: string; currentRevision: number }) {
  const [catalog, setCatalog] = useState<RunCatalog | null>(null);
  const [report, setReport] = useState<StoredTwinSnapshot | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const selected = useRef('');
  const request = useRef(0);
  const refresh = useCallback(async (id?: string) => {
    const token = ++request.current;
    setBusy(true); setError('');
    try {
      const next = await source.list();
      const choice = next.runs.find(r => r.runId === id)?.runId
        ?? next.runs.find(r => r.runId === next.currentRunId)?.runId ?? next.runs[0]?.runId;
      const snapshot = choice ? await source.load(choice) : null;
      if (token !== request.current) return;
      selected.current = choice ?? '';
      setCatalog(next); setReport(snapshot);
    } catch (e) {
      if (token === request.current) setError(e instanceof Error ? e.message : 'Не удалось загрузить архив.');
    } finally { if (token === request.current) setBusy(false); }
  }, []);
  useEffect(() => {
    void refresh(selected.current);
    return () => { request.current++; };
  }, [currentRunId, refresh]);
  useEffect(() => {
    const cleanup = () => document.body.classList.remove('archive-print');
    window.addEventListener('afterprint', cleanup);
    return () => { window.removeEventListener('afterprint', cleanup); cleanup(); };
  }, []);
  const printReport = () => { document.body.classList.add('archive-print'); window.print(); };
  const s = report?.state;
  const summary = report ? summarizeRun(report) : null;
  const outdated = report?.runId === currentRunId && report.revision < currentRevision;
  return <section id="archive" className="panel archive-panel" aria-labelledby="archive-title">
    <div className="panel-heading"><div><span className="section-code">06 /</span><h2 id="archive-title">Архив сценариев и отчёт смены</h2></div><span className="scenario-badge">Сохранено на сервере</span></div>
    <div className="archive-body">
      <p className="archive-intro">Вернитесь к результатам прошлых запусков: выпуску, простоям и событиям. Каждый сброс начинает новый сценарий, сохраняя предыдущий.</p>
      <div className="archive-toolbar">
        <label>Сохранённый сценарий<select aria-label="Сохранённый сценарий" value={report?.runId ?? ''} disabled={busy || !catalog?.runs.length} onChange={e => void refresh(e.target.value)}>
          {!catalog?.runs.length && <option value="">{busy ? 'Загружаем список…' : 'Сценариев пока нет'}</option>}
          {catalog?.runs.map(r => <option key={r.runId} value={r.runId}>{r.runId === currentRunId ? 'Текущий' : 'Архив'} · {realTime(r.createdAt)} · {r.good} годных · {r.runId.slice(0, 8)}</option>)}
        </select></label>
        <button className="button compact" disabled={busy} onClick={() => void refresh(selected.current)}>{busy ? 'Загрузка…' : 'Обновить архив'}</button>
        <button className="button compact" disabled={busy || !report} onClick={() => report && download(report)}>Скачать JSON</button>
        <button className="button primary" disabled={busy || !report} onClick={printReport}>Печать отчёта</button>
      </div>
      <p className="archive-list-note">До 50 последних сценариев. Время сохранения указано по часовому поясу устройства. Импорты CSV находятся в разделе «История».</p>
      {error && <p className="archive-error" role="alert">{error}{report && ' Ниже остаётся ранее загруженный снимок.'}</p>}
      {!busy && !error && !report && <div className="scenario-empty"><div><strong>Архив пока пуст</strong><p>Здесь появятся сохранённые сценарии этой базы.</p></div></div>}
      {report && s && summary && <div className="archive-report" aria-busy={busy}>
        <div className="archive-print-heading">Qostanai Twin · Отчёт производственного сценария</div>
        <div className="archive-report-title"><div><span className="eyebrow">{report.runId === currentRunId ? 'СНИМОК ТЕКУЩЕГО СЦЕНАРИЯ' : 'АРХИВНЫЙ СЦЕНАРИЙ'}</span><h3>{summary.ended ? 'Итоги смены' : `Промежуточный срез на ${modelTime(s.elapsedSec)}`}</h3><p>Сохранён {realTime(report.savedAt)} · модельное время {modelTime(s.elapsedSec)} · версия {report.revision}</p></div><span className="history-source synthetic">{sourceNames[report.source]}{report.source === 'simulation' && ' · не данные АЛЛЮР'}</span></div>
        <p className="archive-id">Сценарий {report.runId}</p>
        <p className="archive-readonly">Сохранённый снимок для просмотра. Управление текущей линией — в разделе «Линия».</p>
        {outdated && <p className="scenario-stale archive-stale">Текущая линия уже изменилась. Нажмите «Обновить архив», чтобы получить новый срез. Отчёт и экспорт относятся к показанной версии.</p>}
        <div className="archive-metrics">
          <article><span>Годный выпуск{!summary.ended && ' на срезе'}</span><strong>{s.good}<small>/ {s.shiftPlan}</small></strong><p>{format(summary.planPct)}% плана всей смены</p></article>
          <article><span>Брак на выходе</span><strong>{s.rejected}<small>изделий</small></strong><p>{summary.rejectPct === null ? 'Ещё нет выпуска' : `${format(summary.rejectPct)}% общего выпуска`}</p></article>
          <article><span>Простои оборудования</span><strong>{format(summary.downtimeSec / 60)}<small>мин</small></strong><p>Сумма остановок всех постов</p></article>
          <article><span>Инциденты</span><strong>{summary.incidentCount}<small>за сценарий</small></strong><p>{summary.unresolvedCount} не закрыто на момент среза</p></article>
        </div>
        <div className="archive-conclusion"><strong>{summary.ended ? `План ${summary.planDelta >= 0 ? 'выполнен' : 'не выполнен'}: ${summary.planDelta >= 0 ? '+' : ''}${summary.planDelta} изделий` : `До плана всей смены: ${Math.max(0, s.shiftPlan - s.good)} годных изделий`}</strong><p>{summary.worstStation ? `Больше всего остановок: ${summary.worstStation.id} «${summary.worstStation.name}» — ${format(summary.worstStation.downtimeSec / 60)} мин.` : 'Остановки постов в этом срезе не зафиксированы.'} В потоке осталось {summary.wip} изделий.</p></div>
        <div className="archive-chart-title"><h3>Выпуск за смену</h3><span><i/>Сохранённый факт <i className="planned"/>Равномерный план</span></div>
        <div className="archive-chart-scroll" tabIndex={0} aria-label="График архивного выпуска"><RunChart snapshot={report}/></div>
        {!summary.ended && <p className="archive-caption">В этом снимке смена ещё не завершена: линия факта заканчивается на времени среза. Это промежуточный результат.</p>}
        <h3 className="archive-section-title">Оборудование на момент сохранения</h3>
        <p className="archive-caption">Подача каждые {s.arrivalIntervalSec} с. Вместимость буферов: {s.buffers.map(b => `${b.id} — ${b.capacity}`).join(', ')}. Параметры сохранены вместе с этим сценарием.</p>
        <div className="archive-table-scroll" tabIndex={0} aria-label="Показатели оборудования"><table><thead><tr><th scope="col">Пост</th><th scope="col">Норматив, с</th><th scope="col">Состояние</th><th scope="col">Обработано</th><th scope="col">Загрузка</th><th scope="col">Остановка, мин</th></tr></thead><tbody>{s.stations.map(p => <tr key={p.id}><th scope="row">{p.id} · {p.name}</th><td>{p.nominalCycleSec}</td><td>{STATUS_LABEL[stationStatus(p)]}</td><td>{p.completed}</td><td>{s.elapsedSec ? `${format(p.busySec / s.elapsedSec * 100)}%` : '—'}</td><td>{format(p.downtimeSec / 60)}</td></tr>)}</tbody></table></div>
        <p className="archive-caption">Загрузка = время обработки / прошедшее время смены. Ожидание и блокировка не входят в обработку. Обработанные изделия разных постов не суммируются в выпуск.</p>
        <h3 className="archive-section-title">Журнал событий · {s.incidents.length}</h3>
        <div className="archive-table-scroll archive-events" tabIndex={0} aria-label="События сохранённого сценария"><table><thead><tr><th scope="col">Начало</th><th scope="col">Событие</th><th scope="col">Пост</th><th scope="col">Состояние на срезе</th></tr></thead><tbody>{[...s.incidents].sort((a, b) => a.startedAtSec - b.startedAtSec).map(e => <tr key={e.id}><td>{modelTime(e.startedAtSec)}</td><th scope="row">{e.title}<span>{e.detail}</span></th><td>{e.stationId ?? 'Линия'}</td><td>{e.severity === 'info' ? 'Информация' : e.resolvedAtSec !== null ? `Закрыт в ${modelTime(e.resolvedAtSec)}` : e.acknowledged ? 'Принят в работу' : 'Требует внимания'}</td></tr>)}</tbody></table></div>
        {!s.incidents.length && <p className="archive-caption">Событий в этом сценарии нет.</p>}
        <p className="archive-report-foot">{report.source === 'simulation' ? 'Учебная модель одного участка. Параметры и качество продукции заданы для демонстрации.' : 'Источник указан в сохранённом снимке.'} Отчёт фиксирует результат сценария и не подтверждает эффект на предприятии.</p>
      </div>}
    </div>
  </section>;
}
