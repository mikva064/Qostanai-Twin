import { useEffect, useRef, useState } from 'react';
import { checkReadiness } from './readiness.ts';
import type { ReadinessReport } from './readiness.ts';
import packageInfo from '../package.json' with { type: 'json' };
import './readiness.css';

export default function ReadinessPanel({ runId, revision }: { runId: string; revision: number }) {
  const [report, setReport] = useState<ReadinessReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const running = useRef(false), token = useRef(0);
  useEffect(() => () => { token.current++; }, []);
  const check = async () => {
    if (running.current) return;
    const request = ++token.current; running.current = true; setBusy(true); setError('');
    try { const result = await checkReadiness(); if (token.current === request) setReport(result); }
    catch (e) { if (token.current === request) setError(e instanceof Error ? e.message : 'Не удалось завершить проверку.'); }
    finally { if (token.current === request) { running.current = false; setBusy(false); } }
  };
  const stale = report?.runId !== null && !!report && (report.runId !== runId || report.revision !== revision);
  const download = () => {
    if (!report) return;
    const content = { ...report, interfaceVersion: packageInfo.version, note: 'Техническая проверка на указанное время. Внешний вид, проектор, презентация и резервное видео проверяются вручную.' };
    const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2)], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'qostanai-readiness.json';
    document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="readiness-panel">
    <div className="readiness-heading"><div><h3>Проверка перед показом</h3><p>Интерфейс {packageInfo.version} · проверяем сервер и материалы демонстрации.</p></div><button className="button compact" disabled={busy} onClick={check}>{busy ? 'Проверяем…' : 'Проверить готовность'}</button></div>
    <p className="readiness-note">Проверка читает данные и не выполняет команды модели. Если сайт не открывается, запустите check.cmd из папки приложения.</p>
    {error && <p className="history-errors" role="alert">{error}</p>}
    {report && <div aria-busy={busy}>
      <div className="readiness-summary" role="status"><strong>{report.checks.some(c => c.status === 'error') ? 'Есть ошибки — устраните их до показа' : report.checks.some(c => c.status === 'warn') ? 'Нужна подготовка перед показом' : 'Технические проверки пройдены'}</strong><span>{new Date(report.checkedAt).toLocaleString('ru-RU')} · успешно {report.checks.filter(c => c.status === 'ok').length} из {report.checks.length}</span></div>
      {stale && <p className="scenario-stale">Состояние линии изменилось после проверки. Проверьте готовность ещё раз для актуального результата.</p>}
      <ul className="readiness-checks">{report.checks.map(c => <li key={c.id} className={c.status}><span aria-label={c.status === 'ok' ? 'Успешно' : c.status === 'warn' ? 'Требуется действие' : 'Ошибка'}>{c.status === 'ok' ? '✓' : '!'}</span><div><strong>{c.title}</strong><p>{c.detail}</p></div></li>)}</ul>
      <div className="readiness-footer"><span>Вручную: пройти показ, проверить проектор и локальную презентацию, записать резервное видео.</span><button className="button compact" disabled={busy} onClick={download}>Скачать результат проверки</button></div>
    </div>}
  </div>;
}
