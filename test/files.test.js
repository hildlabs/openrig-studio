// Saving files while they are being read (src/server/files.js). On Windows a plain rename over a
// file that another request is reading fails with EPERM; the editor polls clips during generation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { writeJson } from '../src/server/files.js';

test('writing a file that is read at the same time never fails and never leaves half a file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'openrig-files-'));
  const file = path.join(dir, 'clip.json');
  const pad = 'x'.repeat(100000);
  await writeJson(file, { n: 0, pad });
  let stop = false, broken = 0;
  const reader = (async () => {
    while (!stop) {
      try { JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e instanceof SyntaxError) broken++; }
    }
  })();
  for (let n = 1; n <= 100; n++) await writeJson(file, { n, pad });
  stop = true;
  await reader;
  assert.equal(JSON.parse(await readFile(file, 'utf8')).n, 100);
  assert.equal(broken, 0);
  await rm(dir, { recursive: true, force: true });
});
