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
const secret = 'a'.repeat(64);
test('API readiness fails on a real state save fault while liveness stays healthy, then recovers', { skip: process.getuid?.() === 0 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-live-health-'));
  fs.writeFileSync(path.join(dir, 'secret'), secret);
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ users: [{ id: 'user', name: 'User' }], creds: [] }));
  const child = spawn(process.execPath, ['server.js'], { cwd: API, env: { ...process.env, DATA_DIR: dir, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stderr.on('data', d => logs += d);
  t.after(() => { child.kill('SIGKILL'); fs.chmodSync(dir, 0o700); fs.rmSync(dir, { recursive: true, force: true }); });
  const port = await boundPort(child, () => logs);
  const url = p => `http://127.0.0.1:${port}${p}`;
  const ready = async () => {
    for (let i = 0; i < 130; i++) { if ((await fetch(url('/api/readyz'))).status === 200) return; await new Promise(r => setTimeout(r, 100)); }
    throw new Error('did not recover readiness');
  };
  await ready();
  assert.deepEqual(await fetch(url('/api/health')).then(r => r.json()), { ok: true });
  const payload = `user:${Date.now() + 86400000}:0`;
  const cookie = payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const headers = { Cookie: `gymsid=${cookie}`, Origin: 'http://localhost:8080', 'Content-Type': 'application/json' };
  // Real filesystem save failure, also compatible with K8S-07's random temporary names.
  fs.chmodSync(dir, 0o500);
  assert.equal((await fetch(url('/api/data'), { method: 'PUT', headers, body: JSON.stringify({ state: { workouts: [] } }) })).status, 500);
  assert.equal((await fetch(url('/api/readyz'))).status, 503);
  assert.equal((await fetch(url('/api/health'))).status, 503);
  const live = await fetch(url('/api/healthz'));
  assert.equal(live.status, 200);
  assert.equal(live.headers.get('cache-control'), 'no-store');
  fs.chmodSync(dir, 0o700);
  await ready();
  assert.equal((await fetch(url('/api/data'), { method: 'PUT', headers, body: JSON.stringify({ state: { workouts: [] } }) })).status, 200);
  assert.match(logs, /storage readiness failed/);
});
test('a corrupt existing VAPID record prevents startup and is preserved', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-bad-vapid-'));
  fs.writeFileSync(path.join(dir, 'vapid.json'), '{');
  const child = spawn(process.execPath, ['server.js'], { cwd: API, env: { ...process.env, DATA_DIR: dir, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stderr.on('data', d => logs += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });
  await assert.rejects(boundPort(child, () => logs), /Storage integrity failure/);
  assert.equal(fs.readFileSync(path.join(dir, 'vapid.json'), 'utf8'), '{');
});
