// Offline validation, no server imports, writes, provider calls, or decrypted-key output.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const dir = process.argv[2];
if (!dir) throw new Error('Usage: node scripts/backup/validate-backup.mjs /restored/data');
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const read = file => {
  const full = path.join(dir, file);
  if (!fs.lstatSync(full).isFile()) throw new Error(`Not a regular file: ${file}`);
  let value;
  try { value = JSON.parse(fs.readFileSync(full, 'utf8')); }
  catch { throw new Error(`Unreadable or invalid JSON: ${file}`); }
  if (!object(value)) throw new Error(`Invalid object: ${file}`);
  return value;
};
const secretPath = path.join(dir, 'secret');
if (!fs.lstatSync(secretPath).isFile()) throw new Error('Missing regular secret file');
const secret = fs.readFileSync(secretPath, 'utf8').trim();
if (!/^[a-fA-F0-9]{64}$/.test(secret)) throw new Error('Invalid or missing signing/decryption secret');
const db = read('db.json');
if (!Array.isArray(db.users) || !Array.isArray(db.creds)) throw new Error('Invalid account database');
const ids = new Set();
for (const user of db.users) {
  if (!object(user) || typeof user.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(user.id) || ids.has(user.id)) throw new Error('Invalid/duplicate user');
  ids.add(user.id);
}
for (const cred of db.creds) if (!object(cred) || !ids.has(cred.userId) || !cred.id || !cred.publicKey) throw new Error('Invalid credential');
const vapid = read('vapid.json');
if (typeof vapid.publicKey !== 'string' || typeof vapid.privateKey !== 'string') throw new Error('Invalid push keys');
const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), Buffer.from('opengym-coach-v1'), 32));
function checkEncrypted(value, file) {
  if (!object(value)) return;
  if (typeof value.data === 'string' && value.type) {
    try {
      const blob = Buffer.from(value.data, 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
      decipher.setAuthTag(blob.subarray(12, 28));
      JSON.parse(Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString());
    } catch { throw new Error(`Coach credential cannot be decrypted with restored secret: ${file}`); }
  }
  for (const child of Object.values(value)) if (object(child)) checkEncrypted(child, file);
}
let profiles = 0, files = 0, bytes = 0;
function walk(relative = '') {
  for (const name of fs.readdirSync(path.join(dir, relative))) {
    const file = path.join(relative, name), full = path.join(dir, file), st = fs.lstatSync(full);
    if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) throw new Error(`Unexpected file type: ${file}`);
    if (st.isDirectory()) { walk(file); continue; }
    files++; bytes += st.size;
    if (/^state-[a-zA-Z0-9_-]+\.json$/.test(file)) {
      const state = read(file);
      for (const field of ['workouts', 'routines', 'bodyweight', 'customEx']) if (state[field] != null && !Array.isArray(state[field])) throw new Error(`Invalid profile list: ${file}`);
      if (state._rev != null && (!Number.isSafeInteger(state._rev) || state._rev < 0)) throw new Error(`Invalid profile revision: ${file}`);
      profiles++;
    } else if (/^(coach\.json|coach-auth-[a-zA-Z0-9_-]+\.json|coach\/[^/]+\.json)$/.test(file)) {
      checkEncrypted(read(file), file);
    }
  }
}
walk();
console.log(`Validated ${db.users.length} users, ${profiles} profiles, ${files} files, ${bytes} bytes. Record these counts with the snapshot ID; verify expected completeness and account/media behavior in isolation.`);
