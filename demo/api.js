// Browser-only stand-in for the OpenRig Studio server, used by the live demo on GitHub Pages.
// The library lives in this tab (and localStorage), seeded with the bundled example clips.
// Everything that runs in src/core works as usual: editing, saving, history, R6 retargeting,
// contact sheets and .rbxmx / Luau export. Generating needs an AI provider and Roblox Studio
// needs the local MCP bridge, so those answer with a short note instead.
import { prepare, retarget, restClip, isRest, cleanName, toRbxmx, toLuauBuilder } from './core/anim.js';
import { RIG_R15, RIG_R6 } from './core/rig.js';
import { renderSheet, renderStrip } from './core/render.js';
import { getLang } from './i18n.js';
import EXAMPLES from './demo-data.js';
import PRESETS from './demo-presets.js';

const KEY = 'openrig.demo.library';
const REPO = 'https://github.com/hildlabs/openrig-studio';
const now = () => new Date().toISOString();
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const copy = v => structuredClone(v);

const NOTE = {
  en: {
    generate: 'This live demo has no AI attached. Install OpenRig Studio locally to generate with Claude Code, Codex CLI or your own API keys.',
    studio: 'Roblox Studio is reached through its MCP bridge on your computer, which a web page cannot do. Install OpenRig Studio locally for this.',
    settings: 'Settings are read-only in the live demo.',
    banner: 'Live demo in your browser: edit the example clips, scrub the timeline, export .rbxmx. Generating needs a local install.',
    source: 'Source on GitHub',
    reset: 'Reset demo',
  },
  de: {
    generate: 'In dieser Live-Demo ist keine KI angebunden. Installiere OpenRig Studio lokal, um mit Claude Code, Codex CLI oder eigenen API-Keys zu generieren.',
    studio: 'Roblox Studio wird über die MCP-Brücke auf deinem Rechner angesprochen, das kann eine Webseite nicht. Dafür OpenRig Studio lokal installieren.',
    settings: 'Die Einstellungen sind in der Live-Demo schreibgeschützt.',
    banner: 'Live-Demo im Browser: Beispiel-Clips bearbeiten, Timeline scrubben, .rbxmx exportieren. Generieren geht nur lokal.',
    source: 'Quellcode auf GitHub',
    reset: 'Demo zurücksetzen',
  },
};
const note = key => (NOTE[getLang()] ?? NOTE.en)[key];

// ---------- library state ----------
function seed() {
  const at = now();
  return { clips: Object.fromEntries(EXAMPLES.map(c => [c.id, { ...copy(c), folder: 'Examples', createdAt: at, updatedAt: at }])), folders: ['Examples'] };
}
let db;
try { db = JSON.parse(localStorage.getItem(KEY)) ?? seed(); } catch { db = seed(); }
const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* storage blocked: keep it in memory */ } };

const slug = s => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'clip';
const rigOf = clip => (clip.rig === 'r6' ? RIG_R6 : RIG_R15);
const entryRig = (clip, h) => h.rig ?? (h.anim.keyframes.some(k => k.poses.Torso) ? 'r6' : '');
const entryOf = (clip, entry) => clip.history.find(h => h.id === Number(entry)) ?? { anim: clip.anim, rig: clip.rig ?? '' };

function load(id) {
  const clip = db.clips[id];
  if (!clip) throw fail('Clip not found.', 404);
  return copy(clip);
}
function save(clip) {
  clip.updatedAt = now();
  db.clips[clip.id] = copy(clip);
  persist();
  return clip;
}
function addEntry(clip, result, kind, label = '') {
  const id = (clip.history.at(-1)?.id ?? 0) + 1;
  clip.history.push({ id, at: now(), kind, label, rig: clip.rig ?? '', anim: result.anim, warnings: result.warnings ?? [], fixes: result.fixes ?? [], issues: result.issues ?? [] });
  clip.anim = result.anim;
  clip.current = id;
}
function create(name = 'New animation', folder = '') {
  name = cleanName(name).slice(0, 80) || 'New animation';
  let id = slug(name), n = 2;
  while (db.clips[id]) id = `${slug(name)}-${n++}`;
  const clip = { id, name, folder, starred: false, createdAt: now(), history: [], chat: [] };
  addEntry(clip, prepare(restClip(name)), 'created');
  return save(clip);
}
function update(id, { name, folder, starred }) {
  const clip = load(id);
  if (typeof name === 'string' && cleanName(name)) { clip.name = cleanName(name).slice(0, 80); clip.anim.name = clip.name; clip.untitled = false; }
  if (typeof folder === 'string') { clip.folder = folder.trim().slice(0, 40); if (clip.folder && !db.folders.includes(clip.folder)) db.folders.push(clip.folder); }
  if (typeof starred === 'boolean') clip.starred = starred;
  return save(clip);
}
const folders = () => [...new Set([...db.folders, ...Object.values(db.clips).map(c => c.folder).filter(Boolean)])].sort((a, b) => a.localeCompare(b));
function summaries() {
  return Object.values(db.clips).map(c => {
    const gen = c.history.findLast(h => h.kind === 'generated');
    return {
      id: c.id, name: c.name, folder: c.folder ?? '', starred: Boolean(c.starred), createdAt: c.createdAt, updatedAt: c.updatedAt,
      duration: c.anim.keyframes.at(-1).t, loop: c.anim.loop, keyframes: c.anim.keyframes.length,
      model: gen?.label ?? c.chat?.findLast(m => m.engine)?.engine ?? '', rig: c.rig ?? '', rigName: c.rig === 'r6' ? 'R6' : '',
      issues: (c.history.find(h => h.id === c.current)?.issues ?? []).length,
    };
  });
}

// ---------- images: the server's software renderer, drawn into a canvas instead of a PNG file ----------
function toDataUrl(cv) {
  const el = document.createElement('canvas');
  el.width = cv.w; el.height = cv.h;
  const ctx = el.getContext('2d');
  const img = ctx.createImageData(cv.w, cv.h);
  for (let i = 0, j = 0; i < cv.rgb.length; i += 3, j += 4) { img.data[j] = cv.rgb[i]; img.data[j + 1] = cv.rgb[i + 1]; img.data[j + 2] = cv.rgb[i + 2]; img.data[j + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  return el.toDataURL('image/png');
}
const sheetOf = (clip, entry) => { const h = entryOf(clip, entry); return renderSheet(h.anim, { rig: entryRig(clip, h) === 'r6' ? RIG_R6 : RIG_R15 }); };
const images = new Map();
window.__demoImage = path => {
  const url = new URL(path, location.href);
  const m = url.pathname.match(/\/api\/clips\/([a-z0-9-]+)\/(strip|sheet)\.png$/);
  if (!m || !db.clips[m[1]]) return '';
  const clip = db.clips[m[1]];
  const key = `${m[2]}:${clip.id}:${clip.updatedAt}:${url.searchParams.get('entry') ?? ''}`;
  if (!images.has(key)) images.set(key, toDataUrl(m[2] === 'strip' ? renderStrip(clip.anim, rigOf(clip)).png : sheetOf(clip, url.searchParams.get('entry')).png));
  return images.get(key);
};
window.__demoDownload = path => {
  const ids = (new URL(path, location.href).searchParams.get('ids') ?? '').split(',').filter(Boolean);
  const clips = ids.map(load);
  if (!clips.length) return;
  const file = toRbxmx(clips.map(c => ({ anim: c.anim, rig: rigOf(c) })));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([file], { type: 'application/xml' }));
  a.download = `${clips.length === 1 ? slug(clips[0].name).replace(/-/g, '_') : `openrig_${clips.length}_clips`}.rbxmx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// ---------- routes, mirroring src/server/main.js ----------
const PROVIDERS = () => {
  const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
  const claude = [['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-5-5', 'Haiku 5.5']].map(([id, label]) => ({ id, label, efforts }));
  return [
    { id: 'claude-code', label: 'Claude Code', kind: 'subscription', available: true, detail: 'demo', models: claude },
    { id: 'codex', label: 'Codex CLI', kind: 'subscription', available: true, detail: 'demo', models: [{ id: '', label: 'Default model', efforts: ['low', 'medium', 'high'] }] },
    { id: 'anthropic', label: 'Anthropic API', kind: 'api', available: false, models: claude },
    { id: 'openai', label: 'OpenAI API', kind: 'api', available: false, models: [] },
    { id: 'compatible', label: 'OpenAI-compatible API', kind: 'api', available: false, models: [] },
  ];
};
const SETTINGS = () => ({ anthropicApiKey: '', openaiApiKey: '', compatApiKey: '', compatBaseUrl: '', compatModels: '', compatMaxTokens: '', compatImages: '', openaiModels: '', claudePath: '', codexPath: '', studioMcpPath: '', style: '', studioMcpFound: false });

const routes = [
  ['GET', /^\/api\/providers$/, () => PROVIDERS()],
  ['GET', /^\/api\/presets$/, () => copy(PRESETS)],
  ['GET', /^\/api\/settings$/, () => SETTINGS()],
  ['PUT', /^\/api\/settings$/, () => { throw fail(note('settings')); }],
  ['POST', /^\/api\/settings\/test$/, () => { throw fail(note('generate')); }],

  ['GET', /^\/api\/clips$/, () => ({ clips: summaries(), folders: folders() })],
  ['POST', /^\/api\/clips$/, (b) => { const clip = create(String(b.name || 'New animation').slice(0, 80), String(b.folder ?? '')); if (b.untitled) { clip.untitled = true; save(clip); } return clip; }],
  ['GET', /^\/api\/clips\/([a-z0-9-]+)$/, (b, [id]) => load(id)],
  ['PATCH', /^\/api\/clips\/([a-z0-9-]+)$/, (b, [id]) => update(id, b)],
  ['DELETE', /^\/api\/clips\/([a-z0-9-]+)$/, (b, [id]) => { delete db.clips[id]; persist(); return { ok: true }; }],
  ['POST', /^\/api\/clips\/([a-z0-9-]+)\/duplicate$/, (b, [id]) => {
    const src = load(id);
    const dup = create(`${src.name} copy`, src.folder);
    dup.history = [];
    if (src.rig) dup.rig = src.rig;
    addEntry(dup, { anim: { ...copy(src.anim), name: dup.name } }, 'created', src.name);
    return save(dup);
  }],
  ['POST', /^\/api\/clips\/([a-z0-9-]+)\/generate$/, () => { throw fail(note('generate')); }],
  ['POST', /^\/api\/clips\/([a-z0-9-]+)\/save$/, (b, [id]) => {
    const clip = load(id);
    addEntry(clip, prepare({ ...b.anim, name: clip.name }, { ground: b.ground !== false }, rigOf(clip)), 'edited');
    return save(clip);
  }],
  ['POST', /^\/api\/clips\/([a-z0-9-]+)\/restore$/, (b, [id]) => {
    const clip = load(id);
    const h = clip.history.find(x => x.id === Number(b.entry));
    if (!h) throw fail('History entry not found.', 404);
    const from = entryRig(clip, h) === 'r6' ? RIG_R6 : RIG_R15, to = rigOf(clip);
    let result = { ...h, anim: copy(h.anim) };
    if (entryRig(clip, h) !== (clip.rig ?? '')) {
      if ((from.family ?? 'R15') !== (to.family ?? 'R15')) throw fail(`This version was made for ${from.family ?? 'R15'}, the clip is now ${to.family ?? 'R15'}.`);
      result = retarget(h.anim, from, to);
    }
    addEntry(clip, { ...result, anim: { ...result.anim, name: clip.name } }, 'restored', String(h.id));
    return save(clip);
  }],
  ['GET', /^\/api\/clips\/([a-z0-9-]+)\/sheet$/, (b, [id], url) => { const { times, cell, views } = sheetOf(load(id), url.searchParams.get('entry')); return { times, cell, views }; }],
  ['POST', /^\/api\/clips\/([a-z0-9-]+)\/rig$/, (b, [id]) => {
    const clip = load(id);
    const next = b.rig === 'r6' ? 'r6' : '';
    if (next === (clip.rig ?? '')) return clip;
    const from = rigOf(clip), target = next === 'r6' ? RIG_R6 : RIG_R15;
    let result;
    if ((from.family ?? 'R15') === (target.family ?? 'R15')) result = retarget(clip.anim, from, target);
    else if (isRest(clip.anim)) result = prepare(restClip(clip.name), {}, target);
    else throw fail(`Only an empty clip can switch between ${from.family ?? 'R15'} and ${target.family ?? 'R15'}. Start a new clip for this rig.`);
    if (next) clip.rig = next; else delete clip.rig;
    addEntry(clip, result, 'retargeted', next ? 'R6' : 'R15');
    return save(clip);
  }],
  ['GET', /^\/api\/clips\/([a-z0-9-]+)\/luau$/, (b, [id]) => { const clip = load(id); return toLuauBuilder(clip.anim, rigOf(clip)); }],

  ['GET', /^\/api\/rigs$/, () => []],
  ['POST', /^\/api\/rigs\/import$/, () => { throw fail(note('studio')); }],
  ['POST', /^\/api\/bulk$/, ({ action, ids = [], folder }) => {
    for (const id of ids) {
      if (action === 'delete') delete db.clips[id];
      else if (action === 'move') update(id, { folder: String(folder ?? '') });
    }
    persist();
    return { ok: true };
  }],
  ['POST', /^\/api\/folders$/, ({ name }) => { name = String(name ?? '').trim().slice(0, 40); if (name && !db.folders.includes(name)) db.folders.push(name); persist(); return folders(); }],
  ['PATCH', /^\/api\/folders$/, ({ from, to }) => {
    to = String(to).trim().slice(0, 40);
    for (const c of Object.values(db.clips)) if (c.folder === from) c.folder = to;
    db.folders = db.folders.map(f => (f === from ? to : f)).filter((f, i, a) => f && a.indexOf(f) === i);
    persist();
    return folders();
  }],
  ['DELETE', /^\/api\/folders$/, (b, m, url) => {
    const name = url.searchParams.get('name') ?? '';
    for (const c of Object.values(db.clips)) if (c.folder === name) c.folder = '';
    db.folders = db.folders.filter(f => f !== name);
    persist();
    return folders();
  }],
  ['GET', /^\/api\/compare$/, () => []],
  ['POST', /^\/api\/compare$/, () => { throw fail(note('generate')); }],
  ['GET', /^\/api\/studio$/, () => ({ found: false, instances: [] })],
  ['GET', /^\/api\/studio\/saves$/, () => { throw fail(note('studio')); }],
  ['POST', /^\/api\/studio\/push$/, () => { throw fail(note('studio')); }],
  ['POST', /^\/api\/clips\/([a-z0-9-]+)\/(studio|pull)$/, () => { throw fail(note('studio')); }],
];

export async function demoApi(path, { method = 'GET', body } = {}) {
  const url = new URL(path, 'http://demo.local');
  for (const [m, pattern, handler] of routes) {
    const match = url.pathname.match(pattern);
    if (!match || m !== method) continue;
    return handler(body ?? {}, match.slice(1), url);
  }
  throw fail('Not found.', 404);
}

// ---------- demo banner ----------
function banner() {
  const bar = document.createElement('div');
  bar.className = 'demo-banner';
  const render = () => {
    bar.innerHTML = `<span>${note('banner')}</span><a href="${REPO}" target="_blank" rel="noreferrer">${note('source')} ↗</a><button type="button">${note('reset')}</button>`;
    bar.querySelector('button').addEventListener('click', () => { try { localStorage.removeItem(KEY); } catch { /* blocked */ } location.reload(); });
  };
  render();
  document.body.prepend(bar);
  document.addEventListener('click', e => { if (e.target.closest('.lang button')) setTimeout(render); });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', banner); else banner();
