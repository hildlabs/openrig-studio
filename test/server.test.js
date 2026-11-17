// The HTTP layer of src/server/main.js, against a real server on a free port with its own data folder.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server', 'main.js');
let server, data, port;

before(async () => {
  data = await mkdtemp(path.join(os.tmpdir(), 'openrig-server-'));
  port = 20000 + Math.floor(Math.random() * 20000);
  server = spawn(process.execPath, [MAIN], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', OPENRIG_DATA: data }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', d => { if (String(d).includes('is running')) resolve(); });
    server.once('exit', code => reject(new Error(`server exited with ${code}`)));
  });
});
after(async () => {
  server.kill();
  await rm(data, { recursive: true, force: true });
});

function call(method, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: { 'Content-Type': 'application/json', Host: `localhost:${port}` } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', d => { text += d; });
      res.on('end', () => resolve(JSON.parse(text)));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

// Sends the body in the given pieces, so a test can split a character between two chunks.
function post(route, pieces) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', headers: { 'Content-Type': 'application/json', Host: `localhost:${port}` } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    (async () => {
      for (const p of pieces) { req.write(p); await new Promise(r => setTimeout(r, 20)); }
      req.end();
    })();
  });
}

test('a character split between two request chunks arrives intact', async () => {
  const bytes = Buffer.from(JSON.stringify({ name: 'Grüße' }), 'utf8');
  const cut = bytes.indexOf(Buffer.from('ü')) + 1; // inside the two bytes of ü
  const res = await post('/api/clips', [bytes.subarray(0, cut), bytes.subarray(cut)]);
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Grüße');
});

test('broken JSON is answered with 400, not a server error', async () => {
  const res = await post('/api/clips', ['{"name": ']);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /not valid JSON/);
});

test('the library list follows every change right away', async () => {
  const clip = await post('/api/clips', [JSON.stringify({ name: 'List check' })]);
  const find = async () => (await call('GET', '/api/clips')).clips.find(c => c.id === clip.body.id);
  assert.equal((await find()).name, 'List check');
  // Quick changes of the same length, so neither the size nor (often) the time of the file differs.
  for (const name of ['List chek', 'List chec', 'List check']) {
    await call('PATCH', `/api/clips/${clip.body.id}`, { name });
    assert.equal((await find()).name, name);
  }
  await call('PATCH', `/api/clips/${clip.body.id}`, { starred: true });
  assert.equal((await find()).starred, true);
  await call('DELETE', `/api/clips/${clip.body.id}`);
  assert.equal(await find(), undefined);
});
