import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'scripts/backup/opengym-backup.sh');
const validator = path.join(root, 'scripts/backup/validate-backup.mjs');
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-tools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = path.join(dir, 'data'), bin = path.join(dir, 'bin');
  fs.mkdirSync(data); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(data, 'secret'), 'a'.repeat(64));
  fs.writeFileSync(path.join(data, 'db.json'), JSON.stringify({ users: [{ id: 'user' }], creds: [] }));
  fs.writeFileSync(path.join(data, 'vapid.json'), JSON.stringify({ publicKey: 'public', privateKey: 'private' }));
  fs.writeFileSync(path.join(data, 'state-user.json'), JSON.stringify({ workouts: [], _rev: 1 }));
  fs.writeFileSync(path.join(bin, 'restic'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$CALL_LOG"\nexit "${RESTIC_EXIT:-0}"\n', { mode: 0o700 });
  return { dir, data, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RESTIC_REPOSITORY: 's3:https://example.invalid/backup', RESTIC_PASSWORD_FILE: '/run/secrets/password', CALL_LOG: path.join(dir, 'calls') } };
}
test('backup refuses unconfirmed quiesce; takes same lock as the writer and propagates partial backup failure', t => {
  const h = setup(t);
  const run = env => spawnSync('bash', [script, 'backup', h.data], { env, encoding: 'utf8' });
  assert.notEqual(run(h.env).status, 0);
  assert.equal(fs.existsSync(h.env.CALL_LOG), false);
  const env = { ...h.env, OPENGYM_QUIESCED: '1' };
  assert.equal(run(env).status, 0);
  assert.match(fs.readFileSync(h.env.CALL_LOG, 'utf8'), /backup\n--host\nopengym\n--tag\nopengym-complete/);
  const locked = spawnSync('flock', ['--exclusive', path.join(h.data, '.writer.lock'), 'bash', script, 'backup', h.data], { env, encoding: 'utf8' });
  assert.notEqual(locked.status, 0);
  assert.match(locked.stderr, /still owns/);
  assert.equal(run({ ...env, RESTIC_EXIT: '3' }).status, 3);
});
test('restore refuses existing destinations and requires an explicit snapshot', t => {
  const h = setup(t);
  for (const id of ['12345678', 'latest']) assert.notEqual(spawnSync('bash', [script, 'restore', id, '/data', h.data], { env: h.env }).status, 0);
  assert.equal(fs.existsSync(h.env.CALL_LOG), false);
});
test('validator rejects missing secret, corrupt profiles, symlinks and undecryptable Coach credentials', t => {
  const h = setup(t);
  const run = () => spawnSync(process.execPath, [validator, h.data], { encoding: 'utf8' });
  assert.equal(run().status, 0);
  fs.writeFileSync(path.join(h.data, 'state-user.json'), '[]');
  assert.notEqual(run().status, 0);
  fs.writeFileSync(path.join(h.data, 'state-user.json'), '{}');
  fs.symlinkSync('/etc/passwd', path.join(h.data, 'outside'));
  assert.notEqual(run().status, 0);
  fs.unlinkSync(path.join(h.data, 'outside'));
  fs.writeFileSync(path.join(h.data, 'coach.json'), JSON.stringify({ auth: { openai: { type: 'api-key', data: 'bad' } } }));
  assert.notEqual(run().status, 0);
  fs.unlinkSync(path.join(h.data, 'coach.json'));
  fs.unlinkSync(path.join(h.data, 'secret'));
  assert.notEqual(run().status, 0);
});

test('validator decrypts real Coach credentials and rejects a mismatched restored secret', t => {
  const h = setup(t);
  const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from('a'.repeat(64)), Buffer.alloc(0), Buffer.from('opengym-coach-v1'), 32));
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ apiKey: 'fixture-only' })), cipher.final()]);
  const data = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  fs.writeFileSync(path.join(h.data, 'coach-auth-user.json'), JSON.stringify({ openai: { type: 'api-key', data } }));
  const run = () => spawnSync(process.execPath, [validator, h.data], { encoding: 'utf8' });
  assert.equal(run().status, 0);
  fs.writeFileSync(path.join(h.data, 'secret'), 'b'.repeat(64));
  const failed = run();
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /cannot be decrypted/);
  assert.doesNotMatch(failed.stderr, /fixture-only/);
});
