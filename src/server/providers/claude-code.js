// Claude Code CLI (`claude -p`): uses the Claude subscription the user is logged in with.
// Runs in an empty temp folder without tools or MCP servers; images are read with the Read tool.
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { which, firstExisting, home, run } from '../process.js';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: EFFORTS },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', efforts: EFFORTS },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', efforts: EFFORTS },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', efforts: EFFORTS },
];

export const find = settings => firstExisting([settings.claudePath, which('claude'),
  path.join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')]);

export async function runClaudeCode(exe, { model, effort, system, text, images = [] }) {
  const work = await mkdtemp(path.join(os.tmpdir(), 'openrig-'));
  try {
    const systemFile = path.join(work, 'system.md');
    await writeFile(systemFile, system, 'utf8');
    for (const img of images) await writeFile(path.join(work, img.name), img.data);
    const args = ['-p', '--output-format', 'json', '--system-prompt-file', systemFile, '--strict-mcp-config', '--no-session-persistence', '--permission-mode', 'dontAsk'];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    args.push('--tools', images.length ? 'Read' : '');
    if (images.length) args.push('--allowedTools', 'Read');
    const input = images.length ? `${text}\n\nFirst read the image file${images.length > 1 ? 's' : ''} ${images.map(i => `./${i.name}`).join(', ')} with the Read tool and look at ${images.length > 1 ? 'them' : 'it'} carefully.` : text;
    const r = await run(exe, args, { input, cwd: work });
    if (r.timedOut) throw new Error('Claude Code did not answer within 15 minutes.');
    let out;
    try { out = JSON.parse(r.stdout); } catch { throw new Error(`Claude Code returned no readable answer: ${(r.stderr || r.stdout).trim().slice(-500)}`); }
    if (out.is_error) throw new Error(`Claude Code reported an error: ${String(out.result).slice(0, 500)}`);
    const u = out.usage ?? {};
    return {
      text: out.result ?? '',
      usage: { calls: 1, input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), cached: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0, reasoning: 0 },
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
