import { useMemo, useState } from 'react';
import rawDataset from './case-dataset.json' with { type: 'json' };
import { analyzeCase, CASE_SECTIONS, caseDates, caseDateLabel, caseExport, caseRate, parseCaseDataset, SECTION_LABELS } from './case-analysis.ts';
import type { CaseSection } from './case-analysis.ts';
import './case-data.css';

const parsed = (() => { try { return { data: parseCaseDataset(rawDataset), error: '' }; } catch (error) { return { data: null, error: String(error) }; } })();
const fmt = (value: number, digits = 1) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(value);

export default function CaseDataPanel({ visible = true }: { visible?: boolean }) {
  const data = parsed.data;
  const [date, setDate] = useState(() => data ? caseDates(data).at(-1)! : '');
  const [section, setSection] = useState<CaseSection>('painting');
  const [question, setQuestion] = useState<'priorities' | 'plan' | 'ai'>('priorities');
  const report = useMemo(() => data ? analyzeCase(data, date) : null, [data, date]);
  if (!data || !report) return <section id="case" hidden={!visible} className="case-data"><p role="alert">{parsed.error}</p></section>;
  const row = report.rows.find(item => item.section === section);
  const days = caseDates(data);
  const history = data.production.filter(item => item.section === section && item.date <= date).sort((a, b) => a.date.localeCompare(b.date));
  const exportReport = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(caseExport(data, date), null, 2)], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `zauyt-ai-case-${date}.json`; document.body.append(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section id="case" className="case-data" hidden={!visible} aria-labelledby="case-title">
    <div className="case-heading"><div><div className="eyebrow">ПРОИЗВОДСТВЕННЫЕ ПОКАЗАТЕЛИ</div><h1 id="case-title">Завод в цифрах</h1><p>Сварка, окраска и сборка — план, качество и зарегистрированные простои.</p></div></div>
    <div className="case-toolbar"><label>Дата среза<select value={date} onChange={event => setDate(event.target.value)}>{days.map(day => <option key={day} value={day}>{caseDateLabel(day)}</option>)}</select></label><button className="button compact" onClick={exportReport}>Скачать отчёт ↓</button></div>

    <div className="case-kpis" aria-label="Производственные показатели">
      <article><span>Выпуск на сборке</span><strong>{report.assembly?.actual ?? '—'}<small>/ {report.assembly?.plan ?? '—'}</small></strong><p>{report.assembly ? `${fmt(report.assembly.planPct)}% плана на дату` : 'Нет записи на дату'}</p></article>
      <article className={report.qualityBreaches.length ? 'attention' : ''}><span>Качество требует внимания</span><strong>{report.qualityBreaches.length}<small>/ {report.rows.filter(item => item.quality).length} участков</small></strong><p>Расчётная доля брака выше {fmt(data.rules.maxDefectPct)}%</p></article>
      <article><span>Месячный план по моделям</span><strong>{fmt(report.monthlyPlan)}<small>/ {fmt(data.rules.monthlyTarget)}</small></strong><p>Разница с общей целью: {fmt(report.monthlyGap)} автомобилей</p></article>
      <article><span>OEE · цель ≥ {data.rules.oeeTargetPct}%</span><strong className="case-unavailable">Нет расчёта</strong><p>Нужны нормативный цикл, плановое время и границы периода</p></article>
    </div>

    <div className="panel case-flow-panel"><div className="panel-heading"><div><span className="section-code">Маршрут /</span><h2>Производственный маршрут</h2></div></div><div className="case-flow" aria-label="Участки производства">{data.topology.map((label, index) => {
      const id = CASE_SECTIONS.find(key => SECTION_LABELS[key] === label);
      const stage = report.rows.find(item => item.section === id);
      const warning = stage && ((stage.defectPct ?? 0) > data.rules.maxDefectPct || stage.planGap > 0);
      return <div key={label} className="case-flow-step"><button disabled={!id} aria-pressed={id ? section === id : undefined} className={`${id && section === id ? 'selected' : ''} ${warning ? 'attention' : ''}`} onClick={() => id && setSection(id)}><span className="case-stage-index">0{index + 1}</span><strong>{label}</strong><span>{stage ? `${stage.actual} / ${stage.plan} · брак ${stage.defectPct === null ? 'нет данных' : fmt(stage.defectPct) + '%'}` : 'Нет измерений'}</span></button>{index < data.topology.length - 1 && <span className="case-flow-arrow" aria-hidden="true">→</span>}</div>;
    })}</div></div>

    <div className="case-columns">
      <article className="panel case-detail"><div className="panel-heading"><div><span className="section-code">Участок /</span><h2>{SECTION_LABELS[section]}</h2></div><label className="case-section-select"><span className="case-visually-hidden">Участок для подробного просмотра</span><select value={section} onChange={event => setSection(event.target.value as CaseSection)}>{CASE_SECTIONS.map(id => <option key={id} value={id}>{SECTION_LABELS[id]}</option>)}</select></label></div>
        <div className="case-detail-body">{row ? <><div className="case-line-numbers"><div><span>Факт / план</span><strong>{row.actual} / {row.plan}</strong></div><div><span>Брак</span><strong>{row.quality ? `${row.quality.rejected} ед.` : 'Нет данных'}</strong></div><div><span>Загрузка</span><strong>{fmt(row.utilizationPct)}%</strong></div><div><span>Время работы</span><strong>{fmt(row.operatingHours)} ч</strong></div></div></> : <p>На выбранную дату нет записи по участку.</p>}
          <h3>План и факт по доступным датам</h3><div className="case-output-bars">{history.map(item => <div className="case-output-row" key={item.date}><span>{caseDateLabel(item.date)}</span><div className="case-bar-track"><span style={{ width: `${Math.min(100, item.actual / Math.max(item.plan, item.actual) * 100)}%` }}/><i style={{ left: `${Math.min(99.5, item.plan / Math.max(item.plan, item.actual) * 100)}%` }}/></div><strong>{item.actual} / {item.plan}</strong></div>)}</div><p className="case-footnote">Полоса — факт; отметка — план.</p>
          <div className="case-table-scroll" tabIndex={0} aria-label="Качество выбранного участка"><table><thead><tr><th>Дата</th><th>Выпущено</th><th>Брак</th><th>Доля брака</th></tr></thead><tbody>{history.map(item => {
            const quality = data.quality.find(q => q.date === item.date && q.section === section);
            const rate = quality ? caseRate(quality.rejected, quality.produced) : null;
            return <tr key={item.date}><th>{caseDateLabel(item.date)}</th><td>{quality?.produced ?? '—'}</td><td>{quality?.rejected ?? '—'}</td><td className={rate !== null && rate > data.rules.maxDefectPct ? 'case-breach' : ''}>{rate === null ? '—' : `${fmt(rate, 2)}%`}</td></tr>;
          })}</tbody></table></div>
        </div>
      </article>

      <article className="panel case-assistant"><div className="panel-heading"><div><span className="section-code">Аналитика /</span><h2>Помощник руководителя</h2></div></div><div className="case-assistant-body"><p className="case-assistant-intro">Отклонения и приоритетные действия на {caseDateLabel(date)}.</p><div className="case-questions" role="group" aria-label="Вопрос помощнику">{([['priorities', 'Что проверить первым?'], ['plan', 'Сходится ли план?'], ['ai', 'О прогнозе']] as const).map(([id, label]) => <button key={id} aria-pressed={question === id} onClick={() => setQuestion(id)}>{label}</button>)}</div>
        <div aria-live="polite">{question === 'priorities' && <div className="case-insights">{report.insights.length ? report.insights.map(insight => <div className={`case-insight ${insight.severity}`} key={insight.id}><h3>{insight.title}</h3><p>{insight.evidence}</p><p className="case-next-action">{insight.action}</p><small>{insight.source}</small></div>) : <p>По доступным записям отклонений от проверяемых порогов нет. Это не подтверждает отсутствие незарегистрированных событий.</p>}</div>}
          {question === 'plan' && <div className="case-insight attention"><h3>{report.monthlyGap ? `Нужно уточнить разницу ${fmt(report.monthlyGap)}` : 'Сумма планов достигает общей цели'}</h3><p>{data.monthlyPlans.map(item => `${item.model}: ${fmt(item.plan)}`).join(' + ')} = {fmt(report.monthlyPlan)}. Общая цель — не менее {fmt(data.rules.monthlyTarget)} в месяц.</p><p className="case-next-action">Уточнить, все ли модели перечислены и к одному ли месяцу относятся цифры. Это расхождение исходного плана; прогноз месячного недовыпуска по двум датам не рассчитан.</p><small>Таблица «Производственный план» и «Дополнительные вводные»</small></div>}
          {question === 'ai' && <div className="case-ai-note"><h3>{days.length} даты · {data.production.length} записей о линиях</h3><p>Этого набора хватает для демонстрации анализа отклонений. Он не позволяет подтвердить точность прогноза простоя или обучить надёжную модель.</p><ul><li>Время начала и конца каждого простоя, состояние оборудования и его критичность.</li><li>Показания датчиков до события, режим работы и отметки обслуживания.</li><li>Смены, нормативные циклы, выпуск и дефекты с привязкой ко времени.</li><li>Более длинная история для обучения и отдельный более поздний период для проверки; сравнение с простым прогнозом по темпу.</li></ul><p>Сейчас: объяснимые правила. OEE, вероятность отказа и дата следующего простоя не выдаются как рассчитанные показатели.</p></div>}
        </div></div>
      </article>
    </div>

    <article className="panel case-records"><div className="panel-heading"><div><span className="section-code">Журнал /</span><h2>Простои за {caseDateLabel(date)}</h2></div><span className="case-muted">{report.downtime.length} записи</span></div><div className="case-table-scroll" tabIndex={0} aria-label="Журнал простоев"><table><thead><tr><th>Участок</th><th>Оборудование</th><th>Причина</th><th>Длительность</th><th>Критичность</th></tr></thead><tbody>{report.downtime.map((item, index) => <tr key={index}><th>{SECTION_LABELS[item.section]}</th><td>{item.equipment}</td><td>{item.reason}</td><td>{item.minutes} мин</td><td>{item.critical === null ? 'Не указана' : item.critical ? 'Критическое' : 'Некритическое'}</td></tr>)}</tbody></table>{!report.downtime.length && <p className="case-footnote">Записей на дату нет; отсутствие простоев не подтверждено.</p>}</div></article>

    <article className="panel case-monthly"><div className="panel-heading"><div><span className="section-code">План /</span><h2>Модели автомобилей</h2></div><span className="case-muted">Месяц не указан</span></div><div className="case-models">{data.monthlyPlans.map(item => <div key={item.model}><strong>{item.model}</strong><span>{fmt(item.plan)} автомобилей</span><div className="case-bar-track"><span style={{ width: `${Math.min(100, item.plan / data.rules.monthlyTarget * 100)}%` }}/></div></div>)}</div><p className="case-plan-gap">Всего {fmt(report.monthlyPlan)} из целевых {fmt(data.rules.monthlyTarget)} · разница {fmt(report.monthlyGap)}.</p></article>

    <details className="panel case-provenance"><summary>О данных и расчётах</summary><p>Источник — тестовый документ кейса за 1–2 октября 2026 года. Это исторические итоги; они не обновляются вместе с симуляцией линии. Помощник применяет правила и пороги, модель машинного обучения на этом наборе не обучалась.</p><p>Выпуск на сборке — результат участка, без подтверждения выпуска после ОТК. Выпуск последовательных участков не суммируется. Текущее состояние оборудования из итогов неизвестно.</p><p>Режим работы: {data.rules.schedule.shiftsPerDay} × {data.rules.schedule.hoursPerShift} часов. Номер смены в таблице отсутствует; часы нельзя автоматически делить на 8 или 16 для расчёта доступности.</p><p>Лимит {data.rules.criticalDowntimeMinutesPerDay} мин/сутки относится к критическому оборудованию. Время начала и конца событий не указано. Причины простоев не доказывают причину брака или отклонения выпуска.</p><p>{data.provenance.title}. Файл: <strong>{data.provenance.fileName}</strong>.</p><p>Перенесены все четыре таблицы: {data.production.length} записей работы, {data.downtime.length} простоев, {data.monthlyPlans.length} моделей, {data.quality.length} записей качества; также схема и пять вводных. Проценты брака пересчитаны из счётчиков, исходные округлённые значения сохранены в экспорте.</p><p>Формулы: выполнение плана = факт / план × 100%; доля брака = брак / выпущено × 100%. Изменение доли сравнивается с предыдущей доступной датой. Показатели между участками не складываются в число уникальных автомобилей.</p><p>В файле нет нормативов циклов и буферов. Эти итоги не преобразованы в минутную телеметрию и не подменяют учебную линию из пяти постов. Для отдельного участка без наблюдений показатель остаётся неизвестным.</p><code>SHA-256: {data.provenance.sha256}</code></details>
  </section>;
}
