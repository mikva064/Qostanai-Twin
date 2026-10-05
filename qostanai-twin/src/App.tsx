import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { HttpDataSource, ApiError } from './data-source.ts';
import ScenarioPanel from './ScenarioPanel.tsx';
import HistoryPanel from './HistoryPanel.tsx';
import ArchivePanel from './ArchivePanel.tsx';
import SettingsPanel from './SettingsPanel.tsx';
import DemoGuide from './DemoGuide.tsx';
import CaseDataPanel from './CaseDataPanel.tsx';
import AgentPanel from './AgentPanel.tsx';
import type { ScenarioComparison, TwinCommand, TwinSnapshot } from './types.ts';
import { cycleSec, modelTime, progressPercent, stationStatus, STATUS_LABEL } from './simulation.ts';

type IconName = 'grid' | 'line' | 'pulse' | 'alert' | 'clock' | 'check' | 'arrow' | 'pause' | 'play' | 'reset' | 'box' | 'tool' | 'layers' | 'shield' | 'exit';
function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
    line: <><rect x="2" y="8" width="5" height="8" rx="1"/><rect x="17" y="8" width="5" height="8" rx="1"/><path d="M7 12h10M10 8h4M10 16h4"/></>,
    pulse: <path d="M2 12h5l3-8 4 16 3-8h5"/>,
    alert: <><path d="m12 3 10 17H2L12 3Z"/><path d="M12 9v5M12 17v.1"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>,
    pause: <><path d="M8 5v14M16 5v14"/></>,
    play: <path d="m8 4 12 8-12 8V4Z"/>,
    reset: <><path d="M4 11a8 8 0 1 1 2 7M4 4v7h7"/></>,
    box: <><path d="m12 3 9 5v9l-9 5-9-5V8l9-5Zm-9 5 9 5 9-5M12 13v9M7 5.8l9 5"/></>,
    tool: <><path d="m14 6 4 4 4-4a7 7 0 0 1-9 9l-7 7-4-4 7-7a7 7 0 0 1 9-9l-4 4Z"/></>,
    layers: <><path d="m12 3 10 6-10 6L2 9l10-6ZM3 14l9 5 9-5M3 18l9 5 9-5"/></>,
    shield: <><path d="m12 3 9 4v6c0 5-9 9-9 9s-9-4-9-9V7l9-4Z"/><path d="m7 12 3 3 6-6"/></>,
    exit: <><path d="M14 4H4v16h10M10 12h12m-5-5 5 5-5 5"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
const stationIcons: IconName[] = ['box', 'tool', 'layers', 'shield', 'exit'];
const number = (n: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(n);
const sectionFromHash = () => ['overview', 'production', 'scenarios', 'events', 'history', 'archive', 'settings', 'demo', 'case', 'agent'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';

function OutputChart({ snapshot }: { snapshot: TwinSnapshot }) {
  const { state, forecast: prediction } = snapshot;
  const width = 780, height = 170, left = 34, top = 14, bottom = 30;
  const maxY = Math.ceil(Math.max(state.shiftPlan, prediction.goodAtShiftEnd, state.good) / 100) * 100;
  const x = (sec: number) => left + sec / state.shiftDurationSec * (width - left - 12);
  const y = (good: number) => height - bottom - good / maxY * (height - top - bottom);
  const history = [...state.history, { elapsedSec: state.elapsedSec, good: state.good }];
  const points = history.map(p => `${x(p.elapsedSec)},${y(p.good)}`).join(' ');
  return <svg className="output-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`График выпуска: ${state.good} годных изделий сейчас, прогноз ${prediction.goodAtShiftEnd} к 16:00, план ${state.shiftPlan}`}>
    <defs><linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#719e65" stopOpacity=".23"/><stop offset="100%" stopColor="#719e65" stopOpacity=".02"/></linearGradient></defs>
    {[0, .5, 1].map(n => <g key={n}><line x1={left} x2={width - 12} y1={y(n * maxY)} y2={y(n * maxY)} stroke="#e8eeeb"/><text x="0" y={y(n * maxY) + 4}>{n * maxY}</text></g>)}
    {[0, 2, 4, 6, 8].map(h => <text key={h} x={x(h * 3600)} y={height - 5} textAnchor={h === 0 ? 'start' : h === 8 ? 'end' : 'middle'}>{String(8 + h).padStart(2, '0')}:00</text>)}
    <line x1={x(0)} y1={y(0)} x2={x(state.shiftDurationSec)} y2={y(state.shiftPlan)} stroke="#acb5b1" strokeDasharray="5 5" strokeWidth="1.5"/>
    <polygon points={`${x(0)},${y(0)} ${points} ${x(state.elapsedSec)},${y(0)}`} fill="url(#chartFill)"/>
    <polyline points={points} fill="none" stroke="#367856" strokeWidth="3" strokeLinejoin="round"/>
    <line x1={x(state.elapsedSec)} y1={y(state.good)} x2={x(state.shiftDurationSec)} y2={y(prediction.goodAtShiftEnd)} stroke={prediction.planDelta >= 0 ? '#77a95e' : '#d79433'} strokeWidth="2" strokeDasharray="4 5"/>
    <circle cx={x(state.elapsedSec)} cy={y(state.good)} r="4" fill="#367856" stroke="white" strokeWidth="2"/>
    <circle cx={x(state.shiftDurationSec)} cy={y(prediction.goodAtShiftEnd)} r="4" fill={prediction.planDelta >= 0 ? '#77a95e' : '#d79433'}/>
  </svg>;
}

export default function App() {
  const source = useRef<HttpDataSource | null>(null);
  if (!source.current) source.current = new HttpDataSource();
  const [snapshot, setSnapshot] = useState<TwinSnapshot | null>(null);
  const latest = useRef<TwinSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState('P03');
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const commandBusy = useRef(false);
  const [stale, setStale] = useState(false);
  const lastSeen = useRef(0);
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState<'all' | 'active'>('all');
  const [resetOpen, setResetOpen] = useState(false);
  const [activeSection, setActiveSection] = useState(sectionFromHash);
  const [demoComparison, setDemoComparison] = useState<ScenarioComparison | null>(null);
  const [demoRequest, setDemoRequest] = useState(0);
  const resetDialog = useRef<HTMLDialogElement>(null);
  const accept = useCallback((next: TwinSnapshot) => {
    if (!latest.current || next.revision >= latest.current.revision) {
      latest.current = next;
      setSnapshot(next);
    }
    lastSeen.current = Date.now();
    setStale(false); setError(null);
  }, []);
  const refresh = useCallback(async () => {
    try { accept(await source.current!.getSnapshot()); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось получить состояние линии'); }
  }, [accept]);
  const send = useCallback(async (command: TwinCommand, expectedRunId?: string): Promise<boolean> => {
    if (commandBusy.current || !latest.current) return false;
    if (expectedRunId && expectedRunId !== latest.current.runId) {
      setActionError('Сценарий изменился. Загрузите актуальные параметры перед применением.');
      return false;
    }
    commandBusy.current = true;
    setPending(true); setActionError(null);
    try {
      const result = await source.current!.dispatch(command, expectedRunId ?? latest.current.runId);
      accept(result);
      if ((command.type === 'configure_line' || command.type === 'reset') && latest.current.runId !== result.runId) {
        setActionError('Новый сценарий сохранён, но текущий запуск уже изменён в другой вкладке. Проверьте архив и актуальное состояние.');
        return false;
      }
      return true;
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Не удалось подтвердить выполнение команды');
      if (e instanceof ApiError && e.status === 409) await refresh();
      return false;
    } finally { commandBusy.current = false; setPending(false); }
  }, [accept, refresh]);
  useEffect(() => {
    let active = true;
    let timer: number;
    const poll = async () => {
      try { const result = await source.current!.getSnapshot(); if (active) accept(result); }
      catch (e) { if (active) setError(e instanceof Error ? e.message : 'Нет связи с сервером'); }
      if (active) timer = window.setTimeout(poll, 1000);
    };
    void poll();
    return () => { active = false; window.clearTimeout(timer); };
  }, [accept]);
  useEffect(() => {
    const timer = window.setInterval(() => setStale(lastSeen.current > 0 && Date.now() - lastSeen.current > 5000), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => { if (!notice) return; const t = window.setTimeout(() => setNotice(''), 3500); return () => clearTimeout(t); }, [notice]);
  useEffect(() => {
    if (resetOpen) resetDialog.current?.showModal(); else resetDialog.current?.close();
  }, [resetOpen]);
  useEffect(() => {
    const update = () => setActiveSection(sectionFromHash());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const ready = snapshot !== null;
  useEffect(() => {
    if (!ready) return;
    const frame = requestAnimationFrame(() => document.getElementById(activeSection)?.scrollIntoView());
    return () => cancelAnimationFrame(frame);
  }, [ready, activeSection]);

  if (!snapshot && activeSection === 'agent') return <main className="case-standalone"><a href="#overview">← К учебной линии</a><AgentPanel/></main>;
  if (!snapshot && activeSection === 'case') return <main className="case-standalone"><a href="#overview">← К учебной линии</a><CaseDataPanel/></main>;
  if (!snapshot) return <div className="loading-state"><span className="brand-mark">Q</span><div><p>{error || 'Подключение к производственной линии…'}</p>{error && <button className="button" onClick={refresh}>Повторить подключение</button>}<p><a href="#case">Открыть данные кейса из документа</a></p></div></div>;
  const { state, forecast: prediction } = snapshot;
  const { paused, speed } = snapshot.controls;
  const disconnected = Boolean(error) || stale;
  const controlsDisabled = pending || disconnected;
  const selected = state.stations.find(s => s.id === selectedId)!;
  const selectedStatus = stationStatus(selected);
  const activeIncidents = state.incidents.filter(i => i.resolvedAtSec === null);
  const visibleIncidents = state.incidents.filter(i => filter === 'all' || i.resolvedAtSec === null);
  const stopped = state.stations.filter(s => s.mode === 'stop').length;
  const slow = state.stations.filter(s => s.mode === 'slow').length;
  const downtime = state.stations.reduce((total, s) => total + s.downtimeSec, 0);
  const completed = state.good + state.rejected;
  const rejectionRate = completed ? 100 * state.rejected / completed : 0;
  const wip = state.buffers.reduce((n, b) => n + b.count, 0) + state.stations.filter(s => s.remainingWorkSec !== null).length;
  const ended = state.elapsedSec >= state.shiftDurationSec;
  const operate = async (mode: 'normal' | 'slow' | 'stop') => {
    if (await send({ type: 'set_station_mode', stationId: selectedId, mode })) {
      setNotice(`${selectedId}: ${mode === 'normal' ? 'нормальный режим восстановлен' : mode === 'slow' ? 'время цикла увеличено вдвое' : 'пост остановлен'}`);
    }
  };

  return <div className="app-shell">
    <a className="skip-link" href="#main">Перейти к содержимому</a>
    <aside className="sidebar">
      <a className="brand" href="#overview" aria-label="Qostanai Twin, обзор"><span className="brand-mark">Q<span/></span><span>QOSTANAI<strong>TWIN<span className="brand-dot">.</span></strong></span></a>
      <div className="workspace-label">ПРОИЗВОДСТВО</div>
      <nav aria-label="Основная навигация">
        {([['overview', 'grid', 'Обзор'], ['case', 'line', 'Данные кейса'], ['agent', 'pulse', 'ИИ-агент'], ['production', 'line', 'Линия'], ['scenarios', 'layers', 'Сценарии'], ['events', 'pulse', 'События'], ['history', 'clock', 'История'], ['archive', 'box', 'Архив'], ['settings', 'tool', 'Настройки'], ['demo', 'play', 'Показ']] as const).map(([id, icon, label]) => <a key={id} aria-label={label} aria-current={activeSection === id ? 'location' : undefined} className={activeSection === id ? 'nav-item active' : 'nav-item'} href={`#${id}`} onClick={() => setActiveSection(id)}><Icon name={icon}/><span>{label}</span>{id === 'events' && activeIncidents.length > 0 && <span className="nav-count">{activeIncidents.length}</span>}</a>)}
      </nav>
      <div className="sidebar-bottom"><span className="sidebar-building"><Icon name="line" size={24}/></span><strong>Участок сборки</strong><span>Линия 01 · 5 постов</span><div className="sidebar-divider"/><span className="simulation-label"><i/> Демонстрационная модель</span><small>История сохраняется на сервере</small></div>
    </aside>

    <main id="main">
      <header className="topbar"><span>Производство <span className="breadcrumb-slash">/</span> <strong>{activeSection === 'case' ? 'Данные кейса' : activeSection === 'agent' ? 'ИИ-агент' : 'Мониторинг линии'}</strong></span><div className="connection-group"><span className={`connection-status ${disconnected && activeSection !== 'case' ? 'offline' : ''}`} role="status">{activeSection === 'case' ? 'Документ загружен' : disconnected ? 'Связь потеряна' : 'Сервер подключён'}</span><span className="demo-badge"><span/> {activeSection === 'case' ? 'Тестовый набор кейса' : 'Демонстрационные данные'}</span></div></header>
      <div className="page-content" id="overview">
        <CaseDataPanel visible={activeSection === 'case'}/>
        <AgentPanel visible={activeSection === 'agent'} snapshot={snapshot}/>
        <div hidden={activeSection === 'case' || activeSection === 'agent'}>
        <section className="page-heading">
          <div><div className="eyebrow">ОПЕРАТИВНЫЙ МОНИТОРИНГ</div><h1>Производственная линия</h1><p>Участок сборки <span>•</span> Смена 01 <span>•</span> 08:00–16:00</p></div>
          <div className="shift-clock"><Icon name="clock" size={18}/><div><strong>{modelTime(state.elapsedSec, true)}</strong><span>Время модели · {disconnected ? 'нет связи' : ended ? 'смена завершена' : paused ? 'пауза' : `${speed}×`}</span></div></div>
        </section>
        {disconnected && <div className="error-banner" role="alert">{error || 'Данные не обновлялись более 5 секунд.'} Показаны последние полученные значения. Управление временно недоступно. <button onClick={refresh}>Повторить</button></div>}
        {actionError && <div className="error-banner" role="alert">{actionError} <button onClick={() => setActionError(null)}>Закрыть</button></div>}

        <section className="kpi-grid" aria-label="Показатели смены">
          <article className="kpi-card"><div className="kpi-label">Годный выпуск <Icon name="box"/></div><div className="kpi-number">{state.good}<span>/ {state.shiftPlan}</span></div><div className="kpi-track"><span style={{ width: `${Math.min(100, state.good / state.shiftPlan * 100)}%` }}/></div><div className="kpi-note">{number(state.good / state.shiftPlan * 100)}% плана смены</div></article>
          <article className="kpi-card forecast-kpi"><div className="kpi-label">Прогноз к 16:00 <Icon name="pulse"/></div><div className="kpi-number">{prediction.goodAtShiftEnd}<span>изделий</span></div><div className={`delta ${prediction.planDelta < 0 ? 'negative' : ''}`}><Icon name={prediction.planDelta < 0 ? 'alert' : 'check'} size={15}/>{prediction.planDelta >= 0 ? `На ${prediction.planDelta} выше плана` : `На ${Math.abs(prediction.planDelta)} ниже плана`}</div><div className="kpi-note">При сохранении текущего режима</div></article>
          <article className="kpi-card"><div className="kpi-label">Простои оборудования <Icon name="clock"/></div><div className="kpi-number">{number(downtime / 60)}<span>мин</span></div><div className={`kpi-status ${stopped ? 'text-red' : ''}`}>{stopped ? `Остановлено постов: ${stopped}` : 'Остановленных постов нет'}</div><div className="kpi-note">Сумма времени остановок постов</div></article>
          <article className="kpi-card"><div className="kpi-label">Доля брака <Icon name="shield"/></div><div className="kpi-number">{number(rejectionRate)}<span>%</span></div><div className="kpi-status">{state.rejected} из {completed} изделий</div><div className="kpi-note">По результатам выходного контроля</div></article>
        </section>

        <DemoGuide snapshot={snapshot} disabled={controlsDisabled} visible={activeSection === 'demo'} comparison={demoComparison} onCommand={async (command, expected) => {
          if (controlsDisabled || latest.current?.runId !== expected.runId || latest.current?.revision !== expected.revision) {
            setActionError('Данные изменились перед выполнением шага. Проверьте подсказки и повторите действие.');
            return null;
          }
          if (!await send(command, expected.runId)) return null;
          setSelectedId('P03');
          return latest.current;
        }} onCompare={() => {
          setSelectedId('P03'); setDemoComparison(null); setDemoRequest(n => n + 1);
          location.hash = 'scenarios'; setActiveSection('scenarios');
          document.getElementById('scenarios')?.scrollIntoView();
        }}/>

        <div className="production-layout" id="production">
          <section className="line-panel panel">
            <div className="panel-heading"><div><span className="section-code">01 /</span><h2>Схема производственного потока</h2></div><span className={`flow-label ${stopped ? 'danger' : slow || prediction.bottleneckId ? 'warning' : ''}`}><i/>{stopped ? 'Поток прерван' : slow || prediction.bottleneckId ? 'Есть ограничение' : 'Поток стабилен'}</span></div>
            <div className="line-canvas">
              <div className="canvas-top"><span>ЛИНИЯ 01</span><span>Подача каждые {state.arrivalIntervalSec} с <Icon name="arrow" size={14}/></span></div>
              <div className="station-flow">
                {state.stations.map((s, i) => <div className="flow-part" key={s.id}>
                  <button className={`station-card ${stationStatus(s)} ${s.id === selectedId ? 'selected' : ''}`} aria-label={`${s.id} ${s.name}: ${STATUS_LABEL[stationStatus(s)]}`} aria-pressed={s.id === selectedId} onClick={() => setSelectedId(s.id)}>
                    <span className="station-top"><span>{s.id}</span><i className="station-led"/></span>
                    <span className="station-symbol"><Icon name={stationIcons[i]} size={29}/></span>
                    <strong>{s.name}</strong>
                    <span className="station-status">{STATUS_LABEL[stationStatus(s)]}</span>
                    <span className="station-progress"><span style={{ width: `${progressPercent(s)}%` }}/></span>
                    <span className="station-cycle">{cycleSec(s)} <span>с / цикл</span></span>
                  </button>
                  {i < state.buffers.length && <div className={`buffer ${state.buffers[i].capacity > 9 ? 'large-buffer' : ''} ${state.buffers[i].count === state.buffers[i].capacity ? 'full' : ''}`} aria-label={`${state.buffers[i].id}: ${state.buffers[i].count} из ${state.buffers[i].capacity} мест занято`}><span className="buffer-id">{state.buffers[i].id}</span><div className="conveyor-track"><span className={!disconnected && !paused && !ended && s.mode !== 'stop' ? 'moving' : ''}/><Icon name="arrow" size={16}/></div><span className="buffer-count">{state.buffers[i].count}<small>/{state.buffers[i].capacity}</small></span><div className="buffer-slots" aria-hidden="true">{Array.from({ length: Math.min(12, state.buffers[i].capacity) }, (_, index) => <i key={index} className={index < Math.ceil(state.buffers[i].count / state.buffers[i].capacity * Math.min(12, state.buffers[i].capacity)) ? 'filled' : ''}/>)}</div></div>}
                </div>)}
              </div>
              <div className="canvas-bottom"><span><i className="legend-dot running"/> Работа</span><span><i className="legend-dot slowed"/> Отклонение</span><span><i className="legend-dot stopped"/> Остановка</span><span><i className="legend-dot starved"/> Ожидание</span><span className="wip-label">В потоке <strong>{wip}</strong></span></div>
            </div>
            <div className="demo-controls"><div className="demo-control-title"><Icon name="play" size={16}/><span>Симуляция</span></div><button className="button compact" disabled={ended || controlsDisabled} onClick={() => send({ type: 'set_playback', paused: !paused })}><Icon name={paused ? 'play' : 'pause'} size={16}/>{paused ? 'Продолжить' : 'Пауза'}</button><label className="speed-label">Скорость <select aria-label="Скорость симуляции" value={speed} disabled={ended || controlsDisabled} onChange={e => send({ type: 'set_playback', speed: Number(e.target.value) as 20 | 60 | 120 })}><option value="20">20×</option><option value="60">60×</option><option value="120">120×</option></select></label><button className="button compact" disabled={ended || controlsDisabled} onClick={() => send({ type: 'advance', seconds: 300 })}>+5 мин</button><button className="reset-button" disabled={controlsDisabled} onClick={() => setResetOpen(true)}><Icon name="reset" size={16}/><span>Сбросить</span></button></div>
            <div className={`insight-bar ${prediction.bottleneckId ? 'has-risk' : ''}`}><span className="insight-icon"><Icon name={prediction.bottleneckId ? 'alert' : 'check'} size={19}/></span><div><strong>{ended ? 'Смена завершена' : prediction.bottleneckId ? `Ограничение на ${prediction.bottleneckId}` : prediction.planDelta < 0 ? 'Риск невыполнения плана' : 'План смены достижим'}</strong><p>{ended ? `Выпущено ${state.good} годных изделий при плане ${state.shiftPlan}. Для нового сценария сбросьте симуляцию.` : prediction.explanation}</p>{prediction.minutesToFill !== null && !ended && <span className="eta">{prediction.minutesToFill <= 0 ? `${prediction.fillBufferId}: буфер заполнен` : `${prediction.fillBufferId}: заполнение примерно через ${number(prediction.minutesToFill)} мин`}</span>}</div></div>
          </section>

          <aside className="detail-panel panel" aria-label="Карточка выбранного поста">
            <div className="detail-heading"><span>ВЫБРАННЫЙ ПОСТ</span><strong>{selected.id}</strong></div>
            <div className="detail-title"><span className="detail-icon"><Icon name={stationIcons[state.stations.indexOf(selected)]} size={24}/></span><div><h2>{selected.name}</h2><span className={`status-tag ${selectedStatus}`}>{STATUS_LABEL[selectedStatus]}</span></div></div>
            <p className="detail-operation">{selected.operation}</p>
            <dl className="station-metrics"><div><dt>Время цикла</dt><dd>{cycleSec(selected)} <span>с</span>{selected.mode === 'slow' && <em>×2</em>}</dd></div><div><dt>Норматив</dt><dd>{selected.nominalCycleSec} <span>с</span></dd></div><div><dt>Обработано</dt><dd>{selected.completed} <span>шт.</span></dd></div><div><dt>Загрузка за смену</dt><dd>{number(selected.busySec / state.elapsedSec * 100)} <span>%</span></dd></div><div><dt>Время остановки</dt><dd>{number(selected.downtimeSec / 60)} <span>мин</span></dd></div></dl>
            <div className="station-actions"><div className="action-label">СЦЕНАРИЙ ДЛЯ {selected.id}</div><div className="action-pair"><button className="button warning-button" disabled={ended || controlsDisabled || selected.mode === 'slow'} onClick={() => operate('slow')}><Icon name="clock" size={16}/>Замедлить ×2</button><button className="button danger-button" disabled={ended || controlsDisabled || selected.mode === 'stop'} onClick={() => operate('stop')}><span className="stop-square"/>Остановить</button></div><button className="button restore-button" disabled={ended || controlsDisabled || selected.mode === 'normal'} onClick={() => operate('normal')}><Icon name="play" size={16}/>Восстановить работу</button><p>Команды меняют только модель линии.</p></div>
          </aside>
        </div>

        <ScenarioPanel snapshot={snapshot} source={source.current} selectedId={selectedId} onSelect={setSelectedId} disabled={controlsDisabled} demoRequest={demoRequest} onReport={setDemoComparison}/>

        <section className="bottom-grid">
          <article className="chart-panel panel"><div className="panel-heading"><div><span className="section-code">03 /</span><h2>Выпуск за смену</h2></div><span className="muted">Годные изделия</span></div><div className="chart-legend"><span><i className="chart-key actual"/>Факт</span><span><i className="chart-key projected"/>Прогноз</span><span><i className="chart-key planned"/>План</span></div><OutputChart snapshot={snapshot}/><div className="chart-footnote">Прогноз рассчитан в {modelTime(prediction.calculatedAtSec)} · режимы до конца смены сохраняются</div></article>
          <article className="events-panel panel" id="events"><div className="panel-heading"><div><span className="section-code">04 /</span><h2>События линии</h2></div><span className="event-counter">{activeIncidents.length} активных</span></div><div className="event-filters" role="group" aria-label="Фильтр событий"><button aria-pressed={filter === 'all'} className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>Все события</button><button aria-pressed={filter === 'active'} className={filter === 'active' ? 'active' : ''} onClick={() => setFilter('active')}>Активные</button></div><div className="event-list">{visibleIncidents.length === 0 ? <div className="empty-events"><Icon name="check" size={22}/><div><strong>Активных инцидентов нет</strong><span>События появятся при изменении режима поста.</span></div></div> : visibleIncidents.map(incident => <div className={`event-row ${incident.severity}`} key={incident.id}><span className="event-icon"><Icon name={incident.severity === 'info' ? 'check' : 'alert'} size={17}/></span><div className="event-text"><strong>{incident.title}</strong><span>{incident.detail}</span>{incident.severity !== 'info' && <small>{incident.resolvedAtSec !== null ? `Устранён в ${modelTime(incident.resolvedAtSec)}` : incident.acknowledged ? 'Принят в работу' : 'Требует внимания'}</small>}</div><div className="event-meta"><time>{modelTime(incident.startedAtSec)}</time>{incident.resolvedAtSec === null && !incident.acknowledged && <button disabled={controlsDisabled} onClick={() => send({ type: 'acknowledge_incident', incidentId: incident.id })}>Принять</button>}</div></div>)}</div></article>
        </section>
        <HistoryPanel snapshot={snapshot}/>
        <ArchivePanel currentRunId={snapshot.runId} currentRevision={snapshot.revision}/>
        <SettingsPanel snapshot={snapshot} disabled={controlsDisabled} onApply={async (command, expectedRunId) => {
          if (!await send(command, expectedRunId)) return null;
          setSelectedId('P03'); setNotice('Новый сценарий создан с заданными параметрами.');
          return latest.current!.runId;
        }}/>
        <footer className="page-footer"><span>Qostanai Twin <span>·</span> Прототип цифрового двойника</span><span>Условный участок · модельный прогноз, без ИИ</span></footer>
        </div>
      </div>
    </main>
    <div className={`toast ${notice ? 'visible' : ''}`} role="status" aria-live="polite"><Icon name="check" size={18}/>{notice}</div>
    <dialog ref={resetDialog} className="reset-dialog" onCancel={() => setResetOpen(false)} onClose={() => setResetOpen(false)}><Icon name="reset" size={28}/><h2>Начать сценарий заново?</h2><p>Линия вернётся к 08:45 на паузе. План, нормативы и буферы сохранятся. История текущего сценария останется в архиве сервера.</p>{(actionError || disconnected) && <p role="alert">{actionError || 'Нет связи с сервером. Дождитесь восстановления подключения.'}</p>}<div><button className="button" autoFocus onClick={() => setResetOpen(false)}>Отмена</button><button className="button primary" disabled={controlsDisabled} onClick={async () => { if (await send({ type: 'reset' })) { setSelectedId('P03'); setResetOpen(false); setNotice('Новый сценарий создан. Предыдущая история сохранена.'); } }}>Сбросить сценарий</button></div></dialog>
  </div>;
}
