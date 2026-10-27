// Retargeting clips to rigs with other proportions (anim.js retarget) on the bundled examples.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RIG_R15, solve, lowestY, quatFromR } from '../src/core/rig.js';
import { retarget, FEET, buildTracks, sampleTracks, duration } from '../src/core/anim.js';
import { motionStats } from '../src/core/metrics.js';

const example = name => JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', `${name}.json`), 'utf8')).anim;
const NAMES = ['idle', 'walk', 'wave', 'cheer', 'jump'];

// The default rig with legs, arms and the rest of the body scaled separately, standing on y = 0.
function scaled({ legs, arms, body }) {
  const f = part => (/Leg|Foot/.test(part) ? legs : /Arm|Hand/.test(part) ? arms : body);
  const rig = structuredClone(RIG_R15);
  for (const [n, size] of Object.entries(rig.parts)) rig.parts[n] = size.map(v => v * f(n));
  for (const j of rig.joints) { j.c0 = j.c0.map(v => v * f(j.part0)); j.c1 = j.c1.map(v => v * f(j.part1)); }
  rig.hipHeight *= legs;
  rig.hipHeight -= lowestY(solve({}, rig), FEET, rig);
  return rig;
}
const RIGS = {
  bigger: scaled({ legs: 1.3, arms: 1.3, body: 1.3 }),
  'long legs': scaled({ legs: 1.25, arms: 1.1, body: 1 }),
  'short legs': scaled({ legs: 0.8, arms: 0.9, body: 1 }),
};

function maxRotationDiff(a, b) {
  const A = buildTracks(a), B = buildTracks(b);
  let max = 0;
  for (let t = 0; t <= duration(a) + 1e-9; t += 1 / 60) {
    const sa = sampleTracks(A, t), sb = sampleTracks(B, t);
    for (const part of Object.keys(sa)) {
      const qa = quatFromR(sa[part].R), qb = quatFromR(sb[part].R);
      max = Math.max(max, 2 * Math.acos(Math.min(1, Math.abs(qa.reduce((s, v, i) => s + v * qb[i], 0)))) * 180 / Math.PI);
    }
  }
  return max;
}

test('retargeting to the same rig changes (almost) nothing', () => {
  for (const name of NAMES) {
    const anim = example(name);
    const out = retarget(anim, RIG_R15, RIG_R15);
    assert.ok(maxRotationDiff(anim, out.anim) < 1, `${name} turned a joint by ${maxRotationDiff(anim, out.anim).toFixed(2)}°`);
  }
  assert.deepEqual(retarget(example('idle'), RIG_R15, RIG_R15).anim, example('idle'));
});

test('on other proportions feet stay on the ground and jumps keep their airtime', () => {
  for (const [rigName, rig] of Object.entries(RIGS)) {
    for (const name of NAMES) {
      const source = motionStats(example(name));
      const out = retarget(example(name), RIG_R15, rig);
      const m = motionStats(out.anim, rig);
      assert.ok(m.footSink <= 0.06, `${name} on ${rigName}: feet sink ${m.footSink}`);
      assert.ok(Math.abs(m.airTime - source.airTime) <= 0.1, `${name} on ${rigName}: airtime ${source.airTime} → ${m.airTime}`);
      assert.equal(out.issues.length, 0, `${name} on ${rigName}: ${JSON.stringify(out.issues)}`);
    }
  }
});

test('without retargeting the same clip sinks into the ground on shorter legs', () => {
  assert.ok(motionStats(example('jump'), RIGS['short legs']).footSink > 0.2);
});

test('root motion scales with the hip height', () => {
  const rig = RIGS.bigger;
  const s = rig.hipHeight / RIG_R15.hipHeight;
  const src = example('jump'), out = retarget(src, RIG_R15, rig).anim;
  const peak = anim => Math.max(...anim.keyframes.map(k => k.poses.LowerTorso?.pos[1] ?? 0));
  assert.ok(Math.abs(peak(out) - peak(src) * s) < 0.05, `peak ${peak(src)} × ${s.toFixed(2)} vs ${peak(out)}`);
});
