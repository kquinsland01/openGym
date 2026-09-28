import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';
const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'a'.repeat(64);
function start(t, rawDb, rawState) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-storage-'));
  fs.writeFileSync(path.join(dir, 'secret'), SECRET);
  if (rawDb !== undefined) fs.writeFileSync(path.join(dir, 'db.json'), rawDb);
  if (rawState !== undefined) fs.writeFileSync(path.join(dir, 'state-user.json'), rawState);
  const child = spawn(process.execPath, ['server.js'], { cwd: API, env: { ...process.env, DATA_DIR: dir, PORT: '0', ORIGIN: 'http://localhost:8080' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => log += d);
  child.stderr.on('data', d => log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, ready: boundPort(child, () => log) };
}
const validDb = JSON.stringify({ users: [{ id: 'user', name: 'User' }], creds: [] });
for (const raw of ['{', 'null', '[]', '{}', '{"users":42,"creds":[]}']) test(`database ${raw} prevents startup and remains intact`, async t => {
  const h = start(t, raw);
  await assert.rejects(h.ready, /Storage integrity failure/);
  assert.equal(fs.readFileSync(path.join(h.dir, 'db.json'), 'utf8'), raw);
});
test('an invalid profile prevents startup', async t => {
  const h = start(t, validDb, '[]');
  await assert.rejects(h.ready, /profile must be an object/);
  assert.equal(fs.readFileSync(path.join(h.dir, 'state-user.json'), 'utf8'), '[]');
});
test('a genuinely new database still starts', async t => {
  const h = start(t);
  assert.ok(await h.ready);
});
test('corruption after startup refuses reads, revision polling and replacement without modifying data', async t => {
  const h = start(t, validDb);
  const port = await h.ready;
  const payload = `user:${Date.now() + 86400000}:0`;
  const cookie = payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  const headers = { Cookie: `gymsid=${cookie}`, Origin: 'http://localhost:8080', 'Content-Type': 'application/json' };
  const file = path.join(h.dir, 'state-user.json');
  assert.equal((await fetch(`http://localhost:${port}/api/data`, { headers }).then(r => r.json())).state, null);
  for (const raw of ['{', 'null', '[]', '{"workouts":{}}']) {
    fs.writeFileSync(file, raw);
    for (const endpoint of ['/api/data', '/api/data/rev']) assert.equal((await fetch(`http://localhost:${port}${endpoint}`, { headers })).status, 500);
    assert.equal((await fetch(`http://localhost:${port}/api/data`, { method: 'PUT', headers, body: JSON.stringify({ state: { workouts: [] } }) })).status, 500);
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
  }
  fs.writeFileSync(file, JSON.stringify({ workouts: [], _rev: 7 }));
  assert.equal((await fetch(`http://localhost:${port}/api/data/rev`, { headers }).then(r => r.json())).rev, 7);
});
