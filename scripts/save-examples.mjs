// Writes the clips of the library folder "Examples" to examples/<name>.json, the clips every
// new install starts with. Only the current version is kept, plus the request and model notes
// that produced it. Usage: npm run save-examples
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { ROOT, DATA } from '../src/server/settings.js';
import { listClips, loadClip, slug } from '../src/server/library.js';

const out = path.join(ROOT, 'examples');
await mkdir(out, { recursive: true });
const keys = [];
for (const { id } of (await listClips()).filter(c => c.folder === 'Examples')) {
  const clip = await loadClip(id);
  const cur = clip.history.find(h => h.id === clip.current);
  const key = slug(clip.name);
  // The first request and the latest model answer; the answer now points at the only entry.
  const request = clip.chat.find(m => m.role === 'user');
  const reply = clip.chat.findLast(m => m.role === 'assistant');
  const chat = [request, reply && { ...reply, entry: 1, draftEntry: undefined }].filter(Boolean);
  const example = {
    id: key, name: clip.name, folder: 'Examples', starred: false,
    history: [{ ...cur, id: 1, at: clip.updatedAt }], current: 1, anim: cur.anim, chat,
  };
  await writeFile(path.join(out, `${key}.json`), JSON.stringify(example, null, 1) + '\n', 'utf8');
  keys.push(key);
  console.log(`examples/${key}.json  (${cur.anim.keyframes.length} keyframes, ${cur.kind}${cur.label ? `, ${cur.label}` : ''})`);
}
// These clips already are in this library; don't add them a second time on the next start.
const seededFile = path.join(DATA, 'examples.json');
let seeded = [];
try { seeded = JSON.parse(await readFile(seededFile, 'utf8')); } catch { /* none yet */ }
await writeFile(seededFile, JSON.stringify([...new Set([...seeded, ...keys])], null, 1), 'utf8');
if (!keys.length) console.log('No clips in the folder "Examples".');
