// Two-bone IK for the limbs of a rig. The model may give target positions for hands and feet
// (character space: x right, y up from the ground, z backwards); joint angles are solved
// numerically (damped least squares) starting from the model's own guess, so the elbow/knee
// direction it intended is kept. Joint limits of the rig are respected.
//
// R15 has four fixed chains. A custom rig lists its own in `rig.chains` (rig-builder.js finds
// them in the joint hierarchy): { joints: [upper, lower], end, foot?, ball?, lift? }.
import { RIG_R15, solve, anglesDeg, cf, rotV, mulR, eulerDeg } from './rig.js';

export const IK_CHAINS = {
  RightHand: { joints: ['RightUpperArm', 'RightLowerArm'], end: 'RightHand' },
  LeftHand: { joints: ['LeftUpperArm', 'LeftLowerArm'], end: 'LeftHand' },
  RightFoot: { joints: ['RightUpperLeg', 'RightLowerLeg'], end: 'RightFoot', foot: true },
  LeftFoot: { joints: ['LeftUpperLeg', 'LeftLowerLeg'], end: 'LeftFoot', foot: true },
};
// The chains of a rig by name of their end part ({} when it has none).
export const chainsOf = rig => rig.chains ?? (rig.ik ? IK_CHAINS : {});
export const chainOf = (rig, name) => (Object.hasOwn(chainsOf(rig), name) ? chainsOf(rig)[name] : null);
// Studs from the centre of a foot part to its sole. R15 feet lie flat; a custom rig measured it.
export const soleLift = (rig, name) => chainOf(rig, name)?.lift ?? rig.parts[name][1] / 2;
// Parameters per chain: upper x, y, z and the hinge (lower x). A chain whose lower joint has
// no known hinge axis (custom rigs) solves all three axes of it.
const HINGE = [[0, 0], [0, 1], [0, 2], [1, 0]];
const BALL = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2]];
const clampTo = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

function transformsFrom(rotations, base) {
  const out = { ...base };
  for (const [part, rot] of Object.entries(rotations)) out[part] = cf(base[part]?.p ?? [0, 0, 0], anglesDeg(rot));
  return out;
}

// base: sampled transforms {part: {p, R}} at this keyframe; rot: current [x,y,z] per joint.
// Returns new rotations for the chain joints (+ foot) and the remaining error in studs.
// flat: turn the foot so its sole is parallel to the ground (off: the foot keeps its own pose).
export function solveChain(name, target, base, rot, rig = RIG_R15, { flat = true } = {}) {
  const chain = chainOf(rig, name);
  const PARAMS = chain.ball ? BALL : HINGE;
  const want = chain.foot ? [target[0], target[1] + soleLift(rig, name), target[2]] : target;
  const lim = j => rig.limits[j];
  const endPos = state => solve(transformsFrom(state, base), rig)[chain.end].p;
  const err = state => { const p = endPos(state); return [want[0] - p[0], want[1] - p[1], want[2] - p[2]]; };
  const get = (s, [ji, ai]) => s[chain.joints[ji]][ai];
  const set = (s, [ji, ai], v) => { s[chain.joints[ji]][ai] = clampTo(v, lim(chain.joints[ji])[ai]); };
  const copy = s => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, [...v]]));
  let state = Object.fromEntries(chain.joints.map(j => [j, [...(rot[j] ?? [0, 0, 0])]]));
  let e = err(state), en = Math.hypot(...e), lambda = 30;
  for (let it = 0; it < 80 && en > 0.005; it++) {
    // Numeric Jacobian (studs per degree); step inwards when a parameter sits on its limit.
    const p0 = endPos(state);
    const J = PARAMS.map(pi => {
      const s = copy(state);
      const v = get(s, pi);
      set(s, pi, v + 0.5);
      if (get(s, pi) === v) set(s, pi, v - 0.5);
      const dh = get(s, pi) - v;
      if (dh === 0) return [0, 0, 0];
      const p1 = endPos(s);
      return [0, 1, 2].map(k => (p1[k] - p0[k]) / dh);
    });
    // (JᵀJ + λI) Δ = Jᵀ e
    const A = PARAMS.map((_, a) => PARAMS.map((_, b) => J[a].reduce((s, v, k) => s + v * J[b][k], 0) + (a === b ? lambda * 1e-4 : 0)));
    const g = PARAMS.map((_, a) => J[a].reduce((s, v, k) => s + v * e[k], 0));
    const delta = solveLinear(A, g);
    if (!delta) break;
    const next = copy(state);
    PARAMS.forEach((pi, i) => set(next, pi, get(next, pi) + Math.max(-25, Math.min(25, delta[i]))));
    const ne = err(next), nen = Math.hypot(...ne);
    if (nen < en) { state = next; e = ne; en = nen; lambda = Math.max(1, lambda / 2); }
    else lambda *= 4;
    if (lambda > 1e6) break;
  }
  if (chain.foot && flat) state[chain.end] = flatFoot(chain, state, base, rig);
  return { rotations: state, error: en };
}

// Foot rotation that keeps the sole parallel to the ground and pointing where the hips point.
// The foot's world rotation is Ry(yaw) turned into its rest orientation (identity on R15, where
// every part starts aligned with the world; custom rigs may rest rotated). With W = P · C0 · T · C1⁻¹
// for the foot's joint, T = C0⁻¹ · Pᵀ · Ry(yaw) · Rest · C1.
const transpose = R => [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
function flatFoot(chain, state, base, rig) {
  const world = solve(transformsFrom(state, base), rig);
  const rest = solve({}, rig);
  const P = world[chain.joints[1]].R;
  // Where the body faces now, relative to its rest orientation (−Z at rest).
  const fwd = rotV(mulR(world[rig.body].R, transpose(rest[rig.body].R)), [0, 0, -1]);
  const yaw = Math.atan2(-fwd[0], -fwd[2]) * 180 / Math.PI;
  const joint = rig.joints.find(j => j.part1 === chain.end);
  const c0 = joint.c0R ?? IDENT, c1 = joint.c1R ?? IDENT;
  const want = mulR(anglesDeg([0, yaw, 0]), rest[chain.end].R);
  const local = mulR(mulR(transpose(c0), mulR(transpose(P), want)), c1);
  return eulerDeg(local).map((v, i) => Math.round(clampTo(v, rig.limits[chain.end][i]) * 100) / 100);
}
const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}
