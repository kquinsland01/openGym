import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

const available = process.platform === 'linux' && spawnSync('flock', ['--version']).status === 0;

test('startup lock excludes another writer and releases on SIGKILL without deleting its inode', { skip: !available }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-writer-lock-'));
  const data = path.join(root, 'data');
  fs.copyFileSync(new URL('../start.sh', import.meta.url), path.join(root, 'start.sh'));
  // The fixture writes only after the same production startup wrapper has locked.
  fs.writeFileSync(path.join(root, 'server.js'), `
    const fs = require('node:fs');
    fs.appendFileSync(process.env.DATA_DIR + '/started', 'writer\\n');
    console.log('ready');
    setInterval(() => {}, 1000);
  `);
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const launch = () => {
    const child = spawn('sh', [path.join(root, 'start.sh')], {
      env: { ...process.env, DATA_DIR: data }, stdio: ['ignore', 'pipe', 'pipe']
    });
    children.push(child);
    return child;
  };
  const ready = child => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('writer did not start')), 5000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`writer exited ${code}`)); });
  });
  const first = launch();
  await ready(first);
  const inode = fs.statSync(path.join(data, '.writer.lock')).ino;
  const contender = launch();
  assert.equal((await once(contender, 'exit'))[0], 73);
  assert.equal(fs.readFileSync(path.join(data, 'started'), 'utf8'), 'writer\n');
  first.kill('SIGKILL');
  await once(first, 'exit');
  const recovered = launch();
  await ready(recovered);
  assert.equal(fs.statSync(path.join(data, '.writer.lock')).ino, inode);
  assert.equal(fs.readFileSync(path.join(data, 'started'), 'utf8'), 'writer\nwriter\n');
});
