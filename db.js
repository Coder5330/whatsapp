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

-- Baileys speaks WhatsApp's protocol and keeps nothing: no chat list, no
-- history. Whatever arrives over the socket is ours to store or lose. So
-- the viewer reads from here rather than from a live client, which also
-- means history survives a restart instead of being re-synced each boot.
CREATE TABLE IF NOT EXISTS wa_chats (
  inbox_id     TEXT NOT NULL,
  chat_id      TEXT NOT NULL,
  name         TEXT,
  is_group     BOOLEAN NOT NULL DEFAULT false,
  unread_count INTEGER DEFAULT 0,
  last_ts      BIGINT,
  last_text    TEXT,
  last_media   TEXT,
  PRIMARY KEY (inbox_id, chat_id)
);

CREATE INDEX IF NOT EXISTS wa_chats_recent ON wa_chats (inbox_id, last_ts DESC);

CREATE TABLE IF NOT EXISTS wa_messages (
  inbox_id    TEXT NOT NULL,
  chat_id     TEXT NOT NULL,
  msg_id      TEXT NOT NULL,
  from_me     BOOLEAN NOT NULL DEFAULT false,
  sender_name TEXT,
  body        TEXT,
  ts          BIGINT NOT NULL,
  media_kind  TEXT,
  raw         JSONB,
  PRIMARY KEY (inbox_id, msg_id)
);

CREATE INDEX IF NOT EXISTS wa_messages_thread
  ON wa_messages (inbox_id, chat_id, ts DESC);

-- Who a jid belongs to. Baileys hands the address book over once, during
-- the first history sync, and never again — so holding it in memory meant
-- losing every name at the next restart and falling back to bare phone
-- numbers. It belongs on disk with everything else.
CREATE TABLE IF NOT EXISTS wa_contacts (
  inbox_id TEXT NOT NULL,
  jid      TEXT NOT NULL,
  name     TEXT,
  PRIMARY KEY (inbox_id, jid)
);

-- Earlier versions declared unread_count NOT NULL. A row derived from a
-- message has no opinion about unread counts and passes null so it cannot
-- reset one, which that constraint rejected.
ALTER TABLE wa_chats ALTER COLUMN unread_count DROP NOT NULL;

-- Profile pictures. WhatsApp serves them from signed URLs that expire, so
-- the fetch time is kept too: a null url with a recent timestamp means
-- "asked, there isn't one", which is worth remembering so it is not asked
-- again on every sync.
ALTER TABLE wa_chats ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE wa_chats ADD COLUMN IF NOT EXISTS avatar_checked_at BIGINT;

-- The picture itself, not a link to it. WhatsApp serves profile pictures
-- from signed URLs that expire; handing one to a browser meant it worked
-- until the signature died and then silently fell back to initials, which
-- is indistinguishable from having no picture at all. A preview is a few
-- KB, so keeping the bytes is cheap and it cannot go stale on someone
-- else's schedule.
ALTER TABLE wa_chats ADD COLUMN IF NOT EXISTS avatar_bytes BYTEA;
ALTER TABLE wa_chats ADD COLUMN IF NOT EXISTS avatar_mime TEXT;

-- Migrations that must happen exactly once, rather than on every boot.
-- Without this, "re-check everything" would mean re-checking everything at
-- every restart, which is how an account gets rate-limited by WhatsApp.
CREATE TABLE IF NOT EXISTS schema_meta (
  key        TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- An earlier version recorded a chat as checked once it had a URL, before
-- there was anywhere to put the picture itself. Those rows count as checked
-- and so are skipped for twelve hours, but hold no bytes to show — the
-- pictures could never appear. Mark them unchecked so they are fetched
-- properly. Rows where WhatsApp genuinely offered no picture have no url
-- either and are left alone.
UPDATE wa_chats
   SET avatar_checked_at = NULL
 WHERE avatar_bytes IS NULL
   AND avatar_url IS NOT NULL;

-- An earlier version stored the chat's own number as its name. That is not
-- a name, and because the column is COALESCEd on write it outranks the real
-- one forever once written. Clear those rows; the number is derived from
-- the jid at read time, so nothing is lost and the next real name sticks.
UPDATE wa_chats
   SET name = NULL
 WHERE name IS NOT NULL
   AND name = split_part(chat_id, '@', 1);
`;

// Applies `sql` only if this key has never been recorded. The key insert
// and the work share a transaction, so a crash midway leaves the key unset
// and the migration is retried next boot rather than silently skipped.
async function runOnce(key, sql) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO schema_meta (key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING key',
      [key]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return false;
    }
    const result = await client.query(sql);
    await client.query('COMMIT');
    console.log(`Migration ${key}: ${result.rowCount ?? 0} rows.`);
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.warn(`Migration ${key} failed, will retry next boot:`, err.message);
    return false;
  } finally {
    client.release();
  }
}

async function init() {
  await getPool().query(SCHEMA);

  // Every chat asked about before profile pictures actually worked was
  // recorded as checked and left blank, and blank is indistinguishable from
  // "this person has no picture" — so each would sit untouched for twelve
  // hours. Ask about all of them once more, and let the answers be recorded
  // with reasons this time. Once only: after this, a blank result really
  // does mean there is no picture.
  await runOnce(
    'avatar-recheck-after-download-fix',
    'UPDATE wa_chats SET avatar_checked_at = NULL WHERE avatar_bytes IS NULL'
  );
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

// Ids are lowercase slugs, but earlier versions seeded them straight from a
// hardcoded list that used capitals ("Marshall"). Postgres text keys are
// case-sensitive, so "Marshall" and "marshall" became two inboxes — two
// Chromium instances, two setup codes, one of them pointing at an empty
// session. Fold each mixed-case row down onto its lowercase id.
//
// Returns the renames it performed so the caller can move the matching
// session directories on disk.
async function mergeMixedCaseInboxes() {
  const { rows } = await getPool().query(
    'SELECT id FROM inboxes WHERE id <> lower(id)'
  );
  const renames = [];

  for (const { id } of rows) {
    const lower = id.toLowerCase();
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');

      const { rows: existing } = await client.query(
        'SELECT id FROM inboxes WHERE id = $1',
        [lower]
      );

      if (existing.length === 0) {
        // Nothing in the way — just rename it, credentials and all.
        await client.query('UPDATE inboxes SET id = $2 WHERE id = $1', [id, lower]);
        await client.query(
          'UPDATE inbox_credentials SET user_id = $2 WHERE user_id = $1',
          [id, lower]
        );
      } else {
        // Both exist. Keep whichever credential someone has actually set a
        // password on; a claimed inbox is a person who has already been
        // through setup, and losing that would lock them out.
        const { rows: creds } = await client.query(
          `SELECT user_id, password_hash FROM inbox_credentials
            WHERE user_id IN ($1, $2)`,
          [id, lower]
        );
        const mixed = creds.find((c) => c.user_id === id);
        const plain = creds.find((c) => c.user_id === lower);

        if (mixed && mixed.password_hash && !(plain && plain.password_hash)) {
          await client.query('DELETE FROM inbox_credentials WHERE user_id = $1', [lower]);
          await client.query(
            'UPDATE inbox_credentials SET user_id = $2 WHERE user_id = $1',
            [id, lower]
          );
        } else {
          await client.query('DELETE FROM inbox_credentials WHERE user_id = $1', [id]);
        }
        await client.query('DELETE FROM inboxes WHERE id = $1', [id]);
      }

      await client.query('COMMIT');
      renames.push({ from: id, to: lower });
      console.log(`Folded inbox "${id}" onto "${lower}".`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`Could not fold inbox "${id}" onto "${lower}":`, err.message);
    } finally {
      client.release();
    }
  }

  return renames;
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

// ---- Chats and messages ----

// History sync arrives in bulk, so write in chunks rather than a statement
// per row; a busy account can produce thousands of messages at once.
const WRITE_CHUNK = 200;

function chunk(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) out.push(rows.slice(i, i + WRITE_CHUNK));
  return out;
}

// contacts: [{ jid, name }]. Only rows carrying a name are worth writing —
// a null would say nothing that the jid does not already say.
async function upsertContacts(inboxId, contacts) {
  const rows = contacts.filter((c) => c.jid && c.name);
  if (!rows.length) return 0;

  for (const group of chunk(rows)) {
    const values = [];
    const params = [];
    group.forEach((c, i) => {
      const b = i * 3;
      values.push(`($${b + 1}, $${b + 2}, $${b + 3})`);
      params.push(inboxId, c.jid, c.name);
    });
    await getPool().query(
      `INSERT INTO wa_contacts (inbox_id, jid, name)
       VALUES ${values.join(', ')}
       ON CONFLICT (inbox_id, jid) DO UPDATE SET
         name = COALESCE(EXCLUDED.name, wa_contacts.name)`,
      params
    );
  }
  return rows.length;
}

// Every message already carries the sender's own display name, and those
// are already stored. So a chat that has ever received a message can be
// named right now instead of waiting for the next one to arrive — which is
// what made names trickle in over several minutes.
//
// One-to-one chats only: whoever last spoke in a group does not name it.
async function backfillContactNames(inboxId) {
  const { rowCount } = await getPool().query(
    `INSERT INTO wa_contacts (inbox_id, jid, name)
     SELECT DISTINCT ON (m.chat_id) $1, m.chat_id, m.sender_name
       FROM wa_messages m
       JOIN wa_chats c
         ON c.inbox_id = m.inbox_id AND c.chat_id = m.chat_id AND c.is_group = false
      WHERE m.inbox_id = $1
        AND m.from_me = false
        AND m.sender_name IS NOT NULL
        AND m.sender_name <> ''
        AND m.sender_name <> split_part(m.chat_id, '@', 1)
      ORDER BY m.chat_id, m.ts DESC
     ON CONFLICT (inbox_id, jid) DO NOTHING`,
    [inboxId]
  );
  return rowCount || 0;
}

// Read back at startup so a restart does not begin with every name blank.
async function listContacts(inboxId) {
  const { rows } = await getPool().query(
    `SELECT jid, name FROM wa_contacts WHERE inbox_id = $1 AND name IS NOT NULL`,
    [inboxId]
  );
  return rows.map((r) => ({ jid: r.jid, name: r.name }));
}

// A null url records that WhatsApp was asked and had nothing to give, which
// stops the next sync from asking again.
// A default parameter only covers `undefined`, so a caller passing null —
// the natural way to say "there is no picture" — would throw on destructuring.
async function setChatAvatar(inboxId, chatId, picture) {
  const { url = null, bytes = null, mimetype = null } = picture || {};
  await getPool().query(
    `UPDATE wa_chats
        SET avatar_url = $3, avatar_bytes = $4, avatar_mime = $5, avatar_checked_at = $6
      WHERE inbox_id = $1 AND chat_id = $2`,
    [inboxId, chatId, url, bytes, mimetype, Date.now()]
  );
}

// The bytes for one chat, read only when the browser asks for that picture.
async function getChatAvatar(inboxId, chatId) {
  const { rows } = await getPool().query(
    `SELECT avatar_bytes, avatar_mime FROM wa_chats
      WHERE inbox_id = $1 AND chat_id = $2 AND avatar_bytes IS NOT NULL`,
    [inboxId, chatId]
  );
  if (!rows.length) return null;
  return { buffer: rows[0].avatar_bytes, mimetype: rows[0].avatar_mime || 'image/jpeg' };
}

// The chats worth asking about: most recent first, and only those never
// checked or checked longer ago than `staleBefore`.
// How many chats there are to have pictures for, so "nothing to do" can be
// told apart from "nothing happened".
async function countChatsWithAvatar(inboxId) {
  const { rows } = await getPool().query(
    `SELECT count(*)::int AS total,
            count(avatar_bytes)::int AS with_picture
       FROM wa_chats WHERE inbox_id = $1`,
    [inboxId]
  );
  return { total: rows[0].total, withPicture: rows[0].with_picture };
}

async function chatsNeedingAvatar(inboxId, staleBefore, limit) {
  const { rows } = await getPool().query(
    `SELECT chat_id FROM wa_chats
      WHERE inbox_id = $1
        AND (avatar_checked_at IS NULL OR avatar_checked_at < $2)
      ORDER BY last_ts DESC NULLS LAST
      LIMIT $3`,
    [inboxId, staleBefore, limit]
  );
  return rows.map((r) => r.chat_id);
}

// chats: [{ id, name, isGroup, unreadCount, lastTs, lastText, lastMedia }]
async function upsertChats(inboxId, chats) {
  if (!chats.length) return;

  for (const group of chunk(chats)) {
    const values = [];
    const params = [];
    group.forEach((c, i) => {
      const b = i * 8;
      values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8})`);
      params.push(
        inboxId, c.id, c.name || null, !!c.isGroup,
        // null means "no opinion" — a row derived from a message knows the
        // text and timestamp but nothing about how many are unread, and
        // must not reset a count the chat list actually reported.
        c.unreadCount === null || c.unreadCount === undefined
          ? null
          : Number(c.unreadCount) || 0,
        c.lastTs === undefined || c.lastTs === null ? null : String(c.lastTs),
        c.lastText || null, c.lastMedia || null
      );
    });

    // A later sync can carry less detail than an earlier one, so keep the
    // better value rather than letting a null overwrite a real name or a
    // newer timestamp go backwards.
    await getPool().query(
      `INSERT INTO wa_chats
         (inbox_id, chat_id, name, is_group, unread_count, last_ts, last_text, last_media)
       VALUES ${values.join(', ')}
       ON CONFLICT (inbox_id, chat_id) DO UPDATE SET
         name         = COALESCE(EXCLUDED.name, wa_chats.name),
         is_group     = EXCLUDED.is_group,
         unread_count = COALESCE(EXCLUDED.unread_count, wa_chats.unread_count),
         last_ts      = GREATEST(COALESCE(EXCLUDED.last_ts, 0), COALESCE(wa_chats.last_ts, 0)),
         last_text    = CASE WHEN COALESCE(EXCLUDED.last_ts, 0) >= COALESCE(wa_chats.last_ts, 0)
                             THEN EXCLUDED.last_text ELSE wa_chats.last_text END,
         last_media   = CASE WHEN COALESCE(EXCLUDED.last_ts, 0) >= COALESCE(wa_chats.last_ts, 0)
                             THEN EXCLUDED.last_media ELSE wa_chats.last_media END`,
      params
    );
  }
}

// messages: [{ id, chatId, fromMe, senderName, body, ts, mediaKind, raw }]
async function upsertMessages(inboxId, messages) {
  if (!messages.length) return;

  for (const group of chunk(messages)) {
    const values = [];
    const params = [];
    group.forEach((m, i) => {
      const b = i * 9;
      values.push(
        `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9})`
      );
      params.push(
        inboxId, m.chatId, m.id, !!m.fromMe, m.senderName || null,
        m.body || null, String(m.ts || 0), m.mediaKind || null,
        m.raw ? JSON.stringify(m.raw) : null
      );
    });

    await getPool().query(
      `INSERT INTO wa_messages
         (inbox_id, chat_id, msg_id, from_me, sender_name, body, ts, media_kind, raw)
       VALUES ${values.join(', ')}
       ON CONFLICT (inbox_id, msg_id) DO UPDATE SET
         body       = COALESCE(EXCLUDED.body, wa_messages.body),
         media_kind = COALESCE(EXCLUDED.media_kind, wa_messages.media_kind),
         raw        = COALESCE(EXCLUDED.raw, wa_messages.raw)`,
      params
    );
  }
}

async function listChats(inboxId, limit = 200) {
  const { rows } = await getPool().query(
    `SELECT c.chat_id, c.is_group, c.unread_count, c.last_ts, c.last_text,
            c.last_media, (c.avatar_bytes IS NOT NULL) AS has_avatar,
            -- A group is named by its subject, which only the chat row has.
            -- A person is named by the address book, which beats whatever
            -- name they set on their own phone.
            CASE WHEN c.is_group THEN COALESCE(c.name, ct.name)
                 ELSE COALESCE(ct.name, c.name) END AS name
       FROM wa_chats c
       LEFT JOIN wa_contacts ct
         ON ct.inbox_id = c.inbox_id AND ct.jid = c.chat_id
      WHERE c.inbox_id = $1
      ORDER BY c.last_ts DESC NULLS LAST
      LIMIT $2`,
    [inboxId, limit]
  );
  return rows.map((r) => ({
    id: r.chat_id,
    // The number is the fallback, computed here rather than stored — a name
    // written into the row would outrank the real one when it arrives.
    name: r.name || r.chat_id.split('@')[0],
    // Whether there is a picture to ask for — never the bytes, which would
    // make the chat list enormous.
    hasAvatar: !!r.has_avatar,
    isGroup: r.is_group,
    unreadCount: r.unread_count || 0,
    lastMessage: r.last_ts
      ? {
          body: r.last_text || '',
          timestamp: Number(r.last_ts) * 1000,
          hasMedia: !!r.last_media,
          mediaKind: r.last_media
        }
      : null
  }));
}

async function listMessages(inboxId, chatId, limit = 100) {
  const { rows } = await getPool().query(
    `SELECT msg_id, from_me, sender_name, body, ts, media_kind
       FROM wa_messages
      WHERE inbox_id = $1 AND chat_id = $2
      ORDER BY ts DESC
      LIMIT $3`,
    [inboxId, chatId, limit]
  );
  // Newest first out of the database so the LIMIT keeps recent messages;
  // the viewer wants them oldest first.
  return rows.reverse().map((r) => ({
    id: r.msg_id,
    fromMe: r.from_me,
    fromName: r.from_me ? 'You' : r.sender_name || 'Unknown',
    body: r.body || '',
    timestamp: Number(r.ts) * 1000,
    hasMedia: !!r.media_kind,
    mediaKind: r.media_kind
  }));
}

// The stored protocol message, needed to download its media later.
async function getMessageRaw(inboxId, msgId) {
  const { rows } = await getPool().query(
    'SELECT raw, media_kind FROM wa_messages WHERE inbox_id = $1 AND msg_id = $2',
    [inboxId, msgId]
  );
  if (rows.length === 0) return null;
  return { raw: rows[0].raw, mediaKind: rows[0].media_kind };
}

async function countChats(inboxId) {
  const { rows } = await getPool().query(
    'SELECT count(*)::int AS n FROM wa_chats WHERE inbox_id = $1',
    [inboxId]
  );
  return rows[0].n;
}

// Used when an inbox is unlinked: its history belongs to a WhatsApp account
// that is no longer connected here.
async function clearInboxHistory(inboxId) {
  await getPool().query('DELETE FROM wa_messages WHERE inbox_id = $1', [inboxId]);
  await getPool().query('DELETE FROM wa_chats WHERE inbox_id = $1', [inboxId]);
  await getPool().query('DELETE FROM wa_contacts WHERE inbox_id = $1', [inboxId]);
}

async function close() {
  if (pool) await pool.end();
}

module.exports = {
  MAX_INBOXES,
  isConfigured,
  init,
  listInboxes,
  mergeMixedCaseInboxes,
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
  upsertChats,
  upsertContacts,
  backfillContactNames,
  listContacts,
  setChatAvatar,
  getChatAvatar,
  chatsNeedingAvatar,
  countChatsWithAvatar,
  upsertMessages,
  listChats,
  listMessages,
  getMessageRaw,
  countChats,
  clearInboxHistory,
  close
};
