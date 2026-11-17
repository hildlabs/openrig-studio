// The parts of the API SDKs that src/server/providers/api.js relies on. Dependabot updates the SDKs
// weekly; this catches a renamed class or method before a user with an API key does. Skipped when
// the SDKs aren't installed (subscription-only setups); CI always installs them.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const load = async name => { try { return (await import(name)).default; } catch { return null; } };
const Anthropic = await load('@anthropic-ai/sdk');
const OpenAI = await load('openai');

test('Anthropic SDK: error classes and streaming calls', { skip: !Anthropic && 'not installed' }, () => {
  for (const name of ['AuthenticationError', 'RateLimitError', 'APIError']) assert.equal(typeof Anthropic[name], 'function', name);
  const client = new Anthropic({ apiKey: 'test' });
  assert.equal(typeof client.messages.stream, 'function');
  assert.equal(typeof client.beta.messages.stream, 'function');
  assert.equal(typeof client.models.list, 'function');
});

test('OpenAI SDK: error classes and the Responses API', { skip: !OpenAI && 'not installed' }, () => {
  for (const name of ['AuthenticationError', 'RateLimitError', 'APIError']) assert.equal(typeof OpenAI[name], 'function', name);
  const client = new OpenAI({ apiKey: 'test' });
  assert.equal(typeof client.responses.create, 'function');
  assert.equal(typeof client.models.list, 'function');
});
