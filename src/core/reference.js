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
