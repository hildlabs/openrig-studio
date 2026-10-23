// Provider registry: what is available on this machine and how to call it.
import { loadSettings, secret } from '../settings.js';
import { run as runProcess } from '../process.js';
import * as claudeCode from './claude-code.js';
import * as codex from './codex.js';
import { ANTHROPIC_MODELS, runAnthropic, runOpenAI, testAnthropic, testOpenAI } from './api.js';

export async function listProviders() {
  const s = await loadSettings();
  const claudeExe = claudeCode.find(s), codexExe = codex.find(s);
  const anthropicKey = secret(s, 'anthropicApiKey', 'ANTHROPIC_API_KEY');
  const openaiKey = secret(s, 'openaiApiKey', 'OPENAI_API_KEY');
  const codexModels = codex.models();
  const openaiModels = [
    ...s.openaiModels.split(',').map(x => x.trim()).filter(Boolean).map(id => ({ id, label: id, efforts: ['low', 'medium', 'high', 'xhigh'] })),
    ...codexModels.filter(m => m.id && m.apiAvailable),
  ];
  return [
    { id: 'claude-code', label: 'Claude Code', kind: 'subscription', available: Boolean(claudeExe), detail: claudeExe, models: claudeCode.MODELS },
    { id: 'codex', label: 'Codex CLI', kind: 'subscription', available: Boolean(codexExe), detail: codexExe, models: codexModels },
    { id: 'anthropic', label: 'Anthropic API', kind: 'api', available: Boolean(anthropicKey), models: ANTHROPIC_MODELS },
    { id: 'openai', label: 'OpenAI API', kind: 'api', available: Boolean(openaiKey), models: openaiModels },
  ];
}

const safe = s => /^[\w.:-]{0,80}$/.test(String(s ?? ''));

// request: { provider, model, effort, system, text, images }
export async function callModel(request) {
  if (!safe(request.model) || !safe(request.effort)) throw new Error('Invalid model or effort.');
  const s = await loadSettings();
  switch (request.provider) {
    case 'claude-code': {
      const exe = claudeCode.find(s);
      if (!exe) throw new Error('Claude Code CLI not found. Install it and run "claude" once to log in, or set its path in Settings.');
      return claudeCode.runClaudeCode(exe, request);
    }
    case 'codex': {
      const exe = codex.find(s);
      if (!exe) throw new Error('Codex CLI not found. Install it and run "codex" once to log in, or set its path in Settings.');
      return codex.runCodex(exe, request);
    }
    case 'anthropic': {
      const key = secret(s, 'anthropicApiKey', 'ANTHROPIC_API_KEY');
      if (!key) throw new Error('No Anthropic API key. Add one in Settings.');
      return runAnthropic(key, request);
    }
    case 'openai': {
      const key = secret(s, 'openaiApiKey', 'OPENAI_API_KEY');
      if (!key) throw new Error('No OpenAI API key. Add one in Settings.');
      return runOpenAI(key, request);
    }
    default: throw new Error(`Unknown provider "${request.provider}".`);
  }
}

// Connection check for the Settings page; never generates anything.
export async function testProvider(id) {
  const s = await loadSettings();
  if (id === 'claude-code' || id === 'codex') {
    const exe = id === 'claude-code' ? claudeCode.find(s) : codex.find(s);
    if (!exe) throw new Error('Not found.');
    const r = await runProcess(exe, ['--version'], { timeoutMs: 20000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(-300) || `Exit code ${r.code}`);
    return r.stdout.trim().split(/\r?\n/)[0];
  }
  if (id === 'anthropic') return testAnthropic(secret(s, 'anthropicApiKey', 'ANTHROPIC_API_KEY'));
  if (id === 'openai') return testOpenAI(secret(s, 'openaiApiKey', 'OPENAI_API_KEY'));
  throw new Error(`Unknown provider "${id}".`);
}
