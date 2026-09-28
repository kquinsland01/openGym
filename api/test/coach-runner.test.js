import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRunner } from '../coach/runner/server.js';
import { validateJob } from '../coach/runner/protocol.js';
const job = { provider: 'fixture', operation: 'invoke', prompt: 'test', model: null, timeoutMs: 2000, credential: null };
const keys = crypto.generateKeyPairSync('ed25519');
function signed(body, key = keys.privateKey) {
  const stamp = String(Date.now()), nonce = crypto.randomBytes(16).toString('hex');
  return { 'content-type': 'application/json', 'x-coach-timestamp': stamp, 'x-coach-nonce': nonce, 'x-coach-signature': crypto.sign(null, Buffer.from(`${stamp}\n${nonce}\n${body}`), key).toString('base64') };
}
test('runner accepts signed fixed-provider jobs and rejects unauthenticated, tampered and replayed requests', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'));
  const socketPath = path.join(dir, 'runner.sock');
  const server = await createRunner({ publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), jobRoot: dir });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  function send(body, headers = {}) { return new Promise((resolve, reject) => { const req = http.request({ socketPath, path: '/v1/job', method: 'POST', headers }, res => { let text = ''; res.on('data', d => text += d); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) })); }); req.on('error', reject); req.end(body); }); }
  const body = JSON.stringify(job), headers = signed(body);
  assert.equal((await send(body)).status, 401);
  assert.equal((await send(body + ' ', headers)).status, 401);
  const success = await send(body, headers);
  assert.equal(success.status, 200); assert.equal(JSON.parse(success.body.text).ok, true);
  assert.equal((await send(body, headers)).status, 409);
  assert.deepEqual(fs.readdirSync(dir), ['runner.sock'], 'job scratch removed');
  const arbitrary = JSON.stringify({ ...job, command: '/bin/sh' });
  assert.equal((await send(arbitrary, signed(arbitrary))).status, 400);
  const wrong = signed(body, crypto.generateKeyPairSync('ed25519').privateKey);
  assert.equal((await send(body, wrong)).status, 401);
});
test('protocol rejects arbitrary paths/env, providers, credentials, oversized prompt and unbounded timeout', () => {
  for (const patch of [{ provider: 'constructor' }, { cwd: '/data' }, { env: { HOME: '/data' } }, { timeoutMs: 0 }, { timeoutMs: 300001 }, { prompt: 'x'.repeat(1024 * 1024) }, { model: '--dangerously-bypass-approvals-and-sandbox' }, { credential: { name: 'NODE_OPTIONS', value: '--inspect' } }, { provider: 'claude', credential: { name: 'ANTHROPIC_API_KEY', value: 'x\ny' } }]) assert.throws(() => validateJob({ ...job, ...patch }));
});
test('runner bounds concurrent jobs, kills timed-out workers and recovers capacity', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-limit-'));
  const socketPath = path.join(dir, 'runner.sock');
  const server = await createRunner({ publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), jobRoot: dir });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => { delete process.env.COACH_RUNNER_FIXTURE_MODE; await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  function send(data) { const body = JSON.stringify(data); return new Promise((resolve, reject) => { const req = http.request({ socketPath, path:'/v1/job', method:'POST', headers:signed(body) }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject); req.end(body); }); }
  process.env.COACH_RUNNER_FIXTURE_MODE = 'timeout';
  const first = send({ ...job, timeoutMs: 500 });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await send(job), 503);
  assert.equal(await send({ ...job, operation: 'check' }), 200, 'status works while execution is busy');
  assert.equal(await send({ ...job, operation: 'check' }), 200, 'cached status does not spawn another job');
  assert.equal(await first, 502);
  delete process.env.COACH_RUNNER_FIXTURE_MODE;
  assert.equal(await send(job), 200);
  assert.deepEqual(fs.readdirSync(dir), ['runner.sock']);
});
test('client disconnect kills worker and releases scratch/capacity', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-disconnect-'));
  const socketPath = path.join(dir, 'runner.sock');
  const server = await createRunner({ publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), jobRoot: dir });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => { delete process.env.COACH_RUNNER_FIXTURE_MODE; await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  process.env.COACH_RUNNER_FIXTURE_MODE = 'timeout';
  const body = JSON.stringify({ ...job, timeoutMs: 5000 });
  const req = http.request({socketPath,path:'/v1/job',method:'POST',headers:signed(body)});
  req.on('error', () => {}); req.end(body);
  await new Promise(resolve => setTimeout(resolve, 100)); req.destroy();
  for (let i=0; i<50 && fs.readdirSync(dir).length > 1; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(fs.readdirSync(dir), ['runner.sock']);
});
test('shutdown awaits active worker termination and scratch cleanup', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-shutdown-'));
  const socketPath = path.join(dir, 'runner.sock');
  const server = await createRunner({publicKey:keys.publicKey.export({type:'spki',format:'pem'}),jobRoot:dir});
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(() => { delete process.env.COACH_RUNNER_FIXTURE_MODE; fs.rmSync(dir,{recursive:true,force:true}); });
  process.env.COACH_RUNNER_FIXTURE_MODE='timeout';
  const body=JSON.stringify({...job,timeoutMs:5000});
  const req=http.request({socketPath,path:'/v1/job',method:'POST',headers:signed(body)});
  req.on('error',()=>{});req.end(body);
  await new Promise(resolve=>setTimeout(resolve,100));
  await server.shutdown();
  assert.deepEqual(fs.readdirSync(dir),[]);
});
