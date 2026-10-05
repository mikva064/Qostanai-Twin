import { useRef, useState } from 'react';
import { demoActionStages, demoChecks, demoCommand, matchesDemoComparison, matchesDemoStage } from './demo-guide.ts';
import type { DemoAction, DemoStage } from './demo-guide.ts';
import type { ScenarioComparison, TwinCommand, TwinSnapshot } from './types.ts';
import './demo-guide.css';
import ReadinessPanel from './ReadinessPanel.tsx';

const steps = [
  { title: 'Подготовка', speech: 'Один условный участок: пять постов, четыре буфера. Все параметры и цифры учебные; подключение к оборудованию и обученный ИИ пока не реализованы.', target: 'overview' },
  { title: 'Обзор линии', speech: 'План — 410 годных изделий. Сейчас 08:45, выпущено 37. При сохранении нормального режима прогноз к концу смены — 423.', target: 'production' },
  { title: 'Остановка P03', speech: 'Мы остановили P03. Теперь продвинем модель ровно на 15 минут и посмотрим, как остановка повлияет на очереди и выпуск.', target: 'production' },
  { title: 'Последствия', speech: 'Сейчас 09:00, выпущено 39 годных. Перед P03 накопились изделия, следующие посты ждут. Если сохранить остановку до конца смены, выпуск останется равен 39.', target: 'events' },
  { title: 'Выбор решения', speech: 'Без восстановления — 39 годных, при восстановлении сейчас — 421, через 30 минут — 394. Ожидание стоит 27 модельных изделий. Это условный расчёт, а не подтверждённая экономия предприятия.', target: 'scenarios' },
  { title: 'Восстановление', speech: 'P03 снова в нормальном режиме. Продвинем время ещё на пять минут. Прошлое сравнение относится к состоянию до восстановления и должно показываться как устаревшее.', target: 'production' },
  { title: 'История и проверка', speech: 'Поток возобновился. В истории можно загрузить CSV, проверить прошлые прогнозы и сравнить нормативы. На учебной смене MAE модели — 134,67, по темпу — 21; точность ещё предстоит проверить на независимых данных.', target: 'history' },
];
const stages: (DemoStage | null)[] = [null, 'initial', 'stopped', 'impact', 'impact', 'restored', 'recovered'];

export default function DemoGuide({ snapshot, disabled, visible, comparison, onCommand, onCompare }: {
  snapshot: TwinSnapshot; disabled: boolean; visible: boolean; comparison: ScenarioComparison | null;
  onCommand: (command: TwinCommand, expected: { runId: string; revision: number }) => Promise<TwinSnapshot | null>;
  onCompare: () => void;
}) {
  const [session, setSession] = useState<{ runId: string; step: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const applying = useRef(false);
  const step = session?.step ?? 0, content = steps[step], stage = stages[step];
  const changedRun = !!session && session.runId !== snapshot.runId;
  const checks = stage ? demoChecks(snapshot, stage) : [];
  const ready = !!session && !changedRun && checks.every(check => check.ok);
  const compared = ready && matchesDemoComparison(comparison, snapshot);
  const locked = disabled || busy;
  const perform = async (action: DemoAction, nextStep: number) => {
    if (locked || applying.current) return;
    applying.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const command = demoCommand(action, snapshot, session?.runId, comparison);
      const result = await onCommand(command, { runId: snapshot.runId, revision: snapshot.revision });
      if (!result) throw new Error('Выполнение шага не подтверждено. Проверьте сообщение сервера и текущее состояние линии.');
      const target = action === 'prepare' ? 'initial' : demoActionStages[action].after;
      if (action === 'prepare' ? result.runId === snapshot.runId : result.runId !== session?.runId) throw new Error('Сценарий изменился во время команды. Начните показ заново.');
      if (!matchesDemoStage(result, target)) throw new Error('Ответ сервера отличается от контрольного состояния. Шаг не засчитан; проверьте линию перед продолжением.');
      setSession({ runId: result.runId, step: nextStep });
      setNotice(action === 'prepare' ? 'Учебная линия подготовлена. Время модели на паузе.' : 'Шаг подтверждён состоянием сервера.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось выполнить шаг.'); }
    finally { applying.current = false; setBusy(false); }
  };
  const syncTarget = step === 1 ? { stage: 'stopped' as const, step: 2 } : step === 2 ? { stage: 'impact' as const, step: 3 } : step === 5 ? { stage: 'recovered' as const, step: 6 } : null;
  const canSync = !!session && !changedRun && syncTarget && matchesDemoStage(snapshot, syncTarget.stage);
  return <><section className="demo-guide panel" id="demo" aria-labelledby="demo-title" hidden={!visible}>
    <div className="panel-heading"><div><span className="section-code">Показ /</span><h2 id="demo-title">Сценарий для отбора</h2></div><span className="scenario-badge">9 октября · около 2 минут</span></div>
    <div className="demo-guide-body">
      <ReadinessPanel runId={snapshot.runId} revision={snapshot.revision}/>
      {!session ? <><p className="scenario-intro">Проведите показ от остановки линии до решения о восстановлении. Подсказки сверяют каждый шаг с данными сервера.</p><p className="demo-guide-note">«Начать учебный показ» создаст новый сценарий с учебными нормативами на 08:45 и на паузе. Текущий запуск останется в архиве. Дальнейшие команды выполняются только по нажатию кнопок.</p></> : <ol className="demo-guide-steps" aria-label="Этапы показа">{steps.slice(1).map((item, i) => <li key={item.title} className={i + 1 === step ? 'active' : i + 1 < step ? 'done' : ''} aria-current={i + 1 === step ? 'step' : undefined}><span>{i + 1}</span>{item.title}</li>)}</ol>}
      <div className="demo-guide-prompt"><div><span className="demo-guide-kicker">{session ? `Шаг ${step} из 6 · ${content.title} · реплика после проверки` : 'Главная мысль'}</span><p>{content.speech}</p></div>{session && <a className="button compact" href={`#${content.target}`}>Показать раздел ↗</a>}</div>
      {changedRun && <p className="settings-conflict" role="alert">В другой вкладке или разделе начат новый сценарий. Этот показ привязан к прежнему запуску; начните его заново.</p>}
      {session && <ul className="demo-guide-checks" aria-label="Проверка контрольного состояния">{checks.map(check => <li key={check.label} className={check.ok && !changedRun ? 'ok' : 'mismatch'}><span>{check.ok && !changedRun ? '✓' : '!'}</span><div><strong>{check.label}</strong><span>{check.actual}</span>{!check.ok && <small>Ожидается: {check.expected}</small>}</div></li>)}</ul>}
      {session && !ready && !changedRun && <p className="settings-conflict" role="status">Состояние отличается от этого шага. Верните модель на паузу и проверьте время. Если сценарий изменён, начните показ заново.</p>}
      {step === 4 && <div className={`demo-guide-comparison ${compared ? 'confirmed' : ''}`} role="status">{compared ? <><strong>Расчёт подтверждён: 39 / 421 / 394</strong><span>Потери от ожидания 30 минут — 27 годных изделий.</span></> : <><strong>Сначала получите расчёт в «Сценариях»</strong><span>Откройте сравнение P03, оставьте ожидание 30 минут и нажмите «Сравнить варианты». Подтверждение появится после ответа сервера.</span></>}</div>}
      <div className="demo-guide-actions">
        {!session && <button className="button primary" disabled={locked} onClick={() => void perform('prepare', 1)}>{busy ? 'Готовим…' : 'Начать учебный показ'}</button>}
        {step === 1 && <button className="button primary" disabled={locked || !ready} onClick={() => void perform('stop', 2)}>Остановить P03</button>}
        {step === 2 && <button className="button primary" disabled={locked || !ready} onClick={() => void perform('advance15', 3)}>+15 модельных минут</button>}
        {(step === 3 || step === 4) && <button className="button" disabled={locked || !ready} onClick={() => { setSession(s => s && ({ ...s, step: 4 })); setError(''); setNotice(''); onCompare(); }}>Открыть сравнение P03</button>}
        {step === 4 && <button className="button primary" disabled={locked || !compared} onClick={() => void perform('restore', 5)}>Восстановить P03</button>}
        {step === 5 && <button className="button primary" disabled={locked || !ready} onClick={() => void perform('advance5', 6)}>+5 модельных минут</button>}
        {step === 6 && ready && <a className="button primary" href="#history">Показать проверку CSV ↗</a>}
        {canSync && <button className="button" disabled={locked} onClick={() => { setSession(s => s && ({ ...s, step: syncTarget!.step })); setError(''); setNotice('Ручное действие подтверждено: продолжайте с текущего шага.'); }}>Продолжить по состоянию линии</button>}
        {session && <button className="button" disabled={locked} onClick={() => void perform('prepare', 1)}>Начать показ заново</button>}
        {session && <button className="button" disabled={busy} onClick={() => { setSession(null); setError(''); setNotice('Подсказки закрыты. Состояние линии сохраняется.'); }}>Закрыть подсказки</button>}
      </div>
      {error && <p className="history-errors" role="alert">{error}</p>}{notice && <p className="demo-guide-note" role="status">{notice}</p>}
      <p className="demo-guide-footnote">Время модели проходит только по вашим командам на паузе. После обновления страницы подсказки начинаются с подготовки, состояние линии сохраняется на сервере. Для запасного показа используйте локальную презентацию.</p>
    </div>
  </section>{session && !visible && <a className="demo-guide-return" href="#demo">Показ · шаг {step}/6 <span>К подсказкам ↑</span></a>}</>;
}
