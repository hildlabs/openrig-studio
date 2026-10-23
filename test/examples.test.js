// The bundled example clips: valid, free of check findings, and added to a new library once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inspect } from '../src/core/anim.js';
import { formatIssue } from '../src/core/messages.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples');
const files = readdirSync(DIR).filter(f => f.endsWith('.json'));

test('example clips are valid and pass the checks', () => {
  assert.ok(files.length >= 5);
  for (const f of files) {
    const clip = JSON.parse(readFileSync(path.join(DIR, f), 'utf8'));
    assert.equal(clip.id, f.slice(0, -5));
    assert.equal(clip.history.find(h => h.id === clip.current).anim.keyframes.length, clip.anim.keyframes.length);
    const issues = inspect(structuredClone(clip.anim));
    assert.equal(issues.length, 0, `${f}: ${issues.map(i => formatIssue(i)).join(' | ')}`);
  }
});

test('examples are added to a new library once', async () => {
  const data = mkdtempSync(path.join(os.tmpdir(), 'openrig-'));
  process.env.OPENRIG_DATA = data;
  try {
    const lib = await import('../src/server/library.js');
    assert.equal(await lib.seedExamples(), files.length);
    const clips = await lib.listClips();
    assert.equal(clips.filter(c => c.folder === 'Examples').length, files.length);
    await lib.trashClip(clips[0].id);
    assert.equal(await lib.seedExamples(), 0, 'a deleted example does not come back');
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
