import { HttpDataSource } from './data-source.ts';
import { HistorySource } from './history-source.ts';
import { demoCommand, matchesDemoStage } from './demo-guide.ts';

export interface ReadinessCheck { id: string; title: string; status: 'ok' | 'warn' | 'error'; detail: string }
export interface ReadinessReport { checkedAt: string; serverVersion: string | null; runId: string | null; revision: number | null; checks: ReadinessCheck[] }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const message = (reason: unknown) => reason instanceof Error ? reason.message : 'Ответ не получен. Проверьте сервер.';
async function read(path: string): Promise<Response> {
  const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Сервер ответил ${response.status}. Проверьте запуск через start.cmd.`);
  return response;
}

export async function checkReadiness(): Promise<ReadinessReport> {
  const [api, snapshot, history, sample] = await Promise.allSettled([
    read('/openapi.json').then(response => response.json() as Promise<unknown>),
    new HttpDataSource().getSnapshot(),
    new HistorySource().list(),
    read('/api/v1/history/example.csv').then(response => response.text()),
  ]);
  const checks: ReadinessCheck[] = [];
  let version: string | null = null, runId: string | null = null, revision: number | null = null;
  if (api.status === 'fulfilled' && record(api.value) && record(api.value.info) && api.value.info.title === 'Zauyt AI API' && typeof api.value.info.version === 'string') {
    version = api.value.info.version;
    checks.push({ id: 'api', title: 'Версия сервера', status: version === '0.8.0' ? 'ok' : 'warn', detail: `Работает API ${version}. ${version === '0.8.0' ? 'Совпадает с этим комплектом приложения.' : 'Версия отличается от комплекта. Остановите прежний сервер в его окне (Ctrl+C) и запустите start.cmd из обновлённой папки.'}` });
  } else checks.push({ id: 'api', title: 'Версия сервера', status: 'error', detail: api.status === 'rejected' ? message(api.reason) : 'Не удалось подтвердить Zauyt AI API.' });
  if (snapshot.status === 'fulfilled') {
    const s = snapshot.value; runId = s.runId; revision = s.revision;
    checks.push({ id: 'snapshot', title: 'Связь с моделью', status: 'ok', detail: 'Получен свежий корректный снимок линии.' });
    const supported = ['configure_line', 'history_configuration'].every(value => s.capabilities?.includes(value));
    checks.push({ id: 'configuration', title: 'Настройки и нормативы CSV', status: supported ? 'ok' : 'warn', detail: supported ? 'Сервер поддерживает обе функции.' : 'В работающем сервере этих функций пока нет. Нужен запуск обновлённой версии через start.cmd; данные сохраняются в SQLite.' });
    try {
      demoCommand('prepare', s);
      const ready = matchesDemoStage(s, 'initial');
      checks.push({ id: 'demo', title: 'Исходное состояние показа', status: ready ? 'ok' : 'warn', detail: ready ? '08:45, пауза, 37 годных, прогноз 423. Контрольный поток совпал.' : 'Сценарий ещё не подготовлен. Нажмите «Начать учебный показ» после проверки; прежний запуск останется в архиве.' });
    } catch (error) { checks.push({ id: 'demo', title: 'Исходное состояние показа', status: 'error', detail: message(error) }); }
  } else {
    checks.push({ id: 'snapshot', title: 'Связь с моделью', status: 'error', detail: message(snapshot.reason) });
    checks.push({ id: 'configuration', title: 'Настройки и нормативы CSV', status: 'error', detail: 'Не проверены: снимок линии недоступен.' });
    checks.push({ id: 'demo', title: 'Исходное состояние показа', status: 'error', detail: 'Не проверено: снимок линии недоступен.' });
  }
  checks.push(history.status === 'fulfilled'
    ? { id: 'history', title: 'Сохранённая история', status: history.value.length ? 'ok' : 'warn', detail: history.value.length ? `Список доступен, отчётов: ${history.value.length}.` : 'Список доступен, импортов пока нет. Для показа CSV выберите учебный пример в «Истории».' }
    : { id: 'history', title: 'Сохранённая история', status: 'error', detail: message(history.reason) });
  const sampleValid = sample.status === 'fulfilled' && sample.value.replace(/^\uFEFF/, '').startsWith('elapsed_sec,good,rejected,P01_mode,P02_mode,P03_mode,P04_mode,P05_mode')
    && new TextEncoder().encode(sample.value).length <= 512 * 1024;
  checks.push({ id: 'sample', title: 'Учебный CSV', status: sampleValid ? 'ok' : 'error', detail: sampleValid ? 'Файл доступен для скачивания и импорта.' : sample.status === 'rejected' ? message(sample.reason) : 'Ответ не похож на учебный CSV. Проверьте комплект файлов.' });
  return { checkedAt: new Date().toISOString(), serverVersion: version, runId, revision, checks };
}
