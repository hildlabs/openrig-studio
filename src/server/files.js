// Writing files safely. A file is written to a temp file and renamed over the old one, so a
// crash never leaves half a file. On Windows the rename fails with EPERM, EACCES or EBUSY while
// another request is reading the file (the editor polls a clip during generation), so it is
// retried for up to about two seconds.
import path from 'node:path';
import { mkdir, writeFile, rename } from 'node:fs/promises';

const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);
export async function moveFile(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return await rename(from, to); }
    catch (e) {
      if (!BUSY.has(e.code) || attempt >= 20) throw e;
      await new Promise(r => setTimeout(r, 10 + attempt * 10));
    }
  }
}
export async function writeJson(file, data, indent = 1) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file + '.tmp', JSON.stringify(data, null, indent), 'utf8');
  await moveFile(file + '.tmp', file);
}
