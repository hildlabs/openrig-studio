// R6 rig (rig.js RIG_R6) against values measured in Roblox Studio: rest pose, playback of a
// test clip with Animator:StepAnimations, and the Pose CFrames written on export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RIG_R6, RIG_R15, solve, inv, mul, lowestY } from '../src/core/rig.js';
import { prepare, retarget, sample, exportTree, fromStudio, inspect } from '../src/core/anim.js';

const near = (a, b, tol, msg) => assert.ok(a.every((v, i) => Math.abs(v - b[i]) <= tol), `${msg}: ${a.map(v => v.toFixed(4))} vs ${b}`);
const relative = (world, part) => { const c = mul(inv(world.HumanoidRootPart), world[part]); return [...c.p, ...c.R]; };

test('R6 rest pose matches Studio (parts relative to the root part, legs end on the ground)', () => {
  const w = solve({}, RIG_R6);
  const studio = {
    Torso: [0, 0, 0], Head: [0, 1.5, 0], 'Right Arm': [1.5, 0, 0], 'Left Arm': [-1.5, 0, 0], 'Right Leg': [0.5, -2, 0], 'Left Leg': [-0.5, -2, 0],
  };
  for (const [part, p] of Object.entries(studio)) near(relative(w, part), [...p, 1, 0, 0, 0, 1, 0, 0, 0, 1], 1e-9, part);
  assert.equal(w['Right Leg'].p[1] - 1, 0, 'legs end at y = 0');
});

// Every joint turned, the body moved, Linear and Out easing; sampled at t = 0.5 in Studio.
const CLIP = { name: 'R6 test', keyframes: [
  { t: 0, poses: {} },
  { t: 0.5, poses: { Torso: { rot: [-20, 30, 10], pos: [0.3, -0.5, 0.4] }, Head: { rot: [15, -40, 5] }, 'Right Arm': { rot: [120, 10, 30] }, 'Left Arm': { rot: [-30, 0, -60], ease: 'Linear' }, 'Right Leg': { rot: [60, 5, 10] }, 'Left Leg': { rot: [-25, 0, -5], ease: 'Out' } } },
  { t: 1, poses: { Torso: { rot: [10, -20, 0], pos: [0, 0.8, 0] }, 'Right Arm': { rot: [170, 0, 10] }, 'Left Leg': { rot: [40, 0, 0] } } },
] };
const STUDIO_AT_05 = {
  Torso: [0.3, -0.5, 0.4, 0.8529, -0.1504, 0.5, -0.0052, 0.9551, 0.2962, -0.5221, -0.2552, 0.8138],
  Head: [0.0986, 0.9519, 0.1204, 0.9837, -0.102, -0.1484, 0.108, 0.9936, 0.0332, 0.1441, -0.0487, 0.9884],
  'Right Arm': [1.5725, 0.1249, -0.7312, 0.9995, 0.0098, 0.0302, 0.0317, -0.2734, -0.9614, -0.0012, 0.9618, -0.2736],
  'Left Leg': [0.3094, -2.2219, 1.5609, 0.8799, -0.2719, 0.3896, -0.0698, 0.7372, 0.6721, -0.47, -0.6186, 0.6297],
};

test('an R6 clip plays like Roblox plays it', () => {
  const { anim, warnings } = prepare(CLIP, { ground: false }, RIG_R6);
  assert.deepEqual(warnings, []);
  const w = solve(sample(anim, 0.5), RIG_R6);
  for (const [part, want] of Object.entries(STUDIO_AT_05)) near(relative(w, part), want, 2e-4, part);
});

test('poses are written in each R6 joint\'s own frame and read back unchanged', () => {
  const { anim } = prepare(CLIP, { ground: false }, RIG_R6);
  const kf = exportTree(anim, RIG_R6)[2];
  const find = (n, part) => (n.part === part ? n : n.children.map(c => find(c, part)).find(Boolean));
  // RootJoint's frame swaps y and z: moving the body up 0.8 studs is Pose (0, 0, 0.8).
  near(find(kf.root, 'Torso').cframe.p, [0, 0, 0.8], 1e-9, 'Torso pose position');
  assert.equal(kf.root.part, 'HumanoidRootPart');
  // Round trip through the format Studio returns (name, weight, CFrame components, style, dir).
  const flat = n => [[n.part, n.weight, [...n.cframe.p, ...n.cframe.R], n.style, n.dir], ...n.children.flatMap(flat)];
  const data = { name: 'R6 test', loop: false, priority: 'Action', keyframes: exportTree(anim, RIG_R6).map(k => ({ t: k.t, poses: flat(k.root), markers: [] })) };
  const back = fromStudio(data, RIG_R6).anim;
  for (const [i, k] of anim.keyframes.entries()) {
    for (const [part, pose] of Object.entries(k.poses)) {
      near(back.keyframes[i].poses[part].rot, pose.rot, 0.01, `${part} rot at ${k.t}`);
      near(back.keyframes[i].poses[part].pos, pose.pos, 0.001, `${part} pos at ${k.t}`);
    }
  }
});

test('R6 clips have no IK, are grounded by the legs and stay R6', () => {
  const r = prepare({ keyframes: [{ t: 0, poses: {} }, { t: 1, ik: { RightHand: [1, 4, -1] }, poses: { Torso: { rot: [-30, 0, 0] } } }] }, {}, RIG_R6);
  assert.ok(r.warnings.some(w => w.code === 'unknownTarget'));
  // Bending the Torso forward swings the legs back and lifts their front corners; grounding lowers the body until the lowest corner touches y = 0.
  assert.ok(Math.abs(lowestY(solve(sample(r.anim, 1), RIG_R6), RIG_R6.feet, RIG_R6)) < 0.011);
  assert.deepEqual(inspect(r.anim, RIG_R6).filter(i => i.code === 'footInGround'), []);
  assert.throws(() => retarget(r.anim, RIG_R6, RIG_R15), /between R6 and R15/);
});
