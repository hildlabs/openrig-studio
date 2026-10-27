// Local settings: data/settings.json (written by the Settings page) plus optional .env.
// Keys never leave this machine except to the provider they belong to.
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA = path.resolve(process.env.OPENRIG_DATA ?? path.join(ROOT, 'data'));
const FILE = path.join(DATA, 'settings.json');

// Minimal .env reader (KEY=value per line) so no extra dependency is needed.
const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const DEFAULTS = {
  anthropicApiKey: '',
  openaiApiKey: '',
  openaiModels: '',      // comma-separated extra model ids for the OpenAI API
  compatBaseUrl: '',     // OpenAI-compatible API (Chat Completions), e.g. https://api.deepseek.com/v1
  compatApiKey: '',
  compatModels: '',      // comma-separated model ids
  compatMaxTokens: '',   // optional max_tokens; empty = the server's default
  compatImages: '',      // 'on' when the models accept images (needed for visual review)
  claudePath: '',        // optional override for the claude CLI
  codexPath: '',         // optional override for the codex CLI
  studioMcpPath: '',     // optional override for Roblox's StudioMCP executable
  style: '',             // project style notes appended to the system prompt
};
let cache = null;

export async function loadSettings() {
  if (cache) return cache;
  try { cache = { ...DEFAULTS, ...JSON.parse(await readFile(FILE, 'utf8')) }; }
  catch { cache = { ...DEFAULTS }; }
  return cache;
}
export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current };
  for (const key of Object.keys(DEFAULTS)) if (typeof patch[key] === 'string') next[key] = patch[key].trim();
  await mkdir(DATA, { recursive: true });
  await writeFile(FILE + '.tmp', JSON.stringify(next, null, 2), 'utf8');
  await rename(FILE + '.tmp', FILE);
  cache = next;
  return next;
}
// Settings file first, environment second.
export const secret = (settings, key, env) => settings[key] || process.env[env] || '';
export const mask = value => (value ? `••••${value.slice(-4)}` : '');
