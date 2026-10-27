// Roblox R15 rig data and minimal CFrame math. Plain ES module without dependencies:
// shared by the server, the tests and the browser.
//
// Joint offsets are taken from the attachments of Studio's default R15 rig.
// Part1.CFrame = Part0.CFrame * C0 * Transform * C1:Inverse(). Every function that works on
// a body takes the rig as a parameter; RIG_R15 is the default and the space models work in.

export const RIG_R15 = {
  id: 'R15',
  root: 'HumanoidRootPart',
  hipHeight: 2.1924,
  parts: {
    HumanoidRootPart: [2, 2, 1],
    LowerTorso: [1.9914, 0.4007, 1.004],
    UpperTorso: [1.9432, 1.698, 1.004],
    Head: [1.159, 1.182, 1.1606],
    LeftUpperArm: [1.0011, 1.2416, 1.0019],
    LeftLowerArm: [1.0011, 1.1175, 1.0019],
    LeftHand: [0.9843, 0.3158, 1.0283],
    RightUpperArm: [1.0011, 1.2416, 1.0019],
    RightLowerArm: [1.0011, 1.1175, 1.0019],
    RightHand: [0.9843, 0.3158, 1.0283],
    LeftUpperLeg: [0.9928, 1.3629, 0.9727],
    LeftLowerLeg: [0.9928, 1.3007, 0.9728],
    LeftFoot: [1.0089, 0.312, 1.0011],
    RightUpperLeg: [0.9928, 1.3629, 0.9727],
    RightLowerLeg: [0.9928, 1.3007, 0.9728],
    RightFoot: [1.0089, 0.312, 1.0011],
  },
  // Ordered parent before child; the Pose for a joint is named after part1.
  joints: [
    { name: 'Root', part0: 'HumanoidRootPart', part1: 'LowerTorso', c0: [0, -1, 0], c1: [0, -0.2, 0] },
    { name: 'Waist', part0: 'LowerTorso', part1: 'UpperTorso', c0: [0, 0.2, 0], c1: [0, -0.849, 0] },
    { name: 'Neck', part0: 'UpperTorso', part1: 'Head', c0: [0, 0.849, 0], c1: [0, -0.5758, 0] },
    { name: 'LeftShoulder', part0: 'UpperTorso', part1: 'LeftUpperArm', c0: [-0.9716, 0.5975, 0], c1: [0.5005, 0.4189, 0] },
    { name: 'LeftElbow', part0: 'LeftUpperArm', part1: 'LeftLowerArm', c0: [0.0005, -0.3549, 0], c1: [0.0005, 0.2748, 0] },
    { name: 'LeftWrist', part0: 'LeftLowerArm', part1: 'LeftHand', c0: [0.0005, -0.5322, 0], c1: [0.0005, 0.1316, 0] },
    { name: 'RightShoulder', part0: 'UpperTorso', part1: 'RightUpperArm', c0: [0.9716, 0.5975, 0], c1: [-0.5005, 0.4189, 0] },
    { name: 'RightElbow', part0: 'RightUpperArm', part1: 'RightLowerArm', c0: [0, -0.355, 0], c1: [0, 0.2747, 0] },
    { name: 'RightWrist', part0: 'RightLowerArm', part1: 'RightHand', c0: [0, -0.5322, 0], c1: [0, 0.1316, 0] },
    { name: 'LeftHip', part0: 'LowerTorso', part1: 'LeftUpperLeg', c0: [-0.5, -0.2, 0], c1: [0, 0.4714, 0] },
    { name: 'LeftKnee', part0: 'LeftUpperLeg', part1: 'LeftLowerLeg', c0: [0, -0.4493, 0], c1: [0, 0.4132, 0] },
    { name: 'LeftAnkle', part0: 'LeftLowerLeg', part1: 'LeftFoot', c0: [0, -0.5965, 0], c1: [0, 0.106, 0] },
    { name: 'RightHip', part0: 'LowerTorso', part1: 'RightUpperLeg', c0: [0.5, -0.2, 0], c1: [0, 0.4714, 0] },
    { name: 'RightKnee', part0: 'RightUpperLeg', part1: 'RightLowerLeg', c0: [0, -0.4492, 0], c1: [0, 0.4134, 0] },
    { name: 'RightAnkle', part0: 'RightLowerLeg', part1: 'RightFoot', c0: [0, -0.5965, 0], c1: [0, 0.106, 0] },
  ],
  // Plausible joint ranges in degrees for [x, y, z] (sign conventions: prompts/system.md).
  limits: {
    LowerTorso: [[-180, 180], [-180, 180], [-180, 180]], // root: spins and flips allowed
    UpperTorso: [[-60, 35], [-60, 60], [-35, 35]],
    Head: [[-50, 50], [-80, 80], [-35, 35]],
    LeftUpperArm: [[-60, 180], [-90, 90], [-180, 70]],
    RightUpperArm: [[-60, 180], [-90, 90], [-70, 180]],
    LeftLowerArm: [[0, 150], [-90, 90], [-10, 10]],
    RightLowerArm: [[0, 150], [-90, 90], [-10, 10]],
    LeftHand: [[-70, 70], [-45, 45], [-40, 40]],
    RightHand: [[-70, 70], [-45, 45], [-40, 40]],
    LeftUpperLeg: [[-45, 120], [-45, 45], [-60, 20]],
    RightUpperLeg: [[-45, 120], [-45, 45], [-20, 60]],
    LeftLowerLeg: [[-150, 0], [-10, 10], [-10, 10]],
    RightLowerLeg: [[-150, 0], [-10, 10], [-10, 10]],
    LeftFoot: [[-50, 40], [-20, 20], [-20, 20]],
    RightFoot: [[-50, 40], [-20, 20], [-20, 20]],
  },
};

export const POSE_PARTS = RIG_R15.joints.map(j => j.part1);
// Body regions, used for colour coding in the UI.
export const REGION = part => (/Leg|Foot/.test(part) ? 'legs' : /Torso/.test(part) ? 'torso' : part === 'Head' ? 'head' : 'arms');

// ---------- CFrame math (row-major 3x3 rotation like Roblox) ----------
export const IDENTITY = Object.freeze({ p: [0, 0, 0], R: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
export const cf = (p = [0, 0, 0], R = IDENTITY.R) => ({ p: [...p], R: [...R] });

export function mulR(a, b) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
    r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}
export const rotV = (R, v) => [
  R[0] * v[0] + R[1] * v[1] + R[2] * v[2],
  R[3] * v[0] + R[4] * v[1] + R[5] * v[2],
  R[6] * v[0] + R[7] * v[1] + R[8] * v[2],
];
export function mul(a, b) {
  const v = rotV(a.R, b.p);
  return { p: [a.p[0] + v[0], a.p[1] + v[1], a.p[2] + v[2]], R: mulR(a.R, b.R) };
}
export const point = (c, v) => { const r = rotV(c.R, v); return [c.p[0] + r[0], c.p[1] + r[1], c.p[2] + r[2]]; };
export function inv(c) {
  const Rt = [c.R[0], c.R[3], c.R[6], c.R[1], c.R[4], c.R[7], c.R[2], c.R[5], c.R[8]];
  return { p: rotV(Rt, c.p).map(v => -v), R: Rt };
}

// Same as Roblox CFrame.Angles(x, y, z) (= Rx * Ry * Rz), angles in degrees.
export function anglesDeg([x = 0, y = 0, z = 0] = []) {
  const d = Math.PI / 180;
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(x * d), Math.sin(x * d), Math.cos(y * d), Math.sin(y * d), Math.cos(z * d), Math.sin(z * d)];
  const rx = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  const ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const rz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  return mulR(mulR(rx, ry), rz);
}

// Euler XYZ (degrees) of a Rx*Ry*Rz rotation, inverse of anglesDeg.
export function eulerDeg(R) {
  const d = 180 / Math.PI;
  const y = Math.asin(Math.max(-1, Math.min(1, R[2])));
  if (Math.abs(R[2]) < 0.9999) return [Math.atan2(-R[5], R[8]) * d, y * d, Math.atan2(-R[1], R[0]) * d];
  return [Math.atan2(R[7], R[4]) * d, y * d, 0];
}

export function quatFromR(R) {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = R;
  const tr = m00 + m11 + m22;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; return [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4]; }
  if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; return [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
  if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; return [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s]; }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s]; // [x, y, z, w]
}
export function rFromQuat([x, y, z, w]) {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

// Roblox blends Pose rotations along the shorter way; the curve depends on the easing style
// (measured in Studio, see docs/how-it-works.md): CubicV2 lerps rotation vectors, two Linear
// poses use a normalised quaternion lerp.
export function quatLog([x, y, z, w]) {
  const s = Math.hypot(x, y, z);
  if (s < 1e-12) return [0, 0, 0];
  const th = 2 * Math.atan2(s, w);
  return [x / s * th, y / s * th, z / s * th];
}
export function quatFromRotVec(v) {
  const th = Math.hypot(v[0], v[1], v[2]);
  if (th < 1e-12) return [0, 0, 0, 1];
  const s = Math.sin(th / 2) / th;
  return [v[0] * s, v[1] * s, v[2] * s, Math.cos(th / 2)];
}
// b flipped into a's hemisphere so blending takes the shorter way.
export const alignQuat = (a, b) => (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? b.map(v => -v) : b);

// Rest position: HumanoidRootPart centre stands hipHeight + half its height above y = 0.
export const rootCFrame = (rig = RIG_R15) => cf([0, rig.hipHeight + rig.parts[rig.root][1] / 2, 0]);

// transforms: { partName: {p, R} } Motor6D.Transform per part1; missing = identity.
// C0/C1 of the default rig are pure translations; other rigs may add rotations (c0R, c1R).
export function solve(transforms = {}, rig = RIG_R15, root = rootCFrame(rig)) {
  const world = { [rig.root]: root };
  for (const j of rig.joints) {
    const t = transforms[j.part1] ?? IDENTITY;
    const c1inv = j.c1R ? inv(cf(j.c1, j.c1R)) : cf(j.c1.map(v => -v));
    world[j.part1] = mul(mul(mul(world[j.part0], cf(j.c0, j.c0R)), t), c1inv);
  }
  return world;
}

// Lowest world y of any corner of the given parts.
export function lowestY(world, parts, rig = RIG_R15) {
  let min = Infinity;
  for (const name of parts) {
    const [sx, sy, sz] = rig.parts[name].map(v => v / 2);
    for (const x of [-sx, sx]) for (const y of [-sy, sy]) for (const z of [-sz, sz])
      min = Math.min(min, point(world[name], [x, y, z])[1]);
  }
  return min;
}
