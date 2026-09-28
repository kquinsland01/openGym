import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, validateDb, validateState, StorageError } from '../storage-read.js';

const db = { users: [{ id: 'legacy' }], creds: [] };
test('only an absent file initializes; a broken symlink, directory, malformed or invalid data fails closed', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-read-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'db.json');
  assert.equal(readJson(file, validateDb, 'new'), 'new');
  fs.symlinkSync(path.join(dir, 'absent'), file);
  assert.throws(() => readJson(file, validateDb, 'new'), StorageError);
  fs.unlinkSync(file);
  assert.throws(() => readJson(dir, validateDb, 'new'), StorageError);
  for (const raw of ['{', 'null', '[]', '{}', '{"users":{},"creds":[]}', JSON.stringify({ ...db, subs: null }), JSON.stringify({ ...db, users: [{ id: 'duplicate' }, { id: 'duplicate' }] })]) {
    fs.writeFileSync(file, raw);
    assert.throws(() => readJson(file, validateDb, 'new'), StorageError);
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
  }
  fs.writeFileSync(file, JSON.stringify(db));
  assert.deepEqual(readJson(file, validateDb), db);
});
for (const code of ['EACCES', 'EIO']) test(`${code} is never treated as missing`, t => {
  t.mock.method(fs, 'readFileSync', () => { throw Object.assign(new Error('fault'), { code }); });
  assert.throws(() => readJson('/unreadable/db.json', validateDb, {}), new RegExp(code));
});
test('profile validation rejects invalid roots, lists and revisions while preserving old profiles', () => {
  for (const value of [null, [], 'state', { workouts: {} }, { routines: 'bad' }, { _rev: -1 }, { _rev: '3' }]) assert.throws(() => validateState(value));
  for (const value of [{}, { routines: null }, { workouts: [null, 3, { id: 'old' }] }, { _rev: 0, unit: 'kg' }]) assert.doesNotThrow(() => validateState(value));
});
