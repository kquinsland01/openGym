import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChallengeStore, challengeLimits, ChallengeBusyError } from '../challenges.js';
const make = async () => ({ challenge: 'random-challenge' });

test('a full store preserves live ceremonies and recovers at expiry without a sweep timer', async () => {
  let at = 0;
  const store = createChallengeStore({ maxEntries: 2, now: () => at });
  const first = await store.issue(make, { kind: 'login' });
  const second = await store.issue(make, { kind: 'register' });
  await assert.rejects(store.issue(make), e => e instanceof ChallengeBusyError && e.retryAfter === 300);
  assert.equal(store.get(first.cid).kind, 'login');
  assert.equal(store.take(first.cid).kind, 'login');
  assert.equal(store.get(first.cid), undefined);
  assert.equal(store.take(first.cid), null);
  await store.issue(make);
  at = 300000;
  assert.equal(store.take(second.cid), null);
  await store.issue(make);
});

test('concurrent generation reserves both the entry cap and the pending cap', async () => {
  for (const limits of [{ maxEntries: 1, maxPending: 4 }, { maxEntries: 4, maxPending: 1 }]) {
    const store = createChallengeStore(limits);
    let finish;
    const first = store.issue(() => new Promise(resolve => { finish = resolve; }));
    let invoked = false;
    await assert.rejects(store.issue(() => { invoked = true; return make(); }), ChallengeBusyError);
    assert.equal(invoked, false);
    finish(await make());
    const { cid } = await first;
    assert.ok(store.take(cid));
    await store.issue(make);
  }
});

test('issuance credits remain bounded when challenges are immediately consumed, and refill gradually', async () => {
  let at = 0;
  const store = createChallengeStore({ perMinute: 2, now: () => at });
  for (let i = 0; i < 2; i++) store.take((await store.issue(make)).cid);
  await assert.rejects(store.issue(make), e => e.retryAfter === 30);
  at = 29999;
  await assert.rejects(store.issue(make), ChallengeBusyError);
  at = 30000;
  store.take((await store.issue(make)).cid);
  await assert.rejects(store.issue(make), ChallengeBusyError);
});

test('generation errors release reservations but cannot bypass the issuance budget', async () => {
  const store = createChallengeStore({ maxEntries: 1, maxPending: 1, perMinute: 2 });
  await assert.rejects(store.issue(async () => { throw new Error('generation failed'); }), /generation failed/);
  store.take((await store.issue(make)).cid);
  await assert.rejects(store.issue(make), ChallengeBusyError);
});

test('invalid or disabling environment values retain bounded defaults', () => {
  const defaults = challengeLimits({});
  for (const value of ['0', '-1', 'Infinity', 'bad', '1.5', '99999999']) {
    assert.deepEqual(challengeLimits({ AUTH_CHALLENGE_MAX: value, AUTH_CHALLENGE_CONCURRENCY: value,
      AUTH_CHALLENGE_PER_MINUTE: value }), defaults);
  }
  assert.deepEqual(challengeLimits({ AUTH_CHALLENGE_MAX: '20', AUTH_CHALLENGE_CONCURRENCY: '3',
    AUTH_CHALLENGE_PER_MINUTE: '15' }), { maxEntries: 20, maxPending: 3, perMinute: 15 });
});
