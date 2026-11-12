// Reference input for the director chat: an image, GIF or video is turned into a few still
// frames here in the browser; the server hands them to the model as images.
import { $, esc, toast } from './api.js';
import { t } from './i18n.js';
import { fitSize, videoFrames, gifFrames, createGate, MAX_FRAMES, DEFAULT_FRAMES, MAX_EDGE, MAX_FRAME_BYTES } from '/core/reference.js';

const MAX_FILE = 500e6; // bigger files are rejected instead of freezing the tab

let frames = [];   // data URLs, in time order
let source = null; // the last attached file, so changing the frame count can re-extract
let wanted = DEFAULT_FRAMES;
let reading = false; // an extraction is running
const gate = createGate();
let onChange = () => {};

export const references = () => frames.slice();
export const isReading = () => reading;
// Removes the frames and drops any extraction still running.
export const clearReferences = () => { gate.cancel(); reading = false; frames = []; source = null; onChange(); };
// The frames for a request, removed from the composer right away; putBack() returns them if the request fails.
export const takeReferences = () => { const taken = frames; clearReferences(); return taken; };
export const putBack = taken => { if (taken.length && !frames.length && !reading) { frames = taken; onChange(); } };

function toDataUrl(drawable, w, h) {
  const { width, height } = fitSize(w, h, MAX_EDGE);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // transparent GIF/PNG areas would turn black in a JPEG
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(drawable, 0, 0, width, height);
  // Quality steps down only for unusually detailed frames.
  for (const q of [0.85, 0.7, 0.5]) {
    const url = canvas.toDataURL('image/jpeg', q);
    if (url.length * 0.75 <= MAX_FRAME_BYTES) return url;
  }
  throw new Error(t('ref.tooLarge'));
}

async function fromImage(file, n, current) {
  if (file.type === 'image/gif' && 'ImageDecoder' in window) {
    let decoder;
    try {
      decoder = new ImageDecoder({ data: file.stream(), type: 'image/gif' });
      const r = await gifFrames(decoder, { n, draw: toDataUrl, current });
      if (!r) return null;
      if (r.frames.length) return { frames: r.frames };
    } catch { if (!current()) return null; /* otherwise fall back to the first frame below */ }
    finally { decoder?.close(); }
  }
  const bitmap = await createImageBitmap(file);
  try { return { frames: [toDataUrl(bitmap, bitmap.width, bitmap.height)], gif: file.type === 'image/gif' }; }
  finally { bitmap.close(); }
}

async function fromVideo(file, n, current) {
  const video = document.createElement('video');
  const objectUrl = URL.createObjectURL(file);
  video.muted = true; video.preload = 'auto'; video.playsInline = true; video.src = objectUrl;
  try {
    const out = await videoFrames(video, { n, draw: toDataUrl, current });
    return out && { frames: out };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}

const readError = e => (e.code === 'timeout' || e.code === 'media' ? t('ref.unreadable') : e.message || t('ref.unreadable'));

// Every attach and every removal is a new operation; a slower, older extraction never
// overwrites a newer one or brings back frames the user removed.
export async function attach(file, n = wanted) {
  if (!file) return;
  if (file.size > MAX_FILE) return toast(t('ref.tooBig'), true);
  const isVideo = file.type.startsWith('video/'), isImage = file.type.startsWith('image/');
  if (!isVideo && !isImage) return toast(t('ref.type'), true);
  const mine = gate.start();
  const current = () => gate.isCurrent(mine);
  reading = true;
  onChange();
  try {
    const r = await (isVideo ? fromVideo(file, n, current) : fromImage(file, n, current));
    if (!current()) return;
    if (r) {
      frames = r.frames.slice(0, MAX_FRAMES);
      source = file;
      if (r.gif) toast(t('ref.gifStill'));
    }
  } catch (e) {
    if (current()) toast(readError(e), true);
  } finally {
    if (current()) { reading = false; onChange(); }
  }
}

// Wires the attach button, the file picker, drag and drop on the composer, and pasting.
export function mountReferences(root) {
  const box = $('#refs', root), input = $('#refFile', root);
  const render = () => {
    box.classList.toggle('hidden', !frames.length && !reading);
    box.innerHTML = !frames.length && reading ? `<div class="refbar"><span class="spinner"></span><span>${esc(t('ref.reading'))}</span><button class="link" id="refClear" type="button">${esc(t('ref.remove'))}</button></div>` : frames.length
      ? `<div class="thumbs">${frames.map((f, i) => `<img src="${f}" alt="${esc(t('ref.frame', { n: i + 1 }))}" title="${esc(t('ref.frame', { n: i + 1 }))}">`).join('')}</div>
         <div class="refbar"><span id="refStatus">${esc(reading ? t('ref.reading') : t(frames.length === 1 ? 'ref.count.one' : 'ref.count', { n: frames.length }))}</span>
         ${source && (frames.length > 1 || source.type.startsWith('video/')) ? `<label>${esc(t('ref.frames'))}<select id="refCount">${Array.from({ length: MAX_FRAMES - 1 }, (_, i) => i + 2).map(n => `<option${n === wanted ? ' selected' : ''}>${n}</option>`).join('')}</select></label>` : ''}
         <button class="link" id="refClear" type="button">${esc(t('ref.remove'))}</button></div>`
      : '';
  };
  onChange = render;
  $('#refBtn', root).addEventListener('click', () => input.click());
  input.addEventListener('change', () => { const f = input.files[0]; input.value = ''; attach(f); });
  box.addEventListener('click', e => { if (e.target.closest('#refClear')) clearReferences(); });
  box.addEventListener('change', e => {
    if (e.target.id !== 'refCount') return;
    wanted = Number(e.target.value);
    if (source) attach(source, wanted);
  });
  const composer = $('.composer', root);
  composer.addEventListener('dragover', e => { if ([...(e.dataTransfer?.types ?? [])].includes('Files')) { e.preventDefault(); composer.classList.add('drop'); } });
  composer.addEventListener('dragleave', () => composer.classList.remove('drop'));
  composer.addEventListener('drop', e => { composer.classList.remove('drop'); const f = e.dataTransfer?.files?.[0]; if (f) { e.preventDefault(); attach(f); } });
  $('#prompt', root).addEventListener('paste', e => {
    const f = [...(e.clipboardData?.files ?? [])].find(x => x.type.startsWith('image/') || x.type.startsWith('video/'));
    if (f) { e.preventDefault(); attach(f); }
  });
  render();
}
