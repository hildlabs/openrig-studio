// HOST=0.0.0.0: other devices need the access token, this computer doesn't (src/server/main.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server', 'main.js');
const lan = Object.values(os.networkInterfaces()).flat().find(a => a?.family === 'IPv4' && !a.internal)?.address;
let server, data, port;

before(async () => {
  if (!lan) return;
  data = await mkdtemp(path.join(os.tmpdir(), 'openrig-token-'));
  port = 20000 + Math.floor(Math.random() * 20000);
  server = spawn(process.execPath, [MAIN], { env: { ...process.env, PORT: String(port), HOST: '0.0.0.0', OPENRIG_DATA: data, OPENRIG_TOKEN: 'test-token' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', d => { if (String(d).includes('is running')) resolve(); });
    server.once('exit', code => reject(new Error(`server exited with ${code}`)));
  });
});
after(async () => {
  server?.kill();
  if (data) await rm(data, { recursive: true, force: true });
});

test('another device needs the token link once, this computer never', { skip: !lan && 'no network interface' }, async () => {
  const get = (host, route, headers = {}) => fetch(`http://${host}:${port}${route}`, { headers, redirect: 'manual' });
  assert.equal((await get(lan, '/api/clips')).status, 401);
  assert.equal((await get(lan, '/')).status, 401);
  assert.equal((await get(lan, '/api/clips', { Cookie: 'openrig_token=wrong' })).status, 401);
  const link = await get(lan, '/?token=test-token');
  assert.equal(link.status, 303);
  const cookie = link.headers.get('set-cookie').split(';')[0];
  assert.equal(cookie, 'openrig_token=test-token');
  assert.equal((await get(lan, '/api/clips', { Cookie: cookie })).status, 200);
  assert.equal((await get('127.0.0.1', '/api/clips')).status, 200);
});
