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

// Several Chromium instances competing for a small container will make
// WhatsApp Web's injection step time out, so a failed start is expected
// rather than exceptional. Retry it with backoff, and never let the
// rejection escape: an uncaught one takes the whole server down, and then
// nobody can reach any inbox.
const MAX_STARTUP_ATTEMPTS = 5;
const STARTUP_BASE_DELAY_MS = 5000;

function buildClient(user, state) {
  const sessionPath = path.join(SESSION_ROOT, user.id);

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: sessionPath }),
    // Never replay a cached copy of WhatsApp Web.
    //
    // The default 'local' cache writes a snapshot of the page whenever
    // injection fails, filed under the WhatsApp Web build the library was
    // released against. Every later start then finds that file, intercepts
    // the request to web.whatsapp.com, and serves the snapshot instead of
    // the live page — so one failed start pins the app to a frozen copy of
    // WhatsApp Web for good. A phone will refuse to link against a stale
    // build ("can't link new devices right now") even though the same
    // account links fine in a real browser.
    //
    // 'none' resolves to no cached content, which leaves the real request
    // alone and loads whatever WhatsApp is serving today. WHATSAPP_WEB_VERSION
    // swaps this for a pinned build instead.
    ...webVersionOptions,
    puppeteer: {
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      // Exactly the flags this app ran with when linking worked. Six more
      // were added here once to trim memory, on no evidence that they
      // helped, and linking stopped working in the same commit:
      // --no-zygote in particular disables the process Chromium forks
      // renderers from, and a renderer dying mid-pairing surfaces as
      // "Target closed", "detached Frame", and a LOGOUT that looks for all
      // the world like WhatsApp rejecting the device. Do not add to this
      // list without a measurement showing it is needed.
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    }
  });

  client.on('qr', async (qr) => {
    state.statusText = 'Scan the QR code below with WhatsApp on your phone.';
    state.sawQrThisRun = true;
    state.startupError = null;

    // The QR is the earliest point where the page has loaded enough to ask
    // what it is. A client stuck here never reaches 'ready', so reporting
    // only there told us nothing in exactly the case we needed it.
    if (!state.loggedEnvironment) {
      state.loggedEnvironment = true;
      Promise.all([
        client.getWWebVersion().catch((e) => `unknown (${e.message})`),
        client.pupBrowser && client.pupBrowser.version
          ? client.pupBrowser.version().catch(() => 'unknown')
          : Promise.resolve('unknown')
      ])
        .then(([web, browser]) => {
          console.log(`[${user.id}] WhatsApp Web build ${web} via ${browser}`);
        })
        .catch(() => {});
    }

    // Log every rotation. WhatsApp reissues the code every 20s or so, and a
    // page that stops rotating has frozen — which looks identical to a
    // working one in a screenshot, but no scan will ever succeed against it.
    state.qrCount = (state.qrCount || 0) + 1;
    try {
      state.latestQr = await qrcode.toDataURL(qr);
    } catch (err) {
      console.error(`[${user.id}] Could not render QR code:`, err.message);
      return;
    }
    console.log(`[${user.id}] QR code updated (#${state.qrCount}). Visit /${user.id}/qr to scan it.`);
  });

  client.on('authenticated', () => {
    state.statusText = 'Linked. Finishing sign-in...';
    state.latestQr = null;
    state.startupError = null;
    state.needsRelink = false;
    state.everAuthenticated = true;
    state.pairingFailures = 0;
    // Between here and 'ready' the QR is gone but the inbox is not usable
    // yet. Without a flag for it the page falls back to "Generating QR
    // code..." — so a scan that just succeeded looks like one that hung.
    state.authenticating = true;
    // Linking WhatsApp is what proves this inbox belongs to whoever is
    // holding the phone, so that is the moment a setup code is worth
    // issuing — but only while nobody has set a password yet.
    issueClaimCodeIfNeeded(user, state);
  });

  client.on('ready', () => {
    state.statusText = 'Connected — syncing chats...';
    state.latestQr = null;
    state.startupError = null;
    console.log(`[${user.id}] Client ready. Waiting for store to settle...`);

    clearTimeout(state.settleTimer);
    state.settleTimer = setTimeout(() => {
      // This fires eight seconds after the client said it was ready, which
      // is long enough for the client to have been signed out and replaced
      // in the meantime. Only the client that is still current may mark the
      // inbox connected, or a dead session comes back to life and the UI
      // cheerfully reports "connected" for a browser that is gone.
      if (state.client !== client) {
        console.log(`[${user.id}] Ignoring settle timer from a replaced client.`);
        return;
      }
      state.isReady = true;
      state.authenticating = false;
      state.statusText = 'Connected.';
      console.log(`[${user.id}] Store settle period complete.`);
      // Which WhatsApp Web build we actually ended up on, and on what
      // browser — the two things worth knowing when linking misbehaves.
      Promise.all([
        client.getWWebVersion().catch(() => 'unknown'),
        client.pupBrowser && client.pupBrowser.version
          ? client.pupBrowser.version().catch(() => 'unknown')
          : Promise.resolve('unknown')
      ])
        .then(([web, browser]) => {
          console.log(`[${user.id}] WhatsApp Web build ${web} via ${browser}`);
        })
        .catch(() => {});
    }, 8000);
  });

  client.on('disconnected', (reason) => {
    console.log(`[${user.id}] Client disconnected:`, reason);
    handleDisconnect(user, state, reason);
  });

  return client;
}

// WhatsApp tells us why the device dropped. These reasons mean the linked
// device was revoked — the stored session can never work again, and the only
// way back is a fresh scan. Anything else may just be a blip worth retrying
// on the existing session.
const UNLINKED_REASONS = new Set(['LOGOUT', 'UNPAIRED', 'UNPAIRED_IDLE', 'CONFLICT']);

// Move a dead session out of the way rather than deleting it: the auth blob
// is worthless once revoked, but it sits next to cached message data, and
// this runs without anyone watching. Keep one previous copy per inbox so the
// volume cannot fill up with them.
function parkDeadSession(id) {
  const live = path.join(SESSION_ROOT, id);
  if (!fs.existsSync(live)) return;

  try {
    fs.renameSync(live, path.join(SESSION_ROOT, `${id}.loggedout-${Date.now()}`));
    console.log(`[${id}] Parked the revoked session; a fresh QR code will be generated.`);
  } catch (err) {
    console.warn(`[${id}] Could not park the revoked session:`, err.message);
    return;
  }

  try {
    const stale = fs
      .readdirSync(SESSION_ROOT)
      .filter((name) => name.startsWith(`${id}.loggedout-`))
      .sort();
    for (const name of stale.slice(0, -1)) {
      fs.rmSync(path.join(SESSION_ROOT, name), { recursive: true, force: true });
    }
  } catch (err) {
    console.warn(`[${id}] Could not prune old parked sessions:`, err.message);
  }
}

// A disconnect used to be terminal: the client was dead, no QR was ever
// produced, and the page sat on its spinner telling people to restart the
// service. Recover on our own instead.
// How many times an inbox may disconnect without ever having authenticated
// before we stop regenerating codes. Each cycle is a fresh pairing attempt
// against WhatsApp, and hammering that is what gets an account told it
// "can't link new devices right now".
const MAX_PAIRING_ATTEMPTS = 3;

async function handleDisconnect(user, state, reason) {
  if (state.restarting) return;
  state.restarting = true;

  clearTimeout(state.settleTimer);
  state.isReady = false;
  state.authenticating = false;
  state.latestQr = null;

  // Three different things arrive as the same LOGOUT, and which one it is
  // decides whether the stored session may be thrown away. Whether a QR has
  // been shown yet in this run is what separates them:
  //
  //   before any QR   -> we were restoring the saved session and WhatsApp
  //                      rejected it. Those credentials are provably dead
  //                      (the device was unpaired, say), so clear them or
  //                      every restart repeats this.
  //   after a QR      -> someone scanned and the pairing did not complete.
  //                      The credentials here are the ones that scan just
  //                      created; discarding them is what made a linked
  //                      phone never sign in.
  //   after authenticating -> a session that was genuinely working has been
  //                      revoked. Clear it and ask for a new scan.
  const unlinkedReason = UNLINKED_REASONS.has(String(reason));
  const revoked = unlinkedReason && state.everAuthenticated;
  const storedSessionRejected = unlinkedReason && !state.everAuthenticated && !state.sawQrThisRun;
  const pairingFailed = unlinkedReason && !state.everAuthenticated && state.sawQrThisRun;

  if (storedSessionRejected) {
    console.warn(
      `[${user.id}] The stored session was rejected (${reason}) before any code was shown — ` +
        'it is no longer valid, most likely unpaired from the phone. Clearing it.'
    );
  }

  if (pairingFailed) {
    state.pairingFailures = (state.pairingFailures || 0) + 1;
    console.warn(
      `[${user.id}] Disconnected (${reason}) after a scan but before signing in — treating as a ` +
        `failed pairing (${state.pairingFailures}/${MAX_PAIRING_ATTEMPTS}), keeping the stored session.`
    );
  }

  state.needsRelink = revoked || storedSessionRejected;
  state.statusText = revoked
    ? `WhatsApp signed this device out (${reason}). Scan the new code to re-link.`
    : storedSessionRejected
      ? 'The saved WhatsApp link is no longer valid. Scan the new code to link again.'
      : `Disconnected (${reason}). Reconnecting...`;

  try {
    if (state.client) await state.client.destroy();
  } catch {
    /* the browser is usually already gone by the time we hear about it */
  }

  // Both of these mean the stored credentials cannot work again.
  if (revoked || storedSessionRejected) parkDeadSession(user.id);

  if (pairingFailed && state.pairingFailures >= MAX_PAIRING_ATTEMPTS) {
    state.startupError =
      `Pairing kept failing (${reason}). WhatsApp accepted the scan but this end never ` +
      'finished signing in.';
    state.statusText =
      'Pairing is not completing. Restart the service to try again, rather than rescanning.';
    state.restarting = false;
    console.error(
      `[${user.id}] Giving up after ${state.pairingFailures} failed pairings. Not generating ` +
        'another code — repeated attempts are what get an account blocked from linking.'
    );
    return;
  }

  state.attempts = 0;
  state.sawQrThisRun = false;
  state.restarting = false;

  startSession(user, state).catch((err) =>
    console.error(`[${user.id}] Reconnect failed:`, err && err.message)
  );
}

async function startSession(user, state) {
  state.attempts += 1;

  // A half-initialised client cannot be re-initialised, so each attempt
  // gets a fresh one.
  const client = buildClient(user, state);
  state.client = client;
  state.statusText = state.needsRelink
    ? 'Generating a new code to re-link this WhatsApp...'
    : state.attempts === 1
      ? 'Starting up...'
      : `Starting up... (attempt ${state.attempts})`;

  try {
    await client.initialize();
    state.startupError = null;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error(`[${user.id}] Startup attempt ${state.attempts} failed:`, message);
    state.startupError = message;
    clearTimeout(state.settleTimer);
    state.isReady = false;
    state.authenticating = false;
    state.latestQr = null;

    try {
      await client.destroy();
    } catch {
      /* the browser may already be gone; nothing to clean up */
    }

    if (state.attempts >= MAX_STARTUP_ATTEMPTS) {
      state.statusText =
        'WhatsApp did not start after several tries. Restart the service to try again.';
      console.error(`[${user.id}] Giving up after ${state.attempts} attempts.`);
      return;
    }

    const delay = Math.min(60000, STARTUP_BASE_DELAY_MS * 2 ** (state.attempts - 1));
    state.statusText = `WhatsApp did not start. Retrying in ${Math.round(delay / 1000)}s...`;
    setTimeout(() => {
      startSession(user, state).catch((e) =>
        console.error(`[${user.id}] Retry scheduling failed:`, e && e.message)
      );
    }, delay);
  }
}

// An inbox held back by MAX_ACTIVE_INBOXES: no browser, no retries, and a
// status that explains itself.
function dormantSession() {
  return {
    client: null,
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
    settleTimer: null,
    authenticating: false,
    everAuthenticated: false,
    pairingFailures: 0,
    dormant: true
  };
}

// `startAfterMs` staggers the launches. Starting every Chromium at the same
// instant is what makes them starve each other and time out.
function createSessionForUser(user, startAfterMs = 0) {
  const state = {
    client: null,
    latestQr: null,
    isReady: false,
    statusText: 'Starting up...',
    // Set once this process has actually displayed a QR code, which is how
    // we know a later 'authenticated' came from someone scanning it here
    // rather than from a session restored off the volume.
    sawQrThisRun: false,
    claimCodePlain: null,
    codeVisibleUntil: 0,
    startupError: null,
    attempts: 0,
    needsRelink: false,
    restarting: false,
    settleTimer: null,
    authenticating: false,
    everAuthenticated: false,
    pairingFailures: 0
  };

  const launch = () =>
    startSession(user, state).catch((err) =>
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
      if (!state || !state.client) return;
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
// whatsapp-web.js drives a browser over a socket, and it surfaces failures
// asynchronously long after startup. Node's default is to abort on an
// unhandled rejection, which would take every other inbox down with it, so
// log and keep serving instead.
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
// to require a shared secret first: each inbox costs a headless Chromium, so
// an open form on a public URL is a resource risk as well as a tidiness one.
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
    authenticating: !!state.authenticating
  });
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
            ? {
                body: c.lastMessage.body,
                timestamp: c.lastMessage.timestamp * 1000,
                hasMedia: !!c.lastMessage.hasMedia,
                mediaKind: mediaKindOf(c.lastMessage)
              }
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

// ---- Media ----

// whatsapp-web.js reports a message type per WhatsApp's own vocabulary;
// collapse it to the handful of shapes the viewer knows how to render.
function mediaKindOf(msg) {
  if (!msg.hasMedia) return null;
  switch (msg.type) {
    case 'image':
      return 'image';
    case 'sticker':
      return 'sticker';
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    case 'ptt':
      return 'voice';
    case 'document':
      return 'document';
    default:
      return 'file';
  }
}

// Downloading is slow enough that a re-render must not re-fetch, but media
// is large, so the cache is bounded by both count and total bytes and drops
// the oldest entry first.
const MEDIA_CACHE_MAX_ITEMS = 40;
const MEDIA_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const mediaCache = new Map();
let mediaCacheBytes = 0;

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

app.get('/api/:userId/messages/:messageId/media', async (req, res) => {
  const user = getUserOr404(req, res);
  if (!user) return;
  const state = sessions.get(user.id);

  if (!state.isReady) return res.status(503).json({ error: 'Client not ready yet' });

  const cacheKey = user.id + '|' + req.params.messageId;
  let entry = cacheGet(cacheKey);

  if (!entry) {
    try {
      const msg = await state.client.getMessageById(req.params.messageId);
      if (!msg) return res.status(404).json({ error: 'Message not found' });
      if (!msg.hasMedia) return res.status(404).json({ error: 'Message has no media' });

      const media = await msg.downloadMedia();
      // WhatsApp drops media from its servers after a while; an old message
      // can legitimately have nothing left to download.
      if (!media || !media.data) {
        return res.status(410).json({ error: 'Media is no longer available' });
      }

      entry = {
        buffer: Buffer.from(media.data, 'base64'),
        mimetype: media.mimetype || 'application/octet-stream',
        filename: media.filename || null
      };
      cachePut(cacheKey, entry);
    } catch (err) {
      console.error(`[${user.id}] media download failed:`, err && err.message ? err.message : err);
      return res.status(502).json({ error: 'Could not download that media' });
    }
  }

  const inline = INLINE_MIME.test(entry.mimetype);
  const safeName = (entry.filename || 'attachment').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);

  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'private, max-age=3600');
  res.type(inline ? entry.mimetype : 'application/octet-stream');
  res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`);
  res.send(entry.buffer);
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
          // For a media message this is the caption, which is often empty.
          body: msg.body,
          timestamp: msg.timestamp * 1000,
          hasMedia: !!msg.hasMedia,
          mediaKind: mediaKindOf(msg)
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
// really linked, while the lowercase one holds whatever Chromium wrote when
// the duplicate inbox started up unlinked. A linked, synced session carries
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

// Launching every Chromium at once is what starves them into timing out.
const STARTUP_STAGGER_MS = 8000;

// Comma-separated inbox ids (or "all") whose stored WhatsApp session should
// be set aside at boot, so they start from a clean QR code. Needed when a
// session is dead but the app cannot tell — after unpairing the device from
// the phone, say — because there is otherwise no way to clear one without
// shell access to the volume. Set it, deploy once, then remove it.
// whatsapp-web.js works by injecting into WhatsApp Web's own page, so it is
// tied to that page's internals and a WhatsApp update can break it. The
// library ships the build it was developed against (see DefaultOptions.
// webVersion) for exactly that reason.
//
// Unset, we load whatever WhatsApp serves today. Set WHATSAPP_WEB_VERSION to
// pin a specific build instead, fetched from the wa-version archive — worth
// trying when pairing completes on the phone but never signs in here, which
// is what a version mismatch looks like.
const WHATSAPP_WEB_VERSION = (process.env.WHATSAPP_WEB_VERSION || '').trim();
const WHATSAPP_WEB_VERSION_PATH =
  process.env.WHATSAPP_WEB_VERSION_PATH ||
  'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html';

const webVersionOptions = WHATSAPP_WEB_VERSION
  ? {
      webVersion: WHATSAPP_WEB_VERSION,
      webVersionCache: { type: 'remote', remotePath: WHATSAPP_WEB_VERSION_PATH }
    }
  : { webVersionCache: { type: 'none' } };

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

// How many inboxes may run a browser at the same time. Each one costs a
// headless Chromium, and on a container too small for all of them the
// symptom is not a clean error: pages freeze, QR codes stop rotating, and
// injection times out — so nothing links and nothing says why.
//
// Unset means all of them. 0 means none: no browsers, no QR codes, no
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

  const activeLimit = MAX_ACTIVE_INBOXES === null ? USERS.length : MAX_ACTIVE_INBOXES;

  if (activeLimit === 0) {
    console.warn(
      'MAX_ACTIVE_INBOXES=0 — paused. No browsers are started and no QR codes are ' +
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
    if (USERS.length > 1) {
      console.log(
        `Starting them ${STARTUP_STAGGER_MS / 1000}s apart; the last one is ready in about ` +
          `${Math.round(((USERS.length - 1) * STARTUP_STAGGER_MS) / 1000)}s.`
      );
    }
    if (activeLimit < USERS.length) {
      console.log(`Running only ${activeLimit} of ${USERS.length} inboxes (MAX_ACTIVE_INBOXES).`);
    }
    if (WHATSAPP_WEB_VERSION) {
      console.log(`Pinned to WhatsApp Web build ${WHATSAPP_WEB_VERSION}.`);
    }
    if (INVITE_CODE) console.log('New inboxes require the invite code.');
  });
}

start();
