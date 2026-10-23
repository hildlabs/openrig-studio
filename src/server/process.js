// Finding and running local executables (claude, codex, StudioMCP) on Windows, macOS and Linux.
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';

const WIN = process.platform === 'win32';

export function which(name) {
  const exts = WIN ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try { if (existsSync(file) && statSync(file).isFile()) return file; } catch { /* unreadable */ }
    }
  }
  return null;
}
export const firstExisting = list => list.find(p => p && existsSync(p)) ?? null;

// Newest file matching dir/<entry>/<rel>, e.g. versioned install folders.
export function newestIn(dir, rel, filter = () => true) {
  try {
    return readdirSync(dir).filter(filter).map(d => path.join(dir, d, rel)).filter(existsSync)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
  } catch { return null; }
}

export const home = os.homedir();

// Windows .cmd/.bat shims need cmd.exe; arguments are quoted verbatim so paths with spaces work.
const quoteWin = a => `"${String(a).replace(/"/g, '""')}"`;
export function run(cmd, args, { input, cwd, timeoutMs = 15 * 60000, env } = {}) {
  return new Promise(resolve => {
    const shim = WIN && /\.(cmd|bat)$/i.test(cmd);
    const child = shim
      ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${[cmd, ...args].map(quoteWin).join(' ')}"`], { cwd, env, windowsHide: true, windowsVerbatimArguments: true, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(cmd, args, { cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', e => { stderr += String(e); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: timedOut ? -1 : code, stdout, stderr, timedOut }); });
    child.stdin.on('error', () => { /* process exited early */ });
    child.stdin.end(input ?? '');
  });
}
