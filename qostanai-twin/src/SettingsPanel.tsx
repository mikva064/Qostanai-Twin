import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { TwinCommand, TwinSnapshot } from './types.ts';
import { configurationDraft, configurationFromState, configurationsEqual, defaultConfiguration, validateConfiguration } from './configuration.ts';
import './settings.css';

export default function SettingsPanel({ snapshot, disabled, onApply }: {
  snapshot: TwinSnapshot; disabled: boolean;
  onApply: (command: TwinCommand, expectedRunId: string) => Promise<string | null>;
}) {
  const [draft, setDraft] = useState(() => configurationDraft(configurationFromState(snapshot.state)));
  const [baseRunId, setBaseRunId] = useState(snapshot.runId);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const applying = useRef(false);
  const changedRun = snapshot.runId !== baseRunId;
  const supported = snapshot.capabilities?.includes('configure_line') ?? false;
  const { value, errors } = validateConfiguration(draft);
  const locked = busy || disabled;
  const unchanged = value && configurationsEqual(value, configurationFromState(snapshot.state));
  const setScalar = (key: 'shiftPlan' | 'arrivalIntervalSec', text: string) => { setNotice(''); setDraft(d => ({ ...d, [key]: text })); };
  const setItem = (key: 'stationCyclesSec' | 'bufferCapacities', index: number, text: string) => {
    setNotice(''); setDraft(d => ({ ...d, [key]: d[key].map((v, i) => i === index ? text : v) }));
  };
  const loadCurrent = () => { setDraft(configurationDraft(configurationFromState(snapshot.state))); setBaseRunId(snapshot.runId); setNotice('Загружены параметры текущего сценария.'); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!value || changedRun || locked || !supported || applying.current) return;
    applying.current = true; setBusy(true); setNotice('');
    try {
      const nextRunId = await onApply({ type: 'configure_line', configuration: value }, baseRunId);
      if (nextRunId) {
        setBaseRunId(nextRunId);
        setNotice('Создан новый сценарий. Параметры сохранены.');
      } else setNotice('Параметры не подтверждены. Проверьте сообщение сервера; черновик сохранён.');
    } finally { applying.current = false; setBusy(false); }
  };
  const field = (key: string, label: string, text: string, min: number, max: number, change: (v: string) => void) =>
    <label className="settings-field" key={key} htmlFor={`config-${key}`}><span>{label}</span><input id={`config-${key}`} type="number" inputMode="numeric" min={min} max={max} step="1" value={text} disabled={locked} aria-invalid={!!errors[key]} aria-describedby={errors[key] ? `config-error-${key}` : undefined} onChange={e => change(e.target.value)}/><small id={`config-error-${key}`} className={errors[key] ? 'settings-field-error' : ''}>{errors[key] || `${min}–${max}`}</small></label>;
  return <section id="settings" className="panel settings-panel" aria-labelledby="settings-title">
    <div className="panel-heading"><div><span className="section-code">07 /</span><h2 id="settings-title">Настройки участка</h2></div><span className="scenario-badge">Параметры нового сценария</span></div>
    <div className="settings-body">
      <p className="scenario-intro">Задайте план, нормативы операций и размер очередей. Применение создаст новый сценарий на паузе в 08:45; прежний останется в архиве со своими параметрами.</p>
      {!supported && <p className="scenario-stale" role="status">Для применения настроек нужен сервер 0.6. Перезапустите start.cmd и обновите страницу. Черновик можно подготовить сейчас.</p>}
      {changedRun && <div className="settings-conflict" role="alert"><p>Текущий сценарий изменился. Черновик сохранён, но применить его к другому запуску нельзя.</p><button className="button compact" disabled={locked} onClick={loadCurrent}>Загрузить актуальные параметры</button></div>}
      <form onSubmit={submit} noValidate>
        <div className="settings-general">{field('shiftPlan', 'План смены, годных изделий', draft.shiftPlan, 1, 100000, v => setScalar('shiftPlan', v))}{field('arrivalIntervalSec', 'Интервал подачи, с', draft.arrivalIntervalSec, 5, 3600, v => setScalar('arrivalIntervalSec', v))}<div className="settings-fixed"><strong>Смена 08:00–16:00</strong><p>Первые 45 минут будут рассчитаны по новым параметрам. Режимы постов — нормальные.</p></div></div>
        <fieldset className="settings-fieldset" disabled={locked}><legend>Нормативное время операций, с</legend><div className="settings-stations">{draft.stationCyclesSec.map((v, i) => field(`P0${i+1}`, `P0${i+1} · ${snapshot.state.stations[i].name}`, v, 5, 3600, text => setItem('stationCyclesSec', i, text)))}</div></fieldset>
        <fieldset className="settings-fieldset" disabled={locked}><legend>Вместимость буферов, изделий</legend><div className="settings-buffers">{draft.bufferCapacities.map((v, i) => field(`B0${i+1}`, `B0${i+1} · P0${i+1} → P0${i+2}`, v, 1, 100, text => setItem('bufferCapacities', i, text)))}</div></fieldset>
        {value && <p className="settings-preview">Новый сценарий: план <strong>{value.shiftPlan}</strong>, подача каждые <strong>{value.arrivalIntervalSec} с</strong>, всего <strong>{value.bufferCapacities.reduce((sum, n) => sum+n, 0)} мест</strong> в буферах.{unchanged && ' Параметры совпадают с текущими; начнётся повторный запуск.'}</p>}
        <div className="settings-actions"><button className="button primary" type="submit" disabled={locked || changedRun || !supported || !value}>{busy ? 'Создаём сценарий…' : 'Применить и начать сценарий'}</button><button className="button" type="button" disabled={locked} onClick={() => { setDraft(configurationDraft(defaultConfiguration())); setNotice('Базовые параметры загружены в форму. Нажмите «Применить и начать сценарий», чтобы запустить модель.'); }}>Базовые параметры</button><button className="button" type="button" disabled={locked} onClick={loadCurrent}>Вернуть текущие</button></div>
      </form>
      {notice && <p className="settings-notice" role="status">{notice}</p>}
      <details className="settings-note data-help"><summary>О параметрах расчёта</summary><p>Пять последовательных постов, один тип изделия, без перерывов. В симуляции брак задан правилом: каждое 25-е изделие. Для проверки CSV с этими нормативами откройте <a href="#history">«История»</a> и выберите «Копия текущих настроек». Каждый отчёт хранит параметры своего расчёта.</p></details>
    </div>
  </section>;
}
