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

/* Unlink throws the stored session away, so it is deliberately not the
   button your eye lands on first. */
.unlink {
  margin-top: 22px;
  padding-top: 18px;
  border-top: 1px solid var(--border);
}

.unlink button {
  background: transparent;
  color: var(--danger);
  border: 1px solid var(--danger);
  padding: 9px 14px;
  font-size: 14px;
}

.unlink .hint { margin-top: 10px; }

.newcode { margin-top: 18px; }
.newcode button { padding: 10px 16px; }

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

.create-card {
  margin-top: 22px;
  background: var(--panel);
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  padding: 20px;
}

.create-card h2 { margin: 0 0 4px; font-size: 16px; font-weight: 600; }

.create-form { display: flex; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
.create-form input { flex: 1; min-width: 180px; margin-top: 0; }
.create-form button { flex-shrink: 0; }

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
  overflow: hidden;
  position: relative;
}

/* The photo sits over the initials rather than replacing them, so a picture
   that fails to load simply never appears and the initials stand. It fades
   in on load, which also means no flash of a half-drawn image. */
.avatar img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  opacity: 0;
  transition: opacity .15s ease-out;
}

.avatar img.ready { opacity: 1; }

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

.code-box {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 27px;
  font-weight: 600;
  letter-spacing: .12em;
  color: var(--accent);
  background: var(--accent-soft);
  border: 1px dashed var(--accent);
  border-radius: 12px;
  padding: 16px 12px;
  margin: 4px 0 20px;
  user-select: all;
  word-break: break-all;
}

.notice-ok {
  background: var(--accent-soft);
  color: var(--accent);
  border-radius: 10px;
  padding: 10px 13px;
  font-size: 13.5px;
  text-align: left;
  margin-bottom: 16px;
}

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

.media-wrap { margin: 2px 0 4px; }

.media-img {
  display: block;
  max-width: 100%;
  max-height: 340px;
  width: auto;
  border-radius: 8px;
  background: var(--panel-alt);
}

.media-img.sticker {
  max-height: 140px;
  background: none;
}

.media-audio { width: 100%; min-width: 240px; max-width: 320px; display: block; }

/* The embedded preview is a low-resolution JPEG, so it is blurred on
   purpose until the real file lands on top of it. */
.media-img.preview {
  filter: blur(6px);
  transform: scale(1.02);
}

.media-img { transition: filter .18s ease-out; }

.media-file {
  display: inline-block;
  font-size: 13.5px;
  font-weight: 500;
  color: var(--accent);
  background: var(--panel-alt);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  text-decoration: none;
}

.media-file:hover { border-color: var(--accent); }

.media-fallback {
  font-size: 13px;
  font-style: italic;
  color: var(--muted);
  background: var(--panel-alt);
  border-radius: 8px;
  padding: 10px 12px;
}

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

// Shown when an inbox is claimed and needs its owner's password.
function inboxLoginPage({ user, error = '', next = '' } = {}) {
  const id = encodeURIComponent(user.id);
  const nextValue = next || '/' + id;
  return page({
    title: `Sign in to ${user.name} — WhatsApp Viewer`,
    body: `
<div class="centered">
  <div class="card">
    <div class="logo">${LOCK_ICON}</div>
    <h1>${escapeHtml(user.name)}'s inbox</h1>
    <p class="sub">This inbox is private. Enter its password to continue.</p>
    ${error ? `<div class="alert">${escapeHtml(error)}</div>` : ''}
    <form class="stack" method="POST" action="/${id}/login">
      <input type="hidden" name="next" value="${escapeHtml(nextValue)}" />
      <label class="field">
        Password
        <input type="password" name="password" autocomplete="current-password"
               autofocus required />
      </label>
      <button type="submit">Sign in</button>
    </form>
    <p class="hint"><a href="/">All inboxes</a></p>
  </div>
</div>`
  });
}

// First-run page: the owner proves it is their inbox with the setup code
// they were shown when they scanned the QR, then picks their own password.
function inboxSetupPage({ user, error = '', prefillCode = '' } = {}) {
  const id = encodeURIComponent(user.id);
  return page({
    title: `Set up ${user.name} — WhatsApp Viewer`,
    body: `
<div class="centered">
  <div class="card">
    <div class="logo">${LOCK_ICON}</div>
    <h1>Set your password</h1>
    <p class="sub">
      Nobody has set a password for ${escapeHtml(user.name)}'s inbox yet.
      Enter the setup code shown when this WhatsApp was linked, then choose
      a password only you know.
    </p>
    ${error ? `<div class="alert">${escapeHtml(error)}</div>` : ''}
    <form class="stack" method="POST" action="/${id}/setup">
      <label class="field">
        Setup code
        <input type="text" name="code" value="${escapeHtml(prefillCode)}"
               placeholder="XXXX-XXXX" autocomplete="off" spellcheck="false"
               autocapitalize="characters" required ${prefillCode ? '' : 'autofocus'} />
      </label>
      <label class="field">
        New password
        <input type="password" name="password" autocomplete="new-password"
               required ${prefillCode ? 'autofocus' : ''} />
      </label>
      <label class="field">
        Confirm password
        <input type="password" name="confirm" autocomplete="new-password" required />
      </label>
      <button type="submit">Set password</button>
    </form>
    <p class="hint">
      Lost the code? Re-link this WhatsApp from the
      <a href="/${id}/qr">QR page</a> to be shown a new one.
    </p>
  </div>
</div>`
  });
}

// Unclaimed, but there is no code to hand out yet — the session was
// restored from disk rather than scanned in this run, so the code went to
// the server logs instead of a public page.
function inboxAwaitingCodePage({ user }) {
  const id = encodeURIComponent(user.id);
  return page({
    title: `${user.name} needs a setup code — WhatsApp Viewer`,
    body: `
<div class="centered">
  <div class="card wide">
    <div class="logo">${LOCK_ICON}</div>
    <h1>Setup code needed</h1>
    <p class="sub">
      ${escapeHtml(user.name)}'s inbox has no password yet, and its WhatsApp
      was already linked before this server started — so no code was shown
      on screen.
    </p>
    <p class="hint">
      Whoever runs the server can read the current setup code from the
      service logs (Railway: <strong>Deployments → View logs</strong>), or
      you can re-link this WhatsApp from the <a href="/${id}/qr">QR page</a>
      and the code will be shown right after you scan.
    </p>
    <p class="hint"><a href="/${id}/setup">I have a code</a> · <a href="/">All inboxes</a></p>
  </div>
</div>`
  });
}

function changePasswordPage({ user, error = '', notice = '' } = {}) {
  const id = encodeURIComponent(user.id);
  return page({
    title: `Change password — ${user.name}`,
    body: `
<div class="centered">
  <div class="card">
    <div class="logo">${LOCK_ICON}</div>
    <h1>Change password</h1>
    <p class="sub">For ${escapeHtml(user.name)}'s inbox.</p>
    ${error ? `<div class="alert">${escapeHtml(error)}</div>` : ''}
    ${notice ? `<div class="notice-ok">${escapeHtml(notice)}</div>` : ''}
    <form class="stack" method="POST" action="/${id}/password">
      <label class="field">
        Current password
        <input type="password" name="current" autocomplete="current-password" autofocus required />
      </label>
      <label class="field">
        New password
        <input type="password" name="password" autocomplete="new-password" required />
      </label>
      <label class="field">
        Confirm new password
        <input type="password" name="confirm" autocomplete="new-password" required />
      </label>
      <button type="submit">Change password</button>
    </form>
    <p class="hint">
      Changing it signs out anyone using the old password.
      <br /><a href="/${id}">Back to inbox</a>
    </p>
  </div>
</div>`
  });
}

// The credential store is the gate; if it is unreachable the app refuses
// to serve inboxes rather than guessing that everything is fine.
function dbErrorPage({ configured }) {
  return page({
    title: 'Storage unavailable — WhatsApp Viewer',
    body: `
<div class="centered">
  <div class="card wide">
    <div class="logo">${LOCK_ICON}</div>
    <h1>${configured ? 'Cannot reach the database' : 'No database configured'}</h1>
    <p class="sub">
      ${
        configured
          ? 'Inbox passwords live in Postgres, and that connection is currently failing. The viewer stays locked until it is back.'
          : 'Inbox passwords live in Postgres. Without <code>DATABASE_URL</code> there is nothing to check passwords against, so the viewer has locked itself.'
      }
    </p>
    <p class="hint">
      Set <code>DATABASE_URL</code> to the Neon connection string on the
      service (Railway: <strong>Variables</strong> tab) and redeploy.
    </p>
  </div>
</div>`
  });
}

// entries: [{ user, claimed }]; capacity: { max, used, needsInvite, error }
function homePage(entries, capacity = { max: 0, used: 0, needsInvite: false, error: '' }) {
  const cards = entries
    .map(({ user, claimed }) => {
      const id = encodeURIComponent(user.id);
      const name = escapeHtml(user.name);
      const initial = escapeHtml((user.name || user.id).trim().charAt(0) || '?');
      return `
      <div class="user-card">
        <div class="avatar">${initial}</div>
        <a class="grow" href="/${id}" style="text-decoration:none;color:inherit;">
          <div class="name">${name}</div>
          <div class="state">
            <span class="dot ${claimed ? 'on' : 'warn'}"></span>
            ${claimed ? 'Private — password required' : 'Not set up yet'}
          </div>
        </a>
        <a class="qr-link" href="/${id}${claimed ? '' : '/setup'}">${
          claimed ? 'Sign in' : 'Set password'
        }</a>
      </div>`;
    })
    .join('');

  const slotsLeft = Math.max(0, capacity.max - capacity.used);
  const full = slotsLeft === 0;

  return page({
    title: 'WhatsApp Viewer',
    body: `
<div class="home">
  <header>
    <div class="logo">${CHAT_ICON}</div>
    <div>
      <h1>WhatsApp Viewer</h1>
      <p>Each inbox has its own password, set by its owner.</p>
    </div>
    <div class="spacer"></div>
    <span class="pill">${capacity.used} of ${capacity.max} used</span>
  </header>

  ${capacity.error ? `<div class="alert">${escapeHtml(capacity.error)}</div>` : ''}

  <div class="user-grid">${cards}</div>

  <div class="create-card">
    ${
      full
        ? `<h2>All ${capacity.max} inboxes are in use</h2>
           <p class="hint">
             There is room for ${capacity.max} at once, since each one runs its
             own copy of WhatsApp on the server.
           </p>`
        : `<h2>Add an inbox</h2>
           <p class="hint" style="margin-top:0;">
             ${slotsLeft} slot${slotsLeft === 1 ? '' : 's'} left. You will be
             taken straight to a QR code to link WhatsApp, then you choose
             your own password.
           </p>
           <form class="create-form" method="POST" action="/create">
             <input type="text" name="name" placeholder="Name, e.g. Priya"
                    maxlength="40" required aria-label="Name for the new inbox" />
             ${
               capacity.needsInvite
                 ? `<input type="text" name="invite" placeholder="Invite code"
                           autocomplete="off" required aria-label="Invite code" />`
                 : ''
             }
             <button type="submit">Create inbox</button>
           </form>`
    }
  </div>

  <p class="hint" style="margin-top:22px;">
    Signing in to one inbox gives you access to that inbox only.
  </p>
</div>`
  });
}

// claimCode is passed only when this server watched the QR get scanned in
// this process — never for a session restored from disk, where the QR page
// is reachable by anyone who has not claimed it yet.
// Asks WhatsApp for a new linking code. Codes are only generated while
// someone is actually waiting to scan one, so this is how they say so.
// Keeps the session and the stored chats — it is not the unlink button.
function newCodeForm(user, label) {
  const id = escapeHtml(user.id);
  return `
    <form method="post" action="/${id}/qr/refresh" class="newcode">
      <button type="submit">${escapeHtml(label)}</button>
    </form>`;
}

// The manual way out. Shown on every state of this page, because the whole
// point is that it works when the app's own idea of the link is wrong.
function unlinkForm(user) {
  const id = escapeHtml(user.id);
  return `
    <div class="unlink">
      <form method="post" action="/${id}/unlink"
            onsubmit="return confirm('Unlink ${escapeHtml(user.name)}?\n\nThe saved WhatsApp session and the stored chats are cleared, and a new QR code is generated to scan.');">
        <button type="submit">Unlink and start over</button>
      </form>
      <p class="hint">
        Press this when WhatsApp has dropped the link but this page has not
        noticed — for example if the device is gone from
        <strong>WhatsApp &rarr; Linked Devices</strong> but the inbox still
        claims to be connected. It clears the saved session and the stored
        chats, then shows a fresh QR code. The inbox password is unchanged.
      </p>
    </div>`;
}

function qrPage({ user, state, claimCode = null, needsSetup = false }) {
  const name = escapeHtml(user.name);
  const id = encodeURIComponent(user.id);

  if (claimCode) {
    return page({
      title: `Linked — set up ${user.name}`,
      body: `
<div class="centered">
  <div class="card">
    <div class="logo">${CHAT_ICON}</div>
    <h1>WhatsApp linked</h1>
    <p class="sub">
      Here is the one-time setup code for ${name}'s inbox. It is shown only
      now, only on this screen — use it to choose your password.
    </p>
    <div class="code-box">${escapeHtml(claimCode)}</div>
    <a href="/${id}/setup?code=${encodeURIComponent(claimCode)}">
      <button type="button">Choose my password</button>
    </a>
    <p class="hint">Write it down if you want to finish setup on another device.</p>
  </div>
</div>`
    });
  }

  if (state.isReady) {
    return page({
      title: `${user.name} connected — WhatsApp Viewer`,
      body: `
<div class="centered">
  <div class="card">
    <div class="logo">${CHAT_ICON}</div>
    <h1>${name} is connected</h1>
    <p class="sub">No QR code needed — the session is already linked.</p>
    ${
      needsSetup
        ? `<p class="hint">This inbox still has no password. The setup code is in the
             server logs, or re-link from WhatsApp to be shown a new one.</p>
           <a href="/${id}/setup"><button type="button">I have a setup code</button></a>`
        : `<a href="/${id}"><button type="button">Open inbox</button></a>`
    }
    ${unlinkForm(user)}
  </div>
</div>`
    });
  }

  if (!state.latestQr) {
    // A startup failure used to look exactly like "still starting" — the
    // same spinner, forever. Say which one it is.
    const dormant = !!state.dormant;
    const failed = !dormant && !!state.startupError;
    const linking = !dormant && !failed && !!state.authenticating;
    const relinking = !dormant && !failed && !linking && !!state.needsRelink;
    // Still trying, but for long enough that a bare spinner would be a lie
    // about how well it is going.
    const struggling = !dormant && !failed && !linking && !relinking && !!state.retryNotice;
    const heading = dormant
      ? 'This inbox is not running'
      : state.pausedForScan
        ? 'Waiting until someone is ready'
        : failed
        ? 'WhatsApp did not start'
        : linking
          ? 'Scan accepted — finishing sign-in'
          : relinking
            ? 'WhatsApp signed this device out'
            : struggling
              ? state.diskFull
                ? 'The server is out of disk space'
                : 'Reconnecting to WhatsApp'
              : 'Generating QR code…';
    return page({
      title: state.pausedForScan
        ? `Ready when you are — ${user.name}`
        : failed
        ? `Startup trouble — ${user.name}`
        : relinking
          ? `Re-link ${user.name} — WhatsApp Viewer`
          : struggling
            ? `Reconnecting — ${user.name}`
            : `Waiting for QR — ${user.name}`,
      body: `
<div class="centered">
  <div class="card">
    ${failed || dormant ? `<div class="logo">${LOCK_ICON}</div>` : '<div class="spinner"></div>'}
    <h1>${heading}</h1>
    <p class="sub">${escapeHtml(state.statusText)}</p>
    ${
      dormant
        ? `<p class="hint">
             The server is configured to run fewer inboxes at once than it has
             (<code>MAX_ACTIVE_INBOXES</code>). Raise that limit to bring this
             inbox up.
           </p>`
        : failed
        ? `<div class="alert">${escapeHtml(state.startupError)}</div>
           <p class="hint">
             Nothing is lost by waiting — the saved session and the stored
             chats are still here. Ask for a new code when someone is
             actually holding the phone, and one is generated then.
           </p>`
        : linking
          ? `<p class="hint">
               WhatsApp accepted the scan. This inbox is syncing now, which
               takes a few seconds — the page moves on by itself.
             </p>
             <span class="pill">Finishing…</span>`
        : relinking
          ? `<p class="hint">
               This happens when the device is removed under WhatsApp &rarr;
               Linked Devices, or when WhatsApp expires a link that has been
               offline too long. A fresh code is being generated now — scan it
               and everything comes back. <strong>The inbox password is
               unchanged</strong>, so there is no setup code to enter again.
             </p>
             <span class="pill">This page refreshes automatically</span>`
          : `${
              struggling
                ? `<div class="alert">${escapeHtml(state.retryNotice)}</div>
                   ${
                     state.diskFull
                       ? `<p class="hint">
                            This is a problem with the server, not with
                            WhatsApp. The disk holding the WhatsApp sessions
                            is full, so this inbox cannot save the session it
                            needs to stay linked. Someone has to free space or
                            make the volume bigger; the inbox retries on its
                            own and comes straight back once there is room.
                          </p>`
                       : state.retryKind === 'start'
                         ? `<p class="hint">
                              This inbox could not start. It keeps retrying by
                              itself and comes back as soon as whatever is in
                              the way clears.
                            </p>`
                         : `<p class="hint">
                              The connection to WhatsApp keeps dropping —
                              usually a network blip at one end or the other.
                              This inbox keeps retrying by itself and picks up
                              where it left off as soon as WhatsApp is
                              reachable again, so there is nothing to restart.
                            </p>`
                   }`
                : ''
            }<span class="pill">This page refreshes automatically</span>`
    }
    ${dormant ? '' : newCodeForm(user, 'Show a new QR code')}
    ${dormant ? '' : unlinkForm(user)}
  </div>
</div>
${dormant ? '' : `<script>setTimeout(function () { location.reload(); }, ${failed ? 15000 : linking ? 2500 : 4000});</script>`}`
    });
  }

  return page({
    title: `Link ${user.name} — WhatsApp Viewer`,
    body: `
<div class="centered">
  <div class="card">
    <h1>${state.needsRelink ? `Re-link ${name}'s WhatsApp` : `Link ${name}'s WhatsApp`}</h1>
    <p class="sub">${escapeHtml(state.statusText)}</p>
    <div class="qr-frame"><img src="${state.latestQr}" alt="WhatsApp linking QR code" /></div>
    <ol class="steps">
      <li>Open WhatsApp on the phone.</li>
      <li>Go to <strong>Settings → Linked Devices</strong>.</li>
      <li>Tap <strong>Link a Device</strong> and scan this code.</li>
    </ol>
    <p class="hint">
      ${
        needsSetup
          ? 'After scanning you will be shown a one-time setup code for choosing this inbox&rsquo;s password.'
          : 'Codes expire after a while. If this one stops working, ask for a new one.'
      }
    </p>
    ${newCodeForm(user, 'Show a new QR code')}
    ${unlinkForm(user)}
  </div>
</div>
<script>setTimeout(function () { location.reload(); }, 6000);</script>`
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
        &middot;
        <a class="back" href="/${encodeURIComponent(user.id)}/password">Password</a>
        &middot;
        <a class="back" href="/${encodeURIComponent(user.id)}/qr">Link</a>
      </div>
      <form method="POST" action="/${encodeURIComponent(user.id)}/logout">
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
    // A phone number has no useful initial, so mark it as a person instead
    // of showing the leading digit.
    if (/^[+0-9][0-9 ()-]*$/.test(t)) return '#';
    return t.charAt(0) || '?';
  }

  // Initials first, then the photo on top of them once it loads. An image
  // that 404s (an expired signed URL) removes itself and the initials show.
  function paintAvatar(el, chat) {
    el.textContent = initialsOf(chat.name);
    if (!chat.hasAvatar) return;

    // The picture goes into the DOM straight away, on top of the initials
    // but transparent until it has loaded. The previous version held the
    // image out of the document until its onload fired while also marking
    // it loading="lazy" — and a lazy image that is not in the document is
    // never near the viewport, so it never loaded, so onload never fired
    // and it was never inserted. No request was ever made.
    var img = document.createElement('img');
    img.alt = '';
    img.onerror = function () { img.remove(); };
    img.onload = function () { img.classList.add('ready'); };
    el.appendChild(img);
    img.src = '/api/' + encodeURIComponent(userId) + '/chats/' +
      encodeURIComponent(chat.id) + '/avatar';
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
    if (res.status === 401) {
      location.href = '/' + encodeURIComponent(userId) + '/login?next=' +
        encodeURIComponent(location.pathname);
      return false;
    }
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
      paintAvatar(avatar, chat);
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
        ? (chat.lastMessage.body ||
           MEDIA_LABEL[chat.lastMessage.mediaKind] ||
           (chat.lastMessage.hasMedia ? 'Attachment' : 'No text'))
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
    paintAvatar(document.getElementById('chatAvatar'), chat);
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

  function mediaUrl(messageId) {
    return messageBase(messageId) + '/media';
  }

  // The embedded preview, which costs a database read rather than a
  // download from WhatsApp.
  function thumbUrlFor(messageId) {
    return messageBase(messageId) + '/thumb';
  }

  function messageBase(messageId) {
    return '/api/' + encodeURIComponent(userId) + '/messages/' +
      encodeURIComponent(messageId);
  }

  var MEDIA_LABEL = {
    image: 'Photo', sticker: 'Sticker', video: 'Video',
    audio: 'Audio', voice: 'Voice message', document: 'Document', file: 'Attachment'
  };

  // Media is fetched per message rather than inlined into the chat payload,
  // so a chat full of photos still opens immediately and the images stream
  // in behind it.
  // Nothing downloads until it is nearly on screen. A chat of a hundred
  // messages otherwise asks WhatsApp for every picture in it at once, and
  // the one being looked at queues behind the rest.
  var nearViewport =
    'IntersectionObserver' in window
      ? new IntersectionObserver(
          function (entries) {
            entries.forEach(function (e) {
              if (!e.isIntersecting) return;
              nearViewport.unobserve(e.target);
              if (e.target._load) e.target._load();
            });
          },
          { rootMargin: '600px 0px' }
        )
      : null;

  function whenNear(el, load) {
    if (!nearViewport) return load();
    el._load = load;
    nearViewport.observe(el);
  }

  function buildMedia(m) {
    var wrap = document.createElement('div');
    wrap.className = 'media-wrap';
    var url = mediaUrl(m.id);
    var thumbUrl = thumbUrlFor(m.id);

    function failed(note) {
      var f = document.createElement('div');
      f.className = 'media-fallback';
      f.textContent = note;
      wrap.innerHTML = '';
      wrap.appendChild(f);
    }

    if (m.mediaKind === 'image' || m.mediaKind === 'sticker') {
      var link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
      var img = document.createElement('img');
      img.className = 'media-img' + (m.mediaKind === 'sticker' ? ' sticker' : '');
      img.alt = MEDIA_LABEL[m.mediaKind];
      link.appendChild(img);
      wrap.appendChild(link);

      whenNear(wrap, function () {
        var haveThumb = false;
        // The preview comes straight out of the database, so it lands almost
        // at once; the real file replaces it whenever it arrives.
        var thumb = new Image();
        thumb.onload = function () {
          if (img.dataset.full) return;
          haveThumb = true;
          img.src = thumbUrl;
          img.classList.add('preview');
        };
        thumb.src = thumbUrl;

        var full = new Image();
        full.onload = function () {
          img.dataset.full = '1';
          img.src = url;
          img.classList.remove('preview');
        };
        full.onerror = function () {
          if (!haveThumb) failed(MEDIA_LABEL[m.mediaKind] + ' unavailable');
        };
        full.src = url;
      });
      return wrap;
    }

    if (m.mediaKind === 'video') {
      var video = document.createElement('video');
      video.className = 'media-img';
      video.controls = true;
      video.preload = 'metadata';
      // A still frame to look at while the video itself is fetched.
      video.poster = thumbUrl;
      video.addEventListener('error', function () { failed('Video unavailable'); });
      wrap.appendChild(video);
      whenNear(wrap, function () { video.src = url; });
      return wrap;
    }

    if (m.mediaKind === 'audio' || m.mediaKind === 'voice') {
      var audio = document.createElement('audio');
      audio.className = 'media-audio';
      audio.controls = true;
      audio.preload = 'none';
      audio.addEventListener('error', function () { failed('Audio unavailable'); });
      wrap.appendChild(audio);
      whenNear(wrap, function () { audio.src = url; });
      return wrap;
    }

    // Documents and anything unrecognised are offered as a download rather
    // than rendered, since the server refuses to serve them inline.
    var dl = document.createElement('a');
    dl.className = 'media-file';
    dl.href = url;
    dl.setAttribute('download', '');
    dl.textContent = '\u2193 ' + (MEDIA_LABEL[m.mediaKind] || 'Attachment');
    wrap.appendChild(dl);
    return wrap;
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

      if (m.hasMedia) {
        bubble.appendChild(buildMedia(m));
      }

      // A media message's body is its caption, and captions are often
      // empty — only add a text row when there is something to show.
      if (m.body || !m.hasMedia) {
        var text = document.createElement('div');
        text.className = 'text' + (m.body ? '' : ' media');
        // textContent, never innerHTML: message bodies are untrusted input.
        text.textContent = m.body || '[no text]';
        bubble.appendChild(text);
      }

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
  inboxLoginPage,
  inboxSetupPage,
  inboxAwaitingCodePage,
  changePasswordPage,
  dbErrorPage,
  homePage,
  qrPage,
  viewerPage
};
