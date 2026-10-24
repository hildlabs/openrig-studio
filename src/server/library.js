// Clip library on disk: data/clips/<id>.json, folders in data/folders.json, deleted clips in data/trash.
// A clip keeps its history (generated, draft, edited, imported, restored) instead of version numbers.
import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { ROOT, DATA } from './settings.js';
import { prepare, restClip, cleanName } from '../core/anim.js';

const CLIPS = path.join(DATA, 'clips');
const TRASH = path.join(DATA, 'trash');
const FOLDERS = path.join(DATA, 'folders.json');
const now = () => new Date().toISOString();

export const slug = s => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'clip';
const clipPath = id => {
  if (!/^[a-z0-9-]+$/.test(id)) throw Object.assign(new Error('Invalid clip id.'), { status: 400 });
  return path.join(CLIPS, `${id}.json`);
};
async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file + '.tmp', JSON.stringify(data, null, 1), 'utf8');
  await rename(file + '.tmp', file);
}

export async function loadClip(id) {
  try { return JSON.parse(await readFile(clipPath(id), 'utf8')); }
  catch (e) { if (e.status) throw e; throw Object.assign(new Error('Clip not found.'), { status: 404 }); }
}
export async function saveClip(clip) {
  clip.updatedAt = now();
  await writeJson(clipPath(clip.id), clip);
  return clip;
}

// kind: created | generated | draft | edited | imported | restored
export function addEntry(clip, result, kind, label = '') {
  const id = (clip.history.at(-1)?.id ?? 0) + 1;
  clip.history.push({ id, at: now(), kind, label, anim: result.anim, warnings: result.warnings ?? [], fixes: result.fixes ?? [], issues: result.issues ?? [] });
  clip.anim = result.anim;
  clip.current = id;
  return id;
}

export async function createClip(name = 'New animation', folder = '') {
  name = cleanName(name).slice(0, 80) || 'New animation';
  let id = slug(name), n = 2;
  while (existsSync(clipPath(id))) id = `${slug(name)}-${n++}`;
  const clip = { id, name, folder, starred: false, createdAt: now(), history: [], chat: [] };
  addEntry(clip, prepare(restClip(name)), 'created');
  return saveClip(clip);
}

export async function listClips() {
  await mkdir(CLIPS, { recursive: true });
  const out = [];
  for (const f of readdirSync(CLIPS).filter(f => f.endsWith('.json'))) {
    try {
      const c = JSON.parse(await readFile(path.join(CLIPS, f), 'utf8'));
      const gen = c.history.findLast(h => h.kind === 'generated');
      out.push({
        id: c.id, name: c.name, folder: c.folder ?? '', starred: Boolean(c.starred), createdAt: c.createdAt, updatedAt: c.updatedAt,
        duration: c.anim.keyframes.at(-1).t, loop: c.anim.loop, keyframes: c.anim.keyframes.length,
        model: gen?.label ?? '', issues: (c.history.find(h => h.id === c.current)?.issues ?? []).length,
      });
    } catch { /* skip unreadable files */ }
  }
  return out;
}

export async function updateClip(id, { name, folder, starred }) {
  const clip = await loadClip(id);
  if (typeof name === 'string' && cleanName(name)) { clip.name = cleanName(name).slice(0, 80); clip.anim.name = clip.name; clip.untitled = false; }
  if (typeof folder === 'string') { clip.folder = folder.trim().slice(0, 40); if (clip.folder) await addFolder(clip.folder); }
  if (typeof starred === 'boolean') clip.starred = starred;
  return saveClip(clip);
}

export async function duplicateClip(id) {
  const src = await loadClip(id);
  const copy = await createClip(`${src.name} copy`, src.folder);
  copy.history = [];
  addEntry(copy, { anim: { ...structuredClone(src.anim), name: copy.name } }, 'created', src.name);
  return saveClip(copy);
}

export async function trashClip(id) {
  await mkdir(TRASH, { recursive: true });
  await rename(clipPath(id), path.join(TRASH, `${id}-${Date.now()}.json`));
}

// Bundled examples (examples/*.json) are copied into the library once, into the folder
// "Examples". data/examples.json remembers which ones were added, so deleted ones stay deleted.
const EXAMPLES = path.join(ROOT, 'examples');
const SEEDED = path.join(DATA, 'examples.json');
export async function seedExamples() {
  if (!existsSync(EXAMPLES)) return 0;
  let seeded = [];
  try { seeded = JSON.parse(await readFile(SEEDED, 'utf8')); } catch { /* first start */ }
  let added = 0;
  for (const f of readdirSync(EXAMPLES).filter(f => f.endsWith('.json')).sort()) {
    const key = f.slice(0, -5);
    if (seeded.includes(key)) continue;
    const clip = JSON.parse(await readFile(path.join(EXAMPLES, f), 'utf8'));
    let id = key, n = 2;
    while (existsSync(clipPath(id))) id = `${key}-${n++}`;
    await saveClip({ ...clip, id, folder: 'Examples', createdAt: now() });
    seeded.push(key);
    added++;
  }
  if (added) await writeJson(SEEDED, seeded);
  return added;
}

// Folders exist on their own so empty ones stay visible.
export async function listFolders() {
  let saved = [];
  try { saved = JSON.parse(await readFile(FOLDERS, 'utf8')); } catch { /* none yet */ }
  const used = (await listClips()).map(c => c.folder).filter(Boolean);
  return [...new Set([...saved, ...used])].sort((a, b) => a.localeCompare(b));
}
export async function addFolder(name) {
  const folders = await listFolders();
  if (!folders.includes(name)) await writeJson(FOLDERS, [...folders, name]);
}
export async function renameFolder(from, to) {
  for (const c of await listClips()) if (c.folder === from) await updateClip(c.id, { folder: to });
  await writeJson(FOLDERS, (await listFolders()).map(f => (f === from ? to : f)).filter((f, i, a) => f && a.indexOf(f) === i));
}
export async function removeFolder(name) {
  for (const c of await listClips()) if (c.folder === name) await updateClip(c.id, { folder: '' });
  await writeJson(FOLDERS, (await listFolders()).filter(f => f !== name));
}
