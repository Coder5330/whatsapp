const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');

const PORT = process.env.PORT || 3000;
const SESSION_ROOT = process.env.SESSION_PATH || '/data/sessions';

// ---- Hardcoded users ----
// Add/remove people here. `id` is used in URLs and as the session folder
// name, so keep it simple (lowercase, no spaces).
const USERS = [
  { id: 'melissa', name: 'Melissa' },
  { id: 'friend2', name: 'Friend 2' }
  // { id: 'friend3', name: 'Friend 3' },
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

// ---- Web routes ----

app.get('/:userId/qr', (req, res) => {
  const user = getUserOr404(req, res);
  if (!user) return;
  const state = sessions.get(user.id);

  if (state.isReady) {
    return res.send(
      `<h2>${user.name} is already connected. No QR code needed.</h2><p><a href="/${user.id}">Go to viewer</a></p>`
    );
  }
  if (!state.latestQr) {
    return res.send('<h2>Waiting for QR code...</h2><p>Refresh in a few seconds.</p>');
  }
  res.send(`
    <html>
      <body style="font-family: sans-serif; text-align: center; padding-top: 40px;">
        <h2>${user.name}: scan with WhatsApp → Linked Devices</h2>
        <img src="${state.latestQr}" alt="QR code" />
        <p>${state.statusText}</p>
      </body>
    </html>
  `);
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

// Home page: pick which person's inbox to view
app.get('/', (req, res) => {
  const links = USERS.map(
    (u) => `<li><a href="/${u.id}">${u.name}</a> — <a href="/${u.id}/qr">scan QR</a></li>`
  ).join('');
  res.send(`
    <html>
      <body style="font-family: sans-serif; padding: 40px;">
        <h2>WhatsApp Viewer</h2>
        <ul>${links}</ul>
      </body>
    </html>
  `);
});

app.get('/:userId', (req, res) => {
  const user = getUserOr404(req, res);
  if (!user) return;

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>WhatsApp Viewer — ${user.name}</title>
  <style>
    body { font-family: -apple-system, sans-serif; margin: 0; display: flex; height: 100vh; }
    #sidebar { width: 280px; border-right: 1px solid #ddd; overflow-y: auto; }
    #sidebar div.chat { padding: 12px; cursor: pointer; border-bottom: 1px solid #eee; }
    #sidebar div.chat:hover { background: #f5f5f5; }
    #main { flex: 1; display: flex; flex-direction: column; }
    #messages { flex: 1; overflow-y: auto; padding: 16px; }
    .msg { margin-bottom: 10px; max-width: 60%; padding: 8px 12px; border-radius: 8px; }
    .msg.mine { background: #dcf8c6; margin-left: auto; }
    .msg.theirs { background: #f0f0f0; }
    .meta { font-size: 11px; color: #888; margin-top: 4px; }
    #status { padding: 8px 16px; background: #fafafa; border-bottom: 1px solid #ddd; font-size: 13px; }
    #backlink { display: block; padding: 8px 16px; font-size: 12px; }
  </style>
</head>
<body>
  <div id="sidebar">
    <a id="backlink" href="/">&larr; All users</a>
    <div id="chatList">Loading chats...</div>
  </div>
  <div id="main">
    <div id="status">Checking status...</div>
    <div id="messages"><p>Select a chat to view messages.</p></div>
  </div>
  <script>
    const userId = ${JSON.stringify(user.id)};

    async function checkStatus() {
      const res = await fetch('/api/' + userId + '/status');
      const data = await res.json();
      document.getElementById('status').textContent = data.status;
      if (!data.ready) {
        if (data.hasQr) {
          document.getElementById('status').innerHTML += ' — <a href="/' + userId + '/qr" target="_blank">Scan QR code</a>';
        }
        setTimeout(checkStatus, 3000);
        return false;
      }
      return true;
    }

    async function loadChats() {
      const ready = await checkStatus();
      if (!ready) { setTimeout(loadChats, 3000); return; }
      const list = document.getElementById('chatList');
      try {
        const res = await fetch('/api/' + userId + '/chats');
        const data = await res.json();
        if (!res.ok || !Array.isArray(data)) {
          console.error('Chats fetch failed:', data);
          list.innerHTML = '<div style="padding:12px;color:#c00;">' +
            'Could not load chats yet: ' + (data.error || 'unknown error') +
            '<br><small>Retrying in 5s...</small></div>';
          setTimeout(loadChats, 5000);
          return;
        }
        list.innerHTML = '';
        if (data.length === 0) {
          list.innerHTML = '<div style="padding:12px;color:#888;">No chats found yet. Retrying...</div>';
          setTimeout(loadChats, 5000);
          return;
        }
        data.forEach((chat) => {
          const div = document.createElement('div');
          div.className = 'chat';
          div.textContent = chat.name + (chat.unreadCount ? ' (' + chat.unreadCount + ')' : '');
          div.onclick = () => loadMessages(chat.id, chat.name);
          list.appendChild(div);
        });
      } catch (err) {
        console.error('Chats fetch threw:', err);
        list.innerHTML = '<div style="padding:12px;color:#c00;">Error loading chats: ' + err.message +
          '<br><small>Retrying in 5s...</small></div>';
        setTimeout(loadChats, 5000);
      }
    }

    async function loadMessages(chatId, chatName) {
      const res = await fetch('/api/' + userId + '/chats/' + encodeURIComponent(chatId) + '/messages');
      const msgs = await res.json();
      const container = document.getElementById('messages');
      container.innerHTML = '<h3>' + chatName + '</h3>';
      msgs.forEach((m) => {
        const div = document.createElement('div');
        div.className = 'msg ' + (m.fromMe ? 'mine' : 'theirs');
        div.innerHTML = '<div>' + (m.body || '<i>[media/no text]</i>') + '</div>' +
          '<div class="meta">' + m.fromName + ' · ' + new Date(m.timestamp).toLocaleString() + '</div>';
        container.appendChild(div);
      });
      container.scrollTop = container.scrollHeight;
    }

    loadChats();
  </script>
</body>
</html>
  `);
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log('Users configured:', USERS.map((u) => u.id).join(', '));
});
