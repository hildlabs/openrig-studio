// Codex CLI (`codex exec`): uses the ChatGPT subscription the user is logged in with.
// The model list comes from Codex's own cache so new models appear without code changes.
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { which, firstExisting, newestIn, home, run } from '../process.js';

export function find(settings) {
  const winStore = process.platform === 'win32'
    ? newestIn('C:\\Program Files\\WindowsApps', path.join('app', 'resources', 'codex.exe'), d => d.startsWith('OpenAI.Codex_'))
    : null;
  return firstExisting([settings.codexPath, which('codex'), winStore]);
}

export function models() {
  try {
    const cache = JSON.parse(readFileSync(path.join(home, '.codex', 'models_cache.json'), 'utf8'));
    const list = (cache.models ?? []).filter(m => m.visibility === 'list').map(m => ({
      id: m.slug, label: m.display_name ?? m.slug, apiAvailable: m.supported_in_api !== false,
      efforts: (m.supported_reasoning_levels ?? []).map(e => e.effort), defaultEffort: m.default_reasoning_level,
    }));
    if (list.length) return list;
  } catch { /* no cache yet */ }
  try {
    const model = readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8').match(/^model\s*=\s*"([^"]+)"/m)?.[1];
    if (model) return [{ id: model, label: model, efforts: ['low', 'medium', 'high', 'xhigh'] }];
  } catch { /* no config */ }
  return [{ id: '', label: 'Default model', efforts: ['low', 'medium', 'high'] }];
}

export async function runCodex(exe, { model, effort, system, text, images = [] }) {
  const work = await mkdtemp(path.join(os.tmpdir(), 'openrig-'));
  try {
    const last = path.join(work, 'last.md');
    for (const img of images) await writeFile(path.join(work, img.name), img.data);
    const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', work, '-o', last];
    if (model) args.push('-m', model);
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
    for (const img of images) args.push(`--image=${path.join(work, img.name)}`);
    args.push('-');
    const r = await run(exe, args, { input: `${system}\n\n---\n\nDo not use tools or files; answer directly.\n\n${text}`, cwd: work });
    if (r.timedOut) throw new Error('Codex did not answer within 15 minutes.');
    let answer = '';
    try { answer = await readFile(last, 'utf8'); } catch { /* no final message */ }
    if (!answer) throw new Error(`Codex returned no answer (exit ${r.code}): ${r.stderr.trim().slice(-500)}`);
    const usage = { calls: 1, input: 0, cached: 0, output: 0, reasoning: 0 };
    for (const line of r.stdout.split(/\r?\n/)) {
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type !== 'turn.completed' || !ev.usage) continue;
      const cached = ev.usage.cached_input_tokens ?? 0;
      usage.input += (ev.usage.input_tokens ?? 0) - cached;
      usage.cached += cached;
      usage.output += ev.usage.output_tokens ?? 0;
      usage.reasoning += ev.usage.reasoning_output_tokens ?? 0;
    }
    return { text: answer, usage };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
