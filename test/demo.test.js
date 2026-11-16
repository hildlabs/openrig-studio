// The live demo rewrites parts of web/ at build time; this fails when a change in web/ breaks a rewrite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('demo build', () => {
  execFileSync(process.execPath, [path.join(ROOT, 'demo', 'build.mjs')], { cwd: ROOT, stdio: 'pipe' });
  const out = path.join(ROOT, 'demo-dist');
  const api = readFileSync(path.join(out, 'api.js'), 'utf8');
  assert.match(api, /return demoApi\(/);
  for (const f of ['app.js', 'editor.js', 'library.js', 'compare.js', 'settings.js', 'api.js']) {
    const s = readFileSync(path.join(out, f), 'utf8');
    assert.doesNotMatch(s, /from '\/core\//, `${f} still imports from /core/`);
    assert.doesNotMatch(s, /src="\/api\//, `${f} still loads images from /api/`);
    assert.doesNotMatch(s, /location\.href = `\/api\//, `${f} still downloads from /api/`);
  }
  assert.doesNotMatch(readFileSync(path.join(out, 'core', 'render.js'), 'utf8'), /from 'node:/);
});
