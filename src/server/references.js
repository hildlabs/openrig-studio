// Reference frames sent by the browser (extracted from an image, GIF or video there):
// validated here, then handed to the model as images.
import { MAX_FRAMES, MAX_FRAME_BYTES, MIME_EXT } from '../core/reference.js';

const bad = message => Object.assign(new Error(message), { status: 400 });

function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// list: array of data URLs ("data:image/jpeg;base64,…"). Returns [{ name, mime, data }].
// The type comes from the bytes, not from what the browser claims.
export function parseReferences(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw bad('Reference frames must be a list.');
  if (list.length > MAX_FRAMES) throw bad(`At most ${MAX_FRAMES} reference frames.`);
  return list.map((item, i) => {
    const m = /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/]+={0,2})$/.exec(typeof item === 'string' ? item : '');
    if (!m) throw bad(`Reference frame ${i + 1} is not an image.`);
    const data = Buffer.from(m[1], 'base64');
    if (data.length > MAX_FRAME_BYTES) throw bad(`Reference frame ${i + 1} is too large.`);
    const mime = sniff(data);
    if (!mime) throw bad(`Reference frame ${i + 1} must be a JPEG, PNG or WebP image.`);
    return { name: `reference-${i + 1}.${MIME_EXT[mime]}`, mime, data };
  });
}
