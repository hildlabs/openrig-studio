// Reference input for the director chat: an image, GIF or video is turned into a few still
// frames here in the browser; the server hands them to the model as images.
import { $, esc, toast } from './api.js';
import { t } from './i18n.js';
import { frameTimes, frameIndices, fitSize, MAX_FRAMES, DEFAULT_FRAMES, MAX_EDGE, MAX_FRAME_BYTES } from '/core/reference.js';

const MAX_FILE = 500e6; // bigger files are rejected instead of freezing the tab

let frames = [];   // data URLs, in time order
let source = null; // the last attached file, so changing the frame count can re-extract
let wanted = DEFAULT_FRAMES;
let onChange = () => {};

export const references = () => frames.slice();
export const clearReferences = () => { frames = []; source = null; onChange(); };

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

async function fromImage(file, n) {
  if (file.type === 'image/gif' && 'ImageDecoder' in window) {
    try {
      const decoder = new ImageDecoder({ data: file.stream(), type: 'image/gif' });
      await decoder.tracks.ready;
      const count = decoder.tracks.selectedTrack.frameCount;
      const out = [];
      for (const frameIndex of frameIndices(count, n)) {
        const { image } = await decoder.decode({ frameIndex });
        out.push(toDataUrl(image, image.displayWidth, image.displayHeight));
        image.close();
      }
      decoder.close();
      if (out.length) return { frames: out, still: count < 2 };
    } catch { /* fall back to the first frame below */ }
  }
  const bitmap = await createImageBitmap(file);
  const url = toDataUrl(bitmap, bitmap.width, bitmap.height);
  bitmap.close();
  return { frames: [url], still: true, gif: file.type === 'image/gif' };
}

async function fromVideo(file, n) {
  const video = document.createElement('video');
  const objectUrl = URL.createObjectURL(file);
  video.muted = true; video.preload = 'auto'; video.playsInline = true; video.src = objectUrl;
  const once = (event) => new Promise((resolve, reject) => {
    video.addEventListener(event, resolve, { once: true });
    video.addEventListener('error', () => reject(new Error(t('ref.unreadable'))), { once: true });
  });
  try {
    await once('loadedmetadata');
    if (!video.videoWidth) throw new Error(t('ref.unreadable'));
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const out = [];
    for (const time of frameTimes(duration, n)) {
      const seeked = once('seeked');
      video.currentTime = Math.min(time, Math.max(0, duration - 0.05));
      await seeked;
      out.push(toDataUrl(video, video.videoWidth, video.videoHeight));
    }
    return { frames: out, still: false };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function attach(file, n = wanted) {
  if (!file) return;
  if (file.size > MAX_FILE) return toast(t('ref.tooBig'), true);
  const isVideo = file.type.startsWith('video/'), isImage = file.type.startsWith('image/');
  if (!isVideo && !isImage) return toast(t('ref.type'), true);
  setStatus(t('ref.reading'));
  try {
    const r = isVideo ? await fromVideo(file, n) : await fromImage(file, n);
    frames = r.frames.slice(0, MAX_FRAMES);
    source = file;
    if (r.gif) toast(t('ref.gifStill'));
    onChange();
  } catch (e) {
    toast(e.message || t('ref.unreadable'), true);
    onChange();
  }
}

function setStatus(text) { const el = $('#refStatus'); if (el) el.textContent = text; }

// Wires the attach button, the file picker, drag and drop on the composer, and pasting.
export function mountReferences(root) {
  const box = $('#refs', root), input = $('#refFile', root);
  const render = () => {
    box.classList.toggle('hidden', !frames.length);
    box.innerHTML = frames.length
      ? `<div class="thumbs">${frames.map((f, i) => `<img src="${f}" alt="${esc(t('ref.frame', { n: i + 1 }))}" title="${esc(t('ref.frame', { n: i + 1 }))}">`).join('')}</div>
         <div class="refbar"><span id="refStatus">${esc(t(frames.length === 1 ? 'ref.count.one' : 'ref.count', { n: frames.length }))}</span>
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
