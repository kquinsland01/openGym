import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createStorageHealth, storageWrite } from '../storage-health.js';

const log = { info() {}, error() {} };
async function until(fn) {
  const end = Date.now() + 4000;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); }
}
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-health-'));
  fs.writeFileSync(path.join(dir, 'secret'), 'a'.repeat(64));
  fs.writeFileSync(path.join(dir, 'vapid.json'), '{}');
  const health = createStorageHealth(dir, { intervalMs: 50, log });
  t.after(async () => { await health.close(); fs.chmodSync(dir, 0o700); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, health };
}
test('write failure immediately removes readiness, actual storage recovery restores it without touching data', async t => {
  const { dir, health } = setup(t);
  const file = path.join(dir, 'state-user.json');
  const original = '{"workouts":[]}';
  fs.writeFileSync(file, original);
  await until(health.ready);
  fs.mkdirSync(file + '.tmp');
  assert.throws(() => storageWrite(file, () => fs.writeFileSync(file + '.tmp', 'overwrite')));
  assert.equal(health.ready(), false);
  await new Promise(r => setTimeout(r, 120));
  assert.equal(health.ready(), false, 'unrelated root transaction cannot hide the failed destination');
  fs.rmdirSync(file + '.tmp');
  await until(health.ready);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['secret', 'state-user.json', 'vapid.json']);
});
test('read permission and directory write failures are detected and recover', { skip: process.getuid?.() === 0 }, async t => {
  const { dir, health } = setup(t);
  await until(health.ready);
  fs.chmodSync(path.join(dir, 'secret'), 0);
  await until(() => !health.ready());
  fs.chmodSync(path.join(dir, 'secret'), 0o600);
  await until(health.ready);
  fs.chmodSync(dir, 0o500);
  await until(() => !health.ready());
  fs.chmodSync(dir, 0o700);
  await until(health.ready);
});
test('damaged profile failure stays unready until its content is repaired', async t => {
  const { dir, health } = setup(t);
  await until(health.ready);
  const file = path.join(dir, 'state-user.json');
  fs.writeFileSync(file, '{');
  health.fail({ code: 'ESTORAGE' }, file);
  await new Promise(r => setTimeout(r, 120));
  assert.equal(health.ready(), false);
  fs.writeFileSync(file, '{"workouts":[]}');
  await until(health.ready);
});
test('stalled checks time out without queueing and cannot clear a newer failure', async t => {
  const worker = new EventEmitter();
  const sent = [];
  worker.postMessage = msg => sent.push(msg);
  worker.terminate = () => {};
  const health = createStorageHealth('/data', { intervalMs: 10, timeoutMs: 20, log, workerFactory: () => worker });
  t.after(() => health.close());
  worker.emit('message', { ok: true });
  assert.equal(health.ready(), true);
  health.check();
  await new Promise(r => setTimeout(r, 70));
  assert.equal(health.ready(), false);
  assert.equal(sent.length, 2, 'one outstanding operation even after multiple intervals');
  health.fail({ code: 'ENOSPC' }, '/data/db.json');
  worker.emit('message', { ok: true });
  assert.equal(health.ready(), false, 'a check started before the failure cannot clear it');
  health.check();
  worker.emit('message', { ok: true });
  assert.equal(health.ready(), true);
});
test('a failed mkdir is rechecked as a directory and recovers after repair', async t => {
  const { dir, health } = setup(t);
  await until(health.ready);
  const coach = path.join(dir, 'coach');
  const target = path.join(coach, 'user.json');
  health.fail({ code: 'EACCES', syscall: 'mkdir', path: coach }, target);
  fs.mkdirSync(coach);
  await until(health.ready);
  assert.deepEqual(fs.readdirSync(coach), []);
});
