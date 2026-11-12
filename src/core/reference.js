// Reference frames: pure helpers shared by the browser (which extracts the frames) and the
// server (which checks them). No DOM, no Node APIs.

export const MAX_FRAMES = 8;
export const DEFAULT_FRAMES = 6;
export const MAX_EDGE = 768;          // longest side of a frame, in pixels
export const MAX_FRAME_BYTES = 1.5e6; // per frame, after encoding
export const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

// n sample times spread evenly over a clip of the given duration, each in the middle of its
// slice so the first and last frame are neither black fade-ins nor the end-of-file frame.
export function frameTimes(duration, n) {
  n = Math.max(1, Math.min(MAX_FRAMES, Math.round(Number(n) || DEFAULT_FRAMES)));
  if (!(duration > 0) || !Number.isFinite(duration)) return [0];
  return Array.from({ length: n }, (_, i) => +(duration * (i + 0.5) / n).toFixed(3));
}

// n indices out of `count` decoded frames (animated GIFs), evenly spread.
export function frameIndices(count, n) {
  n = Math.max(1, Math.min(MAX_FRAMES, Math.round(Number(n) || DEFAULT_FRAMES)));
  if (count <= n) return Array.from({ length: Math.max(count, 0) }, (_, i) => i);
  return Array.from({ length: n }, (_, i) => Math.min(count - 1, Math.floor(count * (i + 0.5) / n)));
}

// Size that fits width × height inside max × max, keeping the aspect ratio, never upscaling.
export function fitSize(w, h, max = MAX_EDGE) {
  const k = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

// What the model is told about the attached frames.
export function referenceNote(count) {
  return `## Reference frames\n${count} image${count === 1 ? ' is' : 's are'} attached (${count === 1 ? 'reference-1' : `reference-1 to reference-${count}`}), in time order, sampled evenly from a picture, GIF or video the user supplied. ${count === 1 ? 'It is a single pose.' : 'They show the motion over time: the first is the beginning, the last the end.'} Use them as a guide for poses, timing and rhythm. This is not motion capture: do not copy pixel positions, but turn what the character does into a clean animation for this rig that follows the style rules. The written request below takes priority where it differs from the images.`;
}

// ---------- Extraction (the browser objects are passed in, so this runs in Node tests too) ----------

const fail = (code, message) => Object.assign(new Error(message), { code });

// Resolves on the first `event`; rejects on 'error' or after ms, so a media element that never
// answers can't hang the extraction.
export function waitEvent(target, event, ms = 10000) {
  return new Promise((resolve, reject) => {
    let timer;
    const done = (fn, arg) => { clearTimeout(timer); target.removeEventListener(event, onEvent); target.removeEventListener('error', onError); fn(arg); };
    const onEvent = () => done(resolve);
    const onError = () => done(reject, fail('media', 'The media could not be read.'));
    target.addEventListener(event, onEvent);
    target.addEventListener('error', onError);
    timer = setTimeout(() => done(reject, fail('timeout', 'The media did not answer in time.')), ms);
  });
}

// n stills from a loaded <video>-like element. draw(source, width, height) → data URL.
// current() turns false when this extraction was replaced; it then stops early (returns null).
export async function videoFrames(video, { n, draw, current = () => true, timeoutMs = 10000 }) {
  if (video.readyState < 1) await waitEvent(video, 'loadedmetadata', timeoutMs);
  if (!video.videoWidth) throw fail('media', 'The video has no picture.');
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const out = [];
  for (const time of frameTimes(duration, n)) {
    if (!current()) return null;
    const target = duration > 0 ? Math.min(time, Math.max(0, duration - 0.05)) : 0;
    // Seeking to where the video already is fires no `seeked` event: use the frame it shows.
    if (Math.abs(video.currentTime - target) < 0.001 && video.readyState >= 2) { /* already there */ }
    else {
      const seeked = waitEvent(video, 'seeked', timeoutMs);
      seeked.catch(() => {}); // reported by the await below, not as an unhandled rejection
      video.currentTime = target;
      await seeked;
    }
    if (video.readyState < 2) await waitEvent(video, 'loadeddata', timeoutMs);
    out.push(draw(video, video.videoWidth, video.videoHeight));
  }
  return current() ? out : null;
}

// n stills from a WebCodecs ImageDecoder on an animated GIF. With a streamed source the frame
// count is only final once `completed` resolves; counting earlier would offer just the first
// frames as if they were the whole motion.
export async function gifFrames(decoder, { n, draw, current = () => true }) {
  await decoder.tracks.ready;
  await decoder.completed;
  const count = decoder.tracks.selectedTrack.frameCount;
  const out = [];
  for (const frameIndex of frameIndices(count, n)) {
    if (!current()) return null;
    const { image } = await decoder.decode({ frameIndex });
    try { out.push(draw(image, image.displayWidth, image.displayHeight)); } finally { image.close(); }
  }
  return current() ? { frames: out, count } : null;
}

// Hands out a number per started operation; only the latest one may still publish its result.
export function createGate() {
  let id = 0;
  return { start: () => ++id, cancel: () => { id++; }, isCurrent: mine => mine === id };
}
