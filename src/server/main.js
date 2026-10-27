// OpenRig Studio server: serves the web app and a small JSON API on http://127.0.0.1:4330.
import http from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { ROOT, loadSettings, saveSettings, secret, mask } from './settings.js';
import { listProviders, testProvider } from './providers/index.js';
import * as lib from './library.js';
import { startJob, getJob, startCompare, compareStatus, listCompares, isBusy } from './generate.js';
import * as studio from './studio.js';
import * as rigs from './rigs.js';
import { prepare, retarget, restClip, isRest, fromStudio, toRbxmx, toLuauBuilder } from '../core/anim.js';
import { RIG_R15 } from '../core/rig.js';
import { renderSheet, renderStrip } from '../core/render.js';

const PORT = Number(process.env.PORT) || 4330;
const HOST = process.env.HOST || '127.0.0.1';
const WEB = path.join(ROOT, 'web');
const CORE = path.join(ROOT, 'src', 'core');
const BROWSER_CORE = ['rig.js', 'anim.js', 'ik.js', 'messages.js'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2' };
// No framing by other pages (clickjacking), no MIME sniffing, no referrer to the CDN.
const SECURITY_HEADERS = { 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
async function readBody(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 4e6) throw Object.assign(new Error('Request too large.'), { status: 413 }); }
  return raw ? JSON.parse(raw) : {};
}
const fileName = name => lib.slug(name).replace(/-/g, '_');
const engineOf = b => ({ provider: String(b.provider ?? ''), model: String(b.model ?? ''), effort: String(b.effort ?? '') });
const bodyOf = async id => (id ? rigs.loadRig(id).catch(() => null) : null);
const entryOf = (clip, entry) => clip.history.find(h => h.id === Number(entry)) ?? { anim: clip.anim, rig: clip.rig ?? '' };
// The body a version was made for. Versions saved before 0.2 don't say; R6 ones are known by their part names.
const entryRig = (clip, h) => h.rig ?? (h.anim.keyframes.some(k => k.poses.Torso) ? 'r6' : '');
const sheetOf = async (clip, entry) => { const h = entryOf(clip, entry); return renderSheet(h.anim, { rig: await rigs.rigOf({ rig: entryRig(clip, h) }) }); };
const notWhileBusy = id => { if (isBusy(id)) throw Object.assign(new Error('Wait until this clip has finished generating.'), { status: 409 }); };

async function settingsView() {
  const s = await loadSettings();
  return {
    anthropicApiKey: mask(secret(s, 'anthropicApiKey', 'ANTHROPIC_API_KEY')),
    openaiApiKey: mask(secret(s, 'openaiApiKey', 'OPENAI_API_KEY')),
    compatApiKey: mask(secret(s, 'compatApiKey', 'OPENAI_COMPATIBLE_API_KEY')),
    compatBaseUrl: s.compatBaseUrl, compatModels: s.compatModels, compatMaxTokens: s.compatMaxTokens, compatImages: s.compatImages,
    openaiModels: s.openaiModels, claudePath: s.claudePath, codexPath: s.codexPath, studioMcpPath: s.studioMcpPath, style: s.style,
    studioMcpFound: await studio.findStudioMcp(),
  };
}

const routes = [
  ['GET', /^\/api\/providers$/, async () => listProviders()],
  ['GET', /^\/api\/presets$/, async () => JSON.parse(await readFile(path.join(ROOT, 'prompts', 'presets.json'), 'utf8'))],
  ['GET', /^\/api\/settings$/, async () => settingsView()],
  ['PUT', /^\/api\/settings$/, async (req) => { localOnly(req); await saveSettings(await readBody(req)); return settingsView(); }],
  ['POST', /^\/api\/settings\/test$/, async (req) => { localOnly(req); return { message: await testProvider((await readBody(req)).provider) }; }],

  ['GET', /^\/api\/clips$/, async () => {
    // Clips made for another body show its name in the library.
    const names = Object.fromEntries([...Object.values(rigs.BUILTIN), ...await rigs.listRigs()].map(r => [r.id, r.name]));
    const clips = (await lib.listClips()).map(c => ({ ...c, rigName: c.rig ? names[c.rig] ?? '' : '' }));
    return { clips, folders: await lib.listFolders() };
  }],
  ['POST', /^\/api\/clips$/, async (req) => {
    const b = await readBody(req);
    const clip = await lib.createClip(String(b.name || 'New animation').slice(0, 80), String(b.folder ?? ''));
    if (b.untitled) { clip.untitled = true; await lib.saveClip(clip); }
    return clip;
  }],
  ['GET', /^\/api\/clips\/([a-z0-9-]+)$/, async (req, [id]) => lib.loadClip(id)],
  ['PATCH', /^\/api\/clips\/([a-z0-9-]+)$/, async (req, [id]) => lib.updateClip(id, await readBody(req))],
  ['DELETE', /^\/api\/clips\/([a-z0-9-]+)$/, async (req, [id]) => { await lib.trashClip(id); return { ok: true }; }],
  ['POST', /^\/api\/clips\/([a-z0-9-]+)\/duplicate$/, async (req, [id]) => lib.duplicateClip(id)],
  ['POST', /^\/api\/clips\/([a-z0-9-]+)\/generate$/, async (req, [id]) => {
    const b = await readBody(req);
    if (b.mode !== 'improve' && !String(b.prompt ?? '').trim()) throw Object.assign(new Error('Describe the motion first.'), { status: 400 });
    return { jobId: (await startJob({ id, prompt: String(b.prompt ?? ''), engine: engineOf(b), mode: b.mode, review: b.review !== false, lang: b.lang })).id };
  }],
  ['POST', /^\/api\/clips\/([a-z0-9-]+)\/save$/, async (req, [id]) => {
    const clip = await lib.loadClip(id);
    const b = await readBody(req);
    lib.addEntry(clip, prepare({ ...b.anim, name: clip.name }, { ground: b.ground !== false }, await rigs.rigOf(clip)), 'edited');
    return lib.saveClip(clip);
  }],
  ['POST', /^\/api\/clips\/([a-z0-9-]+)\/restore$/, async (req, [id]) => {
    const clip = await lib.loadClip(id);
    const { entry } = await readBody(req);
    const h = clip.history.find(x => x.id === Number(entry));
    if (!h) throw Object.assign(new Error('History entry not found.'), { status: 404 });
    // A version made for another body is fitted to the clip's current one (same family only).
    const from = await rigs.rigOf({ rig: entryRig(clip, h) }), to = await rigs.rigOf(clip);
    let result = { ...h, anim: structuredClone(h.anim) };
    if (entryRig(clip, h) !== (clip.rig ?? '')) {
      if ((from.family ?? 'R15') !== (to.family ?? 'R15')) throw Object.assign(new Error(`This version was made for ${from.family ?? 'R15'}, the clip is now ${to.family ?? 'R15'}.`), { status: 400 });
      result = retarget(h.anim, from, to);
    }
    lib.addEntry(clip, { ...result, anim: { ...result.anim, name: clip.name } }, 'restored', String(h.id));
    return lib.saveClip(clip);
  }],
  ['GET', /^\/api\/clips\/([a-z0-9-]+)\/sheet$/, async (req, [id], url) => {
    const { times, cell, views } = await sheetOf(await lib.loadClip(id), url.searchParams.get('entry'));
    return { times, cell, views };
  }],
  ['GET', /^\/api\/clips\/([a-z0-9-]+)\/sheet\.png$/, async (req, [id], url) => {
    return { png: (await sheetOf(await lib.loadClip(id), url.searchParams.get('entry'))).png };
  }],
  ['GET', /^\/api\/clips\/([a-z0-9-]+)\/strip\.png$/, async (req, [id]) => {
    const clip = await lib.loadClip(id);
    return { png: renderStrip(clip.anim, await rigs.rigOf(clip)).png };
  }],
  // Moves the clip to another rig: the current version is retargeted and becomes a new version.
  // Between R15 and R6 there is nothing to carry over, so only an empty clip can switch.
  ['POST', /^\/api\/clips\/([a-z0-9-]+)\/rig$/, async (req, [id]) => {
    const clip = await lib.loadClip(id);
    const { rig: next = '' } = await readBody(req);
    notWhileBusy(id);
    const to = next ? await rigs.loadRig(String(next)) : null;
    if ((to?.id ?? '') === (clip.rig ?? '')) return clip;
    const from = await rigs.rigOf(clip), target = to?.rig ?? RIG_R15;
    let result;
    if ((from.family ?? 'R15') === (target.family ?? 'R15')) result = retarget(clip.anim, from, target);
    else if (isRest(clip.anim)) result = prepare(restClip(clip.name), {}, target);
    else throw Object.assign(new Error(`Only an empty clip can switch between ${from.family ?? 'R15'} and ${target.family ?? 'R15'}. Start a new clip for this rig.`), { status: 400 });
    if (to) clip.rig = to.id; else delete clip.rig;
    lib.addEntry(clip, result, 'retargeted', to?.name ?? 'R15');
    return lib.saveClip(clip);
  }],

  ['GET', /^\/api\/rigs$/, async () => rigs.listRigs()],
  ['POST', /^\/api\/rigs\/import$/, async (req) => {
    const { studio: studioId, name } = await readBody(req);
    const found = await studio.readRig(String(studioId));
    return rigs.addRig(name || found.name, found.rig, found.description);
  }],
  ['PATCH', /^\/api\/rigs\/([a-z0-9-]+)$/, async (req, [id]) => rigs.renameRig(id, (await readBody(req)).name)],
  ['DELETE', /^\/api\/rigs\/([a-z0-9-]+)$/, async (req, [id]) => rigs.deleteRig(id)],
  ['GET', /^\/api\/clips\/([a-z0-9-]+)\/luau$/, async (req, [id]) => {
    const clip = await lib.loadClip(id);
    return { text: toLuauBuilder(clip.anim, await rigs.rigOf(clip)) };
  }],
  ['GET', /^\/api\/export\.rbxmx$/, async (req, m, url) => {
    const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
    const clips = await Promise.all(ids.map(id => lib.loadClip(id)));
    if (!clips.length) throw Object.assign(new Error('Nothing selected.'), { status: 400 });
    const items = await Promise.all(clips.map(async c => ({ anim: c.anim, rig: await rigs.rigOf(c) })));
    return { file: toRbxmx(items), name: clips.length === 1 ? fileName(clips[0].name) : `openrig_${clips.length}_clips` };
  }],
  ['POST', /^\/api\/bulk$/, async (req) => {
    const { action, ids = [], folder } = await readBody(req);
    for (const id of ids) {
      if (action === 'delete') await lib.trashClip(id);
      else if (action === 'move') await lib.updateClip(id, { folder: String(folder ?? '') });
    }
    return { ok: true };
  }],

  ['POST', /^\/api\/folders$/, async (req) => { const { name } = await readBody(req); if (String(name ?? '').trim()) await lib.addFolder(String(name).trim().slice(0, 40)); return lib.listFolders(); }],
  ['PATCH', /^\/api\/folders$/, async (req) => { const { from, to } = await readBody(req); await lib.renameFolder(String(from), String(to).trim().slice(0, 40)); return lib.listFolders(); }],
  ['DELETE', /^\/api\/folders$/, async (req, m, url) => { await lib.removeFolder(url.searchParams.get('name') ?? ''); return lib.listFolders(); }],

  ['GET', /^\/api\/jobs\/([a-z0-9]+)$/, async (req, [id]) => {
    const job = getJob(id);
    if (!job) throw Object.assign(new Error('Unknown job.'), { status: 404 });
    return { ...job, elapsed: Math.round((Date.now() - job.startedAt) / 1000) };
  }],
  ['GET', /^\/api\/compare$/, async () => listCompares()],
  ['POST', /^\/api\/compare$/, async (req) => startCompare(await readBody(req))],
  ['GET', /^\/api\/compare\/([a-z0-9-]+)$/, async (req, [id]) => compareStatus(id)],

  ['GET', /^\/api\/studio$/, async () => ({ found: Boolean(await studio.findStudioMcp()), instances: await studio.listStudios() })],
  ['GET', /^\/api\/studio\/saves$/, async (req, m, url) => studio.listSaves(url.searchParams.get('studio') ?? '')],
  ['POST', /^\/api\/studio\/push$/, async (req) => {
    const { studio: studioId, ids = [] } = await readBody(req);
    const clips = await Promise.all(ids.map(id => lib.loadClip(id)));
    // The preview rig gets the clips' body when they all share one.
    const shared = new Set(clips.map(c => c.rig ?? '')).size === 1 ? clips[0]?.rig : null;
    const items = await Promise.all(clips.map(async c => ({ anim: c.anim, rig: await rigs.rigOf(c) })));
    return { message: await studio.pushClips(String(studioId), items, await bodyOf(shared)) };
  }],
  ['POST', /^\/api\/clips\/([a-z0-9-]+)\/studio$/, async (req, [id]) => {
    const { studio: studioId, action } = await readBody(req);
    const clip = await lib.loadClip(id);
    const { anim } = clip;
    const body = await bodyOf(clip.rig);
    const rig = await rigs.rigOf(clip);
    if (action === 'preview') return { message: await studio.previewClip(String(studioId), anim, body) };
    if (action === 'playtest') return { message: await studio.playtestClip(String(studioId), anim, rig) };
    return { message: await studio.pushClips(String(studioId), [{ anim, rig }], body) };
  }],
  ['POST', /^\/api\/clips\/([a-z0-9-]+)\/pull$/, async (req, [id]) => {
    const { studio: studioId, path: seqPath } = await readBody(req);
    const clip = await lib.loadClip(id);
    const result = fromStudio(await studio.pullSave(String(studioId), String(seqPath)), await rigs.rigOf(clip));
    result.anim.name = clip.name;
    lib.addEntry(clip, result, 'imported', String(seqPath).split('.').pop());
    return lib.saveClip(clip);
  }],
];

async function serveStatic(res, pathname) {
  let file = null;
  if (pathname === '/') file = path.join(WEB, 'index.html');
  else if (pathname.startsWith('/core/') && BROWSER_CORE.includes(path.basename(pathname))) file = path.join(CORE, path.basename(pathname));
  else if (/^\/fonts\/[\w.-]+\.woff2$/.test(pathname)) file = path.join(WEB, 'fonts', path.basename(pathname));
  else if (/^\/[\w.-]+$/.test(pathname)) file = path.join(WEB, pathname.slice(1));
  if (!file || !existsSync(file)) return false;
  send(res, 200, await readFile(file), MIME[path.extname(file)] ?? 'application/octet-stream');
  return true;
}

// Only the app itself may use the API, not other websites open in the same browser:
// a foreign Host header means DNS rebinding, a foreign Origin a cross-site request, and
// requiring JSON for changes forces a CORS preflight that this server never answers.
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
function trusted(req) {
  if (LOOPBACK && !LOCAL.test(req.headers.host ?? '')) return false;
  const origin = req.headers.origin;
  if (origin && origin.replace(/^https?:\/\//, '') !== req.headers.host) return false;
  return req.method === 'GET' || (req.headers['content-type'] ?? '').startsWith('application/json');
}
// Settings choose which programs the server starts, so even with HOST=0.0.0.0 only this
// computer may change or test them, never another device on the network.
function localOnly(req) {
  if (!/^(127\.|::1$|::ffff:127\.)/.test(req.socket.remoteAddress ?? '')) throw Object.assign(new Error('Settings can only be changed on the computer running OpenRig Studio.'), { status: 403 });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (!trusted(req)) return send(res, 403, { error: 'Request blocked: only the OpenRig Studio page itself can use this server.' });
    if (req.method === 'GET' && await serveStatic(res, url.pathname)) return;
    for (const [method, pattern, handler] of routes) {
      const m = url.pathname.match(pattern);
      if (!m || method !== req.method) continue;
      const out = await handler(req, m.slice(1), url);
      if (out?.png) return send(res, 200, out.png, 'image/png');
      if (out?.file) return send(res, 200, out.file, 'application/xml; charset=utf-8', { 'Content-Disposition': `attachment; filename="${out.name}.rbxmx"` });
      if (typeof out?.text === 'string' && url.pathname.endsWith('/luau')) return send(res, 200, out.text, 'text/plain; charset=utf-8');
      return send(res, 200, out);
    }
    send(res, 404, { error: 'Not found.' });
  } catch (e) {
    send(res, e.status ?? 500, { error: e.message });
  }
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is in use. Is OpenRig Studio already running? Start with PORT=4331 to use another port.`);
  else console.error(e);
  process.exit(1);
});
server.listen(PORT, HOST, async () => {
  console.log(`OpenRig Studio is running on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (!LOOPBACK) console.warn(`  WARNING: HOST=${HOST} makes OpenRig Studio reachable from other devices, without a password.\n  Anyone on your network can use your AI subscriptions and library. Unset HOST to keep it local.`);
  const examples = await lib.seedExamples().catch(e => { console.error(`Could not add the example clips: ${e.message}`); return 0; });
  if (examples) console.log(`  Added ${examples} example clips to the library (folder "Examples").`);
  const providers = await listProviders();
  for (const p of providers) console.log(`  [${p.available ? 'x' : ' '}] ${p.label}${p.available ? '' : p.kind === 'api' ? ' (add a key in Settings)' : ' (not installed)'}`);
});
