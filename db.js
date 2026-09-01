// Per-inbox credentials, stored in Postgres (Neon).
//
// The viewer runs on an ephemeral container with a volume only for the
// WhatsApp sessions themselves, so credentials live in Neon instead: they
// survive redeploys, volume changes, and running more than one instance.

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || '';
const isConfigured = DATABASE_URL.length > 0;

// Neon always wants TLS. A local Postgres used for development usually has
// no certificate at all, so only skip TLS for loopback or an explicit
// sslmode=disable — never for a remote host.
function sslSettingFor(url) {
  if (/[?&]sslmode=disable/.test(url)) return false;
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return { rejectUnauthorized: true };
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
  return { rejectUnauthorized: true };
}

let pool = null;

function getPool() {
  if (!isConfigured) throw new Error('DATABASE_URL is not configured');
  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: sslSettingFor(DATABASE_URL),
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });
    // A pool-level error (Neon idling a connection out, a network blip)
    // must not take the process down; pg hands the next query a new socket.
    pool.on('error', (err) => console.warn('Postgres pool error:', err.message));
  }
  return pool;
}

// How many inboxes may exist at once. Each one runs its own headless
// Chromium, so this is a memory ceiling as much as a policy.
const MAX_INBOXES = 4;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inbox_credentials (
  user_id         TEXT PRIMARY KEY,
  password_hash   TEXT,
  claim_code_hash TEXT,
  claimed_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inboxes (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function init() {
  await getPool().query(SCHEMA);
}

// Returns { userId, passwordHash, claimCodeHash, claimedAt } or null.
async function getCredential(userId) {
  const { rows } = await getPool().query(
    `SELECT user_id, password_hash, claim_code_hash, claimed_at
       FROM inbox_credentials WHERE user_id = $1`,
    [userId]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    userId: r.user_id,
    passwordHash: r.password_hash,
    claimCodeHash: r.claim_code_hash,
    claimedAt: r.claimed_at
  };
}

async function isClaimed(userId) {
  const cred = await getCredential(userId);
  return !!(cred && cred.passwordHash);
}

// Store a freshly issued claim code, replacing any previous one. Refuses to
// touch an inbox that already has a password — claiming happens once.
async function storeClaimCode(userId, claimCodeHash) {
  const { rowCount } = await getPool().query(
    `INSERT INTO inbox_credentials (user_id, claim_code_hash)
          VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE
            SET claim_code_hash = EXCLUDED.claim_code_hash,
                updated_at = now()
          WHERE inbox_credentials.password_hash IS NULL`,
    [userId, claimCodeHash]
  );
  return rowCount > 0;
}

// Set the password and burn the claim code, but only while the inbox is
// still unclaimed. Doing both in one statement means two people racing the
// same code cannot both win — the second update matches no rows.
async function claimInbox(userId, passwordHash) {
  const { rowCount } = await getPool().query(
    `UPDATE inbox_credentials
        SET password_hash = $2,
            claim_code_hash = NULL,
            claimed_at = now(),
            updated_at = now()
      WHERE user_id = $1 AND password_hash IS NULL`,
    [userId, passwordHash]
  );
  return rowCount > 0;
}

async function updatePassword(userId, passwordHash) {
  const { rowCount } = await getPool().query(
    `UPDATE inbox_credentials
        SET password_hash = $2, updated_at = now()
      WHERE user_id = $1 AND password_hash IS NOT NULL`,
    [userId, passwordHash]
  );
  return rowCount > 0;
}

// Admin escape hatch for a forgotten password: wipes the credential so the
// inbox can be claimed again with a new code.
async function resetInbox(userId) {
  await getPool().query(
    `INSERT INTO inbox_credentials (user_id, password_hash, claim_code_hash, claimed_at)
          VALUES ($1, NULL, NULL, NULL)
     ON CONFLICT (user_id) DO UPDATE
            SET password_hash = NULL,
                claim_code_hash = NULL,
                claimed_at = NULL,
                updated_at = now()`,
    [userId]
  );
}

// ---- The inbox registry ----

async function listInboxes() {
  const { rows } = await getPool().query(
    'SELECT id, name FROM inboxes ORDER BY created_at, id'
  );
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

async function countInboxes() {
  const { rows } = await getPool().query('SELECT count(*)::int AS n FROM inboxes');
  return rows[0].n;
}

async function inboxExists(id) {
  const { rows } = await getPool().query('SELECT 1 FROM inboxes WHERE id = $1', [id]);
  return rows.length > 0;
}

// The cap is enforced inside the statement rather than by a read-then-write,
// so two people creating an inbox at the same moment cannot both slip past
// the limit. Returns false when the cap is full or the id is taken.
async function createInbox(id, name) {
  const { rowCount } = await getPool().query(
    `INSERT INTO inboxes (id, name)
     SELECT $1, $2
      WHERE (SELECT count(*) FROM inboxes) < $3
     ON CONFLICT (id) DO NOTHING`,
    [id, name, MAX_INBOXES]
  );
  return rowCount > 0;
}

// Carry the previously hardcoded people into the registry on first boot,
// keeping their ids so their existing session folders still match.
async function seedInboxes(users) {
  for (const user of users) {
    await getPool().query(
      `INSERT INTO inboxes (id, name) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [user.id, user.name]
    );
  }
}

async function close() {
  if (pool) await pool.end();
}

module.exports = {
  MAX_INBOXES,
  isConfigured,
  init,
  listInboxes,
  countInboxes,
  inboxExists,
  createInbox,
  seedInboxes,
  getCredential,
  isClaimed,
  storeClaimCode,
  claimInbox,
  updatePassword,
  resetInbox,
  close
};
