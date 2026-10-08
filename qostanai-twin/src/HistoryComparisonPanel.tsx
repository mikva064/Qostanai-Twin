import { useEffect, useRef, useState } from 'react';
import { importLabel, loadHistoryComparison } from './history-comparison.ts';
import type { HistoryComparison } from './history-comparison.ts';
import type { HistorySource, ImportEntry } from './history-source.ts';
import './history-comparison.css';

const format = (n: number | null) => n === null ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n);
const signed = (n: number | null) => n === null ? '—' : `${n > 0 ? '+' : ''}${format(n)}`;

function ComparisonChart({ comparison }: { comparison: HistoryComparison }) {
  const width = 900, height = 220, left = 52, bottom = 30;
  const last = comparison.series[comparison.series.length - 1];
  const maximum = Math.max(50, Math.ceil(Math.max(last.actual, last.a, last.b) / 50) * 50);
  const x = (sec: number) => left + sec / 28800 * (width - left - 14);
  const y = (good: number) => height - bottom - good / maximum * (height - bottom - 18);
  const points = (key: 'actual' | 'a' | 'b') => comparison.series.map(row => `${x(row.elapsedSec)},${y(row[key])}`).join(' ');
  return <svg className="history-comparison-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Воспроизведение одной истории: факт CSV ${last.actual} годных, расчёт A ${last.a}, расчёт B ${last.b}. График использует всю историю режимов, это не прогноз на начало смены.`}>
    {[0, .5, 1].map(fraction => <g key={fraction}><line x1={left} x2={width - 14} y1={y(fraction * maximum)} y2={y(fraction * maximum)} stroke="#e0e7d8"/><text x={left - 8} y={y(fraction * maximum) + 4} textAnchor="end">{format(fraction * maximum)}</text></g>)}
    {[0, 2, 4, 6, 8].map(hour => <text key={hour} x={x(hour * 3600)} y={height - 6} textAnchor={hour === 0 ? 'start' : hour === 8 ? 'end' : 'middle'}>{hour} ч</text>)}
    <polyline points={points('actual')} fill="none" stroke="#347553" strokeWidth="3"/>
    <polyline points={points('a')} fill="none" stroke="#9b7639" strokeWidth="2.5" strokeDasharray="9 5"/>
    <polyline points={points('b')} fill="none" stroke="#577daf" strokeWidth="2.5" strokeDasharray="3 4"/>
  </svg>;
}

export default function HistoryComparisonPanel({ entries, source, disabled }: { entries: ImportEntry[]; source: HistorySource; disabled: boolean }) {
  const [selectedA, setSelectedA] = useState('');
  const [selectedB, setSelectedB] = useState('');
  const [comparison, setComparison] = useState<HistoryComparison | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ pair: string; message: string } | null>(null);
  const [onlyChanged, setOnlyChanged] = useState(false);
  const requestId = useRef(0);
  const aId = entries.some(e => e.importId === selectedA) ? selectedA : (entries[1] ?? entries[0])?.importId ?? '';
  const bId = entries.some(e => e.importId === selectedB) ? selectedB : entries[0]?.importId ?? '';
  const selection = useRef('');
  selection.current = `${aId}:${bId}`;
  useEffect(() => () => { requestId.current++; }, []);
  const invalidate = () => { requestId.current++; setComparison(null); setLoading(false); setError(null); };
  const run = async () => {
    if (disabled || loading || !aId || !bId || aId === bId) return;
    const token = ++requestId.current, pair = `${aId}:${bId}`;
    setSelectedA(aId); setSelectedB(bId);
    setLoading(true); setComparison(null); setError(null);
    try {
      const value = await loadHistoryComparison(source, aId, bId);
      if (requestId.current === token && selection.current === pair) setComparison(value);
    } catch (e) {
      if (requestId.current === token && selection.current === pair) setError({ pair, message: e instanceof Error ? e.message : 'Не удалось сравнить отчёты. Повторите запрос.' });
    } finally { if (requestId.current === token) setLoading(false); }
  };
  const visible = comparison?.reports.a.importId === aId && comparison.reports.b.importId === bId ? comparison : null;
  const visibleError = error?.pair === selection.current ? error.message : '';
  const download = () => {
    if (!visible) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ ...visible, exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `zauyt-ai-history-${aId.slice(0, 8)}-${bId.slice(0, 8)}.json`;
    document.body.append(anchor); anchor.click(); anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const selector = (side: 'A' | 'B', value: string) => <label><span className={`history-comparison-letter side-${side.toLowerCase()}`}>{side}</span>{side === 'A' ? 'Исходный отчёт' : 'Отчёт для сравнения'}<select aria-label={`Отчёт ${side} для сравнения`} value={value} disabled={disabled || entries.length < 2} onChange={event => { invalidate(); (side === 'A' ? setSelectedA : setSelectedB)(event.target.value); }}>
    {!entries.length && <option value="">Сохранённых импортов пока нет</option>}{entries.map(entry => <option key={entry.importId} value={entry.importId}>{importLabel(entry)}</option>)}
  </select></label>;
  return <section className="history-comparison" aria-labelledby="history-comparison-title">
    <div className="history-comparison-heading"><div><h3 id="history-comparison-title">Сравнение проверок</h3><p>Одна история смены, два набора параметров. Все разницы ниже — B − A.</p></div><span className="scenario-badge">Сохранённые отчёты</span></div>
    <div className="history-comparison-selectors">{selector('A', aId)}{selector('B', bId)}</div>
    <div className="history-comparison-actions"><button className="button primary" disabled={disabled || loading || entries.length < 2 || aId === bId} onClick={run}>{loading ? 'Загружаем отчёты…' : 'Сравнить отчёты'}</button><button className="button" disabled={disabled || entries.length < 2 || aId === bId} onClick={() => { invalidate(); setSelectedA(bId); setSelectedB(aId); }}>Поменять A и B</button></div>
    {entries.length < 2 ? <p className="scenario-note">Нужны два сохранённых отчёта. Импортируйте один CSV, измените план или нормативы в форме выше и импортируйте его ещё раз. Тот же файл с теми же параметрами вернёт существующий отчёт.</p> : aId === bId ? <p className="scenario-note">В A и B выбран один отчёт. Выберите разные записи.</p> : !visible && !loading && !visibleError && <p className="history-table-note">Нажмите «Сравнить отчёты». Проверим совпадение всех времён, счётчиков и режимов постов; имя файла может различаться.</p>}
    {visibleError && <p className="history-errors" role="alert">{visibleError}</p>}
    <div aria-live="polite" aria-busy={loading}>
      {visible && <div className="history-comparison-result">
        <div className="history-comparison-basis"><p><strong>История совпадает: {visible.basis.rowCount} записей</strong><span>{visible.basis.good} годных · {visible.basis.rejected} бракованных · срезов для оценки: {visible.basis.checkpointCount}</span></p><button className="button compact" onClick={download}>Скачать сравнение JSON</button></div>
        <div className="history-comparison-reports">{(['a', 'b'] as const).map(key => <p key={key}><strong>{key.toUpperCase()} · {visible.reports[key].fileName}</strong><span>{new Date(visible.reports[key].createdAt).toLocaleString('ru-RU')} · {visible.reports[key].importId.slice(0, 8)}<br/>{visible.reports[key].source === 'synthetic_example' ? 'Пример смены' : 'Загруженный CSV'}</span></p>)}</div>
        <div className="history-comparison-metrics">{visible.metrics.map(metric => <article key={metric.key}><h4>{metric.label}</h4><div><span><small>A</small>{format(metric.a)}</span><span><small>B</small>{format(metric.b)}</span></div><p className={metric.key.endsWith('Mae') && metric.delta !== null ? metric.delta < 0 ? 'difference-better' : metric.delta > 0 ? 'difference-worse' : '' : ''}>B − A: <strong>{signed(metric.delta)}</strong> изд.</p></article>)}</div>
        <div className="history-comparison-table-heading"><h4>Что изменилось в параметрах</h4><label><input type="checkbox" checked={onlyChanged} onChange={e => setOnlyChanged(e.target.checked)}/>Только различия</label></div>
        {onlyChanged && visible.parameters.every(p => p.delta === 0) ? <p className="scenario-note">Все параметры совпадают.</p> : <div className="history-table-scroll" tabIndex={0} aria-label="Параметры двух отчётов"><table><thead><tr><th scope="col">Параметр</th><th scope="col">A</th><th scope="col">B</th><th scope="col">B − A</th></tr></thead><tbody>{visible.parameters.filter(p => !onlyChanged || p.delta !== 0).map(p => <tr key={p.key} className={p.delta ? 'parameter-changed' : ''}><th scope="row">{p.label}, {p.unit}</th><td>{format(p.a)}</td><td>{format(p.b)}</td><td>{signed(p.delta)}</td></tr>)}</tbody></table></div>}
        <h4 className="history-comparison-subtitle">Воспроизведение одной истории</h4>
        <p className="history-table-note">Годный выпуск на выходе линии. Для этих кривых использована вся история режимов. Прошлые прогнозы показаны отдельно в таблице.</p>
        <div className="history-comparison-legend"><span><i/>Факт из CSV</span><span><i/>Расчёт A</span><span><i/>Расчёт B</span></div>
        <div className="history-chart-scroll" tabIndex={0} aria-label="График сравнения воспроизведения, доступна прокрутка"><ComparisonChart comparison={visible}/></div>
        <h4 className="history-comparison-subtitle">Прогнозы на одинаковых срезах</h4>
        <p className="history-table-note">Ошибка = прогноз − итог CSV. Прогноз по темпу общий: он зависит от записей смены. MAE сравнивает абсолютные ошибки на этих срезах.</p>
        {visible.checkpoints.length ? <div className="history-table-scroll" tabIndex={0} aria-label="Сравнение прогнозов"><table><thead><tr><th scope="col">Срез, ч</th><th scope="col">Прогноз A</th><th scope="col">Прогноз B</th><th scope="col">B − A</th><th scope="col">Итог CSV</th><th scope="col">Ошибка A</th><th scope="col">Ошибка B</th><th scope="col">По темпу</th></tr></thead><tbody>{visible.checkpoints.map(row => <tr key={row.elapsedSec}><th scope="row">{format(row.elapsedSec / 3600)}</th><td>{row.a}</td><td>{row.b}</td><td>{signed(row.delta)}</td><td>{row.actual}</td><td>{signed(row.errorA)}</td><td>{signed(row.errorB)}</td><td>{row.rate}</td></tr>)}</tbody></table></div> : <p className="scenario-note">В этой истории нет пригодных промежуточных срезов. MAE не рассчитана.</p>}
        <div className="history-comparison-notices">{visible.notices.map(note => <p key={note}>{note}</p>)}</div>
      </div>}
    </div>
  </section>;
}
