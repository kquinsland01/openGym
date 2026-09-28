import crypto from 'node:crypto';

// Cookie-setting passkey flows cannot borrow the generic Bearer exemption. Check both browser
// signals when present: a valid signed assertion does not identify the HTTP submitting browser.
export function browserAuthOriginOk(req, expectedOrigin) {
  const origin = req.headers.origin;
  if (origin && origin.replace(/\/+$/, '') !== expectedOrigin.replace(/\/+$/, '')) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return false;
  // Non-browser clients can omit these headers, but must still keep the ceremony cookie.
  return true;
}

export function createBrowserAuth({ origin, secret }) {
  const secure = /^https:/i.test(origin);
  const prefix = (secure ? '__Host-' : '') + 'gymceremony-';
  const validId = cid => typeof cid === 'string' && /^[A-Za-z0-9_-]{22}$/.test(cid);
  const token = cid => crypto.createHmac('sha256', secret).update('browser-ceremony:' + cid).digest('base64url');
  const attributes = `; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Strict`;
  return {
    // Independent names let two tabs start their first ceremony simultaneously. No shared
    // browser cookie is overwritten. Unfinished prompts disappear from the cookie jar in 5 min.
    issue(cid) {
      if (!validId(cid)) throw new Error('invalid ceremony id');
      return `${prefix}${cid}=${token(cid)}; Max-Age=300${attributes}`;
    },
    clear(cid) { return `${prefix}${cid}=; Max-Age=0${attributes}`; },
    matches(req, cid) {
      if (!validId(cid)) return false;
      const name = prefix + cid;
      const values = (req.headers.cookie || '').split(';').flatMap(part => {
        const i = part.indexOf('=');
        return i >= 0 && part.slice(0, i).trim() === name ? [part.slice(i + 1).trim()] : [];
      });
      if (values.length !== 1) return false;
      const want = Buffer.from(token(cid)), got = Buffer.from(values[0]);
      return got.length === want.length && crypto.timingSafeEqual(got, want);
    }
  };
}
