// OpenAI-compatible provider (src/server/providers/compatible.js) against a local fake server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runCompatible, testCompatible, baseUrl, models } from '../src/server/providers/compatible.js';

let server, url, last, reply;
const sse = events => events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
const delta = (content, finish = null) => ({ choices: [{ delta: { content }, finish_reason: finish }] });

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      last = { path: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null };
      const r = reply(req);
      res.writeHead(r.status ?? 200, { 'Content-Type': r.type ?? 'text/event-stream' });
      // Split mid-line so the reader has to join chunks.
      const text = r.body ?? '';
      res.write(text.slice(0, 7));
      res.end(text.slice(7));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}/v1/`;
});
after(() => server.close());

const request = { model: 'deepseek/deepseek-chat', effort: '', system: 'You animate.', text: 'A wave.' };

test('streams the answer, drops <think> blocks and maps usage', async () => {
  reply = () => ({ body: sse([
    delta('<think>pla'), delta('n first</think>```json\n{"keyframes"'), delta(': []}\n```', 'stop'),
    { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 400 }, completion_tokens_details: { reasoning_tokens: 120 } } },
  ]) });
  const out = await runCompatible({ url, key: 'sk-test', maxTokens: '' }, request);
  assert.equal(out.text, '```json\n{"keyframes": []}\n```');
  assert.deepEqual(out.usage, { calls: 1, input: 600, cached: 400, output: 300, reasoning: 120 });
  assert.equal(last.path, '/v1/chat/completions');
  assert.equal(last.auth, 'Bearer sk-test');
  assert.equal(last.body.model, 'deepseek/deepseek-chat');
  assert.deepEqual(last.body.messages, [{ role: 'system', content: 'You animate.' }, { role: 'user', content: 'A wave.' }]);
  assert.equal(last.body.stream, true);
  assert.equal('max_tokens' in last.body, false);
  assert.equal('reasoning_effort' in last.body, false);
});

test('sends images as data URLs, max_tokens and effort only when set, no key header without a key', async () => {
  reply = () => ({ body: sse([delta('ok', 'stop')]) });
  await runCompatible({ url, key: '', maxTokens: '16000' }, { ...request, effort: 'high', images: [{ name: 'sheet.png', data: Buffer.from('png') }] });
  assert.equal(last.auth, undefined);
  assert.equal(last.body.max_tokens, 16000);
  assert.equal(last.body.reasoning_effort, 'high');
  assert.deepEqual(last.body.messages[1].content, [
    { type: 'text', text: 'A wave.' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('png').toString('base64')}` } },
  ]);
});

test('a cut-off answer and a rejected key give clear errors', async () => {
  reply = () => ({ body: sse([delta('{"keyfr', 'length')]) });
  await assert.rejects(runCompatible({ url, key: 'k' }, request), /cut off.*Max output tokens/);
  reply = () => ({ status: 401, type: 'application/json', body: JSON.stringify({ error: { message: 'bad key' } }) });
  await assert.rejects(runCompatible({ url, key: 'k' }, request), /API key was rejected \(401\)/);
  reply = () => ({ status: 400, type: 'application/json', body: JSON.stringify({ error: { message: 'Model not found' } }) });
  await assert.rejects(runCompatible({ url, key: 'k' }, request), /API error 400: Model not found/);
  await assert.rejects(runCompatible({ url: 'api.deepseek.com', key: 'k' }, request), /base URL/);
});

test('connection check lists models and calls a missing model list a wrong base URL', async () => {
  reply = () => ({ type: 'application/json', body: JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }) });
  assert.equal(await testCompatible({ url, key: 'k' }), '2 models available');
  assert.equal(last.path, '/v1/models');
  reply = () => ({ status: 404, type: 'text/plain', body: 'not found' });
  await assert.rejects(testCompatible({ url, key: 'k' }), /Check the base URL: most end in \/v1/);
});

test('settings helpers', () => {
  assert.equal(baseUrl(' https://api.deepseek.com/v1// '), 'https://api.deepseek.com/v1');
  assert.deepEqual(models('deepseek-chat, qwen3:32b,,'), [
    { id: 'deepseek-chat', label: 'deepseek-chat', efforts: ['low', 'medium', 'high'] },
    { id: 'qwen3:32b', label: 'qwen3:32b', efforts: ['low', 'medium', 'high'] },
  ]);
});

test('the last event counts without a line break, and servers that ignore streaming work too', async () => {
  reply = () => ({ body: `data: ${JSON.stringify(delta('{"keyframes": []}'))}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}` });
  await assert.rejects(runCompatible({ url, key: 'k' }, request), /cut off/, 'finish_reason in the last line without a newline is seen');
  reply = () => ({ type: 'application/json', body: JSON.stringify({ choices: [{ message: { content: 'plain answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) });
  const out = await runCompatible({ url, key: 'k' }, request);
  assert.equal(out.text, 'plain answer');
  assert.equal(out.usage.output, 5);
});
