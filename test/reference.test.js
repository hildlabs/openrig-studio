// Reference frames: sampling helpers, server-side validation, and how they reach the model.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { frameTimes, frameIndices, fitSize, referenceNote, MAX_FRAMES, MAX_FRAME_BYTES } from '../src/core/reference.js';
import { parseReferences } from '../src/server/references.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);
const url = (buf, type = 'image/jpeg') => `data:${type};base64,${buf.toString('base64')}`;

test('frame times are spread evenly over a video, away from its first and last instant', () => {
  assert.deepEqual(frameTimes(4, 4), [0.5, 1.5, 2.5, 3.5]);
  assert.deepEqual(frameTimes(0, 4), [0]);
  assert.deepEqual(frameTimes(NaN, 4), [0]);
  assert.equal(frameTimes(10, 99).length, MAX_FRAMES);
  assert.equal(frameTimes(10, 0).length, 6, 'no count falls back to the default');
  assert.ok(frameTimes(2, 6).every(t => t > 0 && t < 2));
});

test('GIF frames are picked evenly, and short GIFs give all their frames', () => {
  assert.deepEqual(frameIndices(3, 6), [0, 1, 2]);
  assert.deepEqual(frameIndices(1, 6), [0]);
  assert.deepEqual(frameIndices(0, 6), []);
  assert.deepEqual(frameIndices(8, 4), [1, 3, 5, 7]);
  const many = frameIndices(1000, 6);
  assert.equal(many.length, 6);
  assert.ok(many.every((v, i) => v >= 0 && v < 1000 && (i === 0 || v > many[i - 1])));
});

test('frames are scaled down to fit, never up', () => {
  assert.deepEqual(fitSize(1920, 1080, 768), { width: 768, height: 432 });
  assert.deepEqual(fitSize(100, 50, 768), { width: 100, height: 50 });
  assert.deepEqual(fitSize(5000, 1, 768), { width: 768, height: 1 });
});

test('the note tells the model what the frames are and that they are not motion capture', () => {
  assert.match(referenceNote(4), /4 images are attached \(reference-1 to reference-4\)/);
  assert.match(referenceNote(1), /1 image is attached \(reference-1\)/);
  assert.match(referenceNote(4), /not motion capture/);
});

test('data URLs become named images; the type comes from the bytes', () => {
  const out = parseReferences([url(JPG), url(PNG, 'image/jpeg'), url(WEBP, 'image/webp')]);
  assert.deepEqual(out.map(o => [o.name, o.mime]), [['reference-1.jpg', 'image/jpeg'], ['reference-2.png', 'image/png'], ['reference-3.webp', 'image/webp']]);
  assert.ok(out[0].data.equals(JPG));
  assert.deepEqual(parseReferences(undefined), []);
  assert.deepEqual(parseReferences([]), []);
});

test('bad reference frames are rejected with a 400', () => {
  const fails = (v, re) => assert.throws(() => parseReferences(v), e => re.test(e.message) && e.status === 400);
  fails('x', /must be a list/);
  fails(Array(MAX_FRAMES + 1).fill(url(JPG)), /At most 8/);
  fails(['hello'], /Reference frame 1 is not an image/);
  fails([url(JPG), 42], /Reference frame 2 is not an image/);
  fails(['data:text/html;base64,PGI+'], /not an image/);
  fails([url(Buffer.from('<svg onload=alert(1)>'), 'image/png')], /JPEG, PNG or WebP/);
  fails([url(Buffer.from('GIF89a....'), 'image/gif')], /JPEG, PNG or WebP/);
  fails([url(Buffer.concat([JPG, Buffer.alloc(MAX_FRAME_BYTES)]))], /too large/);
});

// ---- Through the real pipeline, against a fake OpenAI-compatible server ----
const wave = JSON.parse(readFileSync(new URL('../examples/wave.json', import.meta.url), 'utf8')).anim;
const answer = '```json\n' + JSON.stringify(wave) + '\n```';
let server, dir, requests = [], lib, gen, settings;

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      requests.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  dir = await mkdtemp(path.join(os.tmpdir(), 'openrig-ref-'));
  await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ compatBaseUrl: `http://127.0.0.1:${server.address().port}/v1`, compatModels: 'vision-model', compatImages: 'on' }));
  process.env.OPENRIG_DATA = dir; // read once, so set before the modules load
  lib = await import('../src/server/library.js');
  gen = await import('../src/server/generate.js');
  settings = await import('../src/server/settings.js');
});
after(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });

const engine = { provider: 'compatible', model: 'vision-model', effort: '' };
const frames = () => parseReferences([url(JPG), url(PNG, 'image/png')]);
const parts = req => req.messages[1].content;
const images = req => parts(req).filter(p => p.type === 'image_url').map(p => p.image_url.url.slice(0, 22));
const textOf = req => (typeof parts(req) === 'string' ? parts(req) : parts(req).find(p => p.type === 'text').text);

test('the draft request carries the frames and the note about them, and the review keeps them next to the contact sheet', async () => {
  requests = [];
  const system = await gen.systemPrompt('en');
  await gen.runPipeline({ clip: { chat: [] }, wish: 'A cartoon cat pounces.', mode: 'create', engine, system, review: true, references: frames() });
  assert.equal(requests.length, 2);
  assert.deepEqual(images(requests[0]), ['data:image/jpeg;base64', 'data:image/png;base64,']);
  assert.match(textOf(requests[0]), /## Reference frames\n2 images are attached/);
  assert.match(textOf(requests[0]), /## Request for a new animation\nA cartoon cat pounces\./);
  // Review: contact sheet first, then the references.
  assert.deepEqual(images(requests[1]), ['data:image/png;base64,', 'data:image/jpeg;base64', 'data:image/png;base64,']);
  assert.match(textOf(requests[1]), /attached after the contact sheet/);
});

test('without references the request is plain text and unchanged', async () => {
  requests = [];
  const system = await gen.systemPrompt('en');
  await gen.runPipeline({ clip: { chat: [] }, wish: 'A wave.', mode: 'create', engine, system, review: false });
  assert.equal(requests.length, 1);
  assert.equal(typeof parts(requests[0]), 'string');
  assert.doesNotMatch(parts(requests[0]), /Reference frames/);
});

test('a job with frames records how many in the chat and still produces a clip', async () => {
  requests = [];
  const clip = await lib.createClip('Pounce', '');
  const job = await gen.startJob({ id: clip.id, prompt: 'Like the video.', engine, mode: 'chat', review: false, lang: 'en', references: frames() });
  for (let i = 0; i < 200 && gen.getJob(job.id).status === 'running'; i++) await new Promise(r => setTimeout(r, 25));
  assert.equal(gen.getJob(job.id).status, 'done', gen.getJob(job.id).error);
  const saved = await lib.loadClip(clip.id);
  assert.equal(saved.chat[0].references, 2);
  assert.equal(JSON.stringify(saved).includes('base64'), false, 'the images themselves are not stored in the clip');
  assert.equal(images(requests[0]).length, 2);
});

test('frames for a model that cannot see images are refused before anything is sent', async () => {
  await settings.saveSettings({ compatImages: '' });
  requests = [];
  const clip = await lib.createClip('No eyes', '');
  await assert.rejects(gen.startJob({ id: clip.id, prompt: 'x', engine, mode: 'chat', lang: 'en', references: frames() }), e => /cannot see images/.test(e.message) && e.status === 400);
  assert.equal(requests.length, 0);
  assert.equal((await lib.loadClip(clip.id)).chat.length, 0, 'no half-recorded request');
  assert.equal(gen.isBusy(clip.id), false);
  // Text-only requests still work.
  const job = await gen.startJob({ id: clip.id, prompt: 'A wave.', engine, mode: 'chat', review: false, lang: 'en', references: [] });
  for (let i = 0; i < 200 && gen.getJob(job.id).status === 'running'; i++) await new Promise(r => setTimeout(r, 25));
  assert.equal(gen.getJob(job.id).status, 'done');
  await settings.saveSettings({ compatImages: 'on' });
});
