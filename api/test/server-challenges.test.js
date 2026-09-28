import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

async function start(t, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-challenges-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATA_DIR: dir, PORT: '0', RP_ID: 'localhost', ORIGIN: 'http://localhost:8080',
      INVITE_ONLY: '0', COACH_ENABLED: '0', AUDIT_LOG: '0', ...env }
  });
  let log = '';
  child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(async () => {
    await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${await boundPort(child, () => log)}`;
  const cookies = new Map();
  return async (route, body = {}) => {
    const cookie = cookies.get(body.cid);
    const r = await fetch(base + route, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
    for (const c of r.headers.getSetCookie()) {
      const m = /^gymceremony-([^=]+)=([^;]+)/.exec(c);
      if (m) cookies.set(m[1], c.split(';')[0]);
    }
    return { status: r.status, body: await r.json(), retry: r.headers.get('retry-after') };
  };
}

test('login and registration share the live cap, return a retry hint, and permit consumption while full', async t => {
  const post = await start(t, { AUTH_CHALLENGE_MAX: '2' });
  const login = await post('/api/login/options');
  const registration = await post('/api/register/options', { name: 'New user' });
  assert.equal(login.status, 200); assert.equal(registration.status, 200);
  const full = await post('/api/login/options');
  assert.equal(full.status, 503); assert.equal(full.body.code, 'challenge-busy');
  assert.ok(Number(full.retry) > 0);
  assert.equal((await post('/api/login/verify', { cid: login.body.cid })).status, 404);
  assert.equal((await post('/api/login/options')).status, 200);
});

test('global issuance budget survives consumption without creating a per-address bucket', async t => {
  const post = await start(t, { AUTH_CHALLENGE_PER_MINUTE: '1' });
  const login = await post('/api/login/options');
  assert.equal(login.status, 200);
  await post('/api/login/verify', { cid: login.body.cid });
  const limited = await post('/api/register/options', { name: 'New user' });
  assert.equal(limited.status, 503);
  assert.ok(Number(limited.retry) >= 59);
});
