// Builds the browser-only live demo into demo-dist/ (published to GitHub Pages).
// It is the real web app with two changes: api() answers from demo/api.js instead of the
// server, and absolute paths become relative so the app works under /openrig-studio/.
// Every rewrite must match, so a change in web/ that breaks the demo fails the build.
// Usage: npm run build-demo
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, readdir, mkdir, rm, cp } from 'node:fs/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'demo-dist');
const CORE = ['rig.js', 'anim.js', 'ik.js', 'messages.js', 'render.js'];

await rm(OUT, { recursive: true, force: true });
await mkdir(path.join(OUT, 'core'), { recursive: true });
await cp(path.join(ROOT, 'web'), OUT, { recursive: true });
for (const f of CORE) await cp(path.join(ROOT, 'src', 'core', f), path.join(OUT, 'core', f));
await cp(path.join(ROOT, 'demo', 'api.js'), path.join(OUT, 'demo.js'));

async function edit(file, pairs) {
  const p = path.join(OUT, file);
  let s = await readFile(p, 'utf8');
  for (const [from, to] of pairs) {
    const next = typeof from === 'string' ? s.split(from).join(to) : s.replace(from, to);
    if (next === s) throw new Error(`build-demo: nothing to replace in ${file}: ${from}`);
    s = next;
  }
  await writeFile(p, s);
}

// Paths relative to the page.
await edit('index.html', [['href="/style.css"', 'href="style.css"'], ['src="/app.js"', 'src="app.js"'], ['<title>OpenRig Studio</title>', '<title>OpenRig Studio · Live demo</title>']]);
await edit('style.css', [['url(/fonts/', 'url(fonts/']]);
for (const f of (await readdir(path.join(OUT))).filter(f => f.endsWith('.js'))) {
  const s = await readFile(path.join(OUT, f), 'utf8');
  if (s.includes("from '/core/")) await edit(f, [["from '/core/", "from './core/"]]);
}
// The software renderer hands its pixels to demo.js instead of encoding a PNG with node:zlib.
await edit('core/render.js', [["import { deflateSync } from 'node:zlib';\n", ''], ['return { png: cv.png(), times, cell, views };', 'return { png: cv, times, cell, views };']]);
// API calls, images and downloads go to demo.js.
await edit('api.js', [
  ["import { t } from './i18n.js';", "import { t } from './i18n.js';\nimport { demoApi } from './demo.js';"],
  ["export async function api(url, { method = 'GET', body } = {}) {", "export async function api(url, { method = 'GET', body } = {}) {\n  return demoApi(url, { method, body: body && JSON.parse(JSON.stringify(body)) });"],
]);
const img = [/src="(\/api\/clips\/[^"]*)"/g, 'src="${window.__demoImage(`$1`)}"'];
await edit('library.js', [img, [/location\.href = (`\/api\/export\.rbxmx[^`]*`)/, 'window.__demoDownload($1)']]);
await edit('editor.js', [img, [/location\.href = (`\/api\/export\.rbxmx[^`]*`)/, 'window.__demoDownload($1)'],
  // The first clip starts playing, so the demo opens in motion.
  ['  setClip(await api(`/api/clips/${id}`));\n}', '  setClip(await api(`/api/clips/${id}`));\n  if (!window.__demoPlayed) { window.__demoPlayed = true; setPlaying(true); }\n}']]);
await edit('compare.js', [img]);

// Example clips and presets as modules, so the demo needs no fetches.
const examples = [];
for (const f of (await readdir(path.join(ROOT, 'examples'))).filter(f => f.endsWith('.json')).sort()) examples.push(JSON.parse(await readFile(path.join(ROOT, 'examples', f), 'utf8')));
await writeFile(path.join(OUT, 'demo-data.js'), `export default ${JSON.stringify(examples)};\n`);
await writeFile(path.join(OUT, 'demo-presets.js'), `export default ${await readFile(path.join(ROOT, 'prompts', 'presets.json'), 'utf8')};\n`);

// Banner row above the top bar.
const css = await readFile(path.join(OUT, 'style.css'), 'utf8');
await writeFile(path.join(OUT, 'style.css'), `${css}
/* live demo */
body { grid-template-rows: auto 48px 1fr; }
.demo-banner { display: flex; align-items: center; gap: 14px; padding: 7px 14px; background: var(--action); color: #fff; font: 500 13px/1.3 var(--ui); }
.demo-banner span { flex: 1; }
.demo-banner a { color: #fff; font-weight: 600; text-decoration: none; white-space: nowrap; }
.demo-banner a:hover { text-decoration: underline; }
.demo-banner button { font: inherit; color: #fff; background: transparent; border: 1px solid rgba(255,255,255,.55); border-radius: var(--r-sm); padding: 3px 10px; cursor: pointer; white-space: nowrap; }
.demo-banner button:hover { background: rgba(255,255,255,.14); }
`);
await writeFile(path.join(OUT, '.nojekyll'), '');
console.log(`Demo built in ${path.relative(ROOT, OUT)}/ (${examples.length} example clips).`);
