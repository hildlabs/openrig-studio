// Custom rigs: any Motor6D (or AnimationConstraint) hierarchy, humanoid or not. The Studio side
// only reads what is there (part sizes, joints, C0/C1); everything the pipeline needs to know
// about the body is found here, from the joint hierarchy and the rest pose, without part names:
//
//   body      the one child of the root part: it carries the rest and gets the offsets
//   feet      parts that stand on the ground in the rest pose (leaves that sit lowest)
//   chains    two-bone limbs for IK: a leaf, the part above it and the one above that
//   colliders what limbs must not enter; probes: the points of limbs that are checked
//   limits    plausible joint ranges (generous: nothing is known about a creature's joints)
//
// Plain ES module like rig.js; used by the server when a rig is imported and by the tests.
import { solve, point, cf, rootCFrame } from './rig.js';
import { inside } from './anim.js';

const NAME = /^[\p{L}\p{N}_][\p{L}\p{N} _.()-]*$/u;
const MAX_PARTS = 64, MAX_CHAINS = 12;
const vec = (v, n) => Array.isArray(v) && v.length === n && v.every(x => typeof x === 'number' && Number.isFinite(x));
const r4 = v => Math.round(v * 10000) / 10000;
const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const isIdent = R => R.every((v, i) => Math.abs(v - IDENT[i]) <= 1e-4);
const bad = msg => Object.assign(new Error(`This is not a usable custom rig: ${msg}`), { status: 400 });

// Names reach the system prompt, Luau and XML, so only plain names are accepted.
export function cleanLabel(name, fallback = 'Rig') {
  return String(name ?? '').replace(/[^\p{L}\p{N} _.()-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || fallback;
}

// data: { root?, parts: { name: [x, y, z] }, joints: [{ part0, part1, name?, c0, c1, c0R?, c1R? }],
//         feet?: [part], limits?: { part: [[lo, hi], ×3] }, source? }
export function buildCustomRig(data, label = 'Rig') {
  if (!data || typeof data !== 'object') throw bad('no data');
  const names = Object.keys(data.parts ?? {});
  if (names.length < 2) throw bad('it needs at least two parts joined by a Motor6D');
  for (const n of names) {
    if (n.length > 60 || !NAME.test(n) || n in Object.prototype) throw bad(`the part name "${n.slice(0, 40)}" has characters that can't be used (letters, digits, space and _ . ( ) - are fine)`);
    const size = data.parts[n];
    if (!vec(size, 3) || size.some(v => v <= 0 || v > 500)) throw bad(`part ${n} has no valid size`);
  }

  // Joints keyed by the part they move; the first joint of a part wins, joints to unknown parts are ignored.
  const incoming = new Map();
  for (const j of Array.isArray(data.joints) ? data.joints : []) {
    if (!j || !names.includes(j.part0) || !names.includes(j.part1) || j.part0 === j.part1 || incoming.has(j.part1)) continue;
    for (const k of ['c0', 'c1']) if (!vec(j[k], 3) || j[k].some(v => Math.abs(v) > 1000)) throw bad(`the joint to ${j.part1} has no valid offset`);
    for (const k of ['c0R', 'c1R']) if (j[k] !== undefined && !vec(j[k], 9)) throw bad(`the joint to ${j.part1} has a broken rotation`);
    incoming.set(j.part1, j);
  }
  const children = new Map(names.map(n => [n, []]));
  for (const j of incoming.values()) children.get(j.part0).push(j.part1);
  const weight = function count(n, seen = new Set()) { // descendants incl. itself, safe against cycles
    if (seen.has(n)) return 0;
    seen.add(n);
    return 1 + children.get(n).reduce((s, c) => s + count(c, seen), 0);
  };

  // The root: the given one, else the part without a joint above it that has the most below it.
  let root = data.root;
  if (root !== undefined && !names.includes(root)) throw bad(`the root part ${String(root).slice(0, 40)} doesn't exist`);
  if (root === undefined) {
    const tops = names.filter(n => !incoming.has(n));
    if (!tops.length) throw bad('no part is free of a joint above it, so there is no root');
    root = tops.reduce((best, n) => (weight(n) > weight(best) ? n : best));
  } else if (incoming.has(root)) throw bad(`the root part ${root} hangs below another part`);

  // Parent before child, each part once; parts the root doesn't reach can't be animated and are left out.
  const order = [], seen = new Set([root]), queue = [root];
  while (queue.length) {
    const n = queue.shift();
    for (const c of children.get(n)) {
      if (seen.has(c)) continue;
      seen.add(c);
      order.push(incoming.get(c));
      queue.push(c);
    }
  }
  if (!order.length) throw bad('the root part has no joints');
  // Offsets and grounding move the body part, so everything has to hang below one: a second
  // branch off the root would stay behind when the body jumps, or keep its feet in the ground.
  const branches = order.filter(j => j.part0 === root).map(j => j.part1);
  if (branches.length > 1) throw bad(`the root part ${root} carries ${branches.length} parts through separate joints (${branches.slice(0, 4).join(', ')}); everything must hang below a single body part`);
  if (seen.size > MAX_PARTS) throw bad(`it has ${seen.size} parts, at most ${MAX_PARTS} are supported`);
  const parts = Object.fromEntries([root, ...order.map(j => j.part1)].map(n => [n, data.parts[n].map(r4)]));
  const joints = order.map(j => {
    const out = { name: cleanLabel(j.name, j.part1), part0: j.part0, part1: j.part1, c0: j.c0.map(r4), c1: j.c1.map(r4) };
    // Rotations that are (almost) identity are dropped, as in the default rig.
    for (const k of ['c0R', 'c1R']) if (j[k] && !isIdent(j[k])) out[k] = j[k];
    return out;
  });
  const kids = new Map(Object.keys(parts).map(n => [n, joints.filter(j => j.part0 === n).map(j => j.part1)]));
  const parent = Object.fromEntries(joints.map(j => [j.part1, j.part0]));
  const depth = n => (n === root ? 0 : 1 + depth(parent[n]));

  const rig = {
    id: 'custom', family: 'custom', label: cleanLabel(label), root, hipHeight: 0, face: false,
    body: kids.get(root)[0],
    parts, joints, feet: [], ik: false, chains: {}, colliders: [], probes: [], measured: [], limits: {}, regions: {},
  };
  // The name of the Studio model, exactly as it is, to find it again; it is only escaped where it is put into Luau.
  if (typeof data.source === 'string' && data.source && data.source.length <= 1000) rig.source = data.source;

  // ---- Rest pose with the root at the origin ----
  const rest = solve({}, rig, cf());
  const corners = n => {
    const [sx, sy, sz] = parts[n].map(v => v / 2);
    return [-sx, sx].flatMap(x => [-sy, sy].flatMap(y => [-sz, sz].map(z => point(rest[n], [x, y, z]))));
  };
  const low = n => Math.min(...corners(n).map(p => p[1]));
  const high = n => Math.max(...corners(n).map(p => p[1]));
  const leaves = Object.keys(parts).filter(n => n !== root && !kids.get(n).length);

  // ---- Feet: leaves at the lowest level of the rest pose (or those the data names) ----
  let feet;
  if (Array.isArray(data.feet)) {
    feet = data.feet.filter(n => leaves.includes(n));
    if (feet.length !== data.feet.length) throw bad('feet must be parts at the end of a joint chain');
  } else {
    // Only leaves at the bottom of the whole rig stand on the ground: the claw of an arm on a
    // pedestal is its lowest leaf but not near the lowest point.
    const floor = Math.min(...Object.keys(parts).filter(n => n !== root).map(low));
    const height = Math.max(...Object.keys(parts).map(high)) - floor;
    feet = leaves.filter(n => low(n) <= floor + Math.max(0.25, height * 0.08));
  }
  rig.feet = feet.slice(0, 8);

  // ---- Chains: leaf ← lower ← upper, where lower and upper carry nothing else ----
  const chains = {};
  for (const end of leaves) {
    const lower = parent[end], upper = parent[lower];
    // The upper part must be a limb of its own: not the root, not the body that carries everything.
    if (!upper || lower === root || upper === root || upper === rig.body || kids.get(lower).length !== 1 || kids.get(upper).length !== 1) continue;
    if (Object.keys(chains).length >= MAX_CHAINS) break;
    // How far the part's centre sits above its lowest point, so a foot target means the sole.
    chains[end] = { joints: [upper, lower], end, ...(rig.feet.includes(end) ? { foot: true, lift: r4((high(end) - low(end)) / 2) } : {}), ball: true };
  }
  rig.chains = chains;
  rig.ik = Object.keys(chains).length > 0;

  // ---- Stand it on the ground like the default rig: soles at y = 0 in the rest pose ----
  const floor = rig.feet.length ? Math.min(...rig.feet.map(low)) : Math.min(...Object.keys(parts).map(low));
  const rootY = r4(-floor);
  rig.hipHeight = r4(rootY - parts[root][1] / 2);
  const standing = solve({}, rig, rootCFrame(rig));

  // ---- Regions (colours, dope sheet groups): legs = chains ending at a foot, arms = other limbs ----
  const region = rig.regions;
  // The head is the highest part below the root (the root part itself is often as big as the body).
  const top = Object.keys(parts).filter(n => n !== root).reduce((a, b) => (high(b) > high(a) ? b : a));
  const inChain = new Set(Object.values(chains).flatMap(c => [...c.joints, c.end]));
  for (const n of Object.keys(parts)) region[n] = 'torso';
  for (const c of Object.values(chains)) for (const n of [...c.joints, c.end]) region[n] = c.foot ? 'legs' : 'arms';
  for (const n of leaves) if (!chains[n] && n !== root) region[n] = rig.feet.includes(n) ? 'legs' : 'arms';
  rig.head = top;
  if (!inChain.has(top) && top !== rig.body) region[top] = 'head';

  // ---- Limits, colliders, probes, measurements ----
  const given = data.limits && typeof data.limits === 'object' ? data.limits : {};
  for (const n of Object.keys(parts)) {
    if (n === root) continue;
    const l = given[n];
    const ok = Array.isArray(l) && l.length === 3 && l.every(r => Array.isArray(r) && r.length === 2 && r.every(Number.isFinite) && r[0] <= r[1] && r[0] >= -360 && r[1] <= 360);
    // The body part may spin and flip freely; everything else a good way around.
    rig.limits[n] = ok ? l.map(r => [...r]) : n === rig.body ? [[-180, 180], [-180, 180], [-180, 180]] : [[-150, 150], [-150, 150], [-150, 150]];
  }
  // Colliders: everything that is not a limb, the biggest first (the body always).
  const volume = n => parts[n].reduce((a, b) => a * b, 1);
  rig.colliders = Object.keys(parts).filter(n => n !== root && !inChain.has(n)).sort((a, b) => volume(b) - volume(a)).slice(0, 10);
  if (!rig.colliders.includes(rig.body)) rig.colliders.unshift(rig.body);
  // Points of limbs that must stay out of the body; one that starts inside it is a design choice.
  const probes = [];
  for (const c of Object.values(chains).filter(c => !c.foot)) {
    const toEnd = joints.find(j => j.part1 === c.end).c0; // where the end's joint sits in the lower part
    probes.push([c.end, [0, 0, 0]], [c.joints[1], toEnd.map(v => r4(v * 0.66))]);
  }
  rig.probes = probes.filter(([n, at]) => !rig.colliders.some(b => b !== n && inside(standing, b, point(standing[n], at), rig)));
  const measured = [];
  if (!inChain.has(rig.head)) measured.push([rig.head, rig.head, [0, 0, 0]]);
  for (const c of Object.values(chains).filter(c => !c.foot)) measured.push([c.end, c.end, [0, 0, 0]]);
  for (const n of rig.feet) measured.push([n, n, [0, 0, 0]]);
  rig.measured = measured.filter(([, n], i) => measured.findIndex(m => m[1] === n) === i).slice(0, 12);

  // Dope sheet rows: the body line, then every limb (a chain from the first part below a branch).
  rig.groups = groupsOf(rig, kids);
  return rig;
}

// Rows of the dope sheet: unbranched runs of joints, so each limb and the spine get a group.
function groupsOf(rig, kids) {
  const groups = [];
  const walk = (start) => {
    const run = [start];
    let cur = start;
    while (kids.get(cur).length === 1) { cur = kids.get(cur)[0]; run.push(cur); }
    groups.push(run);
    for (const c of kids.get(cur)) walk(c);
  };
  walk(rig.body);
  return groups;
}
