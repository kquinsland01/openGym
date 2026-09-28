// Only data crosses this interface: never a command, path, environment or configuration file.
export const BODY_LIMIT = 1024 * 1024;
export const OUTPUT_LIMIT = 4 * 1024 * 1024;
export const MAX_TIMEOUT = 300000;
export const CREDENTIALS = Object.freeze({ fixture: [], claude: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'], codex: ['CODEX_API_KEY'] });
export function validateJob(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) throw Error('invalid request');
  if (Object.keys(job).some(k => !['provider', 'operation', 'prompt', 'model', 'timeoutMs', 'credential'].includes(k))) throw Error('unknown field');
  if (!Object.hasOwn(CREDENTIALS, job.provider)) throw Error('invalid provider');
  if (!['check', 'invoke'].includes(job.operation)) throw Error('invalid operation');
  if (typeof job.prompt !== 'string' || Buffer.byteLength(job.prompt) > BODY_LIMIT - 16384) throw Error('invalid prompt');
  if (job.model !== null && (typeof job.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(job.model))) throw Error('invalid model');
  if (!Number.isInteger(job.timeoutMs) || job.timeoutMs < 100 || job.timeoutMs > MAX_TIMEOUT) throw Error('invalid timeout');
  if (job.credential !== null) {
    const c = job.credential;
    if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).sort().join() !== 'name,value' || !CREDENTIALS[job.provider].includes(c.name) || typeof c.value !== 'string' || c.value.length > 8192 || /[\x00-\x1f\x7f]/.test(c.value)) throw Error('invalid credential');
  }
  return job;
}
