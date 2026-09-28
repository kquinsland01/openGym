import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite, durableMkdir } from '../durable-write.js';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-write-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, 'old');
  return { dir, file };
}
test('replacement fsyncs complete file before rename, then parent directory, and uses private mode', t => {
  const { dir, file } = fixture(t);
  const calls = [];
  const sync = fs.fsyncSync, rename = fs.renameSync;
  t.mock.method(fs, 'fsyncSync', fd => { calls.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file'); return sync(fd); });
  t.mock.method(fs, 'renameSync', (...args) => { calls.push('rename'); return rename(...args); });
  atomicWrite(file, 'new');
  assert.deepEqual(calls, ['file', 'rename', 'directory']);
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
});
for (const operation of ['writeFileSync', 'fsyncSync', 'renameSync']) test(`${operation} failure preserves old file and removes temporary data`, t => {
  const { dir, file } = fixture(t);
  t.mock.method(fs, operation, () => { throw new Error('injected disk fault'); });
  assert.throws(() => atomicWrite(file, 'new'), /injected disk fault/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'old');
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
});
test('directory fsync failure is reported even though rename has committed', t => {
  const { dir, file } = fixture(t);
  const sync = fs.fsyncSync;
  t.mock.method(fs, 'fsyncSync', fd => { if (fs.fstatSync(fd).isDirectory()) throw new Error('directory fault'); sync(fd); });
  assert.throws(() => atomicWrite(file, 'new'), /directory fault/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
});
test('new nested Coach directory entries are synced before writing records', t => {
  const { dir } = fixture(t);
  const calls = [];
  const sync = fs.fsyncSync;
  t.mock.method(fs, 'fsyncSync', fd => { calls.push(fs.fstatSync(fd).isDirectory()); sync(fd); });
  durableMkdir(path.join(dir, 'coach', 'nested'));
  assert.deepEqual(calls, [true, true]);
  assert.equal(fs.statSync(path.join(dir, 'coach')).mode & 0o777, 0o700);
});
