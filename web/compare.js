// Compare: one prompt, several models; results play in sync on mini stages (one renderer).
import { api, $, $$, esc, kTok, prefs, toast } from './api.js';
import { t, getLang } from './i18n.js';
import { icon } from './icons.js';
import { store, openClip } from './app.js';
import { MultiViewer } from './stage.js';
import { buildTracks } from '/core/anim.js';

const C = { record: null, timer: null, t: 0, playing: true, speed: 1, mode: prefs.get('cmpMode', 'stage'), clips: new Map() };
let root, multi, last = performance.now();
const DEFAULT_RUNS = ['claude-code:claude-opus-5-5', 'codex:gpt-6-astra'];

export function mount(el) {
  root = el;
  root.innerHTML = `<div class="compare">
    <aside class="cmp-setup">
      <h2 data-l="cmp.title"></h2>
      <p data-l="cmp.body"></p>
      <label class="field"><span data-l="cmp.preset"></span><select id="cmpPreset"></select></label>
      <label class="field"><span data-l="cmp.prompt"></span><textarea id="cmpPrompt" rows="4"></textarea></label>
      <div class="field"><span data-l="cmp.models"></span><div class="models" id="cmpModels"></div></div>
      <label class="check"><input type="checkbox" id="cmpReview"><span data-l="composer.review"></span></label>
      <button class="btn primary" id="cmpStart"></button>
    </aside>
    <section class="cmp-main">
      <div class="cmp-bar">
        <select id="cmpHistory" aria-label="History"></select>
        <button class="btn icon primary" id="cmpPlay"></button>
        <input type="range" id="cmpScrub" min="0" max="1000" value="0" aria-label="Time">
        <span class="timecode num" id="cmpTime"></span>
        <div class="seg" role="group"><button data-mode="stage"></button><button data-mode="frames"></button></div>
      </div>
      <div class="cmp-scroll" id="cmpScroll"><canvas class="cmp-canvas" id="cmpCanvas"></canvas><div class="cmp-grid" id="cmpGrid"></div></div>
    </section>
  </div>`;
  multi = new MultiViewer($('#cmpScroll', root), $('#cmpCanvas', root));
  $('#cmpPreset', root).addEventListener('change', e => { const p = store.presets.find(x => x.id === e.target.value); if (p) $('#cmpPrompt', root).value = p.prompt[getLang()] ?? p.prompt.en; });
  $('#cmpModels', root).addEventListener('change', saveRuns);
  $('#cmpReview', root).checked = prefs.get('review', true);
  $('#cmpStart', root).addEventListener('click', start);
  $('#cmpHistory', root).addEventListener('change', e => e.target.value && load(e.target.value));
  $('#cmpPlay', root).addEventListener('click', () => { C.playing = !C.playing; renderPlay(); });
  $('#cmpScrub', root).addEventListener('input', e => { C.playing = false; renderPlay(); C.t = (Number(e.target.value) / 1000) * maxLen(); });
  for (const b of $$('[data-mode]', root)) b.addEventListener('click', () => { C.mode = b.dataset.mode; prefs.set('cmpMode', C.mode); renderGrid(); });
  $('#cmpGrid', root).addEventListener('click', e => {
    const open = e.target.closest('[data-open]');
    if (open) openClip(open.dataset.open);
  });
  relabel();
  requestAnimationFrame(frame);
}
export function relabel() {
  for (const el of $$('[data-l]', root)) el.textContent = t(el.dataset.l);
  $('#cmpStart', root).innerHTML = `${icon('compare')}${t('cmp.start')}`;
  for (const b of $$('[data-mode]', root)) { b.textContent = t(b.dataset.mode === 'stage' ? 'cmp.stage' : 'cmp.frames'); b.setAttribute('aria-pressed', String(b.dataset.mode === C.mode)); }
  renderPlay();
  renderSetup();
  renderGrid();
}
export async function activate() {
  renderSetup();
  await loadHistory();
}

function renderSetup() {
  if (!root || !store.providers.length) return;
  const lang = getLang();
  const sel = $('#cmpPreset', root);
  const keep = sel.value;
  sel.innerHTML = `<option value="">${t('cmp.custom')}</option>` + store.presets.map(p => `<option value="${p.id}">${esc(p.title[lang] ?? p.title.en)}</option>`).join('');
  sel.value = keep || (store.presets[0]?.id ?? '');
  if (!$('#cmpPrompt', root).value && store.presets[0]) $('#cmpPrompt', root).value = store.presets[0].prompt[lang] ?? store.presets[0].prompt.en;
  const saved = prefs.get('cmpRuns', null);
  $('#cmpModels', root).innerHTML = store.providers.map(p => `<div class="grp">${esc(p.label)}${p.available ? '' : ` (${t('cmp.notSetUp')})`}</div>` + p.models.filter(m => m.id).map(m => {
    const key = `${p.id}:${m.id}`;
    const prev = saved?.[key];
    const on = prev ? prev.on : DEFAULT_RUNS.includes(key);
    const effort = prev?.effort ?? (p.id !== 'compatible' && m.efforts.includes('high') ? 'high' : '');
    return `<div class="row${p.available ? '' : ' off'}"><label class="check"><input type="checkbox" data-key="${esc(key)}" ${on && p.available ? 'checked' : ''} ${p.available ? '' : 'disabled'}>${esc(m.label)}</label>
      <select data-effort="${esc(key)}" ${p.available ? '' : 'disabled'}><option value="">${t('engine.default')}</option>${m.efforts.map(e => `<option${e === effort ? ' selected' : ''}>${esc(e)}</option>`).join('')}</select></div>`;
  }).join('')).join('');
}
function saveRuns() {
  const state = {};
  for (const row of $$('#cmpModels .row', root)) {
    const cb = $('[data-key]', row);
    state[cb.dataset.key] = { on: cb.checked, effort: $('[data-effort]', row).value };
  }
  prefs.set('cmpRuns', state);
  return state;
}
async function start() {
  const runs = Object.entries(saveRuns()).filter(([, v]) => v.on).map(([key, v]) => {
    const i = key.indexOf(':');
    return { provider: key.slice(0, i), model: key.slice(i + 1), effort: v.effort };
  });
  if (!runs.length) return toast(t('cmp.models'), true);
  const preset = store.presets.find(p => p.id === $('#cmpPreset', root).value);
  const review = $('#cmpReview', root).checked;
  prefs.set('review', review);
  try {
    const record = await api('/api/compare', { method: 'POST', body: { title: preset ? preset.title[getLang()] ?? preset.title.en : '', prompt: $('#cmpPrompt', root).value, runs, review, lang: getLang() } });
    await loadHistory(record.id);
  } catch (e) { toast(e.message, true); }
}

async function loadHistory(select) {
  const list = await api('/api/compare');
  const sel = $('#cmpHistory', root);
  sel.innerHTML = `<option value="">${t('cmp.history')}</option>` + list.map(c => `<option value="${c.id}">${esc(c.title)}, ${new Date(c.createdAt).toLocaleString(getLang(), { dateStyle: 'short', timeStyle: 'short' })}</option>`).join('');
  const id = select ?? C.record?.id ?? list[0]?.id;
  if (id) { sel.value = id; await load(id); } else { C.record = null; renderGrid(); }
}
async function load(id) {
  clearTimeout(C.timer);
  C.record = await api(`/api/compare/${id}`);
  for (const item of C.record.items) {
    const key = `${item.clipId}:${item.entry}`;
    if (item.status === 'done' && !C.clips.has(key)) {
      const clip = await api(`/api/clips/${item.clipId}`).catch(() => null);
      const anim = clip?.history.find(h => h.id === item.entry)?.anim ?? clip?.anim;
      if (anim) C.clips.set(key, { tracks: buildTracks(anim), length: anim.keyframes.at(-1).t });
    }
  }
  renderGrid();
  if (C.record.items.some(i => i.status === 'running') && !$('#view-compare').classList.contains('hidden')) C.timer = setTimeout(() => load(id).catch(() => {}), 3000);
}
const maxLen = () => Math.max(1, ...[...multi.tiles.values()].map(tile => tile.length ?? 0));

function renderGrid() {
  if (!root) return;
  const grid = $('#cmpGrid', root);
  multi.clear();
  grid.classList.toggle('frames-mode', C.mode === 'frames');
  // Transport and view switch only mean something once there is a comparison to play.
  for (const id of ['#cmpPlay', '#cmpScrub', '#cmpTime']) $(id, root).classList.toggle('hidden', C.mode === 'frames' || !C.record);
  $('.cmp-bar .seg', root).classList.toggle('hidden', !C.record);
  for (const b of $$('[data-mode]', root)) b.setAttribute('aria-pressed', String(b.dataset.mode === C.mode));
  if (!C.record) { grid.innerHTML = `<div class="cmp-empty" style="grid-column:1/-1"><h2>${t('cmp.empty')}</h2><p>${t('cmp.emptyBody')}</p></div>`; return; }
  grid.innerHTML = C.record.items.map((it, i) => {
    let stage = '';
    if (it.status === 'running') stage = `<div class="status"><span><span class="spinner"></span> ${t('cmp.running', { s: it.elapsed })}</span></div>`;
    else if (it.status === 'error') stage = `<div class="status">${esc(t('cmp.failed', { error: it.error }))}</div>`;
    else if (it.status !== 'done') stage = `<div class="status">${t('cmp.interrupted')}</div>`;
    else if (C.mode === 'frames') stage = `<img alt="" src="/api/clips/${it.clipId}/sheet.png?entry=${it.entry}">`;
    const stats = it.status === 'done' ? `<div class="stats num"><span>${t('cmp.stats', { s: it.seconds, keys: it.keyframes, len: it.duration.toFixed(2) })}</span>${it.usage ? `<span>${t('msg.tokens', { in: kTok(it.usage.input + it.usage.cached), out: kTok(it.usage.output) })}</span>` : ''}${it.findings ? `<span>${t('msg.findings', { n: it.findings })}</span>` : ''}${it.review?.applied ? `<span>${t('msg.reviewed')}</span>` : ''}</div>` : '';
    return `<article class="tile"><div class="tile-head"><b>${esc(it.label)}</b></div>
      <div class="tile-stage" data-tile="${i}">${stage}</div>
      <div class="tile-foot">${stats}${it.notes ? `<div>${esc(it.notes)}</div>` : ''}
        ${it.status === 'done' ? `<div class="actions"><button class="btn" data-open="${it.clipId}">${icon('open')}${t('cmp.open')}</button></div>` : ''}</div></article>`;
  }).join('');
  if (C.mode !== 'stage') return;
  C.record.items.forEach((it, i) => {
    const data = C.clips.get(`${it.clipId}:${it.entry}`);
    if (it.status !== 'done' || !data) return;
    const tile = multi.add(i, $(`[data-tile="${i}"]`, grid));
    tile.tracks = data.tracks;
    tile.length = data.length;
  });
}
function renderPlay() {
  const b = $('#cmpPlay', root);
  if (!b) return;
  b.innerHTML = icon(C.playing ? 'pause' : 'play');
  b.title = t(C.playing ? 'transport.pause' : 'transport.play');
}
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (root && !$('#view-compare').classList.contains('hidden') && C.mode === 'stage') {
    const len = maxLen();
    if (C.playing) C.t = (C.t + dt * C.speed) % len;
    $('#cmpScrub', root).value = String(Math.round((C.t / len) * 1000));
    $('#cmpTime', root).textContent = `${C.t.toFixed(2)} s`;
    multi.render(C.t);
  }
  requestAnimationFrame(frame);
}
