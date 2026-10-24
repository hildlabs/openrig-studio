// Editor: director chat, 3D stage, transport, dope sheet / frames / history, inspector.
import { api, $, $$, esc, kTok, prefs, toast, dialog, menu } from './api.js';
import { t, ago, getLang } from './i18n.js';
import { icon } from './icons.js';
import { store, studioId, show } from './app.js';
import { Viewer } from './stage.js';
import { RIG_R15, POSE_PARTS, REGION, eulerDeg } from '/core/rig.js';
import { buildTracks, sampleTracks, EASES } from '/core/anim.js';
import { formatIssue } from '/core/messages.js';

const FPS = 60;
const snap = v => Math.round(Math.max(0, v) * FPS) / FPS;
const r3 = v => Math.round(v * 1000) / 1000;
const GROUPS = [
  ['LowerTorso', 'UpperTorso'], ['Head'],
  ['RightUpperArm', 'RightLowerArm', 'RightHand'], ['LeftUpperArm', 'LeftLowerArm', 'LeftHand'],
  ['RightUpperLeg', 'RightLowerLeg', 'RightFoot'], ['LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot'],
];
const REGION_COLOR = { arms: 'var(--arms)', head: 'var(--arms)', torso: 'var(--torso)', legs: 'var(--legs)' };
const S = { clip: null, anim: null, tracks: null, dirty: false, t: 0, playing: false, speed: 1, loop: true, part: null, job: null, lower: prefs.get('lower', 'dope'), inspKey: '' };
let root, viewer, lastFrame = performance.now(), scrubbing = false, sheetMeta = null;
const dur = () => S.anim?.keyframes.at(-1).t ?? 1;
const kfAt = tt => S.anim.keyframes.findIndex(k => Math.abs(k.t - tt) < 0.0005);

// ---------- Layout ----------
export function mount(el) {
  root = el;
  root.innerHTML = `<div class="editor">
    <aside class="pane director">
      <div class="pane-head"><span class="pane-title" data-l="director"></span></div>
      <div class="engine">
        <select id="engProvider"></select><select id="engModel"></select><select id="engEffort"></select>
        <input type="text" id="engCustom" class="hidden" spellcheck="false">
        <div class="note hidden" id="engNote"></div>
      </div>
      <div class="thread" id="thread" aria-live="polite"></div>
      <div class="job hidden" id="jobBar"><span class="spinner"></span><span id="jobText"></span></div>
      <div class="composer">
        <textarea id="prompt" rows="3"></textarea>
        <div class="row">
          <label class="check" id="reviewLabel"><input type="checkbox" id="review"><span data-l="composer.review"></span></label>
          <span class="grow"></span>
          <button class="btn" id="improveBtn"></button>
          <button class="btn primary" id="sendBtn"></button>
        </div>
      </div>
    </aside>
    <section class="center">
      <div class="clipbar">
        <input class="name" id="clipName" spellcheck="false" aria-label="Name">
        <span class="meta num" id="clipMeta"></span>
        <span class="grow"></span>
        <button class="btn" id="exportBtn"></button>
        <button class="btn" id="studioBtn"></button>
        <button class="btn icon" id="newBtn"></button>
      </div>
      <div class="viewport" id="viewport"><div class="hint" data-l="viewport.hint"></div></div>
      <div class="transport">
        <button class="btn icon quiet" id="tStart"></button>
        <button class="btn icon primary" id="tPlay"></button>
        <button class="btn icon quiet" id="tEnd"></button>
        <input type="range" id="scrub" min="0" max="1000" value="0" aria-label="Time">
        <span class="timecode num" id="timecode"></span>
        <select id="speed" aria-label="Speed"><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option></select>
        <button class="btn icon on" id="tLoop"></button>
      </div>
      <div class="lower">
        <div class="subtabs" role="tablist">
          <button data-lower="dope" data-l="lower.dope"></button>
          <button data-lower="frames" data-l="lower.frames"></button>
          <button data-lower="history" data-l="lower.history"></button>
          <span class="info num" id="lowerInfo"></span>
        </div>
        <div class="lower-body" id="lowerBody"></div>
      </div>
    </section>
    <aside class="pane inspector" id="inspector"></aside>
  </div>`;
  viewer = new Viewer($('#viewport', root));
  viewer.onPick = part => selectPart(part);
  wire();
  relabel();
  requestAnimationFrame(frame);
}

export function relabel() {
  for (const el of $$('[data-l]', root)) el.textContent = t(el.dataset.l);
  $('#prompt', root).placeholder = t('composer.placeholder');
  $('#reviewLabel', root).title = t('composer.reviewHint');
  $('#improveBtn', root).innerHTML = `${icon('sparkle')}${t('composer.improve')}`;
  $('#sendBtn', root).innerHTML = `${icon('send')}${t('composer.send')}`;
  $('#exportBtn', root).innerHTML = `${icon('download')}${t('actions.export')}`;
  $('#studioBtn', root).innerHTML = `${icon('studio')}${t('actions.studio')}${icon('chevron')}`;
  $('#newBtn', root).innerHTML = icon('plus');
  $('#newBtn', root).title = t('lib.new');
  $('#tStart', root).innerHTML = icon('start'); $('#tStart', root).title = t('transport.start');
  $('#tEnd', root).innerHTML = icon('end'); $('#tEnd', root).title = t('transport.end');
  $('#tLoop', root).innerHTML = icon('loop'); $('#tLoop', root).title = t('transport.loop');
  $('#engCustom', root).placeholder = t('engine.customPlaceholder');
  setPlaying(S.playing);
  renderEngine();
  if (S.clip) { renderChat(); renderLower(); renderInspector(); renderClipbar(); }
}

export async function activate() {
  if (store.providers.length) renderEngine();
  if (S.clip) return;
  const { clips } = await api('/api/clips');
  const want = prefs.get('clip', null);
  const pick = clips.find(c => c.id === want) ?? [...clips].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  if (pick) await open(pick.id);
  else await open((await api('/api/clips', { method: 'POST', body: { name: t('clip.untitled'), untitled: true } })).id);
}

export async function open(id) {
  if (S.dirty && S.clip?.id !== id) await save();
  setClip(await api(`/api/clips/${id}`));
}
function setClip(clip, { keepTime = false } = {}) {
  S.clip = clip;
  S.anim = structuredClone(clip.anim);
  S.tracks = buildTracks(S.anim);
  S.dirty = false;
  if (!keepTime || S.t > dur()) S.t = 0;
  if (!keepTime) viewer.fit(S.tracks, dur());
  sheetMeta = null;
  prefs.set('clip', clip.id);
  renderClipbar();
  renderChat();
  renderLower();
  renderInspector();
  viewer.rig.highlight(S.part);
}

// ---------- Engine choice (provider → model → effort, remembered per provider) ----------
const CUSTOM = '__custom';
function renderEngine() {
  if (!root || !store.providers.length) return;
  const sel = $('#engProvider', root);
  const want = prefs.get('provider', store.providers.find(p => p.available)?.id ?? 'claude-code');
  sel.innerHTML = store.providers.map(p => `<option value="${p.id}">${esc(p.label)}${p.available ? '' : ` (${t('cmp.notSetUp')})`}</option>`).join('');
  sel.value = store.providers.some(p => p.id === want) ? want : store.providers[0].id;
  fillModels();
}
function fillModels() {
  const prov = store.providers.find(p => p.id === $('#engProvider', root).value);
  if (!prov) return;
  prefs.set('provider', prov.id);
  const want = prefs.get(`model.${prov.id}`, prov.models[0]?.id ?? CUSTOM);
  const sel = $('#engModel', root);
  sel.innerHTML = prov.models.map(m => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('') + `<option value="${CUSTOM}">${t('engine.custom')}</option>`;
  sel.value = prov.models.some(m => m.id === want) || want === CUSTOM ? want : prov.models[0]?.id ?? CUSTOM;
  $('#engCustom', root).value = prefs.get(`custom.${prov.id}`, '');
  const note = $('#engNote', root);
  note.textContent = t('engine.unavailable', { provider: prov.label });
  note.classList.toggle('hidden', prov.available);
  fillEfforts();
}
function fillEfforts() {
  const prov = store.providers.find(p => p.id === $('#engProvider', root).value);
  const modelId = $('#engModel', root).value;
  const model = prov?.models.find(m => m.id === modelId);
  prefs.set(`model.${prov?.id}`, modelId);
  $('#engCustom', root).classList.toggle('hidden', modelId !== CUSTOM);
  const efforts = model?.efforts ?? prov?.models[0]?.efforts ?? ['low', 'medium', 'high'];
  const want = prefs.get(`effort.${prov?.id}`, 'high');
  $('#engEffort', root).innerHTML = `<option value="">${t('engine.default')}</option>` + efforts.map(e => `<option value="${esc(e)}">${esc(e)}</option>`).join('');
  $('#engEffort', root).value = efforts.includes(want) ? want : '';
}
function engine() {
  const provider = $('#engProvider', root).value;
  const model = $('#engModel', root).value === CUSTOM ? $('#engCustom', root).value.trim() : $('#engModel', root).value;
  return { provider, model, effort: $('#engEffort', root).value };
}

// ---------- Chat ----------
const HISTORY_LABEL = kind => t(`history.${kind}`);
function usageText(u) {
  if (!u) return '';
  return t('msg.tokens', { in: kTok(u.input + u.cached), out: kTok(u.output) }) + (u.reasoning ? ` (${t('msg.thinking', { n: kTok(u.reasoning) })})` : '');
}
function renderChat() {
  const box = $('#thread', root);
  const chat = S.clip?.chat ?? [];
  if (!chat.length) {
    const lang = getLang();
    box.innerHTML = `<div class="empty"><h2>${t('empty.title')}</h2><p>${t('empty.body')}</p>
      <div class="presets">${store.presets.map(p => `<button data-preset="${esc(p.prompt[lang] ?? p.prompt.en)}">${esc(p.title[lang] ?? p.title.en)}</button>`).join('')}</div></div>`;
    return;
  }
  box.innerHTML = chat.map(m => {
    if (m.role === 'user') return `<div class="msg-user">${m.mode === 'improve' ? `<span class="mode">${t('mode.improve')}</span>` : ''}${esc(m.text)}</div>`;
    if (m.role === 'error') return `<div class="msg-bot error">${esc(m.text)}</div>`;
    if (m.role !== 'assistant') return `<div class="msg-note">${esc(m.text)}</div>`;
    const plan = m.plan?.length ? `<details><summary>${t('msg.plan')}</summary><ol>${m.plan.map(p => `<li>${esc(p)}</li>`).join('')}</ol></details>` : '';
    const findings = m.findings?.length ? `<details><summary>${t('msg.findings', { n: m.findings.length })}</summary><ul>${m.findings.map(f => `<li>${esc(formatIssue(f, getLang()))}</li>`).join('')}</ul></details>` : '';
    const fixes = m.fixes?.length ? `<details><summary>${t('msg.fixes')}</summary><ul>${m.fixes.map(f => `<li>${esc(formatIssue(f, getLang()))}</li>`).join('')}</ul></details>` : '';
    const review = m.review?.applied ? t('msg.reviewed') : m.review ? t('msg.reviewKept', { reason: t({ worse: 'msg.reviewWorse', noJson: 'msg.reviewNoJson' }[m.review.reason] ?? 'msg.reviewError') }) : '';
    return `<div class="msg-bot"><div class="txt">${esc(m.text)}</div>${plan}${findings}${fixes}<div class="msg-meta num"><span>${esc(m.engine)}</span><span>${m.seconds} s</span>${m.usage ? `<span>${usageText(m.usage)}</span>` : ''}${review ? `<span>${review}</span>` : ''}${m.draftEntry ? `<button data-restore="${m.draftEntry}">${t('msg.restoreDraft')}</button>` : ''}</div></div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}
function setBusy(on, text = '') {
  $('#jobBar', root).classList.toggle('hidden', !on);
  $('#jobText', root).textContent = text;
  for (const id of ['#sendBtn', '#improveBtn']) $(id, root).disabled = on;
}
async function generate(mode) {
  if (!S.clip || S.job) return;
  const prompt = $('#prompt', root).value.trim();
  if (mode !== 'improve' && !prompt) return $('#prompt', root).focus();
  const eng = engine();
  if (!eng.model && $('#engModel', root).value === CUSTOM) return toast(t('engine.customPlaceholder'), true);
  try {
    if (S.dirty) await save();
    const review = $('#review', root).checked;
    prefs.set('review', review);
    const { jobId } = await api(`/api/clips/${S.clip.id}/generate`, { method: 'POST', body: { prompt, ...eng, mode, review, lang: getLang() } });
    $('#prompt', root).value = '';
    S.job = jobId;
    setBusy(true, t('job.start'));
    setClip(await api(`/api/clips/${S.clip.id}`), { keepTime: true });
    poll(jobId, S.clip.id);
  } catch (e) { toast(e.message, true); }
}
function poll(jobId, clipId) {
  const label = $('#engModel', root).value === CUSTOM ? $('#engCustom', root).value : $('#engModel', root).selectedOptions[0]?.textContent ?? '';
  const timer = setInterval(async () => {
    try {
      const job = await api(`/api/jobs/${jobId}`);
      if (S.clip?.id === clipId) $('#jobText', root).textContent = `${t(`job.${job.step}`, { engine: label })} ${job.elapsed} s`;
      if (job.status === 'running') return;
      clearInterval(timer);
      S.job = null;
      setBusy(false);
      if (S.clip?.id !== clipId) return;
      if (job.status === 'done') { setClip(job.clip); setPlaying(true); }
      else { toast(job.error, true); setClip(await api(`/api/clips/${clipId}`), { keepTime: true }); }
    } catch (e) { clearInterval(timer); S.job = null; setBusy(false); toast(e.message, true); }
  }, 1000);
}

// ---------- Clip bar ----------
function renderClipbar() {
  if (!S.anim) return;
  $('#clipName', root).value = S.clip.name;
  $('#clipMeta', root).textContent = `${dur().toFixed(2)} s · ${t('clip.keys', { n: S.anim.keyframes.length })}${S.anim.loop ? ` · ${t('clip.loop')}` : ''}`;
}
async function studioAction(action) {
  const id = studioId();
  if (!id) return;
  if (S.dirty) await save();
  const btn = $('#studioBtn', root);
  btn.disabled = true;
  try {
    if (action === 'pull') {
      const saves = await api(`/api/studio/saves?studio=${encodeURIComponent(id)}`);
      const pick = await dialog(`<h3>${t('pull.title')}</h3><p class="muted">${t('pull.body')}</p><div class="list">${saves.length
        ? saves.map(s => `<button class="btn" data-value="${esc(s.path)}"><span>${esc(s.name)}</span><span class="muted">${esc(s.rig)} · ${t('pull.keys', { n: s.keys })}</span></button>`).join('')
        : `<p class="muted">${t('pull.none')}</p>`}</div><div class="actions"><button class="btn" data-value="">${t('dialog.cancel')}</button></div>`);
      if (!pick) return;
      setClip(await api(`/api/clips/${S.clip.id}/pull`, { method: 'POST', body: { studio: id, path: pick } }));
      toast(t('done.imported'));
    } else {
      const { message } = await api(`/api/clips/${S.clip.id}/studio`, { method: 'POST', body: { studio: id, action } });
      toast(t(`done.${action}`, { msg: message }));
    }
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; }
}

// ---------- Transport ----------
function frame(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (S.playing && S.anim) {
    S.t += dt * S.speed;
    if (S.t >= dur()) { if (S.loop) S.t %= dur() || 1; else { S.t = dur(); setPlaying(false); } }
  }
  if (S.anim && !$('#view-editor').classList.contains('hidden')) {
    viewer.show(S.tracks, S.t);
    viewer.render();
    updateTime();
  }
  requestAnimationFrame(frame);
}
function updateTime() {
  if (!scrubbing) $('#scrub', root).value = String(Math.round((S.t / dur()) * 1000));
  $('#timecode', root).textContent = `${S.t.toFixed(2)} s  f${Math.round(S.t * FPS)}`;
  const ph = $('#playhead', root);
  if (ph) ph.style.left = `${(S.t / dur()) * 100}%`;
  const fm = $('.frames .marker', root);
  if (fm && sheetMeta) placeFrameMarker();
  if (!S.playing && `${S.part}|${kfAt(S.t)}` !== S.inspKey) renderInspector();
}
function setPlaying(on) {
  S.playing = on;
  const b = $('#tPlay', root);
  b.innerHTML = icon(on ? 'pause' : 'play');
  b.title = t(on ? 'transport.pause' : 'transport.play');
  if (!on && S.anim) renderInspector();
}
function seek(tt) {
  S.t = Math.min(dur(), Math.max(0, tt));
  if (S.playing) setPlaying(false);
  markKeys();
}

// ---------- Lower panel ----------
function renderLower() {
  for (const b of $$('.subtabs [data-lower]', root)) b.setAttribute('aria-selected', String(b.dataset.lower === S.lower));
  if (!S.anim) return;
  $('#lowerInfo', root).textContent = S.lower === 'dope' ? `${t('clip.keys', { n: S.anim.keyframes.length })} · ${t('clip.events', { n: S.anim.events.length })}` : '';
  if (S.lower === 'dope') renderDope();
  else if (S.lower === 'frames') renderFrames();
  else renderHistory();
}
function renderDope() {
  const d = dur();
  const x = v => `${(v / d) * 100}%`;
  const step = d <= 2 ? 0.1 : d <= 5 ? 0.25 : 0.5;
  const every = d <= 3 ? 0.5 : 1;
  let ticks = '';
  for (let v = 0; v <= d + 1e-6; v += step) {
    const label = Math.abs(v / every - Math.round(v / every)) < 1e-6;
    const lastTick = v > d - step / 2;
    ticks += `<span class="tick${lastTick ? ' last' : ''}" style="left:${x(v)};${label ? '' : 'height:35%'}">${label ? v.toFixed(1) : ''}</span>`;
  }
  const flags = S.anim.events.map((e, i) => `<span class="flag" data-t="${e.t}" data-ev="${i}" style="left:${x(e.t)}" title="${esc(e.value)}">${esc(e.name)}</span>`).join('');
  const rows = GROUPS.map(group => group.map((part, i) => {
    const region = REGION(part);
    const keys = S.anim.keyframes.filter(k => k.poses[part]).map(k => `<button class="key" data-region="${region}" data-t="${k.t}" data-part="${part}" style="left:${x(k.t)}" title="${part} ${k.t}s"></button>`).join('');
    return `<div class="dope-row${part === S.part ? ' sel' : ''}${i === 0 ? ' group-start' : ''}" data-row="${part}"><div class="dope-label" data-region="${region}" data-part="${part}">${part}</div><div class="dope-track">${keys}</div></div>`;
  }).join('')).join('');
  $('#lowerBody', root).innerHTML = `<div class="dope">
    <div class="dope-row head"><div class="dope-label muted">${t('lower.time')}</div><div class="dope-track ruler" id="ruler">${ticks}</div></div>
    <div class="dope-row events"><div class="dope-label">${t('lower.events')}</div><div class="dope-track">${flags}</div></div>
    ${rows}
    <div class="dope-overlay"><div class="playhead" id="playhead"></div></div></div>`;
  markKeys();
}
function markKeys() {
  for (const el of $$('.dope .key', root)) el.classList.toggle('sel', Math.abs(Number(el.dataset.t) - S.t) < 0.0005 && el.dataset.part === S.part);
}
async function renderFrames() {
  const body = $('#lowerBody', root);
  const entry = S.clip.current;
  body.innerHTML = `<div class="frames"><p class="muted" style="margin:0 0 8px">${t('frames.hint')}</p><div class="sheet"><img alt="" src="/api/clips/${S.clip.id}/sheet.png?entry=${entry}&r=${Date.now()}"><div class="marker"></div></div></div>`;
  sheetMeta = await api(`/api/clips/${S.clip.id}/sheet?entry=${entry}`).catch(() => null);
  placeFrameMarker();
}
function placeFrameMarker() {
  const img = $('.frames img', root), marker = $('.frames .marker', root);
  if (!img || !marker || !sheetMeta) return;
  const n = sheetMeta.times.length, w = img.clientWidth / n;
  let i = 0;
  while (i < n - 1 && Math.abs(sheetMeta.times[i + 1] - S.t) < Math.abs(sheetMeta.times[i] - S.t)) i++;
  Object.assign(marker.style, { left: `${i * w}px`, width: `${w}px` });
}
function renderHistory() {
  const list = [...S.clip.history].reverse();
  $('#lowerBody', root).innerHTML = `<ul class="history">${list.map(h => {
    const isCurrent = h.id === S.clip.current;
    const findings = (h.issues?.length ?? 0) + (h.warnings?.length ?? 0);
    return `<li class="${isCurrent ? 'current' : ''}"><span class="dot"></span>
      <div><div class="kind">${HISTORY_LABEL(h.kind)}${isCurrent ? ` <span class="badge">${t('history.current')}</span>` : ''}</div>
      <div class="sub num">${esc(h.label && h.kind !== 'restored' ? h.label : '')}${h.label && h.kind !== 'restored' ? ' · ' : ''}${ago(h.at)}${findings ? ` · ${t('history.findings', { n: findings })}` : ''}</div></div>
      <div class="line">${isCurrent ? '' : `<button class="btn" data-restore="${h.id}">${icon('history')}${t('history.restore')}</button>`}</div></li>`;
  }).join('')}</ul>`;
}

// ---------- Inspector ----------
function slider(axis, key, value, lo, hi, step) {
  return `<div class="axis"><span>${axis}</span><input type="range" min="${lo}" max="${hi}" step="${step}" value="${value}" data-k="${key}" aria-label="${axis}"><input type="number" class="num" min="${lo}" max="${hi}" step="${step}" value="${value}" data-k="${key}" aria-label="${axis}"></div>`;
}
function renderInspector() {
  const el = $('#inspector', root);
  if (!S.anim) { el.innerHTML = ''; return; }
  const ki = kfAt(S.t);
  S.inspKey = `${S.part}|${ki}`;
  const kf = S.anim.keyframes[ki];
  let html = '<div class="section">';
  if (!S.part) html += `<h3>${t('insp.joint')}</h3><p>${t('insp.noJoint')}</p>`;
  else {
    html += `<h3><span class="swatch" style="background:${REGION_COLOR[REGION(S.part)]}"></span>${S.part}</h3><p class="num">${kf ? t('insp.atKey', { t: kf.t.toFixed(3) }) : t('insp.between', { t: S.t.toFixed(3) })}</p>`;
    const pose = kf?.poses[S.part];
    if (pose) {
      const lim = RIG_R15.limits[S.part];
      html += pose.rot.map((v, i) => slider('xyz'[i], `rot.${i}`, v, lim[i][0], lim[i][1], 1)).join('');
      if (S.part === 'LowerTorso') html += pose.pos.map((v, i) => slider('XYZ'[i], `pos.${i}`, v, -4, 4, 0.01)).join('') + `<p>${t('insp.groundNote')}</p>`;
      html += `<div class="line"><label>${t('insp.easing')}</label><select data-ease>${EASES.map(e => `<option value="${e}"${e === pose.ease ? ' selected' : ''}>${t(`ease.${e}`)}</option>`).join('')}</select></div>
        <div class="line"><button class="btn danger" data-act="delPose">${icon('trash')}${t('insp.removeKey')}</button></div>`;
    } else html += `<div class="line"><button class="btn primary" data-act="addPose">${icon('plus')}${t('insp.addKey')}</button></div>`;
  }
  html += '</div>';
  if (kf) {
    html += `<div class="section"><h3>${t('insp.keyframe')}</h3>
      <div class="line"><label>${t('insp.time')}</label><input type="number" class="num" step="0.01" min="0" value="${kf.t}" data-kt ${ki === 0 ? 'disabled' : ''} style="width:90px"> s</div>
      <label class="check"><input type="checkbox" data-air ${kf.contact === 'air' ? 'checked' : ''}>${t('insp.air')}</label>
      ${ki > 0 ? `<div class="line"><button class="btn danger" data-act="delKf">${icon('trash')}${t('insp.deleteKeyframe')}</button></div>` : ''}</div>`;
  }
  html += `<div class="section"><h3>${t('insp.clip')}</h3>
    <div class="line"><label class="check"><input type="checkbox" data-loop ${S.anim.loop ? 'checked' : ''}>${t('clip.loop')}</label>
    <label style="min-width:0">${t('insp.priority')}</label><select data-prio>${['Idle', 'Movement', 'Action', 'Action2', 'Action3', 'Action4'].map(p => `<option${p === S.anim.priority ? ' selected' : ''}>${p}</option>`).join('')}</select></div>
    <div class="line"><select data-evname>${['Footstep', 'Sound', 'VFX', 'Hit'].map(n => `<option>${n}</option>`).join('')}</select><button class="btn" data-act="addEv">${t('insp.addEvent', { t: S.t.toFixed(2) })}</button></div>
    ${S.anim.events.map((e, i) => `<div class="line num"><span>${e.t.toFixed(2)} s</span><b>${esc(e.name)}</b><span class="muted">${esc(e.value)}</span><button class="btn icon quiet" data-act="delEv" data-i="${i}" title="${t('actions.delete')}">${icon('trash')}</button></div>`).join('')}</div>`;
  html += `<div class="savebar${S.dirty ? '' : ' hidden'}"><span class="grow">${t('insp.unsaved')}</span><button class="btn" data-act="discard">${t('insp.discard')}</button><button class="btn primary" data-act="save">${t('insp.save')}</button></div>`;
  el.innerHTML = html;
}
function changed({ structure = false } = {}) {
  S.tracks = buildTracks(S.anim);
  S.dirty = true;
  $('#inspector .savebar', root)?.classList.remove('hidden');
  if (structure) { renderLower(); renderInspector(); renderClipbar(); }
}
async function save() {
  if (!S.clip) return;
  setClip(await api(`/api/clips/${S.clip.id}/save`, { method: 'POST', body: { anim: S.anim } }), { keepTime: true });
  toast(t('done.saved'));
}
function selectPart(part) {
  S.part = part;
  viewer.rig.highlight(part);
  for (const row of $$('.dope [data-row]', root)) row.classList.toggle('sel', row.dataset.row === part);
  markKeys();
  renderInspector();
}

// ---------- Events ----------
function wire() {
  $('#engProvider', root).addEventListener('change', fillModels);
  $('#engModel', root).addEventListener('change', fillEfforts);
  $('#engEffort', root).addEventListener('change', e => prefs.set(`effort.${$('#engProvider', root).value}`, e.target.value));
  $('#engCustom', root).addEventListener('change', e => prefs.set(`custom.${$('#engProvider', root).value}`, e.target.value.trim()));
  $('#review', root).checked = prefs.get('review', true);
  $('#sendBtn', root).addEventListener('click', () => generate('chat'));
  $('#improveBtn', root).addEventListener('click', () => generate('improve'));
  $('#prompt', root).addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); generate('chat'); } });
  $('#thread', root).addEventListener('click', async e => {
    const preset = e.target.closest('[data-preset]');
    if (preset) { $('#prompt', root).value = preset.dataset.preset; $('#prompt', root).focus(); return; }
    const restore = e.target.closest('[data-restore]');
    if (restore) restoreEntry(restore.dataset.restore);
  });
  $('#clipName', root).addEventListener('change', async e => {
    const name = e.target.value.trim();
    if (!name || !S.clip) return;
    S.clip = await api(`/api/clips/${S.clip.id}`, { method: 'PATCH', body: { name } });
    S.anim.name = S.clip.name;
    toast(t('done.renamed'));
  });
  $('#newBtn', root).addEventListener('click', async () => {
    if (S.dirty) await save();
    setClip(await api('/api/clips', { method: 'POST', body: { name: t('clip.untitled'), untitled: true } }));
    $('#prompt', root).focus();
  });
  $('#studioBtn', root).addEventListener('click', e => menu(e.currentTarget, [
    { value: 'push', label: t('actions.push'), hint: t('actions.pushHint'), icon: icon('studio') },
    { value: 'preview', label: t('actions.preview'), hint: t('actions.previewHint'), icon: icon('play') },
    { value: 'playtest', label: t('actions.playtest'), hint: t('actions.playtestHint'), icon: icon('play') },
    { value: 'pull', label: t('actions.pull'), hint: t('actions.pullHint'), icon: icon('download') },
  ], studioAction));
  $('#exportBtn', root).addEventListener('click', e => menu(e.currentTarget, [
    { value: 'rbxmx', label: t('actions.rbxmx'), icon: icon('download') },
    { value: 'luau', label: t('actions.luau'), icon: icon('copy') },
    { value: 'duplicate', label: t('actions.duplicate'), icon: icon('duplicate') },
  ], async v => {
    if (S.dirty) await save();
    if (v === 'rbxmx') location.href = `/api/export.rbxmx?ids=${S.clip.id}`;
    else if (v === 'luau') { await navigator.clipboard.writeText(await api(`/api/clips/${S.clip.id}/luau`)); toast(t('done.luau')); }
    else setClip(await api(`/api/clips/${S.clip.id}/duplicate`, { method: 'POST' }));
  }));
  $('#tPlay', root).addEventListener('click', () => { if (!S.playing && S.t >= dur() - 1e-6) S.t = 0; setPlaying(!S.playing); });
  $('#tStart', root).addEventListener('click', () => seek(0));
  $('#tEnd', root).addEventListener('click', () => seek(dur()));
  $('#tLoop', root).addEventListener('click', e => { S.loop = !S.loop; e.currentTarget.classList.toggle('on', S.loop); });
  $('#speed', root).addEventListener('change', e => { S.speed = Number(e.target.value); });
  $('#scrub', root).addEventListener('input', e => { scrubbing = true; seek((Number(e.target.value) / 1000) * dur()); });
  $('#scrub', root).addEventListener('change', () => { scrubbing = false; S.t = snap(S.t); renderInspector(); });
  document.addEventListener('keydown', e => {
    if (e.code !== 'Space' || $('#view-editor').classList.contains('hidden') || /INPUT|TEXTAREA|SELECT|BUTTON/.test(document.activeElement?.tagName)) return;
    e.preventDefault();
    $('#tPlay', root).click();
  });
  for (const b of $$('.subtabs [data-lower]', root)) b.addEventListener('click', () => { S.lower = b.dataset.lower; prefs.set('lower', S.lower); renderLower(); });
  const lower = $('#lowerBody', root);
  lower.addEventListener('click', e => {
    const key = e.target.closest('.key, .flag');
    if (key) { seek(Number(key.dataset.t)); if (key.dataset.part) selectPart(key.dataset.part); else renderInspector(); return; }
    const label = e.target.closest('.dope-label[data-part]');
    if (label) return selectPart(label.dataset.part);
    const restore = e.target.closest('[data-restore]');
    if (restore) return restoreEntry(restore.dataset.restore);
    const img = e.target.closest('.frames .sheet');
    if (img && sheetMeta) {
      const r = img.getBoundingClientRect();
      const i = Math.min(sheetMeta.times.length - 1, Math.floor(((e.clientX - r.left) / r.width) * sheetMeta.times.length));
      seek(sheetMeta.times[i]);
    }
  });
  lower.addEventListener('pointerdown', e => {
    const ruler = e.target.closest('#ruler');
    if (!ruler) return;
    const go = ev => { const r = ruler.getBoundingClientRect(); seek(snap(((ev.clientX - r.left) / r.width) * dur())); };
    go(e);
    const up = () => { removeEventListener('pointermove', go); removeEventListener('pointerup', up); renderInspector(); };
    addEventListener('pointermove', go);
    addEventListener('pointerup', up);
  });
  const insp = $('#inspector', root);
  insp.addEventListener('input', e => {
    const el = e.target;
    const kf = S.anim.keyframes[kfAt(S.t)];
    if (!el.dataset.k || !kf?.poses[S.part]) return;
    const [k, i] = el.dataset.k.split('.');
    const v = Number(el.value);
    if (!Number.isFinite(v)) return;
    kf.poses[S.part][k][Number(i)] = v;
    for (const twin of $$(`[data-k="${el.dataset.k}"]`, insp)) if (twin !== el) twin.value = String(v);
    changed();
  });
  insp.addEventListener('change', e => {
    const el = e.target;
    const ki = kfAt(S.t);
    const kf = S.anim.keyframes[ki];
    if (el.matches('[data-ease]') && kf?.poses[S.part]) { kf.poses[S.part].ease = el.value; changed(); }
    else if (el.matches('[data-air]') && kf) { if (el.checked) kf.contact = 'air'; else delete kf.contact; changed(); }
    else if (el.matches('[data-loop]')) { S.anim.loop = el.checked; changed({ structure: true }); }
    else if (el.matches('[data-prio]')) { S.anim.priority = el.value; changed(); }
    else if (el.matches('[data-kt]') && kf && ki > 0) {
      const nt = r3(snap(Number(el.value)));
      if (!(nt > 0) || S.anim.keyframes.some((k, i) => i !== ki && Math.abs(k.t - nt) < 0.0005)) { renderInspector(); return; }
      kf.t = nt;
      S.anim.keyframes.sort((a, b) => a.t - b.t);
      S.t = nt;
      changed({ structure: true });
    }
  });
  insp.addEventListener('click', async e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    const ki = kfAt(S.t);
    if (act === 'addPose') {
      const tt = r3(snap(S.t));
      let kf = S.anim.keyframes.find(k => Math.abs(k.t - tt) < 0.0005);
      const s = sampleTracks(S.tracks, tt)[S.part];
      if (!kf) { kf = { t: tt, poses: {} }; S.anim.keyframes.push(kf); S.anim.keyframes.sort((a, b) => a.t - b.t); }
      kf.poses[S.part] = { rot: s ? eulerDeg(s.R).map(v => Math.round(v * 10) / 10) : [0, 0, 0], pos: s ? s.p.map(r3) : [0, 0, 0], ease: 'InOut' };
      S.t = tt;
      changed({ structure: true });
    } else if (act === 'delPose') { delete S.anim.keyframes[ki].poses[S.part]; changed({ structure: true }); }
    else if (act === 'delKf' && ki > 0 && S.anim.keyframes.length > 2) { S.anim.keyframes.splice(ki, 1); S.t = Math.min(S.t, dur()); changed({ structure: true }); }
    else if (act === 'addEv') { S.anim.events.push({ t: r3(snap(S.t)), name: $('[data-evname]', insp).value, value: '' }); S.anim.events.sort((a, b) => a.t - b.t); changed({ structure: true }); }
    else if (act === 'delEv') { S.anim.events.splice(Number(e.target.closest('[data-i]').dataset.i), 1); changed({ structure: true }); }
    else if (act === 'save') await save().catch(err => toast(err.message, true));
    else if (act === 'discard') setClip(S.clip, { keepTime: true });
  });
}
async function restoreEntry(entry) {
  if (S.dirty) return toast(t('err.saveFirst'), true);
  if (S.job) return toast(t('err.busy'), true);
  setClip(await api(`/api/clips/${S.clip.id}/restore`, { method: 'POST', body: { entry: Number(entry) } }), { keepTime: true });
  toast(t('done.restored'));
  setPlaying(true);
}
export const current = () => S.clip?.id;
export { show };
