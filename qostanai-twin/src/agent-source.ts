export type AgentScope = 'case' | 'simulation';
export interface AgentStatus { schemaVersion: 1; configured: boolean; provider: 'openai'; model: string; scopes: AgentScope[]; dates: string[]; readOnly: true; maxQuestionChars: number }
export interface AgentRequest { question: string; scope: AgentScope; date?: string; runId?: string; history: { role: 'user' | 'assistant'; content: string }[] }
export interface AgentReply { schemaVersion: 1; provider: 'openai'; model: string; answer: string; context: { scope: AgentScope; date?: string; runId?: string; revision?: number }; tools: { name: string; arguments: Record<string, unknown>; result: Record<string, unknown> }[]; stale: boolean; answeredAt: string; readOnly: true }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const day = (v: unknown): v is string => text(v) && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const toolsByScope = { case: ['get_case_metrics', 'get_case_downtime'], simulation: ['get_twin_snapshot', 'compare_recovery'] };

async function read(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try { response = await fetch(path, { ...init, cache: 'no-store', signal: AbortSignal.timeout(init ? 95000 : 5000) }); }
  catch { throw new Error('Нет ответа агента. Проверьте сервер; запрос автоматически не повторяется.'); }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 404) throw new Error('Для ИИ-агента нужен обновлённый сервер. Перезапустите start.cmd.');
    throw new Error(object(body) && text(body.detail) ? body.detail : `Агент не выполнил запрос (${response.status}).`);
  }
  return body;
}

export async function getAgentStatus(): Promise<AgentStatus> {
  const data = await read('/api/v1/agent/status');
  if (!object(data) || data.schemaVersion !== 1 || data.provider !== 'openai' || typeof data.configured !== 'boolean' || !text(data.model) || data.readOnly !== true || data.maxQuestionChars !== 2000 || !Array.isArray(data.dates) || !data.dates.length || !data.dates.every(day) || !Array.isArray(data.scopes) || !['case', 'simulation'].every(scope => Array.isArray(data.scopes) && data.scopes.includes(scope))) throw new Error('Несовместимые настройки агента. Обновите приложение.');
  return data as unknown as AgentStatus;
}

export async function askAgent(request: AgentRequest): Promise<AgentReply> {
  if (!request.question.trim() || request.question.length > 2000) throw new Error('Введите вопрос до 2000 символов.');
  const data = await read('/api/v1/agent/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
  if (!object(data) || data.schemaVersion !== 1 || data.provider !== 'openai' || !text(data.model) || !text(data.answer) || data.answer.length > 16000 || data.readOnly !== true || typeof data.stale !== 'boolean' || !text(data.answeredAt) || !Number.isFinite(Date.parse(data.answeredAt)) || !object(data.context) || data.context.scope !== request.scope || !Array.isArray(data.tools) || !data.tools.length || data.tools.length > 6 || !data.tools.every(tool => object(tool) && text(tool.name) && toolsByScope[request.scope].includes(tool.name) && object(tool.arguments) && object(tool.result))) throw new Error('Агент вернул несовместимый ответ. Повторите вопрос вручную.');
  if (request.scope === 'case' ? data.context.date !== request.date : data.context.runId !== request.runId || !Number.isSafeInteger(data.context.revision) || Number(data.context.revision) < 0) throw new Error('Ответ относится к другому набору данных. Повторите вопрос.');
  return data as unknown as AgentReply;
}
