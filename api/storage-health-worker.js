// Blocking filesystem calls live in one worker, not the HTTP event loop. A stalled NFS
// operation leaves ONE check in flight; the parent times it out and never queues more.
import fs from 'node:fs';
import { readJson, validateDb, validateState } from './storage-read.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { parentPort } from 'node:worker_threads';

function checkFile(file, required = false) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'ENOTFILE' });
    fs.accessSync(file, fs.constants.R_OK);
  } catch (error) { if (required || error.code !== 'ENOENT') throw error; }
}
function transaction(dir) {
  const source = path.join(dir, `.readiness-${crypto.randomUUID()}`);
  const target = source + '.renamed';
  const bytes = crypto.randomBytes(16);
  let fd;
  try {
    fd = fs.openSync(source, 'wx', 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(source, target);
    if (!fs.readFileSync(target).equals(bytes)) throw Object.assign(new Error('readback'), { code: 'EIO' });
    fs.unlinkSync(target);
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    for (const file of [source, target]) { try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
}
parentPort.on('message', ({ data, failedFiles }) => {
  try {
    checkFile(path.join(data, 'secret'), true);
    checkFile(path.join(data, 'vapid.json'), true);
    checkFile(path.join(data, 'db.json'));
    const dirs = new Set([data]);
    for (const { file, directory } of failedFiles) {
      if (directory) {
        if (fs.existsSync(file)) {
          if (!fs.statSync(file).isDirectory()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
          dirs.add(file);
        }
        continue;
      }
      checkFile(file);
      if (path.basename(file) === 'db.json') readJson(file, validateDb);
      else if (/^state-[a-zA-Z0-9_-]+\.json$/.test(path.basename(file))) readJson(file, validateState);
      let dir = path.dirname(file);
      // A failed first mkdir may leave no Coach/profile subdirectory yet. Check its
      // nearest existing parent; do not create application directories from probes.
      while (!fs.existsSync(dir) && dir !== path.resolve(data)) dir = path.dirname(dir);
      dirs.add(dir);
    }
    for (const dir of dirs) transaction(dir);
    parentPort.postMessage({ ok: true });
  } catch (error) { parentPort.postMessage({ ok: false, code: error.code || 'storage' }); }
});
