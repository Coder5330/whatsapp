const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const wa = require('./wa');
const auth = require('./auth');
const db = require('./db');
const views = require('./views');

const PORT = process.env.PORT || 3000;
const SESSION_ROOT = process.env.SESSION_PATH || '/data/sessions';

// ---- Inboxes ----
// The people who existed before inboxes were stored in the database. They
// are inserted on first boot and then live in the `inboxes` table like any
// other; their ids must not change, because each one names a session folder
// on the volume that is already linked to a real WhatsApp account.
const SEED_USERS = [
  { id: 'joshua', name: 'Joshua' },
  { id: 'marshall', name: 'Marshall' },
  { id: 'yuanbin', name: 'Yuanbin' },
];

// The live registry, loaded from the database at boot and appended to when
// someone creates an inbox. `id` is used in URLs and as the session folder
// name, so it is always a slug (see slugify below).
let USERS = [];

function findUser(id) {
  return USERS.find((u) => u.id === id) || null;
}

// Ids end up as path segments and as directory names under SESSION_PATH, so
// they are restricted to a plain slug — no dots, no slashes, nothing that
// could climb out of the sessions directory.
function slugify(name) {
  return String(name)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

function isSafeInboxId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(id);
}

const app = express();

// ---- Per-user state, keyed by user id ----
// Each entry: { client, latestQr, isReady, statusText }
const sessions = new Map();

// Inboxes held back by MAX_ACTIVE_INBOXES: no connection, no retries, and
// a status that explains itself.
function dormantSession() {
  return {
    latestQr: null,
    isReady: false,
    statusText:
      'Not started — this server is set to run fewer inboxes at once (MAX_ACTIVE_INBOXES).',
    sawQrThisRun: false,
    claimCodePlain: null,
    codeVisibleUntil: 0,
    startupError: null,
    attempts: 0,
    needsRelink: false,
    restarting: false,
    authenticating: false,
    everAuthenticated: false,
    pairingFailures: 0,
    qrCount: 0,
    retryNotice: null,
    dormant: true,
    stop: async () => {}
  };
}

// `startAfterMs` staggers connections. Nothing heavy is being launched any
// more, but it still spreads out the history sync that follows.
function createSessionForUser(user, startAfterMs = 0) {
  const state = wa.createInboxConnection(user, SESSION_ROOT, {
    onClaimCode: (u, st) => issueClaimCodeIfNeeded(u, st)
  });

  const launch = () =>
    state.start().catch((err) =>
      console.error(`[${user.id}] Startup failed unexpectedly:`, err && err.message)
    );

  if (startAfterMs > 0) setTimeout(launch, startAfterMs);
  else launch();

  return state;
}

function getUserOr404(req, res) {
  const user = findUser(req.params.userId);
  if (!user) {
    res.status(404).json({ error: 'Unknown user' });
    return null;
  }
  return user;
}

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down all clients...`);
  await Promise.all(
    USERS.map(async (user) => {
      const state = sessions.get(user.id);
      if (!state || !state.stop) return;
      try {
        await state.stop();
      } catch (err) {
        console.warn(`[${user.id}] Error closing the connection:`, err.message);
      }
    })
  );
  try {
    await db.close();
  } catch (err) {
    console.warn('Error closing the credential pool:', err.message);
  }
  process.exit(0);
}
// A dropped socket or a malformed message surfaces asynchronously, long
// after startup. Node's default is to abort on an unhandled rejection,
// which would take every other inbox down with it, so log and keep
// serving instead.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err && err.stack ? err.stack : err);
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ---- Authentication ----
// Railway (and most PaaS) terminate TLS at a proxy, so trust the
// X-Forwarded-* headers to get the real client IP and protocol.
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));

// Assets carry no private data and the login page needs them, so they are
// served ahead of any inbox check.
app.get('/assets/app.css', (req, res) => {
  res.type('text/css').set('Cache-Control', 'public, max-age=3600').send(views.STYLES);
});

app.get('/assets/icon.svg', (req, res) => {
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(views.FAVICON);
});

app.get('/favicon.ico', (req, res) => res.redirect(301, '/assets/icon.svg'));

// Look up the inbox and its stored credential in one step. Any database
// trouble locks the inbox rather than letting the request through: the
// credential store *is* the gate, so "cannot check" must mean "no".
async function resolveInbox(req, res, { json = false } = {}) {
  const user = findUser(req.params.userId);
  if (!user) {
    if (json) res.status(404).json({ error: 'Unknown user' });
    else res.redirect('/');
    return null;
  }

  if (!db.isConfigured) {
    if (json) res.status(503).json({ error: 'DATABASE_URL is not configured' });
    else res.status(503).send(views.dbErrorPage({ configured: false }));
    return null;
  }

  try {
    const cred = await db.getCredential(user.id);
    return { user, cred, state: sessions.get(user.id) };
  } catch (err) {
    console.error(`[${user.id}] credential lookup failed:`, err.message);
    if (json) res.status(503).json({ error: 'Credential store unavailable' });
    else res.status(503).send(views.dbErrorPage({ configured: true }));
    return null;
  }
}

function isClaimed(cred) {
  return !!(cred && cred.passwordHash);
}

// ---- Claim codes ----

// Issued when a person links their WhatsApp. The plaintext is held only in
// memory and only shown on the QR page when this process actually watched
// the scan happen — for a session restored from disk the QR page is public
// to anyone who has not claimed it yet, so the code goes to the logs alone.
const CODE_VISIBLE_MS = 15 * 60 * 1000;

async function issueClaimCodeIfNeeded(user, state) {
  if (!db.isConfigured) return;
  try {
    if (await db.isClaimed(user.id)) return;

    const code = auth.generateClaimCode();
    const stored = await db.storeClaimCode(user.id, auth.hashClaimCode(code));
    if (!stored) return; // claimed in the meantime

    if (state.sawQrThisRun) {
      state.claimCodePlain = code;
      state.codeVisibleUntil = Date.now() + CODE_VISIBLE_MS;
      console.log(`[${user.id}] Setup code issued and shown on the QR page.`);
    } else {
      state.claimCodePlain = null;
      state.codeVisibleUntil = 0;
    }
    // Always log it: this is the only route to the code for a session that
    // was restored from disk rather than scanned just now.
    console.log(`[${user.id}] SETUP CODE: ${code} — give this to ${user.name} to set their password.`);
  } catch (err) {
    console.error(`[${user.id}] could not issue setup code:`, err.message);
  }
}

function visibleClaimCode(state) {
  if (!state.claimCodePlain) return null;
  if (!state.codeVisibleUntil || Date.now() > state.codeVisibleUntil) return null;
  return state.claimCodePlain;
}

// ---- Public routes ----

// ---- Creating an inbox ----
// Open by default, which is what makes the button a button. Set INVITE_CODE
// to require a shared secret first: each inbox costs a live WhatsApp
// connection and its stored history, so an open form on a public URL is a
// resource risk as well as a tidiness one.
const INVITE_CODE = process.env.INVITE_CODE || '';

app.get('/', async (req, res) => {
  if (!db.isConfigured) return res.status(503).send(views.dbErrorPage({ configured: false }));
  try {
    const entries = await Promise.all(
      USERS.map(async (user) => ({ user, claimed: await db.isClaimed(user.id) }))
    );
    res.send(
      views.homePage(entries, {
        max: db.MAX_INBOXES,
        used: USERS.length,
        needsInvite: INVITE_CODE.length > 0,
        error: typeof req.query.error === 'string' ? req.query.error : ''
      })
    );
  } catch (err) {
    console.error('Home page credential lookup failed:', err.message);
    res.status(503).send(views.dbErrorPage({ configured: true }));
  }
});

app.post('/create', async (req, res) => {
  if (!db.isConfigured) return res.status(503).send(views.dbErrorPage({ configured: false }));

  const fail = (msg) => res.redirect('/?error=' + encodeURIComponent(msg));
  const body = req.body || {};
  const rawName = typeof body.name === 'string' ? body.name.trim() : '';

  if (INVITE_CODE) {
    const supplied = typeof body.invite === 'string' ? body.invite : '';
    // Same throttle bucket as a login, keyed to a name no inbox can take.
    if (auth.lockoutRemainingMs(req, ':create') > 0) {
      return fail('Too many attempts. Try again in a few minutes.');
    }
    if (supplied !== INVITE_CODE) {
      auth.recordFailure(req, ':create');
      return fail('That invite code is not right.');
    }
    auth.clearFailures(req, ':create');
  }

  if (!rawName) return fail('Give the new inbox a name.');
  if (rawName.length > 40) return fail('That name is too long.');

  const id = slugify(rawName);
  if (!isSafeInboxId(id)) {
    return fail('Use a name with some letters or numbers in it.');
  }

  try {
    if (USERS.length >= db.MAX_INBOXES) {
      return fail(`There is room for ${db.MAX_INBOXES} inboxes and they are all taken.`);
    }
    if (await db.inboxExists(id)) {
      return fail(`An inbox called "${id}" already exists.`);
    }

    const created = await db.createInbox(id, rawName);
    if (!created) {
      return fail('Could not create that inbox — the limit may have just been reached.');
    }

    const user = { id, name: rawName };
    USERS.push(user);
    sessions.set(id, createSessionForUser(user));
    console.log(`Created inbox "${id}" (${USERS.length}/${db.MAX_INBOXES} used).`);

    // Straight to the QR page: linking WhatsApp is what issues the setup
    // code, and the setup code is what lets them set a password.
    res.redirect(`/${encodeURIComponent(id)}/qr`);
  } catch (err) {
    console.error('Inbox creation failed:', err.message);
    res.status(503).send(views.dbErrorPage({ configured: true }));
  }
});

app.get('/:userId/login', async (req, res) => {
  const ctx = await resolveInbox(req, res);
  if (!ctx) return;
  const { user, cred } = ctx;

  if (!isClaimed(cred)) return res.redirect(`/${encodeURIComponent(user.id)}/setup`);
  if (auth.isLoggedInAs(req, user.id, cred.passwordHash)) {
    return res.redirect(auth.safeNextPath(req.query.next, `/${encodeURIComponent(user.id)}`));
  }
  res.send(
    views.inboxLoginPage({
      user,
      next: auth.safeNextPath(req.query.next, `/${encodeURIComponent(user.id)}`)
    })
  );
});

app.post('/:userId/login', async (req, res) => {
  const ctx = await resolveInbox(req, res);
  if (!ctx) return;
  const { user, cred } = ctx;

  if (!isClaimed(cred)) return res.redirect(`/${encodeURIComponent(user.id)}/setup`);

  const next = auth.safeNextPath(req.body && req.body.next, `/${encodeURIComponent(user.id)}`);
  const lockedFor = auth.lockoutRemainingMs(req, user.id);

  if (lockedFor > 0) {
    const minutes = Math.ceil(lockedFor / 60000);
    return res.status(429).send(
      views.inboxLoginPage({
        user,
        next,
        error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
      })
    );
  }

  if (!auth.verifySecret((req.body && req.body.password) || '', cred.passwordHash)) {
    auth.recordFailure(req, user.id);
    console.warn(`[${user.id}] Failed login attempt from ${req.ip}`);
    return res
      .status(401)
      .send(views.inboxLoginPage({ user, next, error: 'Incorrect password.' }));
  }

  auth.clearFailures(req, user.id);
  auth.setSessionCookie(req, res, user.id, cred.passwordHash);
  res.redirect(next);
});

app.post('/:userId/logout', async (req, res) => {
  const user = findUser(req.params.userId);
  if (!user) return res.status(404).send('Unknown user');
  auth.clearSessionCookie(req, res, user.id);
  res.redirect(`/${encodeURIComponent(user.id)}/login`);
});

// ---- First-run setup: prove ownership with the code, then pick a password ----

app.get('/:userId/setup', async (req, res) => {
  const ctx = await resolveInbox(req, res);
  if (!ctx) return;
  const { user, cred } = ctx;

  if (isClaimed(cred)) return res.redirect(`/${encodeURIComponent(user.id)}/login`);
  if (!cred || !cred.claimCodeHash) return res.send(views.inboxAwaitingCodePage({ user }));

  const prefill = typeof req.query.code === 'string' ? req.query.code : '';
  res.send(views.inboxSetupPage({ user, prefillCode: prefill }));
});

app.post('/:userId/setup', async (req, res) => {
  const ctx = await resolveInbox(req, res);
  if (!ctx) return;
  const { user, cred, state } = ctx;

  if (isClaimed(cred)) return res.redirect(`/${encodeURIComponent(user.id)}/login`);
  if (!cred || !cred.claimCodeHash) return res.send(views.inboxAwaitingCodePage({ user }));

  const body = req.body || {};
  const lockedFor = auth.lockoutRemainingMs(req, user.id);
  if (lockedFor > 0) {
    const minutes = Math.ceil(lockedFor / 60000);
    return res.status(429).send(
      views.inboxSetupPage({
        user,
        error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
      })
    );
  }

  if (!auth.claimCodeMatches(body.code || '', cred.claimCodeHash)) {
    auth.recordFailure(req, user.id);
    console.warn(`[${user.id}] Bad setup code from ${req.ip}`);
    return res
      .status(401)
      .send(views.inboxSetupPage({ user, error: 'That setup code is not right.' }));
  }

  const problem = auth.passwordProblem(body.password, body.confirm);
  if (problem) {
    return res.status(400).send(
      views.inboxSetupPage({ user, prefillCode: body.code || '', error: problem })
    );
  }

  const passwordHash = auth.hashSecret(body.password);
  let claimed;
  try {
    claimed = await db.claimInbox(user.id, passwordHash);
  } catch (err) {
    console.error(`[${user.id}] claim failed:`, err.message);
    return res.status(503).send(views.dbErrorPage({ configured: true }));
  }

  if (!claimed) {
    // Someone else completed setup between the code check and the write.
    return res.redirect(`/${encodeURIComponent(user.id)}/login`);
  }

  state.claimCodePlain = null;
  state.codeVisibleUntil = 0;
  auth.clearFailures(req, user.id);
  auth.setSessionCookie(req, res, user.id, passwordHash);
  console.log(`[${user.id}] Inbox claimed — password set by its owner.`);
  res.redirect(`/${encodeURIComponent(user.id)}`);
});

// ---- QR page ----
// Public only while the inbox is unclaimed, because linking WhatsApp is how
// a person gets their setup code in the first place. Once claimed it is
// private like everything else.

app.get('/:userId/qr', async (req, res) => {
  const ctx = await resolveInbox(req, res);
  if (!ctx) return;
  const { user, cred, state } = ctx;

  if (isClaimed(cred)) {
    if (!auth.isLoggedInAs(req, user.id, cred.passwordHash)) {
      return res.redirect(
        `/${encodeURIComponent(user.id)}/login?next=` + encodeURIComponent(req.originalUrl)
      );
    }
    return res.send(views.qrPage({ user, state }));
  }

  res.send(
    views.qrPage({ user, state, claimCode: visibleClaimCode(state), needsSetup: true })
  );
});

// ---- Unlink ----
// Pressed by a person who can see that WhatsApp has dropped the link, when
// the app has not worked it out for itself. It does exactly what it says
// and nothing conditional: stop the socket, set the stored session aside,
// forget the stored chats, start again on a fresh QR code. No detection, no
// guessing at whether it was really necessary.
app.post('/:userId/unlink', async (req, res) => {
  const ctx = await resolveInbox(req, res);
  if (!ctx) return;
  const { user, cred } = ctx;

  // Same gate as the QR page itself: once an inbox has a password, only its
  // owner may do this. An unclaimed inbox has no password to check and its
  // QR page is already open to whoever reaches it.
  if (isClaimed(cred) && !auth.isLoggedInAs(req, user.id, cred.passwordHash)) {
    return res.redirect(
      `/${encodeURIComponent(user.id)}/login?next=` + encodeURIComponent(`/${user.id}/qr`)
    );
  }

  console.log(`[${user.id}] Unlink pressed. Clearing the session and starting over.`);

  const previous = sessions.get(user.id);
  if (previous && previous.stop) {
    try {
      await previous.stop();
    } catch (err) {
      console.warn(`[${user.id}] Could not stop the old connection cleanly:`, err.message);
    }
  }

  parkDeadSession(user.id);

  try {
    await db.clearInboxHistory(user.id);
  } catch (err) {
    console.warn(`[${user.id}] Could not clear stored history:`, err.message);
  }

  // A brand new connection object, so none of the old run's state — failed
  // pairings, retry counts, a stale QR — carries over. An inbox held back by
  // MAX_ACTIVE_INBOXES stays held back: clearing its session must not be a
  // way to start a connection the operator has capped.
  if (previous && previous.dormant) {
    sessions.set(user.id, dormantSession());
    console.log(`[${user.id}] Session cleared, but the inbox stays paused (MAX_ACTIVE_INBOXES).`);
  } else {
    sessions.set(user.id, createSessionForUser(user));
  }

  res.redirect(`/${encodeURIComponent(user.id)}/qr`);
});

// ---- A fresh QR code, on request ----
// WhatsApp rotates the linking code every twenty seconds and limits how
// often an account may link a device, so an inbox that nobody is scanning
// stops offering codes rather than spending that allowance on an empty
// room. This is how a person says they are ready now.
//
// Unlike unlinking, nothing is thrown away: the stored session and the
// chat history stay, the connection is simply started again so WhatsApp
// issues a new code.
app.post('/:userId/qr/refresh', async (req, res) => {
  const ctx = await resolveInbox(req, res);
  if (!ctx) return;
  const { user, cred } = ctx;

  if (isClaimed(cred) && !auth.isLoggedInAs(req, user.id, cred.passwordHash)) {
    return res.redirect(
      `/${encodeURIComponent(user.id)}/login?next=` + encodeURIComponent(`/${user.id}/qr`)
    );
  }

  const previous = sessions.get(user.id);

  // A paused inbox is paused by the operator, not by the code counter, and
  // asking for a QR code must not be a way around that.
  if (previous && previous.dormant) {
    return res.redirect(`/${encodeURIComponent(user.id)}/qr`);
  }

  console.log(`[${user.id}] New QR code requested.`);
  if (previous && previous.stop) {
    try {
      await previous.stop();
    } catch (err) {
      console.warn(`[${user.id}] Could not stop the old connection cleanly:`, err.message);
    }
  }
  sessions.set(user.id, createSessionForUser(user));
  res.redirect(`/${encodeURIComponent(user.id)}/qr`);
});

// ---- Change password ----

app.get('/:userId/password', async (req, res) => {
  const ctx = await resolveInbox(req, res);
  if (!ctx) return;
  const { user, cred } = ctx;

  if (!isClaimed(cred)) return res.redirect(`/${encodeURIComponent(user.id)}/setup`);
  if (!auth.isLoggedInAs(req, user.id, cred.passwordHash)) {
    return res.redirect(
      `/${encodeURIComponent(user.id)}/login?next=` + encodeURIComponent(req.originalUrl)
    );
  }
  res.send(views.changePasswordPage({ user }));
});

app.post('/:userId/password', async (req, res) => {
  const ctx = await resolveInbox(req, res);
  if (!ctx) return;
  const { user, cred } = ctx;

  if (!isClaimed(cred)) return res.redirect(`/${encodeURIComponent(user.id)}/setup`);
  if (!auth.isLoggedInAs(req, user.id, cred.passwordHash)) {
    return res.redirect(`/${encodeURIComponent(user.id)}/login`);
  }

  const body = req.body || {};
  if (!auth.verifySecret(body.current || '', cred.passwordHash)) {
    auth.recordFailure(req, user.id);
    return res
      .status(401)
      .send(views.changePasswordPage({ user, error: 'Current password is not right.' }));
  }

  const problem = auth.passwordProblem(body.password, body.confirm);
  if (problem) {
    return res.status(400).send(views.changePasswordPage({ user, error: problem }));
  }

  const passwordHash = auth.hashSecret(body.password);
  try {
    await db.updatePassword(user.id, passwordHash);
  } catch (err) {
    console.error(`[${user.id}] password change failed:`, err.message);
    return res.status(503).send(views.dbErrorPage({ configured: true }));
  }

  // Cookies are signed with a key derived from the password hash, so the
  // old ones are already dead; re-issue this browser's so the person who
  // just changed it stays signed in.
  auth.setSessionCookie(req, res, user.id, passwordHash);
  console.log(`[${user.id}] Password changed.`);
  res.redirect(`/${encodeURIComponent(user.id)}`);
});

// ---- API gate ----
// Every /api/:userId/* route requires a session for that same inbox.

app.use('/api/:userId', async (req, res, next) => {
  const ctx = await resolveInbox(req, res, { json: true });
  if (!ctx) return;
  const { user, cred } = ctx;

  if (!isClaimed(cred)) {
    return res.status(403).json({ error: 'This inbox has not been set up yet' });
  }
  if (!auth.isLoggedInAs(req, user.id, cred.passwordHash)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

// ---- Web routes ----

app.get('/api/:userId/status', (req, res) => {
  const user = getUserOr404(req, res);
  if (!user) return;
  const state = sessions.get(user.id);
  res.json({
    ready: state.isReady,
    status: state.statusText,
    hasQr: !!state.latestQr,
    startupError: state.startupError || null,
    needsRelink: !!state.needsRelink,
    authenticating: !!state.authenticating,
    // Set while the socket keeps dropping. Unlike startupError this is not a
    // dead end: the inbox is still reconnecting on its own.
    retrying: state.retryNotice || null
  });
});

app.get('/api/:userId/chats', async (req, res) => {
  const user = getUserOr404(req, res);
  if (!user) return;

  // Chats come from Postgres rather than the connection, so the list loads
  // whether or not the socket happens to be up, and history survives a
  // restart instead of being re-synced every boot.
  try {
    const chats = await db.listChats(user.id);
    if (chats.length === 0) {
      const state = sessions.get(user.id);
      return res.status(503).json({
        error: state && state.isReady
          ? 'Connected — WhatsApp is still sending history. This can take a few minutes on a busy account.'
          : 'Not connected yet.'
      });
    }
    res.json(chats);
  } catch (err) {
    console.error(`[${user.id}] listing chats failed:`, err.message);
    res.status(500).json({ error: 'Could not read chats' });
  }
});

// ---- Media ----

// Downloading is slow enough that a re-render must not re-fetch, but media
// is large, so the cache is bounded by both count and total bytes and drops
// the oldest entry first.
// Scrolling a chat full of stickers used to evict its own entries and then
// download them all again on the way back up. The byte ceiling is what
// actually bounds memory, so the item count can afford to be generous.
const MEDIA_CACHE_MAX_ITEMS = 250;
const MEDIA_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const mediaCache = new Map();
let mediaCacheBytes = 0;

// Opening a chat asks for every visible picture at once, and the same
// message can be asked for again before the first download has finished.
// One download per message, however many requests are waiting on it.
const mediaInFlight = new Map();

function cacheGet(key) {
  const hit = mediaCache.get(key);
  if (!hit) return null;
  // Refresh recency.
  mediaCache.delete(key);
  mediaCache.set(key, hit);
  return hit;
}

function cachePut(key, entry) {
  if (entry.buffer.length > MEDIA_CACHE_MAX_BYTES) return;
  mediaCache.set(key, entry);
  mediaCacheBytes += entry.buffer.length;
  while (mediaCache.size > MEDIA_CACHE_MAX_ITEMS || mediaCacheBytes > MEDIA_CACHE_MAX_BYTES) {
    const oldestKey = mediaCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = mediaCache.get(oldestKey);
    mediaCache.delete(oldestKey);
    mediaCacheBytes -= oldest ? oldest.buffer.length : 0;
  }
}

// Only these render inline. Everything else is sent as a download, because
// serving arbitrary attachment types inline from this origin would let a
// booby-trapped document (an .html or .svg with a script in it) run as if
// the viewer had written it.
const INLINE_MIME = /^(image\/(png|jpeg|gif|webp|bmp)|video\/(mp4|webm|ogg|quicktime)|audio\/(mpeg|mp4|ogg|wav|webm|aac|amr))$/i;

// WhatsApp sends voice notes as `audio/ogg; codecs=opus`. The pattern above
// is anchored, so the parameter made it fail the match, and the file went
// out as an octet-stream attachment that no <audio> element would play —
// the "Audio unavailable" in the viewer. Match on the type alone.
function baseMime(mimetype) {
  return String(mimetype || '').split(';')[0].trim().toLowerCase();
}

app.get('/api/:userId/messages/:messageId/media', async (req, res) => {
  const user = getUserOr404(req, res);
  if (!user) return;

  const cacheKey = user.id + '|' + req.params.messageId;
  let entry = cacheGet(cacheKey);

  if (!entry) {
    let stored;
    try {
      stored = await db.getMessageRaw(user.id, req.params.messageId);
    } catch (err) {
      console.error(`[${user.id}] media lookup failed:`, err.message);
      return res.status(500).json({ error: 'Could not read that message' });
    }
    if (!stored || !stored.raw) return res.status(404).json({ error: 'Message has no media' });

    try {
      // The socket is what lets an expired URL be re-uploaded rather than
      // failing; if this inbox is offline the download still tries, it just
      // cannot recover a stale one.
      const live = sessions.get(user.id);
      const socket = live && live.socket ? live.socket : null;

      let pending = mediaInFlight.get(cacheKey);
      if (!pending) {
        pending = wa.fetchMedia(stored.raw, socket).finally(() => mediaInFlight.delete(cacheKey));
        mediaInFlight.set(cacheKey, pending);
      }
      const media = await pending;

      if (!media || !media.buffer || media.buffer.length === 0) {
        return res.status(410).json({ error: 'Media is no longer available' });
      }
      entry = {
        buffer: media.buffer,
        mimetype: media.mimetype,
        filename: media.filename
      };
      cachePut(cacheKey, entry);
    } catch (err) {
      // WhatsApp drops media from its servers after a while, so an old
      // message can legitimately have nothing left to download.
      console.error(`[${user.id}] media download failed:`, err && err.message ? err.message : err);
      return res.status(410).json({ error: 'Could not download that media' });
    }
  }

  const inline = INLINE_MIME.test(baseMime(entry.mimetype));
  const safeName = (entry.filename || 'attachment').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);

  res.set('X-Content-Type-Options', 'nosniff');
  // A message's media never changes, so the browser should never ask twice.
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.type(inline ? entry.mimetype : 'application/octet-stream');
  res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`);
  res.send(entry.buffer);
});

// A chat's profile picture, served from our own origin out of Postgres.
// Nothing here talks to WhatsApp, so there is no signed URL to expire
// between the fetch and someone looking at the page.
app.get('/api/:userId/chats/:chatId/avatar', async (req, res) => {
  const user = getUserOr404(req, res);
  if (!user) return;

  let picture;
  try {
    picture = await db.getChatAvatar(user.id, req.params.chatId);
  } catch (err) {
    console.error(`[${user.id}] avatar lookup failed:`, err.message);
    return res.status(500).json({ error: 'Could not read that avatar' });
  }
  if (!picture) return res.status(404).json({ error: 'No picture' });

  res.set('X-Content-Type-Options', 'nosniff');
  // People change their picture, so this is refreshed rather than frozen;
  // the ETag makes the re-check free when it has not changed.
  res.set('Cache-Control', 'private, max-age=3600');
  res.type(picture.mimetype);
  res.send(picture.buffer);
});

// The preview WhatsApp embeds in the message. It comes out of Postgres with
// no call to WhatsApp at all, so it answers in milliseconds where the full
// download takes a second or more — the viewer shows this first and swaps
// the real thing in behind it.
app.get('/api/:userId/messages/:messageId/thumb', async (req, res) => {
  const user = getUserOr404(req, res);
  if (!user) return;

  let stored;
  try {
    stored = await db.getMessageRaw(user.id, req.params.messageId);
  } catch (err) {
    console.error(`[${user.id}] thumbnail lookup failed:`, err.message);
    return res.status(500).json({ error: 'Could not read that message' });
  }
  if (!stored || !stored.raw) return res.status(404).json({ error: 'No preview' });

  const thumb = wa.thumbnailOf(stored.raw);
  if (!thumb) return res.status(404).json({ error: 'No preview' });

  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.type(thumb.mimetype);
  res.send(thumb.buffer);
});

app.get('/api/:userId/chats/:chatId/messages', async (req, res) => {
  const user = getUserOr404(req, res);
  if (!user) return;

  try {
    res.json(await db.listMessages(user.id, req.params.chatId));
  } catch (err) {
    console.error(`[${user.id}] listing messages failed:`, err.message);
    res.status(500).json({ error: 'Could not read messages' });
  }
});

app.get('/:userId', async (req, res) => {
  const ctx = await resolveInbox(req, res);
  if (!ctx) return;
  const { user, cred } = ctx;

  if (!isClaimed(cred)) return res.redirect(`/${encodeURIComponent(user.id)}/setup`);
  if (!auth.isLoggedInAs(req, user.id, cred.passwordHash)) {
    return res.redirect(
      `/${encodeURIComponent(user.id)}/login?next=` + encodeURIComponent(req.originalUrl)
    );
  }
  res.send(views.viewerPage(user));
});

// Move an inbox's stored WhatsApp session aside so the next connection
// starts from a fresh QR code. Moved, not deleted: if the wrong one is
// cleared it can still be put back by hand off the volume. One previous
// copy is kept so the disk cannot fill with them.
//
// This was called by RESET_SESSIONS but never actually written, so setting
// that variable crashed the boot with a ReferenceError before the server
// ever listened.
function parkDeadSession(userId) {
  const dir = path.join(SESSION_ROOT, userId);
  if (!fs.existsSync(dir)) return false;

  const parked = `${dir}.unlinked-${Date.now()}`;
  try {
    fs.renameSync(dir, parked);
  } catch (err) {
    console.warn(`[${userId}] Could not set the session aside:`, err.message);
    return false;
  }

  try {
    const stale = fs
      .readdirSync(SESSION_ROOT)
      .filter((n) => n.startsWith(`${userId}.unlinked-`))
      .sort();
    for (const name of stale.slice(0, -1)) {
      fs.rmSync(path.join(SESSION_ROOT, name), { recursive: true, force: true });
    }
  } catch {
    /* pruning is best effort */
  }
  return true;
}

// Every parked copy — .loggedout-, .unlinked-, .superseded- — is a full
// duplicate of a Baileys auth directory, and one of those is thousands of
// small key files. Each prefix used to prune only its own kind, and
// .superseded- was never pruned at all, so they piled up on a volume that
// has no shell to clean them from. That is how /data fills.
//
// One sweep at boot, over all three: keep the newest copy per inbox as the
// recovery copy the parking is for, delete the rest, and delete even the
// newest once it is older than this.
const PARKED_PREFIXES = ['.loggedout-', '.unlinked-', '.superseded-'];
const PARKED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

function isParkedName(name) {
  return PARKED_PREFIXES.some((p) => name.includes(p));
}

// The trailing Date.now() is what a copy is dated by; a name without one is
// treated as ancient rather than guessed at.
function parkedStamp(name) {
  const m = /-(\d{10,})$/.exec(name);
  return m ? Number(m[1]) : 0;
}

function sweepParkedSessions() {
  let names;
  try {
    names = fs.readdirSync(SESSION_ROOT).filter(isParkedName);
  } catch {
    return; // no session root yet, nothing parked
  }
  if (!names.length) return;

  // Newest first, so the first one seen for an inbox is the keeper.
  names.sort((a, b) => parkedStamp(b) - parkedStamp(a));

  const kept = new Set();
  const cutoff = Date.now() - PARKED_KEEP_MS;
  let removed = 0;
  let freed = 0;

  for (const name of names) {
    const inbox = name.split('.')[0];
    const full = path.join(SESSION_ROOT, name);
    const stamp = parkedStamp(name);
    const keep = !kept.has(inbox) && stamp >= cutoff;

    if (keep) {
      kept.add(inbox);
      continue;
    }
    let size = 0;
    try {
      size = dirSize(full);
    } catch {
      /* size is only for the log */
    }
    try {
      fs.rmSync(full, { recursive: true, force: true });
      removed += 1;
      freed += size;
    } catch (err) {
      console.warn(`Could not remove the parked session ${name}:`, err.message);
    }
  }

  if (removed) {
    console.log(
      `Removed ${removed} parked session ${removed === 1 ? 'copy' : 'copies'}, ` +
        `freeing about ${Math.round(freed / 1024 / 1024)}MB. ` +
        `Kept ${kept.size} for recovery.`
    );
  }
}

// The volume filling up is not something the app can fix, but it is
// something it can say plainly instead of failing as ENOSPC deep inside a
// mkdir. Printed at boot and whenever a write fails for space.
function reportDiskSpace() {
  try {
    const st = fs.statfsSync(SESSION_ROOT);
    const free = st.bsize * st.bavail;
    const total = st.bsize * st.blocks;
    const pct = total ? Math.round((1 - free / total) * 100) : 0;
    console.log(
      `Session volume ${SESSION_ROOT}: ${Math.round(free / 1024 / 1024)}MB free ` +
        `of ${Math.round(total / 1024 / 1024)}MB (${pct}% used).`
    );
    if (total && free / total < 0.05) {
      console.warn(
        'That volume is nearly full. WhatsApp sessions cannot be written and ' +
          'inboxes will fail to start. Grow the volume in Railway, or clear it ' +
          'with RESET_SESSIONS.'
      );
    }
  } catch (err) {
    console.warn('Could not measure the session volume:', err.message);
  }
}

// Sessions live at <SESSION_ROOT>/<id>, so folding an id in the database
// has to move the matching directory or the inbox comes up unlinked and
// asks for a fresh QR scan.

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* vanished mid-walk; it does not count either way */
        }
      }
    }
  }
  return total;
}

// Both directories can exist: the capitalised one holds the session that was
// really linked, while the lowercase one holds whatever the duplicate inbox
// wrote when it started up unlinked. A linked, synced session carries
// its message store and is dramatically larger, so size is a good proxy for
// "this is the real one". Nothing is ever deleted — the loser is moved
// aside, so a wrong guess is recoverable by hand.
function renameSessionDir(from, to) {
  const fromPath = path.join(SESSION_ROOT, from);
  const toPath = path.join(SESSION_ROOT, to);

  if (!fs.existsSync(fromPath)) return;

  if (!fs.existsSync(toPath)) {
    try {
      fs.renameSync(fromPath, toPath);
      console.log(`Moved session directory ${from} -> ${to}.`);
    } catch (err) {
      console.warn(`Could not move ${fromPath} to ${toPath}:`, err.message);
    }
    return;
  }

  const fromSize = dirSize(fromPath);
  const toSize = dirSize(toPath);

  if (toSize >= fromSize) {
    const parked = `${from}.superseded-${Date.now()}`;
    try {
      fs.renameSync(fromPath, path.join(SESSION_ROOT, parked));
      console.log(
        `Kept the existing ${to} session (${toSize} bytes) over ${from} ` +
          `(${fromSize} bytes); the old one is parked at ${parked}.`
      );
    } catch (err) {
      console.warn(`Could not park ${fromPath}:`, err.message);
    }
    return;
  }

  const parked = `${to}.superseded-${Date.now()}`;
  try {
    fs.renameSync(toPath, path.join(SESSION_ROOT, parked));
    fs.renameSync(fromPath, toPath);
    console.log(
      `Moved session directory ${from} -> ${to} (${fromSize} bytes beat ` +
        `${toSize}); the displaced one is parked at ${parked}.`
    );
  } catch (err) {
    console.warn(`Could not swap ${fromPath} into ${toPath}:`, err.message);
  }
}

// Print what this process is actually running with. Several rounds of
// debugging have been spent on a deploy whose settings were not the ones
// being discussed, so the log should answer that without anyone guessing.
function reportEffectiveConfig(activeLimit) {
  console.log(
    'Config: ' +
      `inboxes=${activeLimit}/${USERS.length}` +
      `, transport=baileys (no browser)` +
      `, inviteCode=${INVITE_CODE ? 'on' : 'off'}`
  );

  if (!WHATSAPP_WEB_VERSION) return;
  console.warn(
    'WHATSAPP_WEB_VERSION is set but no longer does anything — it pinned a page ' +
      'build for the old browser-based client. Remove it.'
  );
}

// Connecting every inbox at once means every history sync lands at once, on
// one Postgres and one container. Spread them out.
const STARTUP_STAGGER_MS = 8000;

// Comma-separated inbox ids (or "all") whose stored WhatsApp session should
// be set aside at boot, so they start from a clean QR code. Needed when a
// session is dead but the app cannot tell — after unpairing the device from
// the phone, say — because there is otherwise no way to clear one without
// shell access to the volume. Set it, deploy once, then remove it.
// Left only to warn if it is still set: it pinned a WhatsApp Web page build
// for the old browser-based client and has no meaning for a protocol
// connection, which negotiates its version with WhatsApp directly.
const WHATSAPP_WEB_VERSION = (process.env.WHATSAPP_WEB_VERSION || '').trim();

const RESET_SESSIONS = (process.env.RESET_SESSIONS || '')
  .split(',')
  .map((v) => v.trim().toLowerCase())
  .filter(Boolean);

function applySessionResets(users) {
  if (RESET_SESSIONS.length === 0) return;
  const all = RESET_SESSIONS.includes('all');

  for (const user of users) {
    if (!all && !RESET_SESSIONS.includes(user.id.toLowerCase())) continue;
    if (!fs.existsSync(path.join(SESSION_ROOT, user.id))) {
      console.log(`[${user.id}] RESET_SESSIONS: nothing stored, already clean.`);
      continue;
    }
    parkDeadSession(user.id);
    console.log(`[${user.id}] RESET_SESSIONS: cleared — this inbox will show a fresh QR code.`);
  }
  console.log('RESET_SESSIONS applied. Remove the variable so it does not run again next deploy.');
}

// How many inboxes may hold a WhatsApp connection at the same time. Each one
// costs a socket, a history sync and the memory to buffer it, which is worth
// capping on a small container.
//
// Unset means all of them. 0 means none: no connections, no QR codes, no
// pairing attempts. That matters because WhatsApp limits how often an
// account may link a device, and an app that keeps showing codes keeps
// spending that allowance whether or not anyone is watching.
const rawMaxActive = process.env.MAX_ACTIVE_INBOXES;
const MAX_ACTIVE_INBOXES =
  rawMaxActive === undefined || rawMaxActive.trim() === ''
    ? null
    : Math.max(0, Number(rawMaxActive) || 0);

async function start() {
  if (db.isConfigured) {
    try {
      await db.init();

      // Fold any mixed-case ids before seeding, so seeding does not race
      // against a row that is about to be renamed onto the same id.
      const renames = await db.mergeMixedCaseInboxes();
      for (const { from, to } of renames) renameSessionDir(from, to);

      await db.seedInboxes(SEED_USERS);
      USERS = await db.listInboxes();
      console.log('Credential store ready.');
    } catch (err) {
      console.error('Could not reach the credential store:', err.message);
      console.error('Inboxes stay locked until DATABASE_URL points at a reachable Postgres.');
      // Fall back to the seed list so the already-linked sessions still come
      // up; every request will refuse to serve them until the store is back.
      USERS = SEED_USERS.slice();
    }
  } else {
    console.warn(
      'DATABASE_URL is not set. Inboxes and their passwords live in Postgres ' +
        '(Neon), so everything stays locked until it is configured.'
    );
    USERS = SEED_USERS.slice();
  }

  // Ids are slugs on the way in and folded to lowercase on the way out of
  // the database, so this should never fire. If it does, the row was edited
  // by hand into something that could climb out of the sessions directory —
  // say so loudly rather than dropping an inbox in silence.
  const unsafe = USERS.filter((u) => !isSafeInboxId(u.id));
  if (unsafe.length) {
    console.error(
      'REFUSING to start these inboxes because their ids are not safe directory names:',
      unsafe.map((u) => u.id).join(', ')
    );
    USERS = USERS.filter((u) => isSafeInboxId(u.id));
  }

  applySessionResets(USERS);

  // Before anything tries to write a session, take back whatever the old
  // parked copies are holding, and say where the volume stands.
  sweepParkedSessions();
  reportDiskSpace();

  const activeLimit = MAX_ACTIVE_INBOXES === null ? USERS.length : MAX_ACTIVE_INBOXES;

  if (activeLimit === 0) {
    console.warn(
      'MAX_ACTIVE_INBOXES=0 — paused. No connections are started and no QR codes are ' +
        'generated, so nothing consumes WhatsApp linking attempts. The web UI still runs.'
    );
  }

  USERS.forEach((user, i) => {
    if (i < activeLimit) {
      sessions.set(user.id, createSessionForUser(user, i * STARTUP_STAGGER_MS));
      return;
    }
    // Held back by MAX_ACTIVE_INBOXES. Give it a state object anyway so its
    // pages render and say so, rather than 404ing or looking like a hang.
    sessions.set(user.id, dormantSession());
    console.log(`[${user.id}] Not started: MAX_ACTIVE_INBOXES is ${activeLimit}.`);
  });

  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(
      `Inboxes (${USERS.length}/${db.MAX_INBOXES}):`,
      USERS.map((u) => u.id).join(', ') || '(none yet)'
    );
    if (activeLimit > 1) {
      console.log(
        `Starting them ${STARTUP_STAGGER_MS / 1000}s apart; the last one is ready in about ` +
          `${Math.round(((activeLimit - 1) * STARTUP_STAGGER_MS) / 1000)}s.`
      );
    }
    if (activeLimit < USERS.length) {
      console.log(`Running only ${activeLimit} of ${USERS.length} inboxes (MAX_ACTIVE_INBOXES).`);
    }
    if (INVITE_CODE) console.log('New inboxes require the invite code.');
    reportEffectiveConfig(activeLimit);
  });
}

start();
