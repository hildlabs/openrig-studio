// Stopping a generation ends the program that is answering (src/server/process.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/server/process.js';

test('an aborted run ends the program at once and says so', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = run(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 200);
  const r = await pending;
  assert.equal(r.aborted, true);
  assert.equal(r.timedOut, false);
  assert.ok(Date.now() - started < 10000);
});

test('a run with an already aborted signal does not keep going', async () => {
  const r = await run(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { signal: AbortSignal.abort() });
  assert.equal(r.aborted, true);
});
