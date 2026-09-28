import fs from 'node:fs';

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export class StorageError extends Error {
  constructor(file, cause) {
    super(`Storage integrity failure at ${file}: ${cause.message}. Stop writes and restore a validated backup; do not delete or initialize this file.`, { cause });
    this.name = 'StorageError';
  }
}

// ENOENT is the only bootstrap case. A dangling symlink is an existing broken store,
// not a missing file. Never include file contents (credentials) in diagnostics.
export function readJson(file, validate, missing = null) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') {
      try { fs.lstatSync(file); }
      catch (statError) { if (statError.code === 'ENOENT') return missing; throw new StorageError(file, statError); }
    }
    throw new StorageError(file, new Error(`read failed (${e.code || 'unknown'})`));
  }
  let value;
  try { value = JSON.parse(raw); }
  catch { throw new StorageError(file, new Error('invalid JSON')); }
  try { validate(value); }
  catch (e) { throw new StorageError(file, e); }
  return value;
}

export function validateDb(db) {
  if (!object(db)) throw new Error('database must be an object');
  for (const key of ['users', 'creds', 'subs', 'invites', 'deviceLinks']) {
    // The last three collections were added later. Missing is compatible; a present
    // null/scalar is damaged data and must not be silently replaced with an empty list.
    if (!(key in db) && !['users', 'creds'].includes(key)) continue;
    if (!Array.isArray(db[key]) || !db[key].every(object)) throw new Error(`database ${key} must be an array of records`);
  }
  const ids = new Set();
  for (const user of db.users) {
    if (typeof user.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(user.id) || ids.has(user.id)) throw new Error('invalid or duplicate user id');
    ids.add(user.id);
  }
  const creds = new Set();
  for (const cred of db.creds) {
    if (typeof cred.id !== 'string' || !cred.id || creds.has(cred.id) || !ids.has(cred.userId) || typeof cred.publicKey !== 'string' || !cred.publicKey) throw new Error('invalid credential record');
    creds.add(cred.id);
  }
}

export function validateState(state) {
  if (!object(state)) throw new Error('profile must be an object');
  // Preserve older documents with absent/null lists and individually malformed entries;
  // server readers already filter those entries. Never reinterpret an invalid root/list.
  for (const key of ['workouts', 'routines', 'bodyweight', 'customEx']) {
    if (state[key] != null && !Array.isArray(state[key])) throw new Error(`profile ${key} must be an array`);
  }
  if (state._rev != null && (!Number.isSafeInteger(state._rev) || state._rev < 0)) throw new Error('invalid profile revision');
}
