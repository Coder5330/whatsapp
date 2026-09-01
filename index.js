const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const auth = require('./auth');
const db = require('./db');
const views = require('./views');

const PORT = process.env.PORT || 3000;
const SESSION_ROOT = process.env.SESSION_PATH || '/data/sessions';

// ---- Hardcoded users ----
// Add/remove people here. `id` is used in URLs and as the session folder
// name, so keep it simple (lowercase, no spaces).
const USERS = [
  { id: 'joshua', name: 'Joshua' },
  { id: 'Marshall', name: 'Marshall' },
  { id: 'Yuanbin', name: 'Yuanbin' },
];

// Chromium writes a SingletonLock (and related Singleton* files) into its
// profile directory while running. If the container is killed or crashes
// without Chromium shutting down cleanly, those files are left behind on
// the persistent volume. On the next boot Chromium sees the stale lock and
// refuses to start, thinking another process still owns the profile — even
// though that process is long gone. Clear them before every launch.
function clearStaleChromiumLocks(rootDir) {
  if (!fs.existsSync(rootDir)) return;
  const lockNames = new Set(['SingletonLock', 'SingletonCookie', 'SingletonSocket']);
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (lockNames.has(entry.name)) {
        try {
          fs.unlinkSync(full);
          console.log('Removed stale Chromium lock file:', full);
        } catch (err) {
          console.warn('Could not remove lock file:', full, err.message);
        }
      }
    }
  }
}

clearStaleChromiumLocks(SESSION_ROOT);

const app = express();

// ---- Per-user state, keyed by user id ----
// Each entry: { client, latestQr, isReady, statusText }
const sessions = new Map();

function createSessionForUser(user) {
  const sessionPath = path.join(SESSION_ROOT, user.id);

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: sessionPath }),
    puppeteer: {
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    }
  });

  const state = {
    client,
    latestQr: null,
    isReady: false,
    statusText: 'Starting up...',
    // Set once this process has actually displayed a QR code, which is how
    // we know a later 'authenticated' came from someone scanning it here
    // rather than from a session restored off the volume.
    sawQrThisRun: false,
    claimCodePlain: null,
    codeVisibleUntil: 0
  };

  client.on('qr', async (qr) => {
    state.statusText = 'Scan the QR code below with WhatsApp on your phone.';
    state.sawQrThisRun = true;
    state.latestQr = await qrcode.toDataURL(qr);
    console.log(`[${user.id}] QR code updated. Visit /${user.id}/qr to scan it.`);
  });

  client.on('authenticated', () => {
    state.statusText = 'Authenticated. Finishing startup...';
    state.latestQr = null;
    // Linking WhatsApp is what proves this inbox belongs to whoever is
    // holding the phone, so that is the moment a setup code is worth
    // issuing — but only while nobody has set a password yet.
    issueClaimCodeIfNeeded(user, state);
  });

  client.on('ready', () => {
    state.statusText = 'Connected — syncing chats...';
    state.latestQr = null;
    console.log(`[${user.id}] Client ready. Waiting for store to settle...`);
    setTimeout(() => {
      state.isReady = true;
      state.statusText = 'Connected.';
      console.log(`[${user.id}] Store settle period complete.`);
    }, 8000);
  });

  client.on('disconnected', (reason) => {
    state.isReady = false;
    state.statusText = `Disconnected: ${reason}. Restart the service to reconnect.`;
    console.log(`[${user.id}] Client disconnected:`, reason);
  });

  client.initialize();

  return state;
}

function getUserOr404(req, res) {
  const user = USERS.find((u) => u.id === req.params.userId);
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
      if (!state) return;
      try {
        await state.client.destroy();
      } catch (err) {
        console.warn(`[${user.id}] Error during client.destroy():`, err.message);
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
  const user = USERS.find((u) => u.id === req.params.userId);
  if (!user) {
    if (json) res.status(404).json({ error: 'Unknown user' });
    else res.status(404).send(views.homePage(USERS.map((u) => ({ user: u, claimed: false }))));
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

app.get('/', async (req, res) => {
  if (!db.isConfigured) return res.status(503).send(views.dbErrorPage({ configured: false }));
  try {
    const entries = await Promise.all(
      USERS.map(async (user) => ({ user, claimed: await db.isClaimed(user.id) }))
    );
    res.send(views.homePage(entries));
  } catch (err) {
    console.error('Home page credential lookup failed:', err.message);
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
  const user = USERS.find((u) => u.id === req.params.userId);
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
  res.json({ ready: state.isReady, status: state.statusText, hasQr: !!state.latestQr });
});

app.get('/api/:userId/chats', async (req, res) => {
  const user = getUserOr404(req, res);
  if (!user) return;
  const state = sessions.get(user.id);

  if (!state.isReady) return res.status(503).json({ error: 'Client not ready yet' });

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[${user.id}] Fetching chats (attempt ${attempt})...`);
      const chats = await state.client.getChats();
      console.log(`[${user.id}] Fetched ${chats.length} chats.`);
      return res.json(
        chats.map((c) => ({
          id: c.id._serialized,
          name: c.name || c.id.user,
          isGroup: c.isGroup,
          unreadCount: c.unreadCount,
          lastMessage: c.lastMessage
            ? { body: c.lastMessage.body, timestamp: c.lastMessage.timestamp * 1000 }
            : null
        }))
      );
    } catch (err) {
      console.error(`[${user.id}] getChats() attempt ${attempt} failed:`, err && err.stack ? err.stack : err);
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
  res.status(500).json({ error: 'Chat store not ready yet — WhatsApp may still be syncing. Try again shortly.' });
});

app.get('/api/:userId/chats/:chatId/messages', async (req, res) => {
  const user = getUserOr404(req, res);
  if (!user) return;
  const state = sessions.get(user.id);

  if (!state.isReady) return res.status(503).json({ error: 'Client not ready yet' });
  try {
    const chat = await state.client.getChatById(req.params.chatId);
    const history = await chat.fetchMessages({ limit: 100 });
    const formatted = await Promise.all(
      history.map(async (msg) => {
        const contact = await msg.getContact();
        return {
          id: msg.id._serialized,
          fromMe: msg.fromMe,
          fromName: msg.fromMe ? 'You' : (contact.pushname || contact.number || 'Unknown'),
          body: msg.body,
          timestamp: msg.timestamp * 1000
        };
      })
    );
    res.json(formatted);
  } catch (err) {
    console.error(`[${user.id}] fetchMessages failed:`, err && err.stack ? err.stack : err);
    res.status(500).json({ error: String(err) });
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

async function start() {
  if (db.isConfigured) {
    try {
      await db.init();
      console.log('Credential store ready.');
    } catch (err) {
      console.error('Could not reach the credential store:', err.message);
      console.error('Inboxes stay locked until DATABASE_URL points at a reachable Postgres.');
    }
  } else {
    console.warn(
      'DATABASE_URL is not set. Inbox passwords live in Postgres (Neon), so every ' +
        'inbox stays locked until it is configured.'
    );
  }

  for (const user of USERS) {
    sessions.set(user.id, createSessionForUser(user));
  }

  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log('Inboxes configured:', USERS.map((u) => u.id).join(', '));
  });
}

start();
