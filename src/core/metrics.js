// Measurements of a prepared clip for the benchmark (scripts/bench.mjs), on top of the checks
// in anim.js: how far planted feet slide or sink, how much of the body moves, how long it stands still
// and how long it is in the air. Sampled at 30 fps like the checks.
import { RIG_R15, POSE_PARTS, REGION, quatFromR, solve, lowestY } from './rig.js';
import { FEET, buildTracks, sampleTracks, duration } from './anim.js';

const FPS = 30;
const PLANTED = 0.05;     // a foot whose lowest corner is this close to the ground stands on it
const AIRBORNE = 0.1;     // both feet at least this high: the body is in the air
const ACTIVE_ROT = 5;     // degrees a joint has to move away from its start to count as moving
const ACTIVE_POS = 0.05;  // studs the same for the LowerTorso offset
const STILL_SPEED = 10;   // degrees per second below which a joint counts as standing still
const round = (v, n = 3) => Math.round(v * 10 ** n) / 10 ** n;
const angle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.reduce((s, v, i) => s + v * b[i], 0)))) * 180 / Math.PI;

export function motionStats(anim, rig = RIG_R15) {
  const tracks = buildTracks(anim);
  const end = duration(anim);
  const count = Math.max(1, Math.round(end * FPS));
  const frames = Array.from({ length: count + 1 }, (_, i) => sampleTracks(tracks, Math.min(end, i / FPS)));
  const worlds = frames.map(f => solve(f, rig));
  const quats = frames.map(f => Object.fromEntries(Object.entries(f).map(([part, s]) => [part, quatFromR(s.R)])));

  // Sliding: horizontal movement of a foot between two frames in which it stands on the ground.
  // Sinking: the deepest a foot goes into the ground (the checks only report more than 0.25).
  let footSlide = 0;
  const footSink = Math.max(0, ...worlds.map(w => -lowestY(w, FEET, rig)));
  for (const foot of FEET) {
    for (let i = 1; i < worlds.length; i++) {
      if (lowestY(worlds[i - 1], [foot], rig) > PLANTED || lowestY(worlds[i], [foot], rig) > PLANTED) continue;
      const a = worlds[i - 1][foot].p, b = worlds[i][foot].p;
      footSlide += Math.hypot(b[0] - a[0], b[2] - a[2]);
    }
  }

  const airTime = worlds.slice(1).filter(w => lowestY(w, FEET, rig) > AIRBORNE).length / FPS;

  const moving = POSE_PARTS.filter(part => {
    if (!quats[0][part]) return false;
    const rot = Math.max(...quats.map(q => angle(quats[0][part], q[part])));
    const pos = Math.max(...frames.map(f => Math.hypot(...f[part].p.map((v, k) => v - frames[0][part].p[k]))));
    return rot > ACTIVE_ROT || pos > ACTIVE_POS;
  });

  // Frames in which no joint turns noticeably: holds that read as frozen.
  let still = 0, peakSpeed = 0;
  for (let i = 1; i < quats.length; i++) {
    let fastest = 0;
    for (const part of Object.keys(quats[i])) fastest = Math.max(fastest, angle(quats[i - 1][part], quats[i][part]) * FPS);
    if (fastest < STILL_SPEED) still++;
    peakSpeed = Math.max(peakSpeed, fastest);
  }

  return {
    footSlide: round(footSlide),
    footSink: round(footSink),
    airTime: round(airTime, 2),
    activeJoints: moving.length,
    regions: [...new Set(moving.map(REGION))],
    stillShare: round(still / count, 2),
    peakSpeed: Math.round(peakSpeed),
  };
}
