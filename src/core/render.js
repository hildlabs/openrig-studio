// Software renderer for contact sheets and filmstrips (PNG, no dependencies besides node:zlib).
// Contact sheets give the model visual feedback; filmstrips are library thumbnails.
import { deflateSync } from 'node:zlib';
import { RIG_R15, solve, point, rotV, mulR, anglesDeg } from './rig.js';
import { sample, duration } from './anim.js';

const COLORS = { arms: [245, 205, 48], torso: [42, 111, 214], legs: [75, 163, 75], face: [43, 33, 24] };
const colorOf = name => (/Leg|Foot/.test(name) ? COLORS.legs : /Torso/.test(name) ? COLORS.torso : COLORS.arms);
// Eyes and mouth so the facing direction is readable (head local space, face = -Z).
const FACE = [
  { part: 'Head', center: [-0.22, 0.12, -0.585], size: [0.12, 0.22, 0.04] },
  { part: 'Head', center: [0.22, 0.12, -0.585], size: [0.12, 0.22, 0.04] },
  { part: 'Head', center: [0, -0.22, -0.585], size: [0.36, 0.07, 0.04] },
];
const LIGHT = (() => { const v = [-0.45, 0.8, -0.4]; const n = Math.hypot(...v); return v.map(x => x / n); })();
const BOX_FACES = [[0, 1, 3, 2, [-1, 0, 0]], [4, 6, 7, 5, [1, 0, 0]], [0, 4, 5, 1, [0, -1, 0]], [2, 3, 7, 6, [0, 1, 0]], [0, 2, 6, 4, [0, 0, -1]], [1, 5, 7, 3, [0, 0, 1]]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const BG = [241, 243, 246], GROUND = [222, 227, 234], SHADOW = [198, 205, 216], LINE = [208, 214, 223], LABEL = [74, 85, 104];

// Orthographic camera; at yaw 0 it looks at the character's front.
function camera(yawDeg, pitchDeg) {
  const R = mulR(anglesDeg([0, yawDeg, 0]), anglesDeg([pitchDeg, 0, 0]));
  return { forward: rotV(R, [0, 0, 1]), right: rotV(R, [-1, 0, 0]), up: rotV(R, [0, 1, 0]) };
}
export const VIEWS = { threeQuarter: camera(-35, 12), side: camera(-90, 6), front: camera(0, 8) };

class Canvas {
  constructor(w, h, bg) {
    this.w = w; this.h = h;
    this.rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) this.rgb.set(bg, i * 3);
  }
  rect(x0, y0, w, h, c) {
    for (let y = Math.max(0, y0); y < Math.min(this.h, y0 + h); y++)
      for (let x = Math.max(0, x0); x < Math.min(this.w, x0 + w); x++) this.rgb.set(c, (y * this.w + x) * 3);
  }
  png() {
    const raw = Buffer.alloc((this.w * 3 + 1) * this.h);
    for (let y = 0; y < this.h; y++) Buffer.from(this.rgb.buffer, y * this.w * 3, this.w * 3).copy(raw, y * (this.w * 3 + 1) + 1);
    const chunk = (type, data) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type), data]);
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
      return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0); ihdr.writeUInt32BE(this.h, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  }
}
let CRC_TABLE;
function crc32(buf) {
  CRC_TABLE ??= Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 3x5 digits for time labels.
const GLYPHS = { 0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111', 4: '101101111001001', 5: '111100111001111', 6: '111100111101111', 7: '111001001001001', 8: '111101111101111', 9: '111101111001111', '.': '000000000000010', s: '000011110001110' };
function text(cv, x, y, str, c, size = 2) {
  for (const ch of str) {
    const g = GLYPHS[ch];
    if (g) for (let i = 0; i < 15; i++) if (g[i] === '1') cv.rect(x + (i % 3) * size, y + Math.floor(i / 3) * size, size, size, c);
    x += 4 * size;
  }
}

function boxCorners(c, size) {
  const [sx, sy, sz] = size.map(v => v / 2);
  const out = [];
  for (const x of [-sx, sx]) for (const y of [-sy, sy]) for (const z of [-sz, sz]) out.push(point(c, [x, y, z]));
  return out;
}

function drawCell(cv, ox, oy, w, h, world, cam, scale, center, rig) {
  const zbuf = new Float32Array(w * h).fill(Infinity);
  const proj = v => {
    const d = [v[0] - center[0], v[1] - center[1], v[2] - center[2]];
    return [ox + w / 2 + dot(d, cam.right) * scale, oy + h * 0.56 - dot(d, cam.up) * scale, dot(d, cam.forward)];
  };
  const tri = (a, b, c, color, bias = 0) => {
    const minX = Math.max(ox, Math.floor(Math.min(a[0], b[0], c[0]))), maxX = Math.min(ox + w - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const minY = Math.max(oy, Math.floor(Math.min(a[1], b[1], c[1]))), maxY = Math.min(oy + h - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(area) < 1e-9) return;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area;
      const w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const z = w0 * a[2] + w1 * b[2] + w2 * c[2] + bias;
      const i = (y - oy) * w + (x - ox);
      if (z >= zbuf[i]) continue;
      zbuf[i] = z;
      cv.rgb.set(color, (y * cv.w + x) * 3);
    }
  };
  const quad = (p, color, bias) => { tri(p[0], p[1], p[2], color, bias); tri(p[0], p[2], p[3], color, bias); };
  const g = 7;
  quad([[-g, 0, -g], [g, 0, -g], [g, 0, g], [-g, 0, g]].map(proj), GROUND, 0.02);
  const parts = Object.entries(rig.parts).filter(([n]) => n !== rig.root).map(([n, size]) => ({ cf: world[n], size, color: colorOf(n) }));
  const face = FACE.map(f => ({ cf: { p: point(world[f.part], f.center), R: world[f.part].R }, size: f.size, color: COLORS.face }));
  for (const b of parts) {
    const c = boxCorners(b.cf, b.size).map(v => [v[0], 0.001, v[2]]).map(proj);
    for (const [i, j, k, l] of BOX_FACES) quad([c[i], c[j], c[k], c[l]], SHADOW, 0.01);
  }
  for (const b of [...parts, ...face]) {
    const pc = boxCorners(b.cf, b.size).map(proj);
    for (const [i, j, k, l, n] of BOX_FACES) {
      const nw = rotV(b.cf.R, n);
      if (dot(nw, cam.forward) > 0) continue; // back face
      const shade = 0.55 + 0.45 * Math.max(0, dot(nw, LIGHT));
      quad([pc[i], pc[j], pc[k], pc[l]], b.color.map(v => Math.min(255, Math.round(v * shade))));
    }
  }
}

// Grid of frames: one row per view, one column per time. Returns { png, times, cell, views }.
export function renderSheet(anim, { frames, cell, views = ['threeQuarter', 'side'], labels = true, rig = RIG_R15 } = {}) {
  const d = duration(anim);
  // ~8 frames per second so fast transitions and pops show up between two pictures.
  const n = frames ?? Math.max(6, Math.min(17, Math.round(d / 0.125) + 1));
  cell ??= n > 12 ? [130, 200] : [170, 230];
  const times = Array.from({ length: n }, (_, i) => Math.round((d * i) / (n - 1) * 1000) / 1000);
  const [cw, ch] = cell;
  const cv = new Canvas(cw * n, ch * views.length, BG);
  // Fixed framing so root motion and jump height stay visible.
  let top = 6.2;
  const worlds = times.map(t => solve(sample(anim, t), rig));
  for (const w of worlds) top = Math.max(top, w.Head.p[1] + 1.2);
  const scale = Math.min(cw / 6.5, (ch * 0.92) / (top + 0.4));
  const center = [0, top / 2 - 0.1, 0];
  worlds.forEach((world, i) => {
    views.forEach((v, r) => drawCell(cv, i * cw, r * ch, cw, ch, world, VIEWS[v], scale, center, rig));
    if (labels) text(cv, i * cw + 6, 6, `${times[i].toFixed(2)}s`, LABEL);
  });
  for (let i = 1; i < n; i++) cv.rect(i * cw, 0, 1, cv.h, LINE);
  for (let r = 1; r < views.length; r++) cv.rect(0, r * ch, cv.w, 1, LINE);
  return { png: cv.png(), times, cell, views };
}

// Small single-row strip for the library.
export const renderStrip = (anim, rig) => renderSheet(anim, { frames: 5, cell: [64, 84], views: ['threeQuarter'], labels: false, rig });
