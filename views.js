// All HTML the server renders lives here: one shared stylesheet plus a
// template per page (login, setup notice, home, QR, viewer).

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLES = `
:root {
  --bg: #f0f2f5;
  --panel: #ffffff;
  --panel-alt: #f7f8fa;
  --border: #e4e7ea;
  --text: #111b21;
  --muted: #667781;
  --accent: #1d8a63;
  --accent-soft: #e7f4ee;
  --bubble-mine: #d9fdd3;
  --bubble-theirs: #ffffff;
  --danger: #c0392b;
  --danger-soft: #fdecea;
  --shadow: 0 1px 2px rgba(11, 20, 26, .06), 0 8px 24px rgba(11, 20, 26, .06);
  --radius: 14px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0b141a;
    --panel: #111b21;
    --panel-alt: #182229;
    --border: #22303a;
    --text: #e9edef;
    --muted: #8696a0;
    --accent: #00a884;
    --accent-soft: #143a30;
    --bubble-mine: #005c4b;
    --bubble-theirs: #202c33;
    --danger: #f2827a;
    --danger-soft: #3a1d1a;
    --shadow: 0 1px 2px rgba(0, 0, 0, .3), 0 8px 24px rgba(0, 0, 0, .28);
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    "Helvetica Neue", Arial, sans-serif;
  font-size: 15px;
  line-height: 1.5;
  color: var(--text);
  background: var(--bg);
  -webkit-font-smoothing: antialiased;
}

a { color: var(--accent); }

/* ---------- Centered card pages (login, QR, setup) ---------- */

.centered {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.card {
  width: 100%;
  max-width: 400px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 32px;
  text-align: center;
}

.card.wide { max-width: 560px; }

.card h1 {
  margin: 0 0 6px;
  font-size: 21px;
  font-weight: 600;
  letter-spacing: -.01em;
}

.card p.sub {
  margin: 0 0 24px;
  color: var(--muted);
  font-size: 14px;
}

.logo {
  width: 52px;
  height: 52px;
  margin: 0 auto 18px;
  border-radius: 16px;
  background: var(--accent-soft);
  color: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
}

.logo svg { width: 26px; height: 26px; }

/* ---------- Forms ---------- */

form.stack { display: flex; flex-direction: column; gap: 12px; text-align: left; }

label.field { font-size: 13px; font-weight: 500; color: var(--muted); }

input[type="password"], input[type="search"], input[type="text"] {
  width: 100%;
  font: inherit;
  color: var(--text);
  background: var(--panel-alt);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 11px 13px;
  margin-top: 6px;
  outline: none;
  transition: border-color .15s, box-shadow .15s;
}

input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

button {
  font: inherit;
  font-weight: 600;
  color: #fff;
  background: var(--accent);
  border: 0;
  border-radius: 10px;
  padding: 11px 16px;
  cursor: pointer;
  transition: opacity .15s, transform .05s;
}

button:hover { opacity: .9; }
button:active { transform: translateY(1px); }

.alert {
  background: var(--danger-soft);
  color: var(--danger);
  border-radius: 10px;
  padding: 10px 13px;
  font-size: 13.5px;
  text-align: left;
  margin-bottom: 16px;
}

.hint {
  margin: 18px 0 0;
  font-size: 12.5px;
  color: var(--muted);
}

code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: .92em;
  background: var(--panel-alt);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 1px 5px;
}

/* ---------- Home page ---------- */

.home { max-width: 640px; margin: 0 auto; padding: 56px 24px; }

.home header { display: flex; align-items: center; gap: 14px; margin-bottom: 28px; }
.home header .logo { margin: 0; width: 46px; height: 46px; border-radius: 14px; }
.home header h1 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -.01em; }
.home header p { margin: 2px 0 0; font-size: 13.5px; color: var(--muted); }
.home header .spacer { flex: 1; }

.user-grid { display: flex; flex-direction: column; gap: 12px; }

.user-card {
  display: flex;
  align-items: center;
  gap: 14px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px 18px;
  box-shadow: var(--shadow);
  text-decoration: none;
  color: inherit;
  transition: transform .12s, border-color .12s;
}

.user-card:hover { transform: translateY(-1px); border-color: var(--accent); }

.user-card .name { font-weight: 600; }
.user-card .state { font-size: 13px; color: var(--muted); }
.user-card .grow { flex: 1; min-width: 0; }

.qr-link {
  font-size: 13px;
  font-weight: 500;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: 999px;
  padding: 6px 12px;
  text-decoration: none;
  white-space: nowrap;
}

.avatar {
  flex-shrink: 0;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 15px;
  text-transform: uppercase;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted);
  display: inline-block;
  margin-right: 6px;
  vertical-align: 1px;
}

.dot.on { background: var(--accent); }
.dot.warn { background: #e0a800; }

.linkbtn {
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  color: var(--muted);
  background: none;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 6px 13px;
}

.linkbtn:hover { color: var(--text); border-color: var(--muted); opacity: 1; }

/* ---------- QR page ---------- */

.qr-frame {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 14px;
  display: inline-block;
  line-height: 0;
  margin-bottom: 18px;
}

.qr-frame img { width: 240px; height: 240px; display: block; }

.pill {
  display: inline-block;
  font-size: 13px;
  color: var(--muted);
  background: var(--panel-alt);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 6px 14px;
}

.steps {
  text-align: left;
  margin: 20px 0 0;
  padding-left: 20px;
  font-size: 13.5px;
  color: var(--muted);
}

.steps li { margin-bottom: 4px; }

.spinner {
  width: 26px;
  height: 26px;
  margin: 4px auto 16px;
  border: 3px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin .8s linear infinite;
}

@keyframes spin { to { transform: rotate(360deg); } }

/* ---------- Viewer ---------- */

body.viewer { height: 100vh; overflow: hidden; }

.app { display: flex; height: 100vh; }

.sidebar {
  width: 330px;
  flex-shrink: 0;
  background: var(--panel);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}

.sidebar-head {
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 11px;
}

.sidebar-head .grow { flex: 1; min-width: 0; }
.sidebar-head .name { font-weight: 600; font-size: 15px; }
.sidebar-head .back { font-size: 12.5px; color: var(--muted); text-decoration: none; }
.sidebar-head .back:hover { color: var(--accent); }

.search-wrap { padding: 12px 16px; border-bottom: 1px solid var(--border); }
.search-wrap input { margin-top: 0; }

.chat-list { flex: 1; overflow-y: auto; }

.chat {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 16px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
  transition: background .12s;
}

.chat:hover { background: var(--panel-alt); }
.chat.active { background: var(--accent-soft); }

.chat .grow { flex: 1; min-width: 0; }

.chat .title {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.chat .title .nm {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}

.chat .title .when { font-size: 11.5px; color: var(--muted); flex-shrink: 0; }

.chat .preview {
  font-size: 13px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.badge {
  flex-shrink: 0;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 11.5px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}

.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }

.statusbar {
  padding: 9px 20px;
  background: var(--panel-alt);
  border-bottom: 1px solid var(--border);
  font-size: 13px;
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 8px;
}

.chat-head {
  padding: 12px 20px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 12px;
}

.chat-head .nm { font-weight: 600; }
.chat-head .sub { font-size: 12.5px; color: var(--muted); }

/* Only reachable on narrow screens, where the chat list is hidden. */
.back-to-list {
  display: none;
  flex-shrink: 0;
  font-size: 20px;
  line-height: 1;
  color: var(--muted);
  background: none;
  border: 0;
  padding: 4px 8px 4px 0;
}

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 22px 20px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.divider {
  align-self: center;
  margin: 14px 0 10px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--muted);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 4px 12px;
}

.bubble {
  max-width: min(64%, 560px);
  padding: 7px 11px 5px;
  border-radius: 12px;
  background: var(--bubble-theirs);
  box-shadow: 0 1px 1px rgba(11, 20, 26, .08);
  word-wrap: break-word;
  overflow-wrap: anywhere;
}

.bubble.mine { align-self: flex-end; background: var(--bubble-mine); }
.bubble.theirs { align-self: flex-start; }

.bubble + .bubble.mine, .bubble + .bubble.theirs { margin-top: 3px; }

.bubble .author {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--accent);
  margin-bottom: 2px;
}

.bubble .text { white-space: pre-wrap; }
.bubble .text.media { color: var(--muted); font-style: italic; }

.bubble .time {
  font-size: 11px;
  color: var(--muted);
  text-align: right;
  margin-top: 2px;
}

.placeholder {
  margin: auto;
  text-align: center;
  color: var(--muted);
  font-size: 14px;
  max-width: 320px;
}

.placeholder .logo { margin-bottom: 14px; }

.notice { padding: 14px 16px; font-size: 13.5px; color: var(--muted); }
.notice.error { color: var(--danger); }
.notice small { display: block; margin-top: 4px; opacity: .8; }

@media (max-width: 720px) {
  .sidebar { width: 100%; }
  .app.has-chat .sidebar { display: none; }
  .app:not(.has-chat) .main { display: none; }
  .bubble { max-width: 82%; }
  .back-to-list { display: block; }
}
`;

const LOCK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="3" y="11" width="18" height="11" rx="2"/>' +
  '<path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';

const CHAT_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';

function page({ title, body, bodyClass = '' }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/assets/app.css" />
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml" />
</head>
<body${bodyClass ? ` class="${bodyClass}"` : ''}>
${body}
</body>
</html>`;
}

function loginPage({ error = '', next = '/' } = {}) {
  return page({
    title: 'Sign in — WhatsApp Viewer',
    body: `
<div class="centered">
  <div class="card">
    <div class="logo">${LOCK_ICON}</div>
    <h1>WhatsApp Viewer</h1>
    <p class="sub">This inbox is private. Enter the password to continue.</p>
    ${error ? `<div class="alert">${escapeHtml(error)}</div>` : ''}
    <form class="stack" method="POST" action="/login">
      <input type="hidden" name="next" value="${escapeHtml(next)}" />
      <label class="field">
        Password
        <input type="password" name="password" autocomplete="current-password"
               autofocus required />
      </label>
      <button type="submit">Sign in</button>
    </form>
  </div>
</div>`
  });
}

function setupPage() {
  return page({
    title: 'Setup required — WhatsApp Viewer',
    body: `
<div class="centered">
  <div class="card wide">
    <div class="logo">${LOCK_ICON}</div>
    <h1>Set a password first</h1>
    <p class="sub">
      No <code>APP_PASSWORD</code> is configured, so the viewer has locked
      itself rather than serving anyone's messages to the open internet.
    </p>
    <p class="hint">
      Set an <code>APP_PASSWORD</code> environment variable on the service
      (Railway: <strong>Variables</strong> tab) and redeploy. Everyone who
      should have access uses that one password to sign in.
    </p>
  </div>
</div>`
  });
}

function homePage(users) {
  const cards = users
    .map((u) => {
      const id = escapeHtml(u.id);
      const name = escapeHtml(u.name);
      const initial = escapeHtml((u.name || u.id).trim().charAt(0) || '?');
      return `
      <div class="user-card" data-user="${id}">
        <div class="avatar">${initial}</div>
        <a class="grow" href="/${encodeURIComponent(u.id)}" style="text-decoration:none;color:inherit;">
          <div class="name">${name}</div>
          <div class="state"><span class="dot"></span><span class="state-text">Checking…</span></div>
        </a>
        <a class="qr-link" href="/${encodeURIComponent(u.id)}/qr">Scan QR</a>
      </div>`;
    })
    .join('');

  return page({
    title: 'WhatsApp Viewer',
    body: `
<div class="home">
  <header>
    <div class="logo">${CHAT_ICON}</div>
    <div>
      <h1>WhatsApp Viewer</h1>
      <p>Pick an inbox to browse.</p>
    </div>
    <div class="spacer"></div>
    <form method="POST" action="/logout">
      <button class="linkbtn" type="submit">Sign out</button>
    </form>
  </header>
  <div class="user-grid">${cards}</div>
</div>
<script>
  document.querySelectorAll('.user-card').forEach(function (card) {
    var id = card.getAttribute('data-user');
    fetch('/api/' + encodeURIComponent(id) + '/status')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var dot = card.querySelector('.dot');
        var text = card.querySelector('.state-text');
        text.textContent = d.status || 'Unknown';
        dot.className = 'dot' + (d.ready ? ' on' : (d.hasQr ? ' warn' : ''));
      })
      .catch(function () {
        card.querySelector('.state-text').textContent = 'Status unavailable';
      });
  });
</script>`
  });
}

function qrPage({ user, state }) {
  const name = escapeHtml(user.name);
  const href = '/' + encodeURIComponent(user.id);

  if (state.isReady) {
    return page({
      title: `${user.name} connected — WhatsApp Viewer`,
      body: `
<div class="centered">
  <div class="card">
    <div class="logo">${CHAT_ICON}</div>
    <h1>${name} is connected</h1>
    <p class="sub">No QR code needed — the session is already linked.</p>
    <a href="${href}"><button type="button">Open inbox</button></a>
  </div>
</div>`
    });
  }

  if (!state.latestQr) {
    return page({
      title: `Waiting for QR — ${user.name}`,
      body: `
<div class="centered">
  <div class="card">
    <div class="spinner"></div>
    <h1>Generating QR code…</h1>
    <p class="sub">${escapeHtml(state.statusText)}</p>
    <span class="pill">This page refreshes automatically</span>
  </div>
</div>
<script>setTimeout(function () { location.reload(); }, 4000);</script>`
    });
  }

  return page({
    title: `Link ${user.name} — WhatsApp Viewer`,
    body: `
<div class="centered">
  <div class="card">
    <h1>Link ${name}'s WhatsApp</h1>
    <p class="sub">${escapeHtml(state.statusText)}</p>
    <div class="qr-frame"><img src="${state.latestQr}" alt="WhatsApp linking QR code" /></div>
    <ol class="steps">
      <li>Open WhatsApp on the phone.</li>
      <li>Go to <strong>Settings → Linked Devices</strong>.</li>
      <li>Tap <strong>Link a Device</strong> and scan this code.</li>
    </ol>
    <p class="hint">Codes expire after a while — this page refreshes itself.</p>
  </div>
</div>
<script>setTimeout(function () { location.reload(); }, 20000);</script>`
  });
}

function viewerPage(user) {
  const name = escapeHtml(user.name);
  const initial = escapeHtml((user.name || user.id).trim().charAt(0) || '?');

  return page({
    title: `${user.name} — WhatsApp Viewer`,
    bodyClass: 'viewer',
    body: `
<div class="app" id="app">
  <aside class="sidebar">
    <div class="sidebar-head">
      <div class="avatar">${initial}</div>
      <div class="grow">
        <div class="name">${name}</div>
        <a class="back" href="/">&larr; All inboxes</a>
      </div>
      <form method="POST" action="/logout">
        <button class="linkbtn" type="submit">Sign out</button>
      </form>
    </div>
    <div class="search-wrap">
      <input type="search" id="search" placeholder="Search chats" autocomplete="off" />
    </div>
    <div class="chat-list" id="chatList">
      <div class="notice">Loading chats…</div>
    </div>
  </aside>

  <main class="main">
    <div class="statusbar" id="status"><span class="dot"></span><span id="statusText">Checking status…</span></div>
    <div class="chat-head" id="chatHead" hidden>
      <button class="back-to-list" id="backToList" type="button" aria-label="Back to chats">&larr;</button>
      <div class="avatar" id="chatAvatar"></div>
      <div>
        <div class="nm" id="chatName"></div>
        <div class="sub" id="chatSub"></div>
      </div>
    </div>
    <div class="messages" id="messages">
      <div class="placeholder">
        <div class="logo">${CHAT_ICON}</div>
        Select a chat on the left to read its recent messages.
      </div>
    </div>
  </main>
</div>

<script>
(function () {
  var userId = ${JSON.stringify(user.id)};
  var chats = [];
  var activeChatId = null;

  var listEl = document.getElementById('chatList');
  var messagesEl = document.getElementById('messages');
  var statusTextEl = document.getElementById('statusText');
  var statusDotEl = document.querySelector('#status .dot');
  var searchEl = document.getElementById('search');
  var appEl = document.getElementById('app');

  function initialsOf(text) {
    var t = (text || '?').trim();
    return t.charAt(0) || '?';
  }

  function shortTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // "14:32" for today, "Tue" this past week, otherwise a short date.
  function listStamp(ts) {
    var d = new Date(ts);
    var now = new Date();
    if (d.toDateString() === now.toDateString()) return shortTime(ts);
    if (now - d < 7 * 24 * 3600 * 1000) return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function dayLabel(ts) {
    var d = new Date(ts);
    var now = new Date();
    var yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
    if (d.toDateString() === now.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  }

  function notice(el, text, isError, sub) {
    el.innerHTML = '';
    var div = document.createElement('div');
    div.className = 'notice' + (isError ? ' error' : '');
    div.textContent = text;
    if (sub) {
      var small = document.createElement('small');
      small.textContent = sub;
      div.appendChild(small);
    }
    el.appendChild(div);
  }

  // A 401 means the login cookie expired while the page was open.
  function handleAuth(res) {
    if (res.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); return false; }
    return true;
  }

  async function checkStatus() {
    try {
      var res = await fetch('/api/' + encodeURIComponent(userId) + '/status');
      if (!handleAuth(res)) return false;
      var data = await res.json();
      statusTextEl.textContent = data.status;
      statusDotEl.className = 'dot' + (data.ready ? ' on' : (data.hasQr ? ' warn' : ''));
      if (!data.ready) {
        if (data.hasQr) {
          var a = document.createElement('a');
          a.href = '/' + encodeURIComponent(userId) + '/qr';
          a.target = '_blank';
          a.textContent = 'Scan QR code';
          statusTextEl.appendChild(document.createTextNode(' — '));
          statusTextEl.appendChild(a);
        }
        return false;
      }
      return true;
    } catch (err) {
      statusTextEl.textContent = 'Connection lost — retrying…';
      statusDotEl.className = 'dot';
      return false;
    }
  }

  function renderChats() {
    var term = searchEl.value.trim().toLowerCase();
    var visible = term
      ? chats.filter(function (c) { return (c.name || '').toLowerCase().indexOf(term) !== -1; })
      : chats;

    listEl.innerHTML = '';
    if (visible.length === 0) {
      notice(listEl, term ? 'No chats match "' + searchEl.value.trim() + '".' : 'No chats yet.');
      return;
    }

    visible.forEach(function (chat) {
      var row = document.createElement('div');
      row.className = 'chat' + (chat.id === activeChatId ? ' active' : '');

      var avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = initialsOf(chat.name);
      row.appendChild(avatar);

      var grow = document.createElement('div');
      grow.className = 'grow';

      var title = document.createElement('div');
      title.className = 'title';
      var nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = chat.name;
      title.appendChild(nm);
      if (chat.lastMessage) {
        var when = document.createElement('span');
        when.className = 'when';
        when.textContent = listStamp(chat.lastMessage.timestamp);
        title.appendChild(when);
      }
      grow.appendChild(title);

      var preview = document.createElement('div');
      preview.className = 'preview';
      preview.textContent = chat.lastMessage
        ? (chat.lastMessage.body || '[media]')
        : 'No messages yet';
      grow.appendChild(preview);
      row.appendChild(grow);

      if (chat.unreadCount) {
        var badge = document.createElement('div');
        badge.className = 'badge';
        badge.textContent = chat.unreadCount > 99 ? '99+' : chat.unreadCount;
        row.appendChild(badge);
      }

      row.onclick = function () { openChat(chat); };
      listEl.appendChild(row);
    });
  }

  async function loadChats() {
    var ready = await checkStatus();
    if (!ready) { setTimeout(loadChats, 3000); return; }

    try {
      var res = await fetch('/api/' + encodeURIComponent(userId) + '/chats');
      if (!handleAuth(res)) return;
      var data = await res.json();

      if (!res.ok || !Array.isArray(data)) {
        notice(listEl, 'Could not load chats: ' + (data && data.error ? data.error : 'unknown error'),
          true, 'Retrying in 5s…');
        setTimeout(loadChats, 5000);
        return;
      }
      if (data.length === 0) {
        notice(listEl, 'No chats found yet.', false, 'WhatsApp may still be syncing — retrying in 5s…');
        setTimeout(loadChats, 5000);
        return;
      }

      chats = data;
      renderChats();
    } catch (err) {
      notice(listEl, 'Error loading chats: ' + err.message, true, 'Retrying in 5s…');
      setTimeout(loadChats, 5000);
    }
  }

  async function openChat(chat) {
    activeChatId = chat.id;
    appEl.classList.add('has-chat');
    renderChats();

    document.getElementById('chatHead').hidden = false;
    document.getElementById('chatAvatar').textContent = initialsOf(chat.name);
    document.getElementById('chatName').textContent = chat.name;
    document.getElementById('chatSub').textContent = chat.isGroup ? 'Group chat' : 'Direct message';

    notice(messagesEl, 'Loading messages…');

    try {
      var res = await fetch('/api/' + encodeURIComponent(userId) + '/chats/' +
        encodeURIComponent(chat.id) + '/messages');
      if (!handleAuth(res)) return;
      var msgs = await res.json();

      if (!res.ok || !Array.isArray(msgs)) {
        notice(messagesEl, 'Could not load messages: ' +
          (msgs && msgs.error ? msgs.error : 'unknown error'), true);
        return;
      }
      renderMessages(msgs, chat);
    } catch (err) {
      notice(messagesEl, 'Error loading messages: ' + err.message, true);
    }
  }

  function renderMessages(msgs, chat) {
    messagesEl.innerHTML = '';
    if (msgs.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'placeholder';
      empty.textContent = 'No messages in this chat yet.';
      messagesEl.appendChild(empty);
      return;
    }

    var lastDay = null;
    var lastSender = null;

    msgs.forEach(function (m) {
      var day = new Date(m.timestamp).toDateString();
      if (day !== lastDay) {
        var divider = document.createElement('div');
        divider.className = 'divider';
        divider.textContent = dayLabel(m.timestamp);
        messagesEl.appendChild(divider);
        lastDay = day;
        lastSender = null;
      }

      var bubble = document.createElement('div');
      bubble.className = 'bubble ' + (m.fromMe ? 'mine' : 'theirs');

      // In groups, label who spoke — but only on the first of a run from
      // the same person, the way a chat app does it.
      if (chat.isGroup && !m.fromMe && m.fromName !== lastSender) {
        var author = document.createElement('div');
        author.className = 'author';
        author.textContent = m.fromName;
        bubble.appendChild(author);
      }
      lastSender = m.fromName;

      var text = document.createElement('div');
      text.className = 'text' + (m.body ? '' : ' media');
      // textContent, never innerHTML: message bodies are untrusted input.
      text.textContent = m.body || '[media / no text]';
      bubble.appendChild(text);

      var time = document.createElement('div');
      time.className = 'time';
      time.textContent = shortTime(m.timestamp);
      bubble.appendChild(time);

      messagesEl.appendChild(bubble);
    });

    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  document.getElementById('backToList').addEventListener('click', function () {
    appEl.classList.remove('has-chat');
  });

  searchEl.addEventListener('input', renderChats);
  loadChats();
})();
</script>`
  });
}

// Served at /assets/icon.svg — a small speech bubble in the accent green.
const FAVICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
  '<rect width="24" height="24" rx="6" fill="#1d8a63"/>' +
  '<path d="M20 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3.5 20.5l1.9-4.2a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" ' +
  'fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

module.exports = {
  STYLES,
  FAVICON,
  escapeHtml,
  page,
  loginPage,
  setupPage,
  homePage,
  qrPage,
  viewerPage
};
