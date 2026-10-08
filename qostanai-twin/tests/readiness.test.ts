import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkReadiness } from '../src/readiness.ts';

const fixture = JSON.parse(readFileSync(new URL('../docs/demo.reference.json', import.meta.url), 'utf8'));
const history = JSON.parse(readFileSync(new URL('../docs/history.example.json', import.meta.url), 'utf8'));
const csv = readFileSync(new URL('../public/examples/demo-shift.csv', import.meta.url), 'utf8');

async function check(overrides: Record<string, unknown> = {}) {
  const snapshot = structuredClone(fixture.initial);
  snapshot.capabilities = ['configure_line', 'history_configuration'];
  const responses: Record<string, unknown> = {
    '/openapi.json': { info: { title: 'Zauyt AI API', version: '0.8.0' } },
    '/api/v1/twin': snapshot,
    '/api/v1/history/imports': { imports: [history] },
    '/api/v1/history/example.csv': csv,
    ...overrides,
  };
  const before = JSON.stringify(responses), original = globalThis.fetch, calls: string[] = [];
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(init?.method ?? 'GET', 'GET');
      assert.equal(init?.body, undefined);
      assert.ok(init?.signal);
      const path = String(url); calls.push(path);
      assert.ok(Object.hasOwn(responses, path), path);
      const value = responses[path];
      if (value instanceof Error) throw value;
      return typeof value === 'string' ? new Response(value) : Response.json(value);
    };
    const result = await checkReadiness();
    assert.equal(calls.length, 4);
    assert.equal(JSON.stringify(responses), before, 'readiness must not mutate model or reports');
    assert.equal(result.checks.length, 6);
    return result;
  } finally { globalThis.fetch = original; }
}

test('ready API, exact demo state, saved history and sample pass using GET only', async () => {
  const result = await check();
  assert.ok(result.checks.every(c => c.status === 'ok'), JSON.stringify(result));
  assert.equal(result.runId, fixture.initial.runId);
  assert.equal(result.revision, fixture.initial.revision);
  assert.equal(result.serverVersion, '0.8.0');
  assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
});

test('old API remains readable while missing capabilities and empty history require preparation', async () => {
  const old = structuredClone(fixture.recovered); delete old.capabilities;
  const result = await check({
    '/openapi.json': { info: { title: 'Zauyt AI API', version: '0.4.0' } },
    '/api/v1/twin': old,
    '/api/v1/history/imports': { imports: [] },
  });
  assert.deepEqual(result.checks.filter(c => c.status === 'warn').map(c => c.id), ['api', 'configuration', 'demo', 'history']);
  assert.equal(result.checks.find(c => c.id === 'snapshot')?.status, 'ok');
  assert.match(result.checks[0].detail, /Ctrl\+C/);
});

test('one failed endpoint does not hide other checks', async () => {
  const result = await check({ '/api/v1/history/imports': new Error('История недоступна') });
  assert.deepEqual(result.checks.filter(c => c.status === 'error').map(c => c.id), ['history']);
  assert.match(result.checks.find(c => c.id === 'history')!.detail, /Нет связи с сервером/);
});

test('complete connection loss returns six errors and no model identity', async () => {
  const result = await check(Object.fromEntries(['/openapi.json', '/api/v1/twin', '/api/v1/history/imports', '/api/v1/history/example.csv'].map(path => [path, new Error('offline')])));
  assert.ok(result.checks.every(c => c.status === 'error'));
  assert.equal(result.runId, null); assert.equal(result.revision, null); assert.equal(result.serverVersion, null);
});

test('foreign API, malformed snapshot and HTML instead of CSV fail independently', async () => {
  const result = await check({ '/openapi.json': { info: { title: 'Other', version: '0.8.0' } }, '/api/v1/twin': {}, '/api/v1/history/example.csv': '<html>index</html>' });
  assert.deepEqual(result.checks.filter(c => c.status === 'error').map(c => c.id), ['api', 'snapshot', 'configuration', 'demo', 'sample']);
  assert.equal(result.checks.find(c => c.id === 'history')?.status, 'ok');
});

test('custom configuration on an old API blocks demo preparation, with no reset sent', async () => {
  const custom = structuredClone(fixture.initial); custom.state.shiftPlan = 275; delete custom.capabilities;
  const result = await check({ '/api/v1/twin': custom });
  assert.equal(result.checks.find(c => c.id === 'demo')?.status, 'error');
  assert.match(result.checks.find(c => c.id === 'demo')!.detail, /обновлённый сервер/);
});
