import { useEffect, useRef, useState } from 'react';
import { configurationForReport, HistoryError, HistorySource } from './history-source.ts';
import type { HistoryReport, ImportEntry } from './history-source.ts';
import type { LineConfiguration, TwinSnapshot } from './types.ts';
import { configurationFromState, configurationsEqual, defaultConfiguration } from './configuration.ts';
import './history-configuration.css';
import HistoryComparisonPanel from './HistoryComparisonPanel.tsx';

const format = (n: number | null) => n === null ? '—' : new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 2}).format(n);
const signed = (n: number) => `${n > 0 ? '+' : ''}${format(n)}`;

function ConfigurationSummary({ value }: { value: LineConfiguration }) {
  return <dl className="history-configuration-values">
    <div><dt>Подача</dt><dd>каждые {value.arrivalIntervalSec} с</dd></div>
    <div><dt>Циклы P01 → P05, с</dt><dd>{value.stationCyclesSec.join(' / ')}</dd></div>
    <div><dt>Буферы B01 → B04, мест</dt><dd>{value.bufferCapacities.join(' / ')}</dd></div>
  </dl>;
}

function HistoryChart({ report }: { report: HistoryReport }) {
  const width = 900, height = 190, left = 42, bottom = 29;
  const max = Math.max(50, Math.ceil(Math.max(report.summary.good, report.summary.replayGood) / 50) * 50);
  const x = (sec: number) => left + sec / 28800 * (width - left - 14);
  const y = (good: number) => height - bottom - good / max * (height - bottom - 15);
  return <svg className="history-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Выпуск из CSV: ${report.summary.good}; воспроизведение по истории режимов: ${report.summary.replayGood}. Это сравнение накопленного выпуска, не прошлый прогноз.`}>
    {[0,.5,1].map(n => <g key={n}><line x1={left} x2={width - 14} y1={y(n*max)} y2={y(n*max)} stroke="#e4eadd"/><text x="0" y={y(n*max)+4}>{n*max}</text></g>)}
    {[0,2,4,6,8].map(h => <text key={h} x={x(h*3600)} y={height-5} textAnchor={h===0?'start':h===8?'end':'middle'}>{h} ч</text>)}
    <polyline points={report.observations.map(p=>`${x(p.elapsedSec)},${y(p.good)}`).join(' ')} stroke="#347553" strokeWidth="3" fill="none"/>
    <polyline points={report.observations.map(p=>`${x(p.elapsedSec)},${y(p.replayGood)}`).join(' ')} stroke="#9b8253" strokeWidth="2" strokeDasharray="6 5" fill="none"/>
  </svg>;
}

export default function HistoryPanel({ snapshot }: { snapshot: TwinSnapshot }) {
  const source = useRef(new HistorySource()).current;
  const [entries, setEntries] = useState<ImportEntry[]>([]);
  const [report, setReport] = useState<HistoryReport | null>(null);
  const [file, setFile] = useState<{name:string; text:string} | null>(null);
  const [plan, setPlan] = useState('410');
  const [configuration, setConfiguration] = useState(defaultConfiguration);
  const [configurationSource, setConfigurationSource] = useState<'defaults' | 'current' | 'saved'>('defaults');
  const [configurationLabel, setConfigurationLabel] = useState('Базовые нормативы');
  const [busy, setBusy] = useState(true);
  const running = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<HistoryError | null>(null);
  const [notice, setNotice] = useState('');
  const planValue = Number(plan);
  const validPlan = /^\d+$/.test(plan.trim()) && Number.isInteger(planValue) && planValue > 0 && planValue <= 100000;
  const supported = snapshot.capabilities?.includes('history_configuration') ?? false;
  const configurationChanged = configurationSource === 'current' && !configurationsEqual(configuration, configurationFromState(snapshot.state));
  const importDisabled = busy || !file || !validPlan || (!supported && configurationSource !== 'defaults');
  const selectConfiguration = (source: 'defaults' | 'current') => {
    const value = source === 'defaults' ? defaultConfiguration() : configurationFromState(snapshot.state);
    setConfiguration(value); setPlan(String(value.shiftPlan)); setConfigurationSource(source);
    setConfigurationLabel(source === 'defaults' ? 'Базовые нормативы' : 'Копия текущих настроек');
    setNotice('Параметры выбраны для следующего импорта. Уже сохранённый отчёт не изменён.');
  };
  const fail = (e: unknown) => setError(e instanceof HistoryError ? e : new HistoryError(e instanceof Error ? e.message : 'Не удалось обработать историю.'));
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const saved = await source.list();
        if (!active) return;
        setEntries(saved);
        if (saved.length) { const previous = await source.load(saved[0].importId); if (active) setReport(previous); }
      } catch (e) { if (active) fail(e); }
      finally { if (active) setBusy(false); }
    })();
    return () => { active = false; };
  }, [source]);
  const action = async (operation: () => Promise<void>) => {
    if (running.current || busy) return;
    running.current = true; setBusy(true); setError(null); setNotice('');
    try { await operation(); } catch (e) { fail(e); }
    finally { running.current = false; setBusy(false); }
  };
  const chooseFile = async (chosen: File | undefined) => {
    if (!chosen) return;
    setFile(null);
    await action(async () => {
      if (chosen.size > 512*1024) throw new HistoryError('Размер файла превышает 512 КиБ.');
      let text: string;
      try { text = new TextDecoder('utf-8', {fatal:true}).decode(await chosen.arrayBuffer()); }
      catch { throw new HistoryError('Не удалось прочитать CSV в UTF-8. Пересохраните файл в этой кодировке.'); }
      setFile({name:chosen.name, text});
    });
  };
  const sample = () => action(async () => {
    const response = await fetch('/api/v1/history/example.csv', {cache:'no-store', signal:AbortSignal.timeout(10000)});
    if (!response.ok) throw new HistoryError('Не удалось загрузить пример файла. Повторите позже.');
    setFile({name:'demo-shift.csv',text:await response.text()});
    if (fileInput.current) fileInput.current.value = '';
    setConfiguration(defaultConfiguration()); setConfigurationSource('defaults'); setConfigurationLabel('Базовые нормативы');
    setPlan('410'); setNotice('Пример файла и базовые нормативы выбраны. Нажмите «Проверить и импортировать».');
  });
  const importFile = () => action(async () => {
    if (!file || !validPlan || (!supported && configurationSource !== 'defaults')) return;
    const next = await source.import(file.name, file.text, planValue, supported ? { ...configuration, shiftPlan: planValue } : undefined);
    setReport(next);
    setEntries(previous => [next, ...previous.filter(e=>e.importId!==next.importId)].slice(0,20));
    setNotice('История проверена и сохранена. Повтор того же файла с тем же планом и нормативами не создаёт дубликат.');
  });
  const refreshImports = () => action(async () => {
    const saved = await source.list();
    const next = report && saved.some(e => e.importId === report.importId) ? report : saved.length ? await source.load(saved[0].importId) : null;
    setEntries(saved); setReport(next); setNotice(`Список обновлён. Доступно последних отчётов: ${saved.length}.`);
  });
  return <section id="history" className="panel history-panel" aria-labelledby="history-title">
    <div className="panel-heading"><div><span className="section-code">05 /</span><h2 id="history-title">История и проверка прогноза</h2></div><span className="scenario-badge">Одна смена · CSV</span></div>
    <div className="history-body">
      <p className="scenario-intro">Загрузите выпуск и режимы постов за полную смену. Выберите нормативы, по которым модель восстановит работу линии и рассчитает прошлые прогнозы. Параметры сохраняются вместе с результатом проверки.</p>
      {!supported && <p className="settings-conflict" role="status">Для выбора нормативов запустите обновлённый сервер через start.cmd и обновите страницу. Сейчас импорт доступен с базовыми нормативами; сохранённые отчёты можно просматривать.</p>}
      <div className="history-configuration-picker">
        <div className="history-configuration-heading"><label>Нормативы для следующего импорта<select aria-label="Нормативы для CSV" disabled={busy || !supported} value={configurationSource} onChange={e => { if (e.target.value !== 'saved') selectConfiguration(e.target.value as 'defaults' | 'current'); }}>
          <option value="defaults">Базовые нормативы</option><option value="current">Копия текущих настроек</option>{configurationSource === 'saved' && <option value="saved">Из сохранённого отчёта</option>}
        </select></label>{configurationSource === 'current' && <button className="button compact" disabled={busy || !supported} onClick={() => selectConfiguration('current')}>Обновить из настроек</button>}<a href="#settings">Изменить настройки участка ↗</a></div>
        <ConfigurationSummary value={configuration}/>
        <p>{configurationLabel}. План смены можно изменить ниже. Выбор параметров не запускает новый сценарий.</p>
        {configurationChanged && <p className="history-configuration-changed" role="status">Текущие настройки изменились. Для импорта остаётся выбранная копия параметров; при необходимости обновите её кнопкой выше.</p>}
      </div>
      <div className="history-inputs">
        <label className="history-file-label">CSV в UTF-8 · до 512 КиБ<input ref={fileInput} aria-label="Файл истории CSV" type="file" accept=".csv,text/csv" disabled={busy} onChange={e => void chooseFile(e.target.files?.[0])}/></label>
        <label>План этой смены<input aria-label="План импортируемой смены" type="number" min="1" max="100000" step="1" value={plan} disabled={busy} onChange={e=>setPlan(e.target.value)}/></label>
        <button className="button primary" disabled={importDisabled} onClick={importFile}>{busy ? 'Обработка…' : 'Проверить и импортировать'}</button>
      </div>
      <div className="history-sample"><button className="button compact" disabled={busy} onClick={sample}>Загрузить пример</button><a href="/api/v1/history/example.csv" download>Скачать пример CSV ↗</a></div>
      {file && <p className="history-file-status">К импорту: <strong>{file.name}</strong> · {format(new TextEncoder().encode(file.text).length/1024)} КиБ</p>}
      {notice && <p className="history-notice" role="status">{notice}</p>}
      {error && <div className="history-errors" role="alert"><strong>{error.message}</strong>{error.issues.length > 0 && <><ul>{error.issues.map((i,n)=><li key={n}>{i.row ? `Строка ${i.row}` : 'Файл'} · {i.column}: {i.message}</li>)}</ul>{error.totalIssues > error.issues.length && <p>Показано {error.issues.length} из {error.totalIssues} ошибок.</p>}</>}</div>}
      <details className="history-format"><summary>Формат файла и правила проверки</summary><p>Встроенный пример содержит синтетическую смену, а не данные АЛЛЮР. Загруженный пользователем CSV сохраняет свой источник; приложение не подтверждает его происхождение.</p><p>8 столбцов: <code>elapsed_sec,good,rejected,P01_mode,P02_mode,P03_mode,P04_mode,P05_mode</code>. Разделитель — запятая или точка с запятой. Порядок столбцов может отличаться.</p><p>Время — секунды от начала смены (0–28800); good и rejected — накопленные целые счётчики. Начало: 0, 0, 0. Режимы: normal, slow, stop. Запишите каждое изменение режима в момент его начала. Нужна последняя строка на 28800 с.</p><p>Минимум 3, максимум 6000 записей. Пропуски, дубликаты времени, убывающие счётчики и неизвестные режимы отклоняются. Файл с ошибками не сохраняется. Неполную смену можно добавить после её завершения.</p></details>
      <button className="button compact" disabled={busy} onClick={refreshImports}>Обновить список импортов</button>
      {entries.length > 0 && <label className="history-saved-label">Сохранённые импорты<select aria-label="Сохранённые импорты" value={report?.importId || ''} disabled={busy} onChange={e => {const id=e.target.value; void action(async()=>setReport(await source.load(id)));}}>{entries.map(e=><option key={e.importId} value={e.importId}>{e.fileName} · план {e.summary.good-e.summary.planDelta} · подача {e.configuration?.arrivalIntervalSec ?? 65} с · {new Date(e.createdAt).toLocaleString('ru-RU')} · {e.importId.slice(0,6)}</option>)}</select></label>}
      {!report && <div className="scenario-empty"><span aria-hidden="true">↗</span><div><strong>Проверьте прогноз на завершённой смене</strong><p>Загрузите файл смены или выберите готовый пример.</p></div></div>}
      {report && <div className="history-report" aria-busy={busy}>
        <div className="history-report-heading"><div><h3>{report.fileName}</h3><p>8 часов · {report.quality.rowCount} записей · план {report.plan} · максимум между записями {format(report.quality.maxGapSec/60)} мин</p></div><span className={`history-source ${report.source==='synthetic_example'?'synthetic':''}`}>{report.source==='synthetic_example'?'Пример смены':'Загруженный CSV'}</span></div>
        <div className="history-report-configuration"><div className="history-configuration-heading"><h3>Параметры этого отчёта</h3><button className="button compact" disabled={busy || !supported} onClick={() => {
          const value = configurationForReport(report); setConfiguration(value); setPlan(String(value.shiftPlan)); setConfigurationSource('saved');
          setConfigurationLabel(`Из отчёта «${report.fileName}» от ${new Date(report.createdAt).toLocaleString('ru-RU')}`);
          setNotice('Параметры отчёта скопированы в форму. Выберите CSV и выполните импорт для нового расчёта.');
        }}>Использовать параметры отчёта</button></div><ConfigurationSummary value={configurationForReport(report)}/>
          <p>{report.schemaVersion === 1 ? 'Ранее сохранённый отчёт: здесь показаны фиксированные учебные нормативы прежнего метода. Его результаты не пересчитывались.' : 'Зафиксированы при импорте. Текущие настройки участка не меняют эти результаты.'}</p>
        </div>
        {report.quality.warnings.map(w=><p className="scenario-stale" key={w}>{w}</p>)}
        <div className="history-metrics"><article><span>Годный выпуск из CSV</span><strong>{report.summary.good}<small>изделий</small></strong><p>{signed(report.summary.planDelta)} к плану</p></article><article><span>Брак из CSV</span><strong>{report.summary.rejected}<small>изделий</small></strong><p>{format(report.summary.rejectPct)}% итогового выпуска</p></article><article><span>Ошибка модели · MAE</span><strong>{format(report.summary.flowMae)}<small>изделий</small></strong><p>По {report.summary.checkpointCount} срезам одной смены</p></article><article><span>Ошибка прогноза по темпу</span><strong>{format(report.summary.rateMae)}<small>изделий</small></strong><p>База для сравнения · MAE</p></article></div>
        <div className="history-chart-heading"><h3>Накопленный выпуск за смену</h3><div><span><i/>Данные CSV</span><span><i/>Модель по истории режимов</span></div></div>
        <p className="history-table-note">График воспроизводит всю загруженную историю режимов. Проверка прошлых прогнозов без знания будущего — в таблице ниже.</p>
        <div className="history-chart-scroll" tabIndex={0} aria-label="График истории, доступна горизонтальная прокрутка"><HistoryChart report={report}/></div>
        <h3 className="history-table-title">Что прогнозировали бы в течение смены</h3>
        <p className="history-table-note">В каждом срезе используются только известные к нему данные. Ошибка = прогноз − итог CSV; положительное значение означает завышение.</p>
        {report.checkpoints.length > 0 ? <div className="history-table-scroll" tabIndex={0} aria-label="Таблица проверки прогнозов"><table><thead><tr><th scope="col">Срез от начала</th><th scope="col">Прогноз модели</th><th scope="col">Прогноз по темпу</th><th scope="col">Итог CSV</th><th scope="col">Ошибка модели</th><th scope="col">Ошибка по темпу</th><th scope="col">Окно темпа</th></tr></thead><tbody>{report.checkpoints.map(p=><tr key={p.elapsedSec}><th scope="row">{format(p.elapsedSec/3600)} ч</th><td>{p.flowForecast}</td><td>{p.rateForecast}</td><td>{p.actualGood}</td><td className={p.flowError?'has-error':''}>{signed(p.flowError)}</td><td>{signed(p.rateError)}</td><td>{format(p.rateWindowSec/60)} мин</td></tr>)}</tbody></table></div> : <p className="scenario-note">Нет пригодных промежуточных срезов для оценки. Добавьте записи около 2, 4 и 6 часов от начала смены.</p>}
        <p className="history-conclusion">{report.summary.flowMae !== null && report.summary.rateMae !== null && (report.summary.flowMae === report.summary.rateMae ? 'На этих срезах средние ошибки двух методов равны. ' : report.summary.flowMae < report.summary.rateMae ? 'На этих срезах прогноз модели оказался ближе к итогу. ' : 'На этих срезах прогноз по темпу оказался ближе к итогу. ')}Модель сохраняет режимы на момент среза; последующие ремонты и изменения режима могут заметно изменить результат. Одна смена не подтверждает точность на заводе — нужны независимые смены и согласованные параметры оборудования.</p>
        <details className="scenario-assumptions"><summary>Как рассчитаны прогнозы и ошибки</summary><ul>{report.assumptions.map(a=><li key={a}>{a}</li>)}</ul></details>
      </div>}
      <HistoryComparisonPanel entries={entries} source={source} disabled={busy}/>
    </div>
  </section>;
}
