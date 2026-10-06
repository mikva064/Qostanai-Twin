import test from 'node:test';
import assert from 'node:assert/strict';
import { askAgent, checkAgentConnection, getAgentStatus } from '../src/agent-source.ts';
import type { AgentReply, AgentRequest } from '../src/agent-source.ts';

const request: AgentRequest = { question: 'Проверь качество', scope: 'case', date: '2026-10-02', history: [] };
const reply: AgentReply = { schemaVersion: 1, provider: 'openai', model: 'test-model', answer: 'Брак выше порога.', context: { scope: 'case', date: '2026-10-02' }, tools: [{ name: 'get_case_metrics', arguments: {}, result: { source: 'Тестовый DOCX' } }], stale: false, answeredAt: '2026-10-05T12:00:00Z', readOnly: true };

test('connection check is explicit, sends no question or key, and requires server confirmation', async () => {
  const original = globalThis.fetch;
  const result = { schemaVersion: 1, provider: 'openai', model: 'test-model', reachable: true, checkedAt: '2026-10-06T08:00:00Z', generationTested: false };
  try {
    let count = 0;
    globalThis.fetch = async (url, init) => { count++; assert.equal(url, '/api/v1/agent/check'); assert.equal(init?.method, 'POST'); assert.equal(init?.body, undefined); assert.equal(init?.headers, undefined); return Response.json(result); };
    assert.deepEqual(await checkAgentConnection(), result); assert.equal(count, 1);
    globalThis.fetch = async () => Response.json({ ...result, reachable: false });
    await assert.rejects(checkAgentConnection(), /не подтвердил связь/);
    globalThis.fetch = async () => Response.json({ detail: 'Серверу запрещён доступ к OpenAI', code: 'network_access_denied' }, { status: 503 });
    await assert.rejects(checkAgentConnection(), /Серверу запрещён доступ/);
  } finally { globalThis.fetch = original; }
});

test('configured and unconfigured status never needs a client API key', async () => {
  const original = globalThis.fetch;
  try {
    for (const configured of [true, false]) {
      globalThis.fetch = async (url, init) => { assert.equal(url, '/api/v1/agent/status'); assert.equal(init?.headers, undefined); return Response.json({ schemaVersion: 1, configured, provider: 'openai', model: 'test-model', scopes: ['case', 'simulation'], dates: ['2026-10-01', '2026-10-02'], readOnly: true, maxQuestionChars: 2000 }); };
      assert.equal((await getAgentStatus()).configured, configured);
    }
  } finally { globalThis.fetch = original; }
});

test('question is posted once with bounded context and read-only evidence accepted', async () => {
  const original = globalThis.fetch;
  try {
    let count = 0;
    globalThis.fetch = async (url, init) => { count++; assert.equal(url, '/api/v1/agent/ask'); assert.equal(init?.method, 'POST'); assert.deepEqual(JSON.parse(String(init?.body)), request); return Response.json(reply); };
    assert.deepEqual(await askAgent(request), reply); assert.equal(count, 1);
  } finally { globalThis.fetch = original; }
});

test('rejects unsupported tools, different data source, missing evidence and impossible dates', async () => {
  const original = globalThis.fetch;
  try {
    for (const mutate of [(r: AgentReply) => { r.context.date = '2026-10-01'; }, (r: AgentReply) => { r.context.scope = 'simulation'; }, (r: AgentReply) => { r.tools[0].name = 'reset'; }, (r: AgentReply) => { r.tools = []; }, (r: AgentReply) => { r.answeredAt = 'not a date'; }, (r: AgentReply) => { r.answer = ''; }]) {
      const bad = structuredClone(reply); mutate(bad); globalThis.fetch = async () => Response.json(bad);
      await assert.rejects(askAgent(request));
    }
  } finally { globalThis.fetch = original; }
});

test('provider failures and old API are explained without automatic cost-bearing retry', async () => {
  const original = globalThis.fetch;
  try {
    let count = 0;
    globalThis.fetch = async () => { count++; return Response.json({ detail: 'Ключ не настроен' }, { status: 503 }); };
    await assert.rejects(askAgent(request), /Ключ не настроен/); assert.equal(count, 1);
    globalThis.fetch = async () => Response.json({}, { status: 404 });
    await assert.rejects(getAgentStatus(), /обновлённый сервер/);
  } finally { globalThis.fetch = original; }
});

test('invalid questions fail before transmission; simulation reply is bound to requested run', async () => {
  const original = globalThis.fetch;
  try {
    let count = 0;
    globalThis.fetch = async () => { count++; return Response.json({ ...reply, context: { scope: 'simulation', runId: 'wrong', revision: 1 }, tools: [{ name: 'get_twin_snapshot', arguments: {}, result: {} }] }); };
    await assert.rejects(askAgent({ ...request, question: ' ' }), /Введите/);
    await assert.rejects(askAgent({ ...request, question: 'a'.repeat(2001) }), /Введите/);
    assert.equal(count, 0);
    await assert.rejects(askAgent({ question: 'Срез', scope: 'simulation', runId: 'expected', history: [] }), /другому набору/);
    assert.equal(count, 1);
  } finally { globalThis.fetch = original; }
});
