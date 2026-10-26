// Benchmark measurements (src/core/metrics.js) on hand-made clips and the bundled examples.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prepare, restClip } from '../src/core/anim.js';
import { motionStats } from '../src/core/metrics.js';

const example = name => JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', `${name}.json`), 'utf8')).anim;

test('a clip in rest pose does not move at all', () => {
  assert.deepEqual(motionStats(restClip()), { footSlide: 0, footSink: 0, airTime: 0, activeJoints: 0, regions: [], stillShare: 1, peakSpeed: 0 });
});

test('feet that move with the body while on the ground slide', () => {
  // The whole body moves 1 stud sideways without foot targets: both feet slide along.
  const { anim } = prepare({ keyframes: [{ t: 0, poses: { LowerTorso: { pos: [0, 0, 0], ease: 'Linear' } } }, { t: 1, poses: { LowerTorso: { pos: [1, 0, 0] } } }] });
  const m = motionStats(anim);
  assert.ok(Math.abs(m.footSlide - 2) < 0.01, `slide ${m.footSlide}`);
  assert.equal(m.airTime, 0);
  assert.deepEqual(m.regions, ['torso']);
  assert.equal(m.stillShare, 1, 'moving without turning counts as still');
});

test('the same move with planted foot targets barely slides', () => {
  const ik = { LeftFoot: [-0.5, 0, 0], RightFoot: [0.5, 0, 0] };
  const { anim } = prepare({ keyframes: [{ t: 0, ik, poses: { LowerTorso: { pos: [0, 0, 0] } } }, { t: 1, ik, poses: { LowerTorso: { pos: [0.4, -0.3, 0] } } }] });
  assert.ok(motionStats(anim).footSlide < 0.3);
});

test('planted feet stay put when the body accelerates or its easing is changed by motion flow', () => {
  const ik = { LeftFoot: [-0.5, 0, 0], RightFoot: [0.5, 0, 0] };
  // Fast push-off out of a squat: the body eases In while the legs blend linearly.
  const jump = prepare({ keyframes: [
    { t: 0, ik, poses: { LowerTorso: { pos: [0, 0, 0] } } },
    { t: 0.2, ik, poses: { LowerTorso: { rot: [-15, 0, 0], pos: [0, -0.9, 0.2], ease: 'In' } } },
    { t: 0.32, ik, poses: { LowerTorso: { pos: [0, 0, 0] } } },
    { t: 0.6, contact: 'air', poses: { LowerTorso: { pos: [0, 1.4, 0] } } },
    { t: 1, ik, poses: { LowerTorso: { pos: [0, 0, 0] } } },
  ] }, { literal: true });
  // Sinking in two steps the same way: motion flow turns the middle key into a pass-through.
  const squat = prepare({ keyframes: [
    { t: 0, ik, poses: { LowerTorso: { pos: [0, 0, 0] } } },
    { t: 0.3, ik, poses: { LowerTorso: { rot: [-8, 0, 0], pos: [0, -0.4, 0.1] } } },
    { t: 0.6, ik, poses: { LowerTorso: { rot: [-16, 0, 0], pos: [0, -0.9, 0.2] } } },
    { t: 1, ik, poses: { LowerTorso: { pos: [0, 0, 0] } } },
  ] }, { literal: true });
  for (const [name, r, slide, sink] of [['push-off', jump, 0.15, 0.15], ['squat', squat, 0.35, 0.05]]) {
    const m = motionStats(r.anim);
    assert.deepEqual(r.issues, [], name);
    assert.ok(m.footSlide < slide, `${name}: slide ${m.footSlide}`);
    assert.ok(m.footSink < sink, `${name}: sink ${m.footSink}`);
  }
});

test('feet do not go through the ground between a squat and an airborne key', () => {
  // Straight from the squat into the air: the legs stretch while the body still rises slowly.
  const feet = { LeftFoot: [-0.5, 0, 0], RightFoot: [0.5, 0, 0] };
  const straight = { rot: [0, 0, 0] };
  const r = prepare({ keyframes: [
    { t: 0, ik: feet, poses: { LowerTorso: { pos: [0, 0, 0] } } },
    { t: 0.18, ik: feet, poses: { LowerTorso: { rot: [-12, 0, 0], pos: [0, -0.8, 0.15], ease: 'In' } } },
    { t: 0.4, contact: 'air', poses: { LowerTorso: { pos: [0, 1.25, 0] }, LeftUpperLeg: straight, RightUpperLeg: straight, LeftLowerLeg: straight, RightLowerLeg: straight } },
    { t: 1, ik: feet, poses: { LowerTorso: { pos: [0, 0, 0] } } },
  ] }, { literal: true });
  assert.deepEqual(r.issues, []);
  assert.ok(motionStats(r.anim).footSink < 0.06);
  assert.ok(r.fixes.some(f => f.code === 'liftedBetween'));
  // The added body keys keep the motion flowing instead of stopping at each of them.
  const body = r.anim.keyframes.filter(k => k.poses.LowerTorso && k.t > 0.18 && k.t < 0.4);
  assert.ok(body.length > 0 && body.every(k => k.poses.LowerTorso.ease !== 'InOut'));
});

test('examples: the jump is in the air, the idle stays on the ground, the wave uses the whole body', () => {
  const jump = motionStats(example('jump')), idle = motionStats(example('idle')), wave = motionStats(example('wave'));
  assert.ok(jump.airTime > 0.3);
  assert.equal(idle.airTime, 0);
  assert.ok(idle.footSlide < 0.1);
  assert.deepEqual(wave.regions.toSorted(), ['arms', 'head', 'legs', 'torso']);
  assert.ok(wave.activeJoints >= 10);
});
