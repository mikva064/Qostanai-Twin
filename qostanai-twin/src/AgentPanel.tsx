import { useEffect, useRef, useState } from 'react';
import { askAgent, getAgentStatus } from './agent-source.ts';
import type { AgentReply, AgentRequest, AgentScope, AgentStatus } from './agent-source.ts';
import type { TwinSnapshot } from './types.ts';
import './agent.css';
import { agentTextParts } from './agent-format.ts';

const toolNames: Record<string, string> = { get_case_metrics: 'План и качество', get_case_downtime: 'Журнал простоев', get_twin_snapshot: 'Состояние линии', compare_recovery: 'Расчёт вариантов восстановления' };
interface Turn { question: string; reply: AgentReply }

export default function AgentPanel({ visible = true, snapshot = null }: { visible?: boolean; snapshot?: TwinSnapshot | null }) {
  const [status, setStatus] = useState<AgentStatus | null>(null), [error, setError] = useState('');
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<AgentScope>('case'), [date, setDate] = useState('2026-10-02');
  const [question, setQuestion] = useState(''), [turns, setTurns] = useState<Turn[]>([]);
  const token = useRef(0), sending = useRef(false), statusRequest = useRef(0);
  const refresh = async () => {
    const current = ++statusRequest.current; setLoading(true); setError('');
    try { const next = await getAgentStatus(); if (current === statusRequest.current) { setStatus(next); setDate(old => next.dates.includes(old) ? old : [...next.dates].sort().at(-1)!); } }
    catch (e) { if (current === statusRequest.current) { setStatus(null); setError(e instanceof Error ? e.message : 'Не удалось получить настройки.'); } }
    finally { if (current === statusRequest.current) setLoading(false); }
  };
  useEffect(() => { if (visible && !status) void refresh(); }, [visible]);
  useEffect(() => () => { token.current++; statusRequest.current++; }, []);
  useEffect(() => { setTurns([]); setError(''); token.current++; }, [scope, date]);
  const contextKey = scope === 'simulation' ? snapshot?.runId ?? '' : date;
  const previousContext = useRef(contextKey);
  useEffect(() => { if (previousContext.current !== contextKey) { setTurns([]); token.current++; previousContext.current = contextKey; } }, [contextKey]);
  const submit = async () => {
    if (sending.current || !status?.configured || !question.trim() || (scope === 'simulation' && !snapshot)) return;
    const request = ++token.current; sending.current = true; setBusy(true); setError('');
    const asked = question.trim();
    const history = turns.slice(-4).flatMap(turn => [{ role: 'user' as const, content: turn.question }, { role: 'assistant' as const, content: turn.reply.answer.slice(0, 4000) }]);
    const input: AgentRequest = { question: asked, scope, history, ...(scope === 'case' ? { date } : { runId: snapshot!.runId }) };
    try { const reply = await askAgent(input); if (token.current === request) { setTurns(old => [...old, { question: asked, reply }].slice(-12)); setQuestion(''); } }
    catch (e) { if (token.current === request) setError(e instanceof Error ? e.message : 'Не удалось получить ответ.'); }
    finally { sending.current = false; setBusy(false); }
  };
  const examples = scope === 'case' ? ['Что проверить первым по выбранной дате?', 'Почему планы 4 800 и 5 500 не совпадают?', 'Можно ли посчитать OEE и предсказать простой?'] : ['Объясни текущее ограничение выпуска.', 'Сравни восстановление P03 сейчас и через 30 минут.', 'Какие инциденты требуют внимания?'];
  return <section id="agent" className="agent-panel panel" hidden={!visible} aria-labelledby="agent-title">
    <div className="panel-heading"><div><span className="section-code">AI /</span><h2 id="agent-title">ИИ-агент производства</h2></div><span className="agent-mode">Чтение и расчёты</span></div>
    <div className="agent-body"><p className="agent-intro">Задайте вопрос своими словами. Агент выбирает инструменты, получает данные и формирует ответ с основаниями. Управление линией остаётся в её карточке.</p>
      <details className="data-help agent-connection"><summary>Настройки агента</summary><div className="agent-status"><span>{loading ? 'Проверяем подключение…' : status ? status.configured ? `OpenAI · ${status.model} · ключ настроен` : 'Для ответов нужен ключ OpenAI API' : 'Сервер агента недоступен'}</span><button className="button compact" onClick={() => void refresh()} disabled={loading || busy}>Проверить подключение</button></div></details>
      {status && !status.configured && <div className="agent-setup"><strong>Агент ещё не настроен</strong><details className="data-help"><summary>Как подключить</summary><p>Скопируйте <code>.env.example</code> в <code>.env</code> рядом с <code>package.json</code> и заполните <code>OPENAI_API_KEY</code>. Затем нажмите «Проверить подключение». Ключ не вводится в чат и не попадает в GitHub.</p><p>Пока ключ не настроен, доступен <a href="#case">анализ показателей</a>.</p></details></div>}
      <div className="agent-context"><label>Источник<select disabled={busy} value={scope} onChange={e => setScope(e.target.value as AgentScope)}><option value="case">Показатели производства</option><option value="simulation">Модель линии</option></select></label>{scope === 'case' ? <label>Дата<select value={date} disabled={busy} onChange={e => setDate(e.target.value)}>{(status?.dates ?? ['2026-10-01', '2026-10-02']).map(day => <option key={day} value={day}>{day.split('-').reverse().join('.')}</option>)}</select></label> : <p>{snapshot ? 'Ответ будет основан на состоянии линии на момент вопроса.' : 'Дождитесь загрузки состояния линии.'}</p>}</div>
      <p className="agent-privacy">Вопрос, история чата и данные выбранного источника передаются в OpenAI.</p>
      <div className="agent-examples">{examples.map(text => <button key={text} disabled={busy} onClick={() => setQuestion(text)}>{text}</button>)}</div>
      <div className="agent-conversation" role="log" aria-label="Ответы агента">{turns.map((turn, index) => {
        const ctx = turn.reply.context;
        const stale = turn.reply.stale || ctx.scope === 'simulation' && !!snapshot && (ctx.runId !== snapshot.runId || ctx.revision !== snapshot.revision);
        return <article className="agent-turn" key={index}><div className="agent-question"><span>Вы</span><p>{turn.question}</p></div><div className="agent-answer"><div className="agent-answer-heading"><strong>ИИ-агент</strong><small>{new Date(turn.reply.answeredAt).toLocaleTimeString('ru-RU')}</small></div>{stale && <p className="agent-stale">Линия изменилась после среза. Этот ответ относится к прежнему состоянию.</p>}<p className="agent-answer-text">{agentTextParts(turn.reply.answer).map((part, index) => part.strong ? <strong key={index}>{part.text}</strong> : part.text)}</p><details><summary>Основания ответа · {turn.reply.tools.length} вызова</summary>{turn.reply.tools.map((tool, n) => <div className="agent-tool" key={n}><strong>{toolNames[tool.name] ?? tool.name}</strong><pre>{JSON.stringify({ parameters: tool.arguments, data: tool.result }, null, 2)}</pre></div>)}</details></div></article>;
      })}{!turns.length && <div className="agent-empty"><span>С чего начнём?</span><p>Выберите источник и пример вопроса или напишите свой.</p></div>}</div>
      {error && <p className="agent-error" role="alert">{error}</p>}
      <form className="agent-compose" onSubmit={event => { event.preventDefault(); void submit(); }}><label htmlFor="agent-question">Вопрос агенту</label><textarea id="agent-question" value={question} onChange={e => setQuestion(e.target.value)} maxLength={2000} rows={3} disabled={busy} placeholder="Например: где превышен уровень брака и что стоит проверить?"/><div><span>{question.length} / 2000 {busy ? 'Агент читает данные и готовит ответ…' : ''}</span><button type="button" className="button compact" disabled={busy || !turns.length} onClick={() => setTurns([])}>Очистить чат</button><button className="button primary" type="submit" disabled={busy || !status?.configured || !question.trim() || (scope === 'simulation' && !snapshot)}>{busy ? 'Готовим ответ…' : 'Спросить агента'}</button></div></form>
    </div>
  </section>;
}
