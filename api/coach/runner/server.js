import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BODY_LIMIT, OUTPUT_LIMIT, validateJob } from './protocol.js';
import { localAdapterFor } from '../adapters/index.js';

export async function createRunner({ publicKey, jobRoot = os.tmpdir() }) {
  const key = crypto.createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519') throw Error('Coach runner requires an Ed25519 key');
  const nonces = new Map();
  // Finish bounded, credential-free capability checks before accepting work.
  // Status never spawns a subprocess alongside a credential-bearing job, and
  // there are no background version checks to outlive normal server shutdown.
  const checks = new Map(await Promise.all(['fixture', 'claude', 'codex'].map(async provider => {
    let result;
    try { result = await localAdapterFor(provider).check({}, { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: jobRoot, TMPDIR: jobRoot }); }
    catch { result = { ok: false, error: 'provider runtime unavailable' }; }
    return [provider, result];
  })));
  let admitted = 0;
  let busy = false, activeKill = null, activeDone = Promise.resolve();
  const server = http.createServer(async (req, res) => {
    const reply = (code, value) => { if (!res.destroyed) { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' }); res.end(JSON.stringify(value)); } };
    const stamp = req.headers['x-coach-timestamp'], nonce = req.headers['x-coach-nonce'], signature = req.headers['x-coach-signature'];
    if (!/^\d{13}$/.test(stamp || '') || Math.abs(Date.now() - Number(stamp)) > 30000 || !/^[a-f0-9]{32}$/.test(nonce || '') || !/^[A-Za-z0-9+/]{86}==$/.test(signature || '')) return reply(401, { error: 'unauthorized' });
    if (req.method !== 'POST' || req.url !== '/v1/job' || req.headers['content-type'] !== 'application/json') return reply(400, { error: 'invalid request' });
    // Bound body buffers independently so status checks can work during an active job.
    if (admitted >= 8) return reply(503, { error: 'runner busy' });
    admitted++;
    let resolveDone, ownsExecution = false;
    let dir, child, timer;
    const kill = () => { if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } } };
    const disconnect = () => { if (!res.writableFinished) kill(); };
    res.on('close', disconnect);
    try {
      let size = 0; const chunks = [];
      timer = setTimeout(() => req.destroy(), 5000);
      for await (const chunk of req) { size += chunk.length; if (size > BODY_LIMIT) { reply(413, { error: 'request too large' }); req.destroy(); return; } chunks.push(chunk); }
      clearTimeout(timer);
      const body = Buffer.concat(chunks).toString();
      if (Math.abs(Date.now() - Number(stamp)) > 30000 || !crypto.verify(null, Buffer.from(`${stamp}\n${nonce}\n${body}`), key, Buffer.from(signature, 'base64'))) return reply(401, { error: 'unauthorized' });
      for (const [n, expiry] of nonces) if (expiry < Date.now()) nonces.delete(n);
      if (nonces.has(nonce)) return reply(409, { error: 'replayed request' });
      if (nonces.size >= 1024) return reply(503, { error: 'runner busy' });
      nonces.set(nonce, Number(stamp) + 30000);
      let job;
      try { job = validateJob(JSON.parse(body)); } catch { return reply(400, { error: 'invalid request' }); }
      if (job.operation === 'check') {
        return reply(200, checks.get(job.provider));
      }
      if (busy) return reply(503, { error: 'runner busy' });
      busy = true; ownsExecution = true; activeKill = kill;
      activeDone = new Promise(resolve => { resolveDone = resolve; });
      dir = fs.mkdtempSync(path.join(jobRoot, 'coach-runner-')); fs.chmodSync(dir, 0o700);
      const result = await new Promise((resolve, reject) => {
        child = spawn(process.execPath, [fileURLToPath(new URL('./worker.js', import.meta.url))], { cwd: dir, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: dir, TMPDIR: dir, ...(job.provider === 'fixture' && process.env.COACH_RUNNER_FIXTURE_MODE ? { FIXTURE_MODE: process.env.COACH_RUNNER_FIXTURE_MODE } : {}) }, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
        let total = 0, failure = null; const output = [];
        timer = setTimeout(() => { failure = 'deadline'; kill(); }, job.timeoutMs);
        child.stdout.on('data', chunk => { total += chunk.length; if (total > OUTPUT_LIMIT) { failure = 'output limit'; kill(); } else output.push(chunk); });
        child.on('error', reject);
        child.on('exit', () => kill());
        child.on('close', code => { if (failure || code !== 0) return reject(Error(failure || 'worker failed')); try { resolve(JSON.parse(Buffer.concat(output).toString())); } catch { reject(Error('invalid result')); } });
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify(job));
      });
      reply(200, result);
    } catch { reply(502, { error: 'runner job failed' }); }
    finally {
      admitted--; clearTimeout(timer); kill(); res.off('close', disconnect);
      if (!ownsExecution) return;
      try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); }
      catch {
        // Do not admit another credential while a prior job's scratch remains.
        activeKill = null; resolveDone(); server.close(); return;
      }
      busy = false; activeKill = null; resolveDone();
    }
  });
  server.shutdown = async () => {
    activeKill?.();
    server.closeAllConnections();
    await activeDone;
    await new Promise(resolve => server.close(resolve));
  };
  server.maxConnections = 8;
  server.headersTimeout = 5000; server.requestTimeout = 5000; server.keepAliveTimeout = 1000;
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.getuid?.() === 0) throw Error('Coach runner must run as nonroot');
  if (fs.existsSync('/data')) throw Error('Coach runner must not have /data');
  const socket = process.env.COACH_RUNNER_SOCKET || '/run/coach/runner.sock';
  const publicKey = fs.readFileSync(process.env.COACH_RUNNER_PUBLIC_KEY_FILE || '/run/coach-verification/public.pem', 'utf8');
  // Only remove our socket in the dedicated emptyDir, never an arbitrary filesystem entry.
  if (fs.existsSync(socket)) { if (!fs.lstatSync(socket).isSocket()) throw Error('runner socket path is occupied'); fs.unlinkSync(socket); }
  const server = await createRunner({ publicKey });
  server.listen(socket, () => fs.chmodSync(socket, 0o660));
  const shutdown = async () => { await server.shutdown(); process.exit(0); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
