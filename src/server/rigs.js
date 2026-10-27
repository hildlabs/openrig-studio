// Rigs with other proportions than the default R15 body (Rthro, scaled avatars), read from Studio
// and stored in data/rigs. A clip's `rig` names the one it is made for; none = the default rig.
import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { writeJson } from './files.js';
import { DATA } from './settings.js';
import { RIG_R15, RIG_R6, solve, lowestY, withDefaults } from '../core/rig.js';
import { FEET } from '../core/anim.js';
import { slug } from './library.js';

const RIGS = path.join(DATA, 'rigs');
const rigPath = id => {
  if (!/^[a-z0-9-]+$/.test(id)) throw Object.assign(new Error('Invalid rig id.'), { status: 400 });
  return path.join(RIGS, `${id}.json`);
};
const now = () => new Date().toISOString();

const vec = (v, n) => Array.isArray(v) && v.length === n && v.every(Number.isFinite);
// A rig from Studio has to be an R15 body: the same joints between the same parts, with sizes
// and offsets that are numbers. Joint limits are the default rig's.
export function checkRig(data) {
  const bad = msg => Object.assign(new Error(`This is not a usable R15 rig: ${msg}`), { status: 400 });
  if (!data || typeof data !== 'object') throw bad('no data');
  const parts = {};
  for (const name of Object.keys(RIG_R15.parts)) {
    const size = data.parts?.[name];
    if (!vec(size, 3) || size.some(v => v <= 0 || v > 50)) throw bad(`part ${name} is missing`);
    parts[name] = size.map(v => Math.round(v * 10000) / 10000);
  }
  const joints = RIG_R15.joints.map(ref => {
    const j = data.joints?.find(x => x.part1 === ref.part1);
    if (!j || j.part0 !== ref.part0) throw bad(`joint ${ref.name} is missing`);
    for (const k of ['c0', 'c1']) if (!vec(j[k], 3)) throw bad(`joint ${ref.name} has no offset`);
    for (const k of ['c0R', 'c1R']) if (j[k] !== undefined && !vec(j[k], 9)) throw bad(`joint ${ref.name} has a broken rotation`);
    const out = { name: ref.name, part0: ref.part0, part1: ref.part1, c0: j.c0, c1: j.c1 };
    // Rotations that are (almost) identity are dropped, as in the default rig.
    for (const k of ['c0R', 'c1R']) if (j[k] && j[k].some((v, i) => Math.abs(v - (i % 4 === 0 ? 1 : 0)) > 1e-4)) out[k] = j[k];
    return out;
  });
  const rig = withDefaults({ id: 'custom', root: RIG_R15.root, hipHeight: 0, parts, joints, limits: RIG_R15.limits });
  // Stand it on the ground the same way as the default rig: soles at y = 0 in the rest pose.
  rig.hipHeight = Number.isFinite(data.hipHeight) && data.hipHeight > 0 ? data.hipHeight : RIG_R15.hipHeight;
  rig.hipHeight = Math.round((rig.hipHeight - lowestY(solve({}, rig), FEET, rig)) * 10000) / 10000;
  return rig;
}

export async function listRigs() {
  await mkdir(RIGS, { recursive: true });
  const out = [];
  for (const f of readdirSync(RIGS).filter(f => f.endsWith('.json'))) {
    try { out.push(JSON.parse(await readFile(path.join(RIGS, f), 'utf8'))); } catch { /* skip unreadable files */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
export async function loadRig(id) {
  if (BUILTIN[id]) return BUILTIN[id];
  try { return JSON.parse(await readFile(rigPath(id), 'utf8')); }
  catch (e) { if (e.status) throw e; throw Object.assign(new Error('Rig not found.'), { status: 404 }); }
}
// Built-in bodies besides the default R15 one; imported rigs have ids from their names.
export const BUILTIN = { r6: { id: 'r6', name: 'R6', rig: RIG_R6 } };
// The body a clip is made for; a deleted rig falls back to the default one.
export async function rigOf(clip) {
  if (!clip.rig) return RIG_R15;
  if (BUILTIN[clip.rig]) return BUILTIN[clip.rig].rig;
  try { return withDefaults((await loadRig(clip.rig)).rig); } catch { return RIG_R15; }
}

async function write(entry) {
  await writeJson(rigPath(entry.id), entry);
  return entry;
}
export async function addRig(name, data, description = null) {
  const clean = String(name ?? '').replace(/[\p{Cc}]+/gu, ' ').trim().slice(0, 60) || 'Rig';
  const rig = checkRig(data);
  let id = slug(clean) || 'rig', n = 2;
  while (existsSync(rigPath(id)) || BUILTIN[id]) id = `${slug(clean) || 'rig'}-${n++}`;
  rig.id = id;
  return write({ id, name: clean, createdAt: now(), description, rig });
}
const builtIn = id => { if (BUILTIN[id]) throw Object.assign(new Error('Built-in rigs cannot be changed.'), { status: 400 }); };
export async function renameRig(id, name) {
  builtIn(id);
  const entry = await loadRig(id);
  entry.name = String(name ?? '').replace(/[\p{Cc}]+/gu, ' ').trim().slice(0, 60) || entry.name;
  return write(entry);
}
export async function deleteRig(id) {
  builtIn(id);
  await unlink(rigPath(id)).catch(() => { throw Object.assign(new Error('Rig not found.'), { status: 404 }); });
  return { ok: true };
}
