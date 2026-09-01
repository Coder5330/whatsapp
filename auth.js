const crypto = require('crypto');

// Per-inbox authentication.
//
// Every person sets their own password for their own inbox. Nobody sets it
// for them: the server issues a one-time claim code at the moment that
// person links their WhatsApp by scanning the QR code, and only someone
// holding that code can set the inbox's first password. Possession of the
// phone that scanned is the proof of ownership.

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ---- Password / claim-code hashing (scrypt) ----

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

function hashSecret(plain) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(plain, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('hex'), key.toString('hex')].join('$');
}

function verifySecret(plain, stored) {
  if (typeof plain !== 'string' || typeof stored !== 'string' || !stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, n, r, p, saltHex, keyHex] = parts;
  let candidate;
  try {
    candidate = crypto.scryptSync(plain, Buffer.from(saltHex, 'hex'), keyHex.length / 2, {
      N: Number(n),
      r: Number(r),
      p: Number(p)
    });
  } catch {
    return false;
  }
  const expected = Buffer.from(keyHex, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

// ---- Claim codes ----

// Crockford-ish alphabet: no O/0, I/1, U. These get read aloud and retyped
// by hand, so the ambiguous characters are worth losing.
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTVWXYZ';

function generateClaimCode() {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (i === 3) out += '-';
  }
  return out;
}

// Accept the code however it comes back: lowercase, spaces, missing dash.
function normalizeClaimCode(value) {
  if (typeof value !== 'string') return '';
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashClaimCode(code) {
  return hashSecret(normalizeClaimCode(code));
}

function claimCodeMatches(candidate, storedHash) {
  return verifySecret(normalizeClaimCode(candidate), storedHash);
}

// ---- Password rules ----

const MIN_PASSWORD_LENGTH = 8;

function passwordProblem(password, confirm) {
  if (typeof password !== 'string' || password.length === 0) return 'Choose a password.';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return 'Use at least ' + MIN_PASSWORD_LENGTH + ' characters.';
  }
  if (password.length > 200) return 'That password is too long.';
  if (confirm !== undefined && password !== confirm) return 'The two passwords do not match.';
  return null;
}

// ---- Session cookies ----

// One cookie per inbox, so signing in as Joshua grants nothing on
// Marshall's inbox. The id is sanitised for the cookie name and a short
// digest appended so two ids cannot collide onto one cookie.
function cookieNameFor(userId) {
  const safe = String(userId).replace(/[^A-Za-z0-9_-]/g, '_');
  const digest = crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 8);
  return 'wa_s_' + safe + '_' + digest;
}

// The signing key is derived from the stored password hash, so changing a
// password invalidates that person's existing cookies for free.
// SESSION_SECRET is optional: the password hash is already server-side-only
// and unguessable.
function keyFor(userId, passwordHash) {
  return crypto
    .createHmac('sha256', process.env.SESSION_SECRET || 'wa-viewer/per-inbox/v1')
    .update(String(userId) + ' ' + String(passwordHash))
    .digest();
}

function issueToken(userId, passwordHash) {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const sig = crypto
    .createHmac('sha256', keyFor(userId, passwordHash))
    .update(String(expiresAt))
    .digest('hex');
  return expiresAt + '.' + sig;
}

function tokenIsValid(token, userId, passwordHash) {
  if (typeof token !== 'string' || !passwordHash) return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;

  const expiresAt = Number(token.slice(0, dot));
  const signature = token.slice(dot + 1);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;

  const expected = crypto
    .createHmac('sha256', keyFor(userId, passwordHash))
    .update(String(expiresAt))
    .digest('hex');
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
    const raw = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

function isSecureRequest(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

function isLoggedInAs(req, userId, passwordHash) {
  return tokenIsValid(parseCookies(req)[cookieNameFor(userId)], userId, passwordHash);
}

function setSessionCookie(req, res, userId, passwordHash) {
  res.cookie(cookieNameFor(userId), issueToken(userId, passwordHash), {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    maxAge: SESSION_TTL_MS,
    path: '/'
  });
}

function clearSessionCookie(req, res, userId) {
  res.clearCookie(cookieNameFor(userId), {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    path: '/'
  });
}

// ---- Brute-force throttling, per (IP, inbox) ----

const MAX_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;
const attempts = new Map();

function attemptKey(req, userId) {
  return (req.ip || 'unknown') + '|' + userId;
}

function lockoutRemainingMs(req, userId) {
  const entry = attempts.get(attemptKey(req, userId));
  if (!entry || !entry.lockedUntil) return 0;
  const remaining = entry.lockedUntil - Date.now();
  return remaining > 0 ? remaining : 0;
}

function recordFailure(req, userId) {
  const key = attemptKey(req, userId);
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

function clearFailures(req, userId) {
  attempts.delete(attemptKey(req, userId));
}

// Only allow redirects back to a path on this same site, so a crafted
// ?next=... cannot bounce someone to an attacker's page after login.
function safeNextPath(value, fallback = '/') {
  if (typeof value !== 'string' || !value.startsWith('/')) return fallback;
  if (value.startsWith('//') || value.charAt(1) === '\\') return fallback;
  return value;
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  hashSecret,
  verifySecret,
  generateClaimCode,
  normalizeClaimCode,
  hashClaimCode,
  claimCodeMatches,
  passwordProblem,
  isLoggedInAs,
  setSessionCookie,
  clearSessionCookie,
  lockoutRemainingMs,
  recordFailure,
  clearFailures,
  safeNextPath
};
