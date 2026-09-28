import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { browserAuthOriginOk, createBrowserAuth } from '../browser-auth.js';
const origin = 'https://gym.example';
const req = headers => ({ headers });

test('cookie auth requires consistent Origin and Fetch Metadata even with a Bearer header', () => {
  for (const headers of [
    { origin: 'https://other.example' }, { origin: 'null' },
    { origin, 'sec-fetch-site': 'cross-site' }, { origin, 'sec-fetch-site': 'same-site' },
    { origin: 'https://other.example', 'sec-fetch-site': 'same-origin' },
    { 'sec-fetch-site': 'none' }, { authorization: 'Bearer example', origin: 'https://other.example' }
  ]) assert.equal(browserAuthOriginOk(req(headers), origin), false);
  for (const headers of [{}, { origin }, { origin: origin + '/' }, { 'sec-fetch-site': 'same-origin' },
    { origin, 'sec-fetch-site': 'same-origin' }]) assert.equal(browserAuthOriginOk(req(headers), origin), true);
});

test('ceremony cookies bind one challenge, reject duplicates, and permit concurrent tabs', () => {
  const auth = createBrowserAuth({ origin, secret: crypto.randomBytes(32) });
  const first = crypto.randomBytes(16).toString('base64url');
  const second = crypto.randomBytes(16).toString('base64url');
  const a = auth.issue(first).split(';')[0], b = auth.issue(second).split(';')[0];
  assert.match(auth.issue(first), /^__Host-gymceremony-/);
  assert.match(auth.issue(first), /Max-Age=300; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
  assert.equal(auth.matches(req({}), first), false);
  assert.equal(auth.matches(req({ cookie: b }), first), false);
  assert.equal(auth.matches(req({ cookie: a + '; ' + a }), first), false);
  assert.equal(auth.matches(req({ cookie: a + '; ' + b }), first), true);
  assert.equal(auth.matches(req({ cookie: a + '; ' + b }), second), true);
  assert.equal(auth.matches(req({ cookie: a.slice(0, -1) + '!' }), first), false);
  assert.equal(auth.matches(req({ cookie: a }), null), false);
  assert.match(auth.clear(first), /Max-Age=0/);
});

test('localhost development receives an unprefixed cookie without Secure', () => {
  const auth = createBrowserAuth({ origin: 'http://localhost:8080', secret: crypto.randomBytes(32) });
  const cookie = auth.issue(crypto.randomBytes(16).toString('base64url'));
  assert.match(cookie, /^gymceremony-/);
  assert.doesNotMatch(cookie, /Secure/);
});
