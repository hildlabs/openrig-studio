// Editor undo/redo steps (web/undo.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUndo } from '../web/undo.js';

// A fake clock and a counter as the "state".
function setup(options) {
  let time = 0, state = 0;
  const undo = createUndo({ now: () => time, ...options });
  const change = (value, tag) => { undo.record(() => state, tag); state = value; };
  return { undo, change, wait: ms => { time += ms; }, get: () => state, set: v => { state = v; } };
}

test('undo and redo walk back and forth through the changes', () => {
  const s = setup();
  assert.equal(s.undo.canUndo, false);
  s.change(1); s.change(2); s.change(3);
  s.set(s.undo.undo(s.get())); assert.equal(s.get(), 2);
  s.set(s.undo.undo(s.get())); assert.equal(s.get(), 1);
  s.set(s.undo.redo(s.get())); assert.equal(s.get(), 2);
  s.set(s.undo.undo(s.get())); s.set(s.undo.undo(s.get())); assert.equal(s.get(), 0);
  assert.equal(s.undo.undo(s.get()), null, 'nothing left to undo');
  assert.equal(s.undo.canRedo, true);
});

test('a new change after undo drops the steps ahead', () => {
  const s = setup();
  s.change(1); s.change(2);
  s.set(s.undo.undo(s.get()));
  s.change(5);
  assert.equal(s.undo.canRedo, false);
  s.set(s.undo.undo(s.get())); assert.equal(s.get(), 1);
});

test('a slider drag is one step, a pause or another field starts a new one', () => {
  const s = setup({ mergeMs: 1000 });
  for (let v = 1; v <= 20; v++) { s.change(v, 'rot.0'); s.wait(30); }
  s.set(s.undo.undo(s.get())); assert.equal(s.get(), 0, 'the whole drag is undone at once');
  s.set(s.undo.redo(s.get())); assert.equal(s.get(), 20);
  s.change(21, 'rot.0'); s.wait(2000); s.change(22, 'rot.0'); s.change(23, 'rot.1');
  s.set(s.undo.undo(s.get())); assert.equal(s.get(), 22);
  s.set(s.undo.undo(s.get())); assert.equal(s.get(), 21);
});

test('changes without a tag are never merged, the snapshot is only taken when needed', () => {
  let taken = 0;
  const undo = createUndo({ now: () => 0 });
  undo.record(() => ++taken); undo.record(() => ++taken);
  assert.equal(taken, 2);
  undo.record(() => ++taken, 'a'); undo.record(() => ++taken, 'a');
  assert.equal(taken, 3);
});

test('undo after a redo does not merge into the previous drag', () => {
  const s = setup();
  s.change(1, 'rot.0'); s.change(2, 'rot.0');
  s.set(s.undo.undo(s.get()));
  s.change(9, 'rot.0');
  s.set(s.undo.undo(s.get())); assert.equal(s.get(), 0);
});

test('the oldest steps are dropped beyond the limit, clear forgets everything', () => {
  const s = setup({ limit: 3 });
  for (let v = 1; v <= 5; v++) s.change(v);
  let n = 0;
  while (s.undo.canUndo) { s.set(s.undo.undo(s.get())); n++; }
  assert.equal(n, 3);
  assert.equal(s.get(), 2);
  s.undo.clear();
  assert.equal(s.undo.canRedo, false);
});
