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

test('examples: the jump is in the air, the idle stays on the ground, the wave uses the whole body', () => {
  const jump = motionStats(example('jump')), idle = motionStats(example('idle')), wave = motionStats(example('wave'));
  assert.ok(jump.airTime > 0.3);
  assert.equal(idle.airTime, 0);
  assert.ok(idle.footSlide < 0.1);
  assert.deepEqual(wave.regions.toSorted(), ['arms', 'head', 'legs', 'torso']);
  assert.ok(wave.activeJoints >= 10);
});
