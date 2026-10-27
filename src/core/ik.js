// Two-bone IK for the R15 limbs. The model may give target positions for hands and feet
// (character space: x right, y up from the ground, z backwards); joint angles are solved
// numerically (damped least squares) starting from the model's own guess, so the elbow/knee
// direction it intended is kept. Joint limits of the rig are respected.
import { RIG_R15, solve, anglesDeg, cf, rotV, mulR, eulerDeg } from './rig.js';

export const IK_CHAINS = {
  RightHand: { joints: ['RightUpperArm', 'RightLowerArm'], end: 'RightHand' },
  LeftHand: { joints: ['LeftUpperArm', 'LeftLowerArm'], end: 'LeftHand' },
  RightFoot: { joints: ['RightUpperLeg', 'RightLowerLeg'], end: 'RightFoot', foot: true },
  LeftFoot: { joints: ['LeftUpperLeg', 'LeftLowerLeg'], end: 'LeftFoot', foot: true },
};
// Parameters per chain: upper x, y, z and the hinge (lower x).
const PARAMS = [[0, 0], [0, 1], [0, 2], [1, 0]];
const clampTo = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

function transformsFrom(rotations, base) {
  const out = { ...base };
  for (const [part, rot] of Object.entries(rotations)) out[part] = cf(base[part]?.p ?? [0, 0, 0], anglesDeg(rot));
  return out;
}

// base: sampled transforms {part: {p, R}} at this keyframe; rot: current [x,y,z] per joint.
// Returns new rotations for the chain joints (+ foot) and the remaining error in studs.
export function solveChain(name, target, base, rot, rig = RIG_R15) {
  const chain = IK_CHAINS[name];
  const want = chain.foot ? [target[0], target[1] + rig.parts[chain.end][1] / 2, target[2]] : target;
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
  if (chain.foot) state[chain.end] = flatFoot(chain, state, base, rig);
  return { rotations: state, error: en };
}

// Foot rotation that keeps the sole parallel to the ground and pointing where the hips point.
function flatFoot(chain, state, base, rig) {
  const world = solve(transformsFrom(state, base), rig);
  const P = world[chain.joints[1]].R;
  const fwd = rotV(world.LowerTorso.R, [0, 0, -1]);
  const yaw = Math.atan2(-fwd[0], -fwd[2]) * 180 / Math.PI;
  const local = mulR([P[0], P[3], P[6], P[1], P[4], P[7], P[2], P[5], P[8]], anglesDeg([0, yaw, 0]));
  return eulerDeg(local).map((v, i) => Math.round(clampTo(v, rig.limits[chain.end][i]) * 100) / 100);
}

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
