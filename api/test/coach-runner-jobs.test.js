import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tempData, writeState, sampleState } from './helpers.mjs';
import { createRunner } from '../coach/runner/server.js';
const dir = tempData();
const cfg = await import('../coach/config.js');
const jobs = await import('../coach/jobs.js');
const { forcePrivilegeVerdict } = await import('../coach/adapters/spawn.js');

test('nonroot API queue, validation and admin test use isolated runner without local privilege drop', async t => {
  const pair=crypto.generateKeyPairSync('ed25519');
  const keyFile=path.join(dir,'signing.pem'),socket=path.join(dir,'runner.sock');
  fs.writeFileSync(keyFile,pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  process.env.COACH_RUNNER_SOCKET=socket;process.env.COACH_RUNNER_KEY_FILE=keyFile;
  const server=await createRunner({publicKey:pair.publicKey.export({type:'spki',format:'pem'}),jobRoot:dir});
  await new Promise(resolve=>server.listen(socket,resolve));
  t.after(async()=>{await server.shutdown();delete process.env.COACH_RUNNER_SOCKET;delete process.env.COACH_RUNNER_KEY_FILE;forcePrivilegeVerdict(null);});
  forcePrivilegeVerdict({ok:false,dropped:false,why:'nonroot API cannot change UID'});
  cfg.save({enabled:true,provider:'fixture'});
  assert.equal((await jobs.testRun()).ok,true);
  const uid='u-isolated-runner', other='u-concurrent-runner';
  writeState(dir,uid,sampleState());writeState(dir,other,sampleState());
  jobs.enqueue(uid,{kind:'review'});
  jobs.enqueue(other,{kind:'review'});
  assert.equal(jobs.status(other).job.state,'queued','second user waits for runner capacity');
  const until=Date.now()+10000;
  while((jobs.status(uid).job || jobs.status(other).job) && Date.now()<until) await new Promise(resolve=>setTimeout(resolve,20));
  const result=jobs.status(uid);
  assert.equal(result.job,null);
  assert.ok(result.pending,'validated proposal available');
  assert.equal(jobs.readUser(uid).history.at(-1).outcome,'ready');
  assert.ok(jobs.status(other).pending,'second user also receives a validated proposal');
  assert.equal(jobs.readUser(other).history.at(-1).outcome,'ready');
});

test('direct HTTP providers retain two simultaneous executions', async t => {
  const { localAdapterFor } = await import('../coach/adapters/index.js');
  const waiting = [];
  t.mock.method(localAdapterFor('compatible'), 'invoke', () => new Promise(resolve => waiting.push(resolve)));
  cfg.save({ enabled: true, provider: 'compatible', providerOptions: { compatible: { baseUrl: 'https://example.invalid' } } });
  const uids = ['u-http-first', 'u-http-second'];
  for (const uid of uids) { writeState(dir, uid, sampleState()); jobs.enqueue(uid, { kind: 'review' }); }
  assert.equal(waiting.length, 2, 'both HTTP requests enter the adapter before either completes');
  for (const resolve of waiting) resolve({ code: 0, text: JSON.stringify({coach_contract:1,nochange:true,reading:'No change required.'}), stderr:'' });
  const until = Date.now() + 5000;
  while (uids.some(uid => jobs.status(uid).job) && Date.now() < until) await new Promise(resolve => setTimeout(resolve,20));
  for (const uid of uids) assert.equal(jobs.readUser(uid).history.at(-1).outcome,'nochange');
});
