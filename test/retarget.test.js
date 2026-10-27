// Retargeting clips to rigs with other proportions (anim.js retarget) on the bundled examples.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RIG_R15, solve, lowestY, quatFromR } from '../src/core/rig.js';
import { retarget, prepare, FEET, buildTracks, sampleTracks, duration } from '../src/core/anim.js';
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

// ---------- Rigs read from Studio (src/server/rigs.js) ----------
import { checkRig } from '../src/server/rigs.js';
import { anglesDeg, mul, cf, inv } from '../src/core/rig.js';

const fromStudio = rig => ({ parts: rig.parts, joints: rig.joints.map(({ part0, part1, c0, c1 }) => ({ part0, part1, c0, c1 })), hipHeight: rig.hipHeight });

test('a rig from Studio needs every R15 joint and stands on the ground', () => {
  const data = fromStudio(RIGS['long legs']);
  const rig = checkRig({ ...data, hipHeight: 5 });
  assert.ok(Math.abs(rig.hipHeight - RIGS['long legs'].hipHeight) < 1e-3, 'hip height comes from the body, not the stored value');
  assert.ok(Math.abs(lowestY(solve({}, rig), FEET, rig)) < 1e-3);
  assert.throws(() => checkRig({ ...data, joints: data.joints.filter(j => j.part1 !== 'LeftFoot') }), /LeftAnkle is missing/);
  assert.throws(() => checkRig({ ...data, parts: { ...data.parts, Head: [1, -1, 1] } }), /Head is missing/);
});

test('joints with rotated attachments solve like Roblox (Part0 * C0 * T * C1⁻¹)', () => {
  // Turning both attachments of a joint by the same rotation must not move anything at rest.
  const R = anglesDeg([0, 90, 0]);
  const data = fromStudio(RIG_R15);
  data.joints = data.joints.map(j => (j.part1 === 'LeftUpperArm' ? { ...j, c0R: R, c1R: R } : j));
  const rig = checkRig(data);
  assert.ok(rig.joints.find(j => j.part1 === 'LeftUpperArm').c0R, 'a real rotation is kept');
  const hand = r => { const w = solve({}, r); return mul(inv(w.UpperTorso), w.LeftHand).p; };
  assert.ok(Math.hypot(...hand(RIG_R15).map((v, i) => v - hand(rig)[i])) < 1e-6);
  // A Transform is applied in the attachment's frame: with C0 turned 90° about y, a turn about
  // x in the Transform is a turn about z of the arm.
  const T = { LeftUpperArm: cf([0, 0, 0], anglesDeg([90, 0, 0])) };
  const w = solve(T, rig), j = rig.joints.find(x => x.part1 === 'LeftUpperArm');
  const want = mul(mul(mul(w.UpperTorso, cf(j.c0, j.c0R)), T.LeftUpperArm), inv(cf(j.c1, j.c1R)));
  assert.ok(Math.hypot(...want.p.map((v, i) => v - w.LeftUpperArm.p[i])) < 1e-9);
  assert.ok(checkRig(fromStudio(RIG_R15)).joints.every(x => !x.c0R && !x.c1R), 'identity rotations are dropped');
});

test('a retargeted jump stays in the air when it is saved again', () => {
  // Saving runs prepare() with grounding, which pulls every keyframe not marked "air" down.
  const rig = RIGS.bigger;
  const moved = retarget(example('jump'), RIG_R15, rig).anim;
  assert.ok(moved.keyframes.some(k => k.contact === 'air'), 'air keys are kept');
  const saved = prepare(moved, {}, rig).anim;
  const air = a => motionStats(a, rig).airTime;
  assert.ok(Math.abs(air(saved) - air(moved)) <= 0.05, `airtime ${air(moved)} → ${air(saved)} after saving`);
});
