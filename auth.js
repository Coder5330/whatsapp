const crypto = require('crypto');

// ---- Configuration ----
// The viewer is locked behind a single shared password, set via the
// APP_PASSWORD environment variable. There is deliberately no default and
// no way to skip it: if APP_PASSWORD is unset the app refuses to serve any
// page rather than quietly falling open to the whole internet.
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const isConfigured = APP_PASSWORD.length > 0;

// Login cookies are signed with a key derived from the password itself
// (unless SESSION_SECRET is set explicitly). Deriving it means sessions
// survive restarts and redeploys, and changing APP_PASSWORD automatically
// invalidates every cookie that was issued under the old one.
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  (isConfigured
    ? crypto.createHash('sha256').update('wa-viewer/v1:' + APP_PASSWORD).digest('hex')
    : '');

const COOKIE_NAME = 'wa_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ---- Brute-force throttling ----
// Small in-memory tally per client IP. Not distributed and not persistent —
// it resets on restart — but enough to make guessing a shared password over
// the network impractical.
const MAX_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;
const attempts = new Map();

function clientKey(req) {
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

function lockoutRemainingMs(req) {
  const entry = attempts.get(clientKey(req));
  if (!entry || !entry.lockedUntil) return 0;
  const remaining = entry.lockedUntil - Date.now();
  return remaining > 0 ? remaining : 0;
}

function recordFailure(req) {
  const key = clientKey(req);
  const now = Date.now();
  const entry = attempts.get(key);

  if (!entry || now - entry.firstAt > ATTEMPT_WINDOW_MS) {
    attempts.set(key, { count: 1, firstAt: now, lockedUntil: 0 });
    return;
  }
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = now + LOCKOUT_MS;
    entry.count = 0;
    entry.firstAt = now;
  }
}

function clearFailures(req) {
  attempts.delete(clientKey(req));
}

// ---- Password + cookie primitives ----

// Compare via fixed-length digests so the comparison is constant time and
// doesn't leak the password's length through timing.
function passwordMatches(candidate) {
  if (!isConfigured || typeof candidate !== 'string' || candidate.length === 0) return false;
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(APP_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(String(value)).digest('hex');
}

function issueToken() {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  return expiresAt + '.' + sign(expiresAt);
}

function tokenIsValid(token) {
  if (!isConfigured || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;

  const expiresAt = Number(token.slice(0, dot));
  const signature = token.slice(dot + 1);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;

  const expected = sign(expiresAt);
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[name] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

function isLoggedIn(req) {
  return tokenIsValid(parseCookies(req)[COOKIE_NAME]);
}

function setSessionCookie(req, res) {
  res.cookie(COOKIE_NAME, issueToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    maxAge: SESSION_TTL_MS,
    path: '/'
  });
}

function clearSessionCookie(req, res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    path: '/'
  });
}

function isSecureRequest(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

// Only allow redirects back to a path on this same site, so a crafted
// ?next=... can't bounce someone to an attacker's page after login.
function safeNextPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return '/';
  if (value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
}

module.exports = {
  COOKIE_NAME,
  isConfigured,
  isLoggedIn,
  passwordMatches,
  setSessionCookie,
  clearSessionCookie,
  safeNextPath,
  lockoutRemainingMs,
  recordFailure,
  clearFailures
};
