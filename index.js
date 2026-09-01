const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const auth = require('./auth');
const views = require('./views');

const PORT = process.env.PORT || 3000;
const SESSION_ROOT = process.env.SESSION_PATH || '/data/sessions';

// ---- Hardcoded users ----
// Add/remove people here. `id` is used in URLs and as the session folder
// name, so keep it simple (lowercase, no spaces).
const USERS = [
  { id: 'joshua', name: 'Joshua' },
  { id: 'Marshall', name: 'Marshall' },
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
    statusText: 'Starting up...'
  };

  client.on('qr', async (qr) => {
    state.statusText = 'Scan the QR code below with WhatsApp on your phone.';
    state.latestQr = await qrcode.toDataURL(qr);
    console.log(`[${user.id}] QR code updated. Visit /${user.id}/qr to scan it.`);
  });

  client.on('authenticated', () => {
    state.statusText = 'Authenticated. Finishing startup...';
    state.latestQr = null;
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

for (const user of USERS) {
  sessions.set(user.id, createSessionForUser(user));
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
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ---- Authentication ----
// Railway (and most PaaS) terminate TLS at a proxy, so trust the
// X-Forwarded-* headers to get the real client IP and protocol.
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));

// The stylesheet holds no private data and is needed by the login page
// itself, so it is served before the auth gate.
app.get('/assets/app.css', (req, res) => {
  res.type('text/css').set('Cache-Control', 'public, max-age=3600').send(views.STYLES);
});

app.get('/assets/icon.svg', (req, res) => {
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(views.FAVICON);
});

app.get('/favicon.ico', (req, res) => res.redirect(301, '/assets/icon.svg'));

app.get('/login', (req, res) => {
  if (!auth.isConfigured) return res.status(503).send(views.setupPage());
  if (auth.isLoggedIn(req)) return res.redirect(auth.safeNextPath(req.query.next));
  res.send(views.loginPage({ next: auth.safeNextPath(req.query.next) }));
});

app.post('/login', (req, res) => {
  if (!auth.isConfigured) return res.status(503).send(views.setupPage());

  const next = auth.safeNextPath(req.body && req.body.next);
  const lockedFor = auth.lockoutRemainingMs(req);

  if (lockedFor > 0) {
    const minutes = Math.ceil(lockedFor / 60000);
    return res.status(429).send(
      views.loginPage({
        next,
        error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
      })
    );
  }

  if (!auth.passwordMatches(req.body && req.body.password)) {
    auth.recordFailure(req);
    console.warn(`Failed login attempt from ${req.ip}`);
    return res.status(401).send(views.loginPage({ next, error: 'Incorrect password.' }));
  }

  auth.clearFailures(req);
  auth.setSessionCookie(req, res);
  res.redirect(next);
});

app.post('/logout', (req, res) => {
  auth.clearSessionCookie(req, res);
  res.redirect('/login');
});

// Everything below this line requires a valid session.
app.use((req, res, next) => {
  const wantsJson = req.path.startsWith('/api/');

  if (!auth.isConfigured) {
    return wantsJson
      ? res.status(503).json({ error: 'APP_PASSWORD is not configured on the server' })
      : res.status(503).send(views.setupPage());
  }
  if (auth.isLoggedIn(req)) return next();

  if (wantsJson) return res.status(401).json({ error: 'Not authenticated' });
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
});

// ---- Web routes ----

// Home page: pick which person's inbox to view
app.get('/', (req, res) => {
  res.send(views.homePage(USERS));
});

app.get('/:userId/qr', (req, res) => {
  const user = getUserOr404(req, res);
  if (!user) return;
  res.send(views.qrPage({ user, state: sessions.get(user.id) }));
});

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

app.get('/:userId', (req, res) => {
  const user = getUserOr404(req, res);
  if (!user) return;
  res.send(views.viewerPage(user));
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log('Users configured:', USERS.map((u) => u.id).join(', '));
  if (auth.isConfigured) {
    console.log('Password protection: ON (APP_PASSWORD is set).');
  } else {
    console.warn(
      'Password protection: NOT CONFIGURED. Every page is locked until you ' +
        'set an APP_PASSWORD environment variable and restart.'
    );
  }
});
