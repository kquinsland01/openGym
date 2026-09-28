import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { CREDENTIALS, BODY_LIMIT, OUTPUT_LIMIT, MAX_TIMEOUT, validateJob } from '../runner/protocol.js';

export function runnerConfigured() { return !!process.env.COACH_RUNNER_SOCKET; }
export function runnerRequest(job, signal) {
  validateJob(job);
  const key = crypto.createPrivateKey(fs.readFileSync(process.env.COACH_RUNNER_KEY_FILE || '/run/coach-signing/private.pem'));
  if (key.asymmetricKeyType !== 'ed25519') throw Error('Coach runner requires an Ed25519 key');
  const body = JSON.stringify(job);
  if (Buffer.byteLength(body) > BODY_LIMIT) throw Error('Coach runner request too large');
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = crypto.sign(null, Buffer.from(`${timestamp}\n${nonce}\n${body}`), key).toString('base64');
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: process.env.COACH_RUNNER_SOCKET, path: '/v1/job', method: 'POST', signal, headers: { 'x-coach-timestamp': timestamp, 'x-coach-nonce': nonce, 'x-coach-signature': signature, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      let size = 0; const chunks = [];
      res.on('data', chunk => { size += chunk.length; if (size > OUTPUT_LIMIT + 65536) req.destroy(Error('Coach runner response too large')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(Error(`Coach runner refused request (${res.statusCode})`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(Error('invalid Coach runner response')); }
      });
    });
    // Absolute deadline, including connect/headers; socket idle timeout alone permits trickling.
    const timer = setTimeout(() => req.destroy(Error('Coach runner deadline exceeded')), job.timeoutMs + 5000);
    req.on('error', reject); req.on('close', () => clearTimeout(timer));
    req.end(body);
  });
}
export function remoteAdapter(provider) {
  return {
    id: provider, spawns: false, remote: true,
    async check() {
      try { return await runnerRequest({ provider, operation: 'check', prompt: '', model: null, timeoutMs: 20000, credential: null }); }
      catch { return { ok: false, error: 'isolated Coach runner unavailable' }; }
    },
    async invoke({ prompt, model, timeoutMs = MAX_TIMEOUT, env = {}, signal }) {
      const name = CREDENTIALS[provider].find(k => typeof env[k] === 'string' && env[k]);
      try { return await runnerRequest({ provider, operation: 'invoke', prompt, model: model || null, timeoutMs: Math.min(timeoutMs, MAX_TIMEOUT), credential: name ? { name, value: env[name] } : null }, signal); }
      catch { return { code: -1, text: '', stderr: 'isolated Coach runner unavailable or request refused', timedOut: false, spawnError: true }; }
    }
  };
}
