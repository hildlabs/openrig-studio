// Undo/redo steps for the editor: snapshots of the state before each change. Repeated records
// with the same tag shortly after each other (a slider drag, typing into one field) are one
// step. No DOM here, so the tests can use it directly.
export function createUndo({ limit = 100, mergeMs = 1000, now = () => performance.now() } = {}) {
  let back = [], ahead = [], lastTag = '', lastAt = -Infinity;
  return {
    // take() returns a snapshot of the state before the change; it is only called when needed.
    record(take, tag = '') {
      const at = now();
      const merge = tag && tag === lastTag && at - lastAt < mergeMs;
      lastTag = tag;
      lastAt = at;
      if (merge) return false;
      back.push(take());
      if (back.length > limit) back.shift();
      ahead = [];
      return true;
    },
    // current: snapshot of the state now, kept for the opposite direction.
    undo(current) { return move(back, ahead, current); },
    redo(current) { return move(ahead, back, current); },
    clear() { back = []; ahead = []; lastTag = ''; },
    get canUndo() { return back.length > 0; },
    get canRedo() { return ahead.length > 0; },
  };
  function move(from, to, current) {
    if (!from.length) return null;
    to.push(current);
    lastTag = '';
    return from.pop();
  }
}
