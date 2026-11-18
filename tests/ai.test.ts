import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createModelProvider, SkillRegistry } from '../server/ai.ts';
import { createWorkbenchServer, loopbackHost } from '../server/app.ts';

test('model adapter uses a local compatible endpoint and maps upstream and timeout errors', async (t) => {
  let responseKind = 'success';
  let received: { url?: string; auth?: string; body?: string } = {};
  const upstream = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk.toString();
    received = { url: request.url, auth: request.headers.authorization, body };
    if (responseKind === 'timeout') return;
    response.writeHead(responseKind === 'success' ? 200 : 429, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: '{"answer":"example"}' } }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, loopbackHost, resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const address = upstream.address();
  assert.ok(address && typeof address === 'object');
  const env = { AI_BASE_URL: 'http://127.0.0.1:' + address.port + '/v1', AI_API_KEY: 'local-secret', AI_MODEL: 'test-model' };
  const model = createModelProvider(env, 500);
  const registry = new SkillRegistry();
  registry.register('example', (input, provider) => provider.complete('Reply', input));
  assert.deepEqual(await registry.run('example', { data: 'fact' }, model), { answer: 'example' });
  assert.equal(received.url, '/v1/chat/completions');
  assert.equal(received.auth, 'Bearer local-secret');
  assert.equal(JSON.parse(received.body ?? '').model, 'test-model');
  responseKind = 'error';
  await assert.rejects(model.complete('Reply', ''), { code: 'model_upstream' });
  responseKind = 'timeout';
  await assert.rejects(createModelProvider(env, 25).complete('Reply', ''), { code: 'model_timeout' });

  const app = createWorkbenchServer({ model, databasePath: ':memory:' });
  t.after(() => app.close());
  const base = await app.listen({ host: loopbackHost, port: 0 });
  const health = await (await fetch(base + '/api/health')).json();
  assert.deepEqual(health, { status: 'ok', modelConfigured: true });
  assert.equal(createModelProvider({}).configured, false);
});

test('chat keeps the current turn history and reloads evidence when sources change', async (t) => {
  const app = createWorkbenchServer({ databasePath: ':memory:', model: { configured: true, async complete(_instruction, value) {
    const { history, question, fragments } = value as { question: string; history: Array<{ content: string }>;
      fragments: Array<{ id: string; text: string }> };
    return { content: JSON.stringify({ previous: history.map(({ content }) => content), evidence: fragments.map(({ text }) => text) }),
      insufficient: question === 'Missing fact', citations: question === 'Missing fact' ? [] : fragments.slice(0, 1).map(({ id }) => id) };
  } } });
  t.after(() => app.close());
  const base = await app.listen({ host: loopbackHost, port: 0 });
  async function chat(version: string, libraryIds: string[], question: string,
    history: Array<{ version: string; role: string; content: string }> = []) {
    const response = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ libraryIds, version, question, history }) });
    assert.equal(response.status, 200);
    return await response.json();
  }
  const first = await chat('one', ['sample-writing'], 'First question');
  const history = [{ version: 'one', role: 'assistant', content: first.content }];
  assert.ok((await chat('one', ['sample-writing'], 'Follow up', history)).citations.length);
  assert.deepEqual(JSON.parse((await chat('one', ['sample-writing'], 'Follow up', history)).content).previous, [first.content]);
  assert.deepEqual(JSON.parse((await chat('two', [], 'Follow up', history)).content), { previous: [], evidence: [] });
  assert.equal((await chat('one', ['sample-writing'], 'Missing fact')).insufficient, true);
});
