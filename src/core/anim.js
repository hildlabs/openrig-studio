// Animation clip rules: normalise model output, sample it exactly like Roblox (per-joint
// tracks, shortest-way blending, easing of the earlier pose), solve hand/foot targets, keep
// feet on the ground, check for problems, and export KeyframeSequences (.rbxmx / Luau).
// Findings are structured objects, see messages.js.
import {
  RIG_R15, POSE_PARTS, IDENTITY, anglesDeg, eulerDeg, quatFromR, rFromQuat, quatLog, alignQuat,
  quatFromRotVec, solve, lowestY, cf, point, mul, inv,
} from './rig.js';
import { IK_CHAINS, solveChain } from './ik.js';

export const EASES = ['InOut', 'Out', 'In', 'Linear', 'Constant'];
export const PRIORITIES = { Idle: 0, Movement: 1, Action: 2, Action2: 3, Action3: 4, Action4: 5, Core: 1000 };
export const FEET = ['LeftFoot', 'RightFoot'];
// Stored clips are plain JSON and may come from elsewhere, so exports re-check these too.
export const priorityOf = p => (typeof p === 'string' && Object.hasOwn(PRIORITIES, p) ? p : 'Action');
// Names end up in Luau, XML and the UI: no control or line-break characters.
export const cleanName = s => String(s ?? '').replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();
const round = (v, n = 3) => Math.round(v * 10 ** n) / 10 ** n;
const vec3 = v => (Array.isArray(v) ? [0, 1, 2].map(i => (Number.isFinite(Number(v[i])) ? Number(v[i]) : 0)) : [0, 0, 0]);
const isZero = v => v.every(x => Math.abs(x) < 1e-9);
const wrap180 = v => { const w = ((((v + 180) % 360) + 360) % 360) - 180; return w === -180 && v > 0 ? 180 : w; };

export const restClip = (name = 'New animation') => ({ name, loop: false, priority: 'Action', keyframes: [{ t: 0, poses: {} }, { t: 1, poses: {} }], events: [] });
export const duration = anim => anim.keyframes.at(-1).t;
export const isRest = anim => anim.keyframes.every(k => Object.keys(k.poses).length === 0);

// ---------- Normalisation ----------
// literal: angles come from a model and mean exactly what they say (0 → 360 = full spin).
// Otherwise (stored, edited, imported data) consecutive angles are first unwrapped to the
// nearest equivalent, which is how Roblox blends them anyway.
export function normalize(input, { literal = false } = {}, rig = RIG_R15) {
  const warnings = [];
  const src = input && typeof input === 'object' ? input : {};
  const byTime = new Map();
  for (const kf of Array.isArray(src.keyframes) ? src.keyframes : []) {
    const t = round(Math.max(0, Number(kf?.t ?? kf?.time) || 0));
    const entry = byTime.get(t) ?? { t, poses: {} };
    if (kf?.contact === 'air') entry.contact = 'air';
    for (const [part, pose] of Object.entries(kf?.poses ?? {})) {
      if (!POSE_PARTS.includes(part)) { warnings.push({ code: 'unknownJoint', part }); continue; }
      const rot = vec3(pose?.rot), pos = vec3(pose?.pos);
      if (part !== 'LowerTorso' && !isZero(pos) && pos.some(v => Math.abs(v) > 0.6)) {
        warnings.push({ code: 'offsetTooLarge', part, t });
        for (let i = 0; i < 3; i++) pos[i] = Math.min(0.6, Math.max(-0.6, pos[i]));
      }
      entry.poses[part] = { rot, pos: pos.map(v => round(v, 3)), ease: EASES.includes(pose?.ease) ? pose.ease : 'InOut' };
    }
    for (const [end, goal] of Object.entries(kf?.ik ?? {})) {
      if (!IK_CHAINS[end]) { warnings.push({ code: 'unknownTarget', part: end }); continue; }
      const p = Array.isArray(goal) ? goal : goal?.pos;
      if (!Array.isArray(p) || p.length < 3 || p.some(v => !Number.isFinite(Number(v)))) { warnings.push({ code: 'invalidTarget', part: end, t }); continue; }
      (entry.ik ??= {})[end] = p.slice(0, 3).map(Number);
      if (goal?.space === 'world' || goal?.space === 'body') (entry.ikSpace ??= {})[end] = goal.space;
    }
    byTime.set(t, entry);
  }
  let keyframes = [...byTime.values()].sort((a, b) => a.t - b.t);
  if (!keyframes.length || keyframes[0].t > 0) keyframes.unshift({ t: 0, poses: {} });
  if (keyframes.length < 2) { keyframes.push({ t: 1, poses: {} }); warnings.push({ code: 'noLength' }); }
  startAtRest(keyframes);
  if (!literal) unwrapTracks(keyframes);
  keyframes = expandSpins(keyframes);
  clampRotations(keyframes, rig, warnings);
  const end = keyframes.at(-1).t;
  const events = (Array.isArray(src.events) ? src.events : [])
    .map(e => ({ t: round(Math.min(end, Math.max(0, Number(e?.t) || 0))), name: String(e?.name ?? 'Event').replace(/[^\w]/g, '').slice(0, 40) || 'Event', value: String(e?.value ?? '').slice(0, 100) }))
    .sort((a, b) => a.t - b.t);
  const anim = {
    name: cleanName(src.name ?? 'Animation').slice(0, 80) || 'Animation',
    loop: Boolean(src.loop),
    priority: priorityOf(src.priority),
    keyframes, events,
  };
  return { anim, warnings };
}

// Every track starts at t=0 so preview and Roblox agree; a joint first keyed later starts at
// rest. Runs again after IK, which keys arm and leg joints the model did not key itself.
function startAtRest(keyframes) {
  for (const part of POSE_PARTS) {
    const first = keyframes.find(k => k.poses[part]);
    if (first && first !== keyframes[0]) keyframes[0].poses[part] = { rot: [0, 0, 0], pos: [0, 0, 0], ease: 'InOut' };
  }
}

function unwrapTracks(keyframes) {
  for (const part of POSE_PARTS) {
    let prev = null;
    for (const kf of keyframes) {
      const pose = kf.poses[part];
      if (!pose) continue;
      if (prev) pose.rot = pose.rot.map((v, i) => prev[i] + wrap180(v - prev[i]));
      prev = pose.rot;
    }
  }
}
// Copy with continuous angles per joint (a spin reads 0, 120, 240, 360), as shown to models.
export function forModel(anim) {
  const copy = structuredClone(anim);
  unwrapTracks(copy.keyframes);
  for (const kf of copy.keyframes) for (const pose of Object.values(kf.poses)) pose.rot = pose.rot.map(v => round(v, 2));
  return copy;
}

// Roblox always blends along the shorter way, so a joint can never turn 180° or more between
// two keys. Large steps (spins, flips: 0 → 360 → 720) get in-between keys of at most 120°,
// placed so the original easing's timing is kept; inner pieces blend linearly.
const SPIN_STEP = 120;
function invEase(ease, f) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (easeAlpha(ease, mid) < f) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
function expandSpins(keyframes) {
  const inserts = new Map();
  for (const part of POSE_PARTS) {
    const keyed = keyframes.filter(k => k.poses[part]);
    for (let i = 0; i + 1 < keyed.length; i++) {
      const a = keyed[i], b = keyed[i + 1], pa = a.poses[part], pb = b.poses[part];
      const span = Math.max(...pa.rot.map((v, n) => Math.abs(pb.rot[n] - v)));
      if (span < 150 || pa.ease === 'Constant') continue;
      const n = Math.ceil(span / SPIN_STEP);
      const easeOf = k => (k === 0 && (pa.ease === 'In' || pa.ease === 'InOut') ? 'In'
        : k === n - 1 && (pa.ease === 'Out' || pa.ease === 'InOut') ? 'Out' : 'Linear');
      for (let k = 1; k < n; k++) {
        const f = k / n;
        const t = round(a.t + invEase(pa.ease, f) * (b.t - a.t));
        const entry = inserts.get(t) ?? keyframes.find(kf => Math.abs(kf.t - t) < 1e-9) ?? { t, poses: {} };
        entry.poses[part] = { rot: pa.rot.map((v, m) => v + (pb.rot[m] - v) * f), pos: pa.pos.map((v, m) => round(v + (pb.pos[m] - v) * f)), ease: easeOf(k) };
        inserts.set(t, entry);
      }
      pa.ease = easeOf(0);
    }
  }
  const added = [...inserts.values()].filter(e => !keyframes.includes(e));
  return [...keyframes, ...added].sort((x, y) => x.t - y.t);
}
function clampRotations(keyframes, rig, warnings) {
  for (const kf of keyframes) for (const [part, pose] of Object.entries(kf.poses)) {
    const lim = rig.limits[part];
    pose.rot = pose.rot.map((raw, i) => {
      let v = wrap180(raw);
      const [lo, hi] = lim[i];
      if (v < lo - 5 || v > hi + 5) {
        warnings.push({ code: 'clamped', part, axis: 'xyz'[i], value: raw, lo, hi, t: kf.t });
        v = Math.min(hi, Math.max(lo, v));
      }
      return round(v, 2);
    });
  }
}

// ---------- Sampling (matches Roblox, see docs/how-it-works.md) ----------
export function easeAlpha(ease, a) {
  switch (ease) {
    case 'Linear': return a;
    case 'Constant': return 0;
    case 'In': return a * a * a;
    case 'Out': return 1 - (1 - a) ** 3;
    default: return a < 0.5 ? 4 * a * a * a : 1 - (-2 * a + 2) ** 3 / 2;
  }
}
export function buildTracks(anim) {
  const tracks = {};
  for (const kf of anim.keyframes) for (const [part, pose] of Object.entries(kf.poses)) {
    const q = quatFromR(anglesDeg(pose.rot));
    (tracks[part] ??= []).push({ t: kf.t, q: q[3] < 0 ? q.map(v => -v) : q, p: pose.pos, ease: pose.ease });
  }
  return tracks;
}
export function sampleTracks(tracks, t) {
  const out = {};
  for (const [part, keys] of Object.entries(tracks)) {
    let i = 0;
    while (i < keys.length - 1 && keys[i + 1].t <= t) i++;
    const a = keys[i], b = keys[i + 1];
    if (!b || t <= a.t) { out[part] = { p: a.p, R: rFromQuat(a.q) }; continue; }
    const k = easeAlpha(a.ease, (t - a.t) / (b.t - a.t));
    const lerp = (x, y) => x.map((v, n) => v + (y[n] - v) * k);
    const qb = alignQuat(a.q, b.q);
    let q;
    // Roblox uses nlerp only between two Linear poses, rotation-vector lerp otherwise.
    if (a.ease === 'Linear' && b.ease === 'Linear') { const n = lerp(a.q, qb); const len = Math.hypot(...n); q = n.map(v => v / len); }
    else q = quatFromRotVec(lerp(quatLog(a.q), quatLog(qb)));
    out[part] = { p: lerp(a.p, b.p), R: rFromQuat(q) };
  }
  return out;
}
export const sample = (anim, t) => sampleTracks(buildTracks(anim), t);

// ---------- Ground, IK, motion flow ----------
// Shift LowerTorso so the lowest foot corner touches y = 0 on every keyframe that is not
// marked contact:"air"; airborne keyframes are only lifted out of the ground.
export function groundFeet(anim, rig = RIG_R15) {
  const notes = [];
  for (const kf of anim.keyframes) {
    if (kf.locked) continue; // foot-lock in-betweens follow the body path, IK keeps the feet down
    const world = solve(sample(anim, kf.t), rig);
    const low = lowestY(world, FEET, rig);
    const delta = kf.contact === 'air' ? Math.max(0, -low) : -low;
    if (Math.abs(delta) < 0.01) continue;
    if (!kf.poses.LowerTorso) {
      const s = sample(anim, kf.t).LowerTorso ?? IDENTITY;
      kf.poses.LowerTorso = { rot: eulerDeg(s.R).map(v => round(v, 2)), pos: s.p.map(v => round(v, 3)), ease: 'InOut' };
    }
    kf.poses.LowerTorso.pos[1] = round(kf.poses.LowerTorso.pos[1] + delta);
    if (Math.abs(delta) > 0.15) notes.push({ code: 'bodyLowered', t: kf.t, delta });
  }
  return notes;
}

// Grounding only sees keyframes; between them the legs can still push through the floor, most
// at take-offs where the legs stretch before the body has risen. Where a foot sinks deeper than
// SINK_TOL, the body gets a key at the deepest frame of that body segment, lifted so the foot
// touches the ground. The segment's easing is split so the motion keeps flowing through it.
const SINK_TOL = 0.05, SINK_FPS = 60;
const SPLIT_EASE = { InOut: ['In', 'Out'], In: ['In', 'Linear'], Out: ['Linear', 'Out'], Linear: ['Linear', 'Linear'] };
const bodyPose = (s, ease) => ({ rot: eulerDeg(s.R).map(v => round(v, 2)), pos: s.p.map(v => round(v, 3)), ease });
function groundBetween(anim, rig = RIG_R15) {
  const end = duration(anim);
  let count = 0;
  for (let pass = 0; pass < 6; pass++) {
    const tracks = buildTracks(anim);
    const bodyKeys = anim.keyframes.filter(k => k.poses.LowerTorso);
    const worst = new Map();
    for (let i = 1; i < Math.round(end * SINK_FPS); i++) {
      const t = round(i / SINK_FPS);
      const depth = -lowestY(solve(sampleTracks(tracks, t), rig), FEET, rig);
      if (depth <= SINK_TOL || bodyKeys.some(k => k.t === t)) continue;
      const before = bodyKeys.findLast(k => k.t < t);
      if (before && !SPLIT_EASE[before.poses.LowerTorso.ease]) continue; // Constant: a deliberate hold
      if (!(worst.get(before)?.depth >= depth)) worst.set(before, { t, depth });
    }
    if (!worst.size) break;
    for (const [before, { t, depth }] of worst) {
      const s = sampleTracks(tracks, t).LowerTorso ?? IDENTITY;
      // A body that was never keyed, or not after this point, first gets keys that keep its path.
      if (!before) anim.keyframes[0].poses.LowerTorso = bodyPose(sampleTracks(tracks, 0).LowerTorso ?? IDENTITY, 'InOut');
      if (!bodyKeys.some(k => k.t > t)) anim.keyframes.at(-1).poses.LowerTorso = bodyPose(sampleTracks(tracks, end).LowerTorso ?? IDENTITY, 'InOut');
      const from = (before ?? anim.keyframes[0]).poses.LowerTorso;
      const [first, second] = SPLIT_EASE[from.ease];
      from.ease = first;
      const kf = anim.keyframes.find(k => k.t === t) ?? { t, poses: {} };
      if (!anim.keyframes.includes(kf)) anim.keyframes.push(kf);
      kf.poses.LowerTorso = bodyPose(s, second);
      kf.poses.LowerTorso.pos[1] = round(kf.poses.LowerTorso.pos[1] + depth);
      count++;
    }
    anim.keyframes.sort((x, y) => x.t - y.t);
  }
  return count;
}

// Foot lock: a foot that keeps the same target in two consecutive keyframes gets in-between
// keyframes so it neither slides nor sinks while the body moves.
const LOCK_STEP = 0.07;
function lockFeet(anim) {
  const kfs = anim.keyframes;
  const inserts = new Map();
  for (const foot of FEET) {
    for (let i = 0; i + 1 < kfs.length; i++) {
      const a = kfs[i], b = kfs[i + 1];
      const ta = a.ik?.[foot], tb = b.ik?.[foot];
      if (!ta || !tb || a.contact === 'air' || b.contact === 'air') continue;
      if (a.ikSpace?.[foot] === 'body' || b.ikSpace?.[foot] === 'body') continue;
      if (Math.hypot(ta[0] - tb[0], ta[1] - tb[1], ta[2] - tb[2]) > 0.05) continue;
      (a.linear ??= []).push(foot);
      const n = Math.ceil((b.t - a.t) / LOCK_STEP) - 1;
      for (let k = 1; k <= n; k++) {
        const t = round(a.t + ((b.t - a.t) * k) / (n + 1));
        const entry = inserts.get(t) ?? { t, poses: {}, ik: {}, linear: [], locked: true };
        entry.ik[foot] = [...ta];
        entry.linear.push(foot);
        inserts.set(t, entry);
      }
    }
  }
  anim.keyframes = [...kfs, ...inserts.values()].sort((x, y) => x.t - y.t);
}

// Between two foot-lock keys the legs blend linearly while the body keeps its own easing, so a
// planted foot drifts or dips (most when the body accelerates out of a squat). Gaps where the
// foot leaves its place by more than LOCK_TOL are halved until it stays, down to 1/60 s.
const LOCK_TOL = 0.02, LOCK_MIN = 1 / 60;
const footAt = (anim, foot, t) => solve(sample(anim, t))[foot].p;
function refineLocks(anim) {
  for (let pass = 0; pass < 4; pass++) {
    const inserts = new Map();
    for (const foot of FEET) {
      const keys = anim.keyframes.filter(k => k.ik?.[foot]);
      for (let i = 0; i + 1 < keys.length; i++) {
        const a = keys[i], b = keys[i + 1];
        if (!a.linear?.includes(foot) || b.t - a.t < 2 * LOCK_MIN) continue;
        const t = round((a.t + b.t) / 2);
        const pa = footAt(anim, foot, a.t), pb = footAt(anim, foot, b.t), pm = footAt(anim, foot, t);
        if (Math.hypot(...pm.map((v, k) => v - (pa[k] + pb[k]) / 2)) <= LOCK_TOL) continue;
        const entry = inserts.get(t) ?? anim.keyframes.find(k => k.t === t) ?? { t, poses: {}, locked: true };
        if (IK_CHAINS[foot].joints.some(j => entry.poses[j])) continue;
        (entry.ik ??= {})[foot] = [...a.ik[foot]];
        (entry.linear ??= []).push(foot);
        inserts.set(t, entry);
      }
    }
    if (!inserts.size) break;
    const fresh = [...inserts.values()].filter(k => !anim.keyframes.includes(k));
    anim.keyframes = [...anim.keyframes, ...fresh].sort((x, y) => x.t - y.t);
    applyIK(anim, [...inserts.values()]);
  }
}

const REST_LT = solve({}).LowerTorso;
// Hands default to body space (they follow hips, jumps and turns), feet to world space.
function applyIK(anim, keyframes = anim.keyframes) {
  const notes = [];
  for (const kf of keyframes) {
    if (!kf.ik) continue;
    for (const [end, target] of Object.entries(kf.ik)) {
      const base = sample(anim, kf.t);
      const chain = IK_CHAINS[end];
      const space = kf.ikSpace?.[end] ?? (chain.foot ? 'world' : 'body');
      const goal = space === 'body' ? point(mul(solve(base).LowerTorso, inv(REST_LT)), target) : target;
      const rot = Object.fromEntries(chain.joints.map(j => [j, kf.poses[j]?.rot ?? (base[j] ? eulerDeg(base[j].R) : [0, 0, 0])]));
      const { rotations, error } = solveChain(end, goal, base, rot);
      const ease = kf.linear?.includes(end) ? 'Linear' : null;
      for (const [part, r] of Object.entries(rotations)) {
        kf.poses[part] = { rot: r.map(v => round(v, 2)), pos: kf.poses[part]?.pos ?? [0, 0, 0], ease: ease ?? kf.poses[part]?.ease ?? 'InOut' };
      }
      if (error > 0.2 && !kf.locked) notes.push({ code: 'unreachable', t: kf.t, part: end, target, error });
    }
  }
  return notes;
}
const stripIK = anim => anim.keyframes.forEach(kf => { delete kf.ik; delete kf.ikSpace; delete kf.linear; delete kf.locked; });

// Motion flow: Roblox has no tangents across keys, so InOut on every key makes continuous
// motion stop at each key (stop-and-go). Where a joint keeps moving in the same direction
// through a key, neighbouring InOut segments become pass-through easing.
const FLOW_ROT = 3, FLOW_POS = 0.04;
export function smoothFlow(anim) {
  let changed = 0;
  for (const part of POSE_PARTS) {
    const keys = anim.keyframes.filter(k => k.poses[part]).map(k => k.poses[part]);
    if (keys.length < 3) continue;
    const delta = (a, b) => [...b.rot.map((v, i) => wrap180(v - a.rot[i]) / FLOW_ROT), ...b.pos.map((v, i) => (v - a.pos[i]) / FLOW_POS)];
    const moving = d => Math.hypot(...d) > 1;
    const pass = keys.map((k, i) => {
      if (i === 0 || i === keys.length - 1) return false;
      const d1 = delta(keys[i - 1], k), d2 = delta(k, keys[i + 1]);
      return moving(d1) && moving(d2) && d1.reduce((s, v, n) => s + v * d2[n], 0) > 0.3 * Math.hypot(...d1) * Math.hypot(...d2);
    });
    for (let i = 0; i + 1 < keys.length; i++) {
      if (keys[i].ease !== 'InOut') continue;
      const ease = pass[i] && pass[i + 1] ? 'Linear' : pass[i] ? 'Out' : pass[i + 1] ? 'In' : 'InOut';
      if (ease !== 'InOut') { keys[i].ease = ease; changed++; }
    }
  }
  return changed;
}

// ---------- Checks ----------
const COLLIDERS = ['Head', 'UpperTorso', 'LowerTorso'];
const PROBES = [['LeftHand', [0, 0, 0]], ['RightHand', [0, 0, 0]], ['LeftLowerArm', [0, -0.35, 0]], ['RightLowerArm', [0, -0.35, 0]]];
// Limbs turning faster than this read as missing frames; whole-body spins may be faster.
const POP_SPEED = 1600, POP_SPEED_ROOT = 2400;
function inside(world, part, p, rig, margin = 0.12) {
  const c = world[part], R = c.R;
  const d = [p[0] - c.p[0], p[1] - c.p[1], p[2] - c.p[2]];
  const local = [0, 1, 2].map(i => R[i] * d[0] + R[3 + i] * d[1] + R[6 + i] * d[2]);
  return rig.parts[part].every((s, i) => Math.abs(local[i]) < s / 2 - margin);
}
// Problems between keyframes (30 fps) that the automatic fixes cannot see.
export function inspect(anim, rig = RIG_R15) {
  const issues = [];
  const tracks = buildTracks(anim);
  const end = duration(anim);
  const last = {};
  const once = (key, t, issue) => { if (t - (last[key] ?? -1) > 0.3) issues.push(issue); last[key] = t; };
  let prev = null;
  for (let t = 0; t <= end + 1e-6; t += 1 / 30) {
    const local = sampleTracks(tracks, t);
    const tt = round(t, 2);
    if (prev) for (const [part, s] of Object.entries(local)) {
      if (!prev[part]) continue;
      const q1 = quatFromR(prev[part].R), q2 = quatFromR(s.R);
      const speed = 2 * Math.acos(Math.min(1, Math.abs(q1.reduce((sum, v, i) => sum + v * q2[i], 0)))) * 180 / Math.PI * 30;
      if (speed > (part === 'LowerTorso' ? POP_SPEED_ROOT : POP_SPEED)) once('pop' + part, t, { code: 'pop', t: tt, part, speed: Math.round(speed) });
    }
    prev = local;
    const world = solve(local, rig);
    const low = lowestY(world, FEET, rig);
    if (low < -0.25) once('sink', t, { code: 'footInGround', t: tt, depth: -low });
    for (const [probe, at] of PROBES) for (const body of COLLIDERS) {
      if (inside(world, body, point(world[probe], at), rig)) once(probe + body, t, { code: 'limbInBody', t: tt, part: probe, body });
    }
  }
  if (anim.loop) {
    const a = sampleTracks(tracks, 0), b = sampleTracks(tracks, end);
    for (const part of Object.keys(tracks)) {
      const dq = Math.abs(quatFromR(a[part].R).reduce((s, v, i) => s + v * quatFromR(b[part].R)[i], 0));
      if (dq < 0.995 || a[part].p.some((v, i) => Math.abs(v - b[part].p[i]) > 0.02)) issues.push({ code: 'loopMismatch', part });
    }
  }
  return issues;
}

// Where head, hands and feet really end up per keyframe, as feedback for the model.
const MEASURED = ['Head', 'LeftHand', 'RightHand', 'LeftFoot', 'RightFoot'];
export function measure(anim, rig = RIG_R15) {
  return anim.keyframes.map(kf => {
    const world = solve(sample(anim, kf.t), rig);
    return `t=${kf.t}: ` + MEASURED.map(p => `${p} [${world[p].p.map(v => round(v, 2)).join(', ')}]`).join(', ');
  }).join('\n');
}

// Full pipeline for every model answer and manual edit. IK and grounding run twice so planted
// feet and the body height agree. Model output (literal) also gets automatic motion flow.
// Foot-lock in-betweens have no body key, so the body there depends on its easing: they are
// solved again once motion flow has changed it, then refined.
export function prepare(input, { ground = true, literal = false } = {}) {
  const { anim, warnings } = normalize(input, { literal });
  const hasIK = anim.keyframes.some(k => k.ik);
  if (hasIK) lockFeet(anim);
  let ikNotes = hasIK ? applyIK(anim) : [];
  if (hasIK) startAtRest(anim.keyframes);
  let fixes = ground ? groundFeet(anim) : [];
  if (hasIK) {
    ikNotes = applyIK(anim);
    if (ground) fixes = groundFeet(anim);
  }
  const flow = literal ? smoothFlow(anim) : 0;
  if (flow) fixes = [...fixes, { code: 'flowSmoothed', count: flow }];
  if (hasIK) {
    if (flow) applyIK(anim, anim.keyframes.filter(k => k.locked));
    refineLocks(anim);
    stripIK(anim);
  }
  const lifted = ground ? groundBetween(anim) : 0;
  if (lifted) fixes = [...fixes, { code: 'liftedBetween', count: lifted }];
  return { anim, warnings: [...warnings, ...ikNotes], fixes, issues: inspect(anim) };
}

// ---------- Import from Studio ----------
// data: serialized KeyframeSequence { name, loop, priority, keyframes: [{ t, poses:
// [[name, weight, [12 CFrame comps], style, dir]], markers: [[name, value]] }] }.
// Legacy "Cubic" runs In/Out reversed in Roblox; Constant only holds with direction Out.
const IMPORT_EASE = { Linear: () => 'Linear', Constant: () => 'Constant', CubicV2: dir => dir, Cubic: dir => (dir === 'In' ? 'Out' : dir === 'Out' ? 'In' : 'InOut') };
export function fromStudio(data) {
  const notes = [];
  const keyframes = [], events = [];
  for (const kf of data.keyframes ?? []) {
    const poses = {};
    for (const [name, weight, c, style, dir] of kf.poses ?? []) {
      if (!POSE_PARTS.includes(name) || weight <= 0) continue;
      if (style === 'Constant' && dir === 'In') notes.push({ code: 'importConstantIn', part: name, t: kf.t });
      const map = IMPORT_EASE[style];
      if (!map) notes.push({ code: 'importEasing', part: name, t: kf.t, style });
      poses[name] = { rot: eulerDeg(c.slice(3, 12)).map(v => round(v, 2)), pos: c.slice(0, 3).map(v => round(v, 3)), ease: map ? map(dir) : 'InOut' };
    }
    for (const [name, value] of kf.markers ?? []) events.push({ t: kf.t, name, value });
    if (Object.keys(poses).length || !(kf.markers ?? []).length) keyframes.push({ t: kf.t, poses });
  }
  const { anim, warnings } = normalize({ name: data.name, loop: data.loop, priority: data.priority, keyframes, events });
  return { anim, warnings: [...notes, ...warnings], fixes: [], issues: inspect(anim) };
}

// ---------- Export ----------
const PARENT = Object.fromEntries(RIG_R15.joints.map(j => [j.part1, j.part0]));
const EXPORT_EASE = { Linear: ['Linear', 'In'], Constant: ['Constant', 'Out'], In: ['CubicV2', 'In'], Out: ['CubicV2', 'Out'], InOut: ['CubicV2', 'InOut'] };
const STYLE_TOKEN = { Linear: 0, Constant: 1, Elastic: 2, Cubic: 3, Bounce: 4, CubicV2: 5 };
const DIR_TOKEN = { In: 0, Out: 1, InOut: 2 };
const num = v => String(round(v, 5));

// Keyframe pose trees: keyed poses Weight 1, structural ancestors Weight 0 (like the Animation Editor).
export function exportTree(anim) {
  return anim.keyframes.map(kf => {
    const nodes = new Map();
    const node = part => {
      if (nodes.has(part)) return nodes.get(part);
      const n = { part, weight: 0, cframe: IDENTITY, style: 'Linear', dir: 'In', children: [] };
      nodes.set(part, n);
      if (PARENT[part]) node(PARENT[part]).children.push(n);
      return n;
    };
    for (const part of POSE_PARTS) {
      const pose = kf.poses[part];
      if (!pose) continue;
      const [style, dir] = EXPORT_EASE[pose.ease] ?? EXPORT_EASE.InOut;
      Object.assign(node(part), { weight: 1, cframe: cf(pose.pos, anglesDeg(pose.rot)), style, dir });
    }
    return { t: kf.t, root: nodes.get(RIG_R15.root) ?? null, markers: anim.events.filter(e => Math.abs(e.t - kf.t) < 1e-6) };
  });
}

const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// One or several clips as a Roblox model file; Studio's "Insert from File" adds them all.
export function toRbxmx(anims) {
  const list = Array.isArray(anims) ? anims : [anims];
  const lines = ['<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">'];
  let ref = 0;
  const pose = (n, ind) => {
    const R = n.cframe.R, p = n.cframe.p;
    lines.push(`${ind}<Item class="Pose" referent="RBX${ref++}"><Properties><string name="Name">${n.part}</string>` +
      `<CoordinateFrame name="CFrame"><X>${num(p[0])}</X><Y>${num(p[1])}</Y><Z>${num(p[2])}</Z>` +
      R.map((v, i) => `<R${Math.floor(i / 3)}${i % 3}>${num(v)}</R${Math.floor(i / 3)}${i % 3}>`).join('') + '</CoordinateFrame>' +
      `<token name="EasingDirection">${DIR_TOKEN[n.dir]}</token><token name="EasingStyle">${STYLE_TOKEN[n.style]}</token><float name="Weight">${n.weight}</float></Properties>`);
    for (const c of n.children) pose(c, ind + ' ');
    lines.push(`${ind}</Item>`);
  };
  const marker = m => `<Item class="KeyframeMarker" referent="RBX${ref++}"><Properties><string name="Name">${xml(m.name)}</string><string name="Value">${xml(m.value)}</string></Properties></Item>`;
  for (const anim of list) {
    const events = [...anim.events];
    lines.push(`<Item class="KeyframeSequence" referent="RBX${ref++}"><Properties><string name="Name">${xml(cleanName(anim.name))}</string><bool name="Loop">${anim.loop === true}</bool><token name="Priority">${PRIORITIES[priorityOf(anim.priority)]}</token></Properties>`);
    for (const kf of exportTree(anim)) {
      lines.push(` <Item class="Keyframe" referent="RBX${ref++}"><Properties><string name="Name">Keyframe</string><float name="Time">${num(kf.t)}</float></Properties>`);
      if (kf.root) pose(kf.root, '  ');
      for (const m of kf.markers) { events.splice(events.indexOf(m), 1); lines.push(`  ${marker(m)}`); }
      lines.push(' </Item>');
    }
    // Events between keyframes get their own empty keyframe so markers keep their time.
    for (const e of events) lines.push(` <Item class="Keyframe" referent="RBX${ref++}"><Properties><string name="Name">Event</string><float name="Time">${num(e.t)}</float></Properties>${marker(e)}</Item>`);
    lines.push('</Item>');
  }
  lines.push('</roblox>');
  return lines.join('\n');
}

// Luau string literal: printable ASCII as is, every other byte (UTF-8) as a \ddd escape, so no
// input can end the string, start a new line or hit an escape Luau doesn't know (JSON's \uXXXX).
export const luaStr = s => `"${[...new TextEncoder().encode(String(s))]
  .map(b => (b >= 0x20 && b < 0x7f && b !== 0x22 && b !== 0x5c ? String.fromCharCode(b) : `\\${String(b).padStart(3, '0')}`)).join('')}"`;
// Luau chunk that returns a fresh KeyframeSequence (Command Bar, MCP execute_luau).
export function toLuauBuilder(anim) {
  const kfs = exportTree(anim).map(kf => {
    const poseLua = n => `{${luaStr(n.part)},${n.weight},{${[...n.cframe.p, ...n.cframe.R].map(num).join(',')}},${luaStr(n.style)},${luaStr(n.dir)},{${n.children.map(poseLua).join(',')}}}`;
    return `{${num(kf.t)},${kf.root ? poseLua(kf.root) : 'nil'}}`;
  });
  const name = cleanName(anim.name);
  return `-- OpenRig Studio: ${luaStr(name)}
local DATA = {${kfs.join(',\n')}}
local EVENTS = {${anim.events.map(e => `{${num(e.t)},${luaStr(e.name)},${luaStr(e.value)}}`).join(',')}}
local seq = Instance.new("KeyframeSequence")
seq.Name = ${luaStr(name)}
seq.Loop = ${anim.loop === true}
seq.Priority = Enum.AnimationPriority.${priorityOf(anim.priority)}
local function pose(spec, parent)
	local p = Instance.new("Pose")
	p.Name = spec[1]
	p.Weight = spec[2]
	p.CFrame = CFrame.new(table.unpack(spec[3]))
	p.EasingStyle = Enum.PoseEasingStyle[spec[4]]
	p.EasingDirection = Enum.PoseEasingDirection[spec[5]]
	for _, child in spec[6] do pose(child, p) end
	p.Parent = parent
end
local byTime = {}
for _, kf in DATA do
	local k = Instance.new("Keyframe")
	k.Time = kf[1]
	if kf[2] then pose(kf[2], k) end
	k.Parent = seq
	byTime[kf[1]] = k
end
for _, e in EVENTS do
	local k = byTime[e[1]]
	if not k then
		k = Instance.new("Keyframe")
		k.Name = "Event"
		k.Time = e[1]
		k.Parent = seq
		byTime[e[1]] = k
	end
	local m = Instance.new("KeyframeMarker")
	m.Name = e[2]
	m.Value = e[3]
	m.Parent = k
end
return seq
`;
}
