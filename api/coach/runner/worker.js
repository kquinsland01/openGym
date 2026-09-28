// Runs in a fresh process group with an empty environment and private temporary HOME.
// The supervisor kills the entire group after success, failure, timeout or disconnect.
import { localAdapterFor } from '../adapters/index.js';
import { validateJob } from './protocol.js';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const job = validateJob(JSON.parse(input));
const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: process.cwd(), TMPDIR: process.cwd(), CODEX_HOME: process.cwd() };
if (job.credential) env[job.credential.name] = job.credential.value;
const adapter = localAdapterFor(job.provider);
const result = job.operation === 'check' ? await adapter.check({}, env) : await adapter.invoke({ prompt: job.prompt, jobDir: process.cwd(), env, model: job.model, timeoutMs: job.timeoutMs });
// stdout is protocol output only. Do not return runtime stderr, which could echo credentials.
if (job.operation === 'invoke') {
  result.stderr = result.code === 0 ? '' : 'provider runtime failed';
  delete result.stdout;
}
process.stdout.write(JSON.stringify(result));
