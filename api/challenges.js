import crypto from 'node:crypto';

// Configuration cannot disable a bound accidentally. The fixed five-minute lifetime matches
// the authenticator ceremony; a full store rejects newcomers instead of evicting live prompts.
export function challengeLimits(env = process.env) {
  const number = (key, fallback, ceiling) => {
    const n = Number(env[key]);
    return Number.isSafeInteger(n) && n >= 1 && n <= ceiling ? n : fallback;
  };
  return {
    maxEntries: number('AUTH_CHALLENGE_MAX', 4096, 100000),
    maxPending: number('AUTH_CHALLENGE_CONCURRENCY', 32, 256),
    perMinute: number('AUTH_CHALLENGE_PER_MINUTE', 600, 10000)
  };
}

export class ChallengeBusyError extends Error {
  constructor(retryAfter) {
    super('challenge admission exhausted');
    this.retryAfter = Math.max(1, Math.ceil(retryAfter));
  }
}

export function createChallengeStore({ maxEntries = 4096, maxPending = 32, perMinute = 600,
  ttlMs = 5 * 60000, now = Date.now } = {}) {
  const entries = new Map();
  let pending = 0, credits = perMinute, refilledAt = now();
  function sweep(at = now()) {
    for (const [id, c] of entries) if (c.exp <= at) entries.delete(id);
  }
  return {
    sweep,
    // Inspect without consuming so a browser-binding refusal can preserve a live prompt.
    get: id => entries.get(id),
    take(id) {
      const c = entries.get(id);
      entries.delete(id);
      return c && c.exp > now() ? c : null;
    },
    async issue(makeOptions, data) {
      const at = now();
      sweep(at);
      credits = Math.min(perMinute, credits + Math.max(0, at - refilledAt) * perMinute / 60000);
      refilledAt = at;
      if (pending >= maxPending) throw new ChallengeBusyError(1);
      if (entries.size + pending >= maxEntries) {
        const expiry = entries.values().next().value?.exp;
        throw new ChallengeBusyError(expiry ? (expiry - at) / 1000 : 1);
      }
      if (credits < 1) throw new ChallengeBusyError((1 - credits) * 60 / perMinute);
      // Reserving before the await bounds both unresolved generation and completed challenges.
      // Failed attempts still spend the issuance credit, but always release their reservation.
      credits--;
      pending++;
      try {
        const options = await makeOptions();
        const cid = crypto.randomBytes(16).toString('base64url');
        entries.set(cid, { ...data, challenge: options.challenge, exp: now() + ttlMs });
        return { cid, options };
      } finally { pending--; }
    }
  };
}
