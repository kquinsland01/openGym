import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function syncDirectory(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// A newly created directory also needs its parent's entry persisted. Existing directories
// are assumed to have been provisioned durably; unsupported fsync is an error, not success.
export function durableMkdir(dir, mode = 0o700) {
  try { fs.mkdirSync(dir, { mode }); }
  catch (e) {
    if (e.code === 'ENOENT') { durableMkdir(path.dirname(dir), mode); return durableMkdir(dir, mode); }
    if (e.code === 'EEXIST' && fs.statSync(dir).isDirectory()) return;
    throw e;
  }
  syncDirectory(path.dirname(dir));
}

// Each acknowledged replacement persists the complete new file before persisting its name.
// This is one-file durability on filesystems honoring fsync, not a cross-file transaction.
// A directory-fsync failure after rename leaves an uncertain committed result: report failure
// and let the caller reread/reconcile. Never roll back by deleting the destination.
export function atomicWrite(file, content, mode = 0o600) {
  const tmp = `${file}.${crypto.randomBytes(12).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
    syncDirectory(path.dirname(file));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
