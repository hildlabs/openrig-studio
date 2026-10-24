// Core rules: sign conventions promised in prompts/system.md, Roblox reference values measured
// in Studio (Animator:StepAnimations on a default R15 rig), IK, grounding, flow and export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solve, anglesDeg, eulerDeg, cf, lowestY } from '../src/core/rig.js';
import { prepare, normalize, sample, easeAlpha, toRbxmx, toLuauBuilder, exportTree, fromStudio, forModel, luaStr } from '../src/core/anim.js';
import { formatIssue } from '../src/core/messages.js';
import { renderSheet, renderStrip } from '../src/core/render.js';

const T = rot => cf([0, 0, 0], anglesDeg(rot));
const at = (transforms, part) => solve(transforms)[part].p;
const near = (a, b, eps = 0.02) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const yaw = R => Math.atan2(R[2], R[8]) * 180 / Math.PI; // heading of Ry(θ)
const codes = list => list.map(i => i.code);

test('rest pose stands on the ground and sign conventions hold', () => {
  near(lowestY(solve({}), ['LeftFoot', 'RightFoot']), 0);
  assert.ok(at({ RightUpperArm: T([0, 0, 90]) }, 'RightHand')[0] > 2.5, 'RightUpperArm z+ raises the arm sideways');
  assert.ok(at({ LeftUpperArm: T([0, 0, -90]) }, 'LeftHand')[0] < -2.5, 'LeftUpperArm z- raises the arm sideways');
  assert.ok(at({ RightUpperArm: T([90, 0, 0]) }, 'RightHand')[2] < -1.5, 'UpperArm x+ swings forward');
  assert.ok(at({ RightLowerArm: T([90, 0, 0]) }, 'RightHand')[2] < -0.5, 'elbow x+ bends forward');
  assert.ok(at({ RightUpperLeg: T([90, 0, 0]) }, 'RightFoot')[2] < -1.5, 'hip x+ lifts the leg forward');
  assert.ok(at({ RightLowerLeg: T([-90, 0, 0]) }, 'RightFoot')[2] > 0.5, 'knee x- bends backwards');
  assert.ok(at({ UpperTorso: T([30, 0, 0]) }, 'Head')[2] > 0.3, 'UpperTorso x+ leans back');
  assert.ok(at({ LowerTorso: T([0, 90, 0]) }, 'RightHand')[2] < -1, 'LowerTorso y+ turns left');
  eulerDeg(anglesDeg([20, -35, 50])).forEach((v, i) => near(v, [20, -35, 50][i], 1e-6));
  for (const e of ['InOut', 'In', 'Out', 'Linear']) { near(easeAlpha(e, 0), 0, 1e-9); near(easeAlpha(e, 1), 1, 1e-9); }
});

test('interpolation matches Roblox (Studio reference values)', () => {
  const verify = prepare({ keyframes: [
    { t: 0, poses: { RightUpperArm: { rot: [0, 0, 0], ease: 'Out' }, Head: { rot: [0, 0, 0], ease: 'In' }, LeftUpperLeg: { rot: [0, 0, 0], ease: 'Linear' }, LowerTorso: { rot: [0, 30, 0], pos: [0, 0.5, 0] } } },
    { t: 0.6, poses: { RightUpperArm: { rot: [90, 20, 45] }, LeftUpperLeg: { rot: [40, 0, 0] } } },
    { t: 1.0, poses: { Head: { rot: [0, 40, 10] }, RightUpperArm: { rot: [10, 0, 100] }, LowerTorso: { rot: [0, 30, 0], pos: [0, 0.5, 0] } } },
    { t: 1.5, poses: { RightUpperArm: { rot: [0, 0, 0] } } },
  ] }, { ground: false }).anim;
  const STUDIO = {
    0.3: { RightUpperArm: [0.724, -0.6462, 0.2411, 0.2987, -0.0213, -0.9541, 0.6217, 0.7628, 0.1776], Head: [0.9998, -0.0045, 0.0188, 0.0045, 1, -0.0016, -0.0188, 0.0017, 0.9998], LeftUpperLeg: [1, 0, 0, 0, 0.9397, -0.342, 0, 0.342, 0.9397] },
    0.6: { Head: [0.9881, -0.035, 0.15, 0.037, 0.9993, -0.0104, -0.1496, 0.0158, 0.9886] },
    0.8: { RightUpperArm: [0.2811, -0.9123, 0.2978, 0.7353, 0.0054, -0.6777, 0.6167, 0.4095, 0.6723], Head: [0.9335, -0.0783, 0.3498, 0.0893, 0.9959, -0.0154, -0.3472, 0.0456, 0.9367] },
    1.2: { RightUpperArm: [0.2682, -0.9629, -0.0305, 0.9535, 0.2699, -0.1339, 0.1371, 0.0068, 0.9905] },
    1.4: { RightUpperArm: [0.9984, -0.0557, -0.0048, 0.0557, 0.9984, -0.0042, 0.005, 0.004, 1] },
  };
  for (const [t, parts] of Object.entries(STUDIO)) {
    const s = sample(verify, Number(t));
    for (const [part, R] of Object.entries(parts)) R.forEach((v, i) => near(s[part].R[i], v, 0.002));
  }
  // Two-key tracks as measured (no normalisation): Linear↔Linear is nlerp, otherwise rotation vectors, shorter way.
  const two = (part, a, b, ease, endEase = ease) => ({ keyframes: [{ t: 0, poses: { [part]: { rot: a, pos: [0, 0, 0], ease } } }, { t: 1, poses: { [part]: { rot: b, pos: [0, 0, 0], ease: endEase } } }] });
  const R = (anim, part, t) => sample(anim, t)[part].R;
  near(Math.acos(R(two('RightUpperArm', [0, 0, 0], [0, 0, 179], 'Linear'), 'RightUpperArm', 0.25)[0]) * 180 / Math.PI, 36.8, 0.2);
  near(yaw(R(two('LowerTorso', [0, 0, 0], [0, 179, 0], 'Linear', 'InOut'), 'LowerTorso', 0.25)), 44.8, 0.2);
  near(Math.abs(yaw(R(two('LowerTorso', [0, 170, 0], [0, -170, 0], 'Linear'), 'LowerTorso', 0.5))), 180, 0.2);
  near(yaw(R(two('LowerTorso', [0, 120, 0], [0, -120, 0], 'InOut'), 'LowerTorso', 0.25)), 127.5, 0.2);
  near(yaw(R(two('LowerTorso', [0, 0, 0], [0, 179, 0], 'InOut'), 'LowerTorso', 0.25)), 11.2, 0.2);
  near(yaw(R(two('LowerTorso', [0, 0, 0], [0, 90, 0], 'Constant'), 'LowerTorso', 0.98)), 0, 0.01);
});

test('spins and flips play like Roblox and survive re-normalising', () => {
  const spinFlip = prepare({ keyframes: [
    { t: 0, poses: { LowerTorso: { rot: [0, 0, 0], ease: 'InOut' } } },
    { t: 1, poses: { LowerTorso: { rot: [0, 360, 0], ease: 'Out' } } },
    { t: 2, poses: { LowerTorso: { rot: [-360, 360, 0] } } }] }, { ground: false, literal: true }).anim;
  const STUDIO = { 0.2: [0.9799, 0, 0.1994, 0, 1, 0, -0.1994, 0, 0.9799], 0.4: [-0.0354, 0, 0.9994, 0, 1, 0, -0.9994, 0, -0.0354], 0.5: [-1, 0, 0, 0, 1, 0, 0, 0, -1],
    0.7: [0.7791, 0, -0.6269, 0, 1, 0, 0.6269, 0, 0.7791], 1.2: [1, 0, 0, 0, -0.9819, 0.1897, 0, -0.1897, -0.9819], 1.4: [1, 0, 0, 0, 0.2099, -0.9777, 0, 0.9777, 0.2099], 1.8: [1, 0, 0, 0, 0.9987, -0.0503, 0, 0.0503, 0.9987] };
  for (const [t, R] of Object.entries(STUDIO)) R.forEach((v, i) => near(sample(spinFlip, Number(t)).LowerTorso.R[i], v, 0.002));
  const again = prepare(structuredClone(spinFlip), { ground: false }).anim;
  for (const t of [0.1, 0.3, 0.5, 0.7, 1.3, 1.6]) sample(again, t).LowerTorso.R.forEach((v, i) => near(v, sample(spinFlip, t).LowerTorso.R[i], 0.01));
  const shown = forModel(spinFlip).keyframes.map(k => k.poses.LowerTorso?.rot[1]).filter(v => v !== undefined);
  assert.ok(shown.every((v, i) => i === 0 || v >= shown[i - 1] - 1e-6), 'models see continuous angles');
  const short = prepare({ keyframes: [{ t: 0, poses: { LowerTorso: { rot: [0, 170, 0], ease: 'Linear' } } }, { t: 1, poses: { LowerTorso: { rot: [0, -170, 0] } } }] }, { ground: false }).anim;
  assert.equal(short.keyframes.length, 2, 'a short turn needs no extra keys');
});

test('normalisation', () => {
  const n = normalize({ keyframes: [{ t: 0.5, poses: { Tail: { rot: [1, 2, 3] }, LeftLowerLeg: { rot: [40, 0, 0] } } }, { t: 1.2, poses: {} }] });
  assert.equal(n.anim.keyframes[0].t, 0);
  assert.deepEqual(n.anim.keyframes[0].poses.LeftLowerLeg.rot, [0, 0, 0]);
  assert.deepEqual(codes(n.warnings), ['unknownJoint', 'clamped']);
  assert.match(formatIssue(n.warnings[0], 'de'), /Unbekanntes Gelenk/);
  assert.match(formatIssue(n.warnings[0], 'en'), /Unknown joint/);
});

test('grounding and IK', () => {
  const squat = { LeftUpperLeg: { rot: [60, 0, 0] }, RightUpperLeg: { rot: [60, 0, 0] }, LeftLowerLeg: { rot: [-120, 0, 0] }, RightLowerLeg: { rot: [-120, 0, 0] }, LeftFoot: { rot: [60, 0, 0] }, RightFoot: { rot: [60, 0, 0] } };
  const r = prepare({ keyframes: [{ t: 0, poses: {} }, { t: 0.5, poses: squat }, { t: 0.8, contact: 'air', poses: { LowerTorso: { pos: [0, 2, 0] } } }, { t: 1.2, poses: {} }] });
  const ground = t => lowestY(solve(sample(r.anim, t)), ['LeftFoot', 'RightFoot']);
  near(ground(0.5), 0); near(ground(1.2), 0);
  assert.ok(ground(0.8) > 1.5, 'air keyframe keeps its height');

  const reach = prepare({ keyframes: [{ t: 0, poses: {} }, { t: 1, ik: { RightHand: [1.2, 5.6, -0.3], LeftHand: { pos: [-0.25, 3.9, -1.4] } }, poses: {} }] }, { ground: false });
  const rw = solve(sample(reach.anim, 1));
  near(rw.RightHand.p[0], 1.2, 0.05); near(rw.RightHand.p[1], 5.6, 0.05); near(rw.LeftHand.p[2], -1.4, 0.05);
  assert.ok(reach.anim.keyframes[1].poses.RightLowerArm.rot[0] >= 0, 'elbow never hyperextends');
  assert.equal(reach.anim.keyframes[1].ik, undefined, 'targets are baked into rotations');

  const hop = prepare({ keyframes: [{ t: 0, poses: {} }, { t: 0.5, contact: 'air', ik: { RightHand: [1.9, 5.45, -0.5], LeftHand: { pos: [-1.9, 5.45, -0.5], space: 'world' } }, poses: { LowerTorso: { pos: [0, 2, 0] } } }, { t: 1, poses: {} }] });
  const hw = solve(sample(hop.anim, 0.5));
  near(hw.RightHand.p[1], 7.45, 0.06); // body space follows the jump
  near(hw.LeftHand.p[1], 5.45, 0.06);  // world space stays

  const feet = { LeftFoot: [-0.5, 0, 0], RightFoot: [0.5, 0, 0] };
  const dip = prepare({ keyframes: [
    { t: 0, ik: feet, poses: {} },
    { t: 0.3, ik: feet, poses: { LowerTorso: { rot: [-15, 0, 0], pos: [0, -0.9, 0.2] }, UpperTorso: { rot: [-10, 0, 0] } } },
    { t: 0.6, ik: feet, poses: { LowerTorso: { rot: [-8, 0, 0], pos: [0, -0.4, 0.08] } } }] });
  assert.equal(dip.issues.length, 0, dip.issues.map(i => formatIssue(i)).join(' | '));
  for (let t = 0; t <= 0.6; t += 1 / 30) {
    const w = solve(sample(dip.anim, t));
    near(w.LeftFoot.p[0], -0.5, 0.05); near(w.LeftFoot.p[2], 0, 0.05); near(lowestY(w, ['LeftFoot']), 0, 0.05);
  }
  const far = prepare({ keyframes: [{ t: 0, poses: {} }, { t: 1, ik: { RightHand: [6, 4, 0] }, poses: {} }] }, { ground: false });
  assert.ok(codes(far.warnings).includes('unreachable'));
});

test('checks: collisions, pops, loops', () => {
  const bonk = prepare({ keyframes: [{ t: 0, poses: {} }, { t: 0.1, poses: { RightUpperArm: { rot: [93, 76, -26] }, RightLowerArm: { rot: [135, -56, 9] } } }] }, { ground: false });
  assert.ok(bonk.issues.some(i => i.code === 'limbInBody' && i.part === 'RightHand' && i.body === 'Head'));
  const snap = prepare({ keyframes: [{ t: 0, poses: { RightLowerLeg: { rot: [-120, 0, 0] } } }, { t: 0.08, poses: { RightLowerLeg: { rot: [0, 0, 0] } } }, { t: 0.5, poses: {} }] }, { ground: false });
  assert.ok(snap.issues.some(i => i.code === 'pop' && i.part === 'RightLowerLeg'));
  const loop = prepare({ loop: true, keyframes: [{ t: 0, poses: { Head: { rot: [0, 0, 0] } } }, { t: 1, poses: { Head: { rot: [20, 0, 0] } } }] });
  assert.ok(codes(loop.issues).includes('loopMismatch'));
  assert.equal(prepare({ keyframes: [{ t: 0, poses: {} }, { t: 1, poses: { RightUpperArm: { rot: [160, 0, 20] }, LeftUpperArm: { rot: [160, 0, -20] } } }] }).issues.length, 0);
});

test('motion flow only touches model output and keeps turning points', () => {
  const rise = [0, 1, 2, 3].map(i => ({ t: i * 0.3, contact: 'air', poses: { LowerTorso: { pos: [0, i, 0] } } }));
  assert.deepEqual(prepare({ keyframes: rise }, { literal: true }).anim.keyframes.map(k => k.poses.LowerTorso.ease).slice(0, 3), ['In', 'Linear', 'Out']);
  assert.deepEqual(prepare({ keyframes: rise }).anim.keyframes.map(k => k.poses.LowerTorso.ease).slice(0, 3), ['InOut', 'InOut', 'InOut']);
  const bounce = prepare({ keyframes: [0, 1, 0].map((y, i) => ({ t: i * 0.3, contact: 'air', poses: { LowerTorso: { pos: [0, y + 1, 0] } } })) }, { literal: true }).anim;
  assert.deepEqual(bounce.keyframes.slice(0, 2).map(k => k.poses.LowerTorso.ease), ['InOut', 'InOut']);
});

test('exports cannot be broken out of by names or stored values', () => {
  const n = normalize({ name: 'Wave\rprint(1)', priority: 'constructor', keyframes: [] }).anim;
  assert.equal(n.name, 'Wave print(1)');
  assert.equal(n.priority, 'Action');
  // A stored clip is not re-normalized before export, so the exports check it themselves.
  const raw = { ...n, name: 'Wave\rprint("pwned") --', loop: 'true; print("pwned")', priority: 'Idle\nprint("pwned")', events: [{ t: 0, name: 'a"\n', value: '\\"]] print("pwned")' }] };
  const lua = toLuauBuilder(raw);
  const lines = lua.split(/\r\n|\r|\n/);
  assert.match(lines[0], /^-- OpenRig Studio: "Wave print\(\\034pwned\\034\) --"$/);
  assert.ok(!lines.some(l => /^\s*print/.test(l)), 'no injected statement');
  assert.match(lua, /seq\.Loop = false\nseq\.Priority = Enum\.AnimationPriority\.Action\n/);
  const rbxmx = toRbxmx(raw);
  assert.match(rbxmx, /<bool name="Loop">false<\/bool><token name="Priority">2<\/token>/);
  // Luau literal round trip: \ddd are UTF-8 bytes.
  const text = 'Jubel ü "x" \\ \n' + String.fromCharCode(0x2028) + ' 😀';
  const bytes = luaStr(text).slice(1, -1).replace(/\\(\d{3})|(.)/gs, (_, d, c) => String.fromCharCode(d ? Number(d) : c.charCodeAt(0)));
  assert.equal(new TextDecoder().decode(Uint8Array.from(bytes, c => c.charCodeAt(0))), text);
  assert.match(luaStr(text), /^"[ -~]*"$/, 'printable ASCII only');
});

test('export and Studio round trip', () => {
  const anim = prepare({ name: 'Wink "test"', loop: true, priority: 'Idle', keyframes: [{ t: 0, poses: { Head: { rot: [0, 0, 10], ease: 'Out' } } }, { t: 1, poses: { Head: { rot: [0, 0, 10], ease: 'Constant' } } }], events: [{ t: 0.5, name: 'Sound', value: 'pop' }] }).anim;
  const tree = exportTree(anim);
  assert.equal(tree[0].root.part, 'HumanoidRootPart');
  assert.equal(tree[0].root.weight, 0);
  const rbxmx = toRbxmx([anim, { ...anim, name: 'Second' }]);
  assert.equal((rbxmx.match(/<Item class="KeyframeSequence"/g) || []).length, 2);
  assert.match(rbxmx, /Wink &quot;test&quot;/);
  assert.match(rbxmx, /<token name="EasingDirection">1<\/token><token name="EasingStyle">1<\/token>/, 'Constant exports with direction Out');
  assert.equal((rbxmx.match(/<Item /g) || []).length, (rbxmx.match(/<\/Item>/g) || []).length);
  assert.match(toLuauBuilder(anim), /Enum\.AnimationPriority\.Idle[\s\S]*return seq/);
  // Serialized like the Studio pull script; legacy Cubic In means Out.
  const data = { name: 'x', loop: false, priority: 'Action', keyframes: tree.map(kf => {
    const poses = [];
    const walk = n => { poses.push([n.part, n.weight, [...n.cframe.p, ...n.cframe.R], n.part === 'Head' ? 'Cubic' : n.style, n.part === 'Head' ? 'In' : n.dir]); n.children.forEach(walk); };
    if (kf.root) walk(kf.root);
    return { t: kf.t, poses, markers: kf.markers.map(m => [m.name, m.value]) };
  }).concat([{ t: 0.5, poses: [], markers: [['Sound', 'pop']] }]) }; // event keyframe as exported
  const back = fromStudio(data).anim;
  assert.deepEqual(back.keyframes[0].poses.Head.rot, [0, 0, 10]);
  assert.equal(back.keyframes[0].poses.Head.ease, 'Out');
  assert.equal(back.events[0].name, 'Sound');
});

test('renderer produces PNGs with frame metadata', () => {
  const anim = prepare({ keyframes: [{ t: 0, poses: {} }, { t: 2, poses: { RightUpperArm: { rot: [0, 0, 90] } } }] }).anim;
  const sheet = renderSheet(anim);
  assert.equal(sheet.png.subarray(1, 4).toString(), 'PNG');
  assert.equal(sheet.times.length, 17);
  assert.equal(renderStrip(anim).times.length, 5);
});
