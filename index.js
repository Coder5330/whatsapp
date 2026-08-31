const express = require('express');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const PORT = process.env.PORT || 3000;
const SESSION_PATH = process.env.SESSION_PATH || '/data/session';

const app = express();

// ---- In-memory state ----
let latestQr = null;          // data URL of current QR code (null once logged in)
let isReady = false;
let statusText = 'Starting up...';
const messagesByChat = new Map(); // chatId -> array of {id, from, fromName, body, timestamp, fromMe}

function pushMessage(chatId, msg) {
  if (!messagesByChat.has(chatId)) messagesByChat.set(chatId, []);
  const arr = messagesByChat.get(chatId);
  arr.push(msg);
  // keep last 500 per chat so memory doesn't grow unbounded
  if (arr.length > 500) arr.shift();
}

// ---- WhatsApp client ----
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),
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

client.on('qr', async (qr) => {
  statusText = 'Scan the QR code below with WhatsApp on your phone.';
  latestQr = await qrcode.toDataURL(qr);
  console.log('QR code updated. Visit /qr to scan it.');
});

client.on('authenticated', () => {
  statusText = 'Authenticated. Finishing startup...';
  latestQr = null;
});

client.on('ready', () => {
  isReady = true;
  statusText = 'Connected.';
  latestQr = null;
  console.log('WhatsApp client is ready.');
});

client.on('disconnected', (reason) => {
  isReady = false;
  statusText = `Disconnected: ${reason}. Restart the service to reconnect.`;
  console.log('Client disconnected:', reason);
});

client.on('message_create', async (msg) => {
  try {
    const chat = await msg.getChat();
    const contact = await msg.getContact();
    pushMessage(chat.id._serialized, {
      id: msg.id._serialized,
      fromMe: msg.fromMe,
      fromName: msg.fromMe ? 'You' : (contact.pushname || contact.number || 'Unknown'),
      body: msg.body,
      timestamp: msg.timestamp * 1000
    });
  } catch (err) {
    console.error('Error handling incoming message:', err);
  }
});

client.initialize();

// ---- Web routes ----

app.get('/qr', (req, res) => {
  if (isReady) {
    return res.send('<h2>Already connected. No QR code needed.</h2><p><a href="/">Go to viewer</a></p>');
  }
  if (!latestQr) {
    return res.send('<h2>Waiting for QR code...</h2><p>Refresh in a few seconds.</p>');
  }
  res.send(`
    <html>
      <body style="font-family: sans-serif; text-align: center; padding-top: 40px;">
        <h2>Scan with WhatsApp → Linked Devices</h2>
        <img src="${latestQr}" alt="QR code" />
        <p>${statusText}</p>
      </body>
    </html>
  `);
});

app.get('/api/status', (req, res) => {
  res.json({ ready: isReady, status: statusText, hasQr: !!latestQr });
});

app.get('/api/chats', async (req, res) => {
  if (!isReady) return res.status(503).json({ error: 'Client not ready yet' });
  try {
    const chats = await client.getChats();
    res.json(
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
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/chats/:id/messages', async (req, res) => {
  if (!isReady) return res.status(503).json({ error: 'Client not ready yet' });
  const chatId = req.params.id;
  try {
    // merge live-captured messages with a fresh history fetch
    const chat = await client.getChatById(chatId);
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
    res.status(500).json({ error: String(err) });
  }
});

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>WhatsApp Viewer</title>
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
  </style>
</head>
<body>
  <div id="sidebar"><div id="chatList">Loading chats...</div></div>
  <div id="main">
    <div id="status">Checking status...</div>
    <div id="messages"><p>Select a chat to view messages.</p></div>
  </div>
  <script>
    async function checkStatus() {
      const res = await fetch('/api/status');
      const data = await res.json();
      document.getElementById('status').textContent = data.status;
      if (!data.ready) {
        if (data.hasQr) {
          document.getElementById('status').innerHTML += ' — <a href="/qr" target="_blank">Scan QR code</a>';
        }
        setTimeout(checkStatus, 3000);
        return false;
      }
      return true;
    }

    async function loadChats() {
      const ready = await checkStatus();
      if (!ready) { setTimeout(loadChats, 3000); return; }
      const res = await fetch('/api/chats');
      const chats = await res.json();
      const list = document.getElementById('chatList');
      list.innerHTML = '';
      chats.forEach((chat) => {
        const div = document.createElement('div');
        div.className = 'chat';
        div.textContent = chat.name + (chat.unreadCount ? ' (' + chat.unreadCount + ')' : '');
        div.onclick = () => loadMessages(chat.id, chat.name);
        list.appendChild(div);
      });
    }

    async function loadMessages(chatId, chatName) {
      const res = await fetch('/api/chats/' + encodeURIComponent(chatId) + '/messages');
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
  console.log(\`Server listening on port \${PORT}\`);
});
