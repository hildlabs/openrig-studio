// Generation pipeline: draft → checks → optional visual review (the model sees a contact sheet
// of its draft) → new history entry. Plus model comparisons (one clip per engine).
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { ROOT, DATA, loadSettings } from './settings.js';
import { callModel, listProviders } from './providers/index.js';
import { loadClip, saveClip, addEntry, createClip, slug } from './library.js';
import { prepare, measure, forModel, isRest } from '../core/anim.js';
import { formatIssues } from '../core/messages.js';
import { renderSheet } from '../core/render.js';

const BASE_PROMPT = readFileSync(path.join(ROOT, 'prompts', 'system.md'), 'utf8');
const LANG_NAME = { en: 'English', de: 'German' };
async function systemPrompt(lang) {
  const { style } = await loadSettings();
  let text = BASE_PROMPT;
  if (style) text += `\n\n## Project style\n\n${style}\n`;
  text += `\n\nWrite \`plan\` and \`notes\` in ${LANG_NAME[lang] ?? 'English'}.\n`;
  return text;
}

const now = () => new Date().toISOString();
const report = r => formatIssues([...r.warnings, ...r.issues], 'en').map(s => `- ${s}`).join('\n');
const score = r => r.warnings.length + r.issues.length;
const addUsage = (a, b) => Object.fromEntries(['calls', 'input', 'cached', 'output', 'reasoning'].map(k => [k, (a?.[k] ?? 0) + (b?.[k] ?? 0)]));
const minus = (a, b) => Object.fromEntries(Object.keys(a).map(k => [k, a[k] - (b?.[k] ?? 0)]));

function extractJson(text) {
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(m => m[1]);
  for (const c of [...blocks.reverse(), text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]) {
    try { const v = JSON.parse(c); if (v && Array.isArray(v.keyframes)) return v; } catch { /* next */ }
  }
  return null;
}

function context(clip, anim, rep) {
  const parts = ['## Current animation\n```json\n' + JSON.stringify(forModel(anim)) + '\n```',
    '## Measurements (studs, character faces -Z, ground y=0)\n' + measure(anim)];
  if (rep) parts.push('## Check report\n' + rep);
  const wishes = clip.chat.filter(m => m.role === 'user').slice(-6).map(m => `- ${m.text}`).join('\n');
  if (wishes) parts.push('## Earlier requests\n' + wishes);
  return parts;
}
function buildRequest(clip, wish, mode) {
  const parts = [];
  if (mode !== 'create') {
    const cur = clip.history.find(h => h.id === clip.current);
    parts.push(...context(clip, clip.anim, cur ? report(cur) : ''));
  }
  parts.push(`## ${mode === 'create' ? 'Request for a new animation' : 'New request'}\n${wish}`);
  return parts.join('\n\n');
}
function buildReview(clip, wish, result, times) {
  return [
    '## Original request\n' + wish,
    ...context(clip, result.anim, report(result)).map(p => p.replace('## Current animation', '## Your draft')),
    `## Contact sheet (contact-sheet.png)\nThe image shows your draft. Top row: three-quarter view from the front right. Bottom row: side view from the right; the character faces right in the image. Columns are the times ${times.map(t => `${t}s`).join(', ')}.`,
    '## Task\nReview the draft strictly, like an animation lead: does the motion read instantly? Clear silhouettes? Anything stiff, robotic, random or twisted? Limbs inside each other, floating feet, snaps between frames? Anticipation, timing, settle and weight? Does it match the request? Fix everything in the check report. Then return the improved, complete animation; in "notes" say briefly what you improved.',
  ].join('\n\n');
}
const IMPROVE = 'Improve the animation with the style rules (anticipation, overshoot and settle, overlapping timing, weight, arcs), fix everything in the check report and use the measurements. Keep the idea, length and character of the motion.';

export function engineLabel(providers, { provider, model, effort }) {
  const p = providers.find(x => x.id === provider);
  const m = p?.models.find(x => x.id === model);
  return [p?.label ?? provider, m?.label ?? model, effort].filter(Boolean).join(' · ');
}

// ---------- Jobs ----------
const jobs = new Map();
const busy = new Set();
export const getJob = id => jobs.get(id);

async function generate(job, { id, prompt, engine, mode: requested, lang = 'en', fixedName }) {
  const clip = await loadClip(id);
  const mode = requested === 'improve' ? 'improve' : isRest(clip.anim) ? 'create' : 'edit';
  const wish = mode === 'improve' ? (prompt?.trim() ? `${IMPROVE}\nAlso: ${prompt.trim()}` : IMPROVE) : prompt.trim();
  const label = engineLabel(await listProviders(), engine);
  const system = await systemPrompt(lang);
  const started = Date.now();
  let usage = null;
  const ask = async (text, images) => { const a = await callModel({ ...engine, system, text, images }); usage = addUsage(usage, a.usage); return a.text; };

  job.step = 'draft';
  const request = buildRequest(clip, wish, mode);
  let json = extractJson(await ask(request));
  if (!json) {
    job.step = 'retry';
    json = extractJson(await ask(request + '\n\nIMPORTANT: your last answer contained no valid JSON. Answer only with the ```json block.'));
  }
  if (!json) throw new Error('The model returned no readable animation.');
  const draft = prepare(json, { literal: true });
  const draftUsage = usage;
  let result = draft, notes = json.notes ?? '', plan = json.plan;
  let review = null;
  if (job.review) {
    job.step = 'review';
    try {
      const sheet = renderSheet(draft.anim);
      const better = extractJson(await ask(buildReview(clip, wish, draft, sheet.times), [{ name: 'contact-sheet.png', data: sheet.png }]));
      if (!better) review = { applied: false, reason: 'noJson' };
      else {
        const r2 = prepare(better, { literal: true });
        // The review sees what the checks cannot; allow one extra minor finding, not more.
        if (score(r2) <= score(draft) + 1) { result = r2; notes = better.notes ?? notes; plan = better.plan ?? plan; review = { applied: true }; }
        else review = { applied: false, reason: 'worse', draft: score(draft), review: score(r2) };
      }
    } catch (e) { review = { applied: false, reason: 'error', error: e.message }; }
  }
  if (fixedName) { result.anim.name = fixedName; draft.anim.name = fixedName; }
  const draftEntry = review?.applied ? addEntry(clip, draft, 'draft', label) : undefined;
  const entry = addEntry(clip, result, 'generated', label);
  // An untitled clip takes the name the model gave its first result.
  if (!fixedName && clip.untitled && result.anim.name) clip.name = result.anim.name.slice(0, 80);
  clip.untitled = false;
  clip.anim.name = clip.name;
  clip.chat.push({
    role: 'assistant', text: notes, plan: Array.isArray(plan) ? plan.slice(0, 12).map(String) : undefined, at: now(),
    entry, draftEntry, engine: label, seconds: Math.round((Date.now() - started) / 1000),
    usage, draftUsage, reviewUsage: review?.applied || review?.reason === 'worse' ? minus(usage, draftUsage) : undefined, review,
    findings: [...result.warnings, ...result.issues], fixes: result.fixes,
  });
  await saveClip(clip);
  return clip;
}

// Records the request in the chat right away, then generates in the background.
export async function startJob(params) {
  if (busy.has(params.id)) throw Object.assign(new Error('This clip is already generating.'), { status: 409 });
  busy.add(params.id);
  try {
    const clip = await loadClip(params.id);
    const mode = params.mode === 'improve' ? 'improve' : 'chat';
    clip.chat.push({ role: 'user', text: params.prompt?.trim() || '', mode, at: now() });
    await saveClip(clip);
  } catch (e) { busy.delete(params.id); throw e; }
  const job = { id: Math.random().toString(36).slice(2), clipId: params.id, status: 'running', step: 'start', startedAt: Date.now(), review: params.review !== false };
  jobs.set(job.id, job);
  generate(job, params)
    .then(clip => Object.assign(job, { status: 'done', clip }))
    .catch(async e => {
      Object.assign(job, { status: 'error', error: e.message });
      try { const clip = await loadClip(params.id); clip.chat.push({ role: 'error', text: e.message, at: now() }); await saveClip(clip); } catch { /* clip gone */ }
    })
    .finally(() => busy.delete(params.id));
  return job;
}

// ---------- Comparisons ----------
const COMPARE = path.join(DATA, 'comparisons');
const comparePath = id => {
  if (!/^[a-z0-9-]+$/.test(id)) throw Object.assign(new Error('Invalid comparison id.'), { status: 400 });
  return path.join(COMPARE, `${id}.json`);
};
export async function startCompare({ title, prompt, runs, review, lang }) {
  if (!String(prompt ?? '').trim()) throw Object.assign(new Error('Enter a prompt.'), { status: 400 });
  if (!Array.isArray(runs) || !runs.length || runs.length > 8) throw Object.assign(new Error('Choose 1 to 8 models.'), { status: 400 });
  await mkdir(COMPARE, { recursive: true });
  const providers = await listProviders();
  const name = String(title || prompt).trim().slice(0, 48);
  const record = { id: `${slug(name)}-${Date.now().toString(36)}`, title: name, prompt: String(prompt), review: review !== false, createdAt: now(), items: [] };
  for (const run of runs) {
    const engine = { provider: String(run.provider), model: String(run.model ?? ''), effort: String(run.effort ?? '') };
    const label = engineLabel(providers, engine);
    const clip = await createClip(`${name} (${label})`.slice(0, 80), 'Comparisons');
    const job = await startJob({ id: clip.id, prompt: record.prompt, engine, mode: 'chat', review: record.review, lang, fixedName: clip.name });
    record.items.push({ clipId: clip.id, label, engine, jobId: job.id });
  }
  await writeFile(comparePath(record.id), JSON.stringify(record, null, 1), 'utf8');
  return compareStatus(record.id);
}
export async function compareStatus(id) {
  const record = JSON.parse(await readFile(comparePath(id), 'utf8'));
  for (const item of record.items) {
    const job = jobs.get(item.jobId);
    let clip = null;
    try { clip = await loadClip(item.clipId); } catch { /* deleted */ }
    const last = clip?.chat.findLast(m => m.role === 'assistant' || m.role === 'error');
    if (job?.status === 'running') Object.assign(item, { status: 'running', step: job.step, elapsed: Math.round((Date.now() - job.startedAt) / 1000) });
    else if (last?.role === 'assistant') Object.assign(item, { status: 'done', entry: last.entry, seconds: last.seconds, notes: last.text, review: last.review, findings: last.findings?.length ?? 0, keyframes: clip.anim.keyframes.length, duration: clip.anim.keyframes.at(-1).t, usage: last.usage });
    else if (last?.role === 'error' || job?.status === 'error') Object.assign(item, { status: 'error', error: job?.error ?? last?.text });
    else Object.assign(item, { status: clip ? 'interrupted' : 'deleted' });
  }
  return record;
}
export async function listCompares() {
  await mkdir(COMPARE, { recursive: true });
  const out = [];
  for (const f of readdirSync(COMPARE).filter(f => f.endsWith('.json'))) {
    try { const r = JSON.parse(await readFile(path.join(COMPARE, f), 'utf8')); out.push({ id: r.id, title: r.title, createdAt: r.createdAt, count: r.items.length }); } catch { /* skip */ }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
