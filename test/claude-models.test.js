// Claude Code and the Anthropic API offer the same Claude models from one list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS } from '../src/server/providers/claude-code.js';
import { ANTHROPIC_MODELS } from '../src/server/providers/api.js';
import { CLAUDE_MODELS, FALLBACK_MODELS } from '../src/server/providers/claude-models.js';

test('both Claude providers list the same models', () => {
  assert.deepEqual(MODELS, CLAUDE_MODELS);
  assert.deepEqual(ANTHROPIC_MODELS, CLAUDE_MODELS);
});

test('every listed model has a unique id, a label and efforts', () => {
  assert.equal(new Set(CLAUDE_MODELS.map(m => m.id)).size, CLAUDE_MODELS.length);
  for (const m of CLAUDE_MODELS) {
    assert.match(m.id, /^claude-[a-z]+-\d+(-\d+)?$/);
    assert.ok(m.label && m.efforts.includes('high'));
  }
});

test('the refusal fallback covers the models that support it', () => {
  for (const id of ['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5']) assert.ok(FALLBACK_MODELS.has(id), id);
  assert.ok(!FALLBACK_MODELS.has('claude-haiku-5-5'));
});
