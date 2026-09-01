# WhatsApp Viewer (multi-user)

Minimal WhatsApp message viewer built on `whatsapp-web.js`. Runs one headless
Chromium session per hardcoded person, each logged into their own WhatsApp
account, and serves a simple web UI per person to browse their chats.

**Important:** this uses an unofficial library that automates WhatsApp Web.
It's not sanctioned by Meta and could, in principle, get an account flagged
if it behaves too much like a bot. Use it for a personal viewer, not for
anything high-volume or automated.

**Also important — currently pinned to an unmerged fix.** `package.json`
points `whatsapp-web.js` at a GitHub branch
(`carlosalaniz/whatsapp-web.js#fix/lid-getchats-crash`) instead of the
official npm release, because of a live upstream bug
([wwebjs#201845](https://github.com/wwebjs/whatsapp-web.js/issues/201845))
where `getChats()` throws a minified `r: r` error after a recent WhatsApp
Web update. Once that fix is merged and released to npm, switch back to a
normal version range for long-term stability.

## Passwords — one per inbox, set by its owner

Each person's inbox has its own password, and **they set it themselves**.
Signing in to one inbox gives access to that inbox only.

Nobody hands out the first password. Instead the server issues a one-time
**setup code** at the moment a person links their WhatsApp — holding the
phone that scanned the QR is what proves the inbox is theirs:

1. They open `/<id>/qr` and scan the code with WhatsApp.
2. The moment it links, the page shows a one-time setup code.
3. They click through, enter that code, and choose their own password.
4. From then on `/<id>` asks only for that password, and the code is dead.

An inbox with no password yet is **not** readable — it serves the setup
page, never messages.

### If the session was already linked

A WhatsApp session restored from the volume never shows a code on screen:
that page is reachable by anyone until the inbox is claimed, so printing a
code there would defeat the point. The code goes to the **service logs**
instead (Railway: *Deployments → View logs*), as a line like:

```
[joshua] SETUP CODE: 7K2F-9QMX — give this to Joshua to set their password.
```

Read it from the logs and pass it to that person privately, or have them
re-link from the QR page and read the code straight off the screen. A new
code is issued on every restart while an inbox is unclaimed, so the newest
line in the logs is the valid one.

### Forgotten passwords

```bash
npm run reset-inbox -- joshua
```

That clears the stored password. Restart the service (or have them re-link)
and they get a fresh setup code to choose a new one.

### Where the passwords live

In Postgres — a [Neon](https://neon.tech) database, set through
`DATABASE_URL`:

```bash
DATABASE_URL='postgresql://user:pass@host/db?sslmode=require'
```

Passwords and setup codes are stored as salted scrypt hashes, never in
plaintext. The table is created automatically on first boot. Without a
reachable `DATABASE_URL` there is nothing to check passwords against, so
every inbox stays locked rather than falling open.

Signing in sets a signed, `HttpOnly` cookie for that one inbox, good for 7
days. The signature is derived from the stored password hash, so changing a
password immediately signs out anything using the old one. Failed attempts
are throttled per inbox and per IP: 8 wrong guesses in 15 minutes locks that
pair out for 15 minutes.

## Adding people

Use the **Add an inbox** form on the home page. Type a name, and you go
straight to a QR code — scan it with WhatsApp, and the setup code appears so
you can choose your own password. Nothing to edit, no redeploy.

**Four inboxes at once, maximum.** Each one runs its own headless Chromium
(roughly 150–300MB), so the cap is a memory ceiling as much as a policy. To
change it, edit `MAX_INBOXES` in `db.js`.

The name becomes a URL slug — "Dan Lee" becomes `dan-lee` — used for:
- QR page: `/<id>/qr`
- Viewer page: `/<id>`
- Session folder on disk: `<SESSION_PATH>/<id>/`

The two people who were hardcoded before (`joshua`, `Marshall`) are inserted
into the database on first boot with their original ids, so their existing
linked sessions keep working.

### Locking down who can add one

By default anyone who can reach the home page can create an inbox, up to the
cap. Set `INVITE_CODE` to require a shared secret in the form as well:

```bash
INVITE_CODE='something-only-your-friends-know'
```

Worth doing on a public URL — a stranger cannot read anyone's messages, but
they can burn a slot and start a Chromium instance on your server.

### Removing one

There is no delete button. Remove the rows by hand:

```sql
DELETE FROM inboxes WHERE id = 'dan-lee';
DELETE FROM inbox_credentials WHERE user_id = 'dan-lee';
```

Then restart, and delete `<SESSION_PATH>/dan-lee/` to unlink the session.

## Media

Photos, videos, voice notes and stickers render inline in the conversation;
documents appear as a download link. Media is fetched one message at a time
from `/api/<id>/messages/<message-id>/media`, so a chat full of photos still
opens immediately and the images stream in behind it. Recently viewed media
is cached in memory (40 items / 64MB) so scrolling back does not re-download
it.

Only images, video and audio are served inline. Anything else — a document,
an `.html` attachment — is sent as a download with
`Content-Type: application/octet-stream`, so a booby-trapped attachment
cannot run as a page on this origin.

WhatsApp drops media from its servers after a while, so older messages may
show "Photo unavailable" where the file is simply gone.

## Run locally

```bash
npm install
DATABASE_URL='postgresql://...' node index.js
```

Then open `http://localhost:3000` to see the configured inboxes. Visit
`http://localhost:3000/<id>/qr` for each person to scan their own QR code
(WhatsApp app → Settings → Linked Devices → Link a Device); the setup code
appears as soon as it links, and they use it to choose a password. After
that `http://localhost:3000/<id>` shows that person's chats once they sign
in.

Session data is stored under `./data/sessions/<id>/` locally (or wherever
`SESSION_PATH` points) so nobody has to rescan on restart.

## Deploy to Railway

1. Push this folder to a GitHub repo.
2. In Railway: **New Project → Deploy from GitHub repo**, pick this repo.
   Railway detects the `Dockerfile` and `railway.json` and builds with
   Docker automatically.
3. **Set `DATABASE_URL`**: create a database at
   [neon.tech](https://neon.tech), copy its connection string, and add it
   on the service → **Variables** tab. Until you do, every inbox stays
   locked. Keep the string in Railway's variables only — never commit it.
4. **Add a volume**: right-click empty space on the project canvas → New →
   Volume → attach it to this service → set the mount path to `/data`.
   This is what makes every person's session survive redeploys — without
   it, everyone has to rescan their QR code each time the service restarts.
5. Deploy. Once it's up, send each person their own
   `https://<your-app>.up.railway.app/<id>/qr` link so they can scan and
   set their password. For a session that was already linked, read their
   setup code out of the logs and send it to them privately.
6. After that, `https://<your-app>.up.railway.app/<id>` shows that
   person's chats to them alone, and the home page (`/`) lists everyone.

## Notes / limitations

- Each linked person runs their own headless Chromium instance
  simultaneously — this uses meaningfully more RAM per person (roughly
  150–300MB each). Keep an eye on Railway's memory graph as you add people;
  you may need to bump the service's plan/resources.
- Media is downloaded on demand through the server, so opening a chat full
  of large photos uses bandwidth and memory on the service, not just in the
  browser.
- `fetchMessages` pulls up to 100 recent messages per chat on open; older
  history depends on what WhatsApp Web itself has synced.
- Whoever runs the service can still read everything: they control the
  server, the session files, and the database. Per-inbox passwords keep
  people out of *each other's* messages, not out of the operator's reach.
- A setup code for an already-linked session passes through the service
  logs, so anyone who can read those logs can claim an unclaimed inbox.
  Claim them promptly and treat log access as privileged.
- Login attempts are throttled in memory only, so the counter resets when the
  service restarts and isn't shared across replicas.
- There is no password reset by email — recovery is `npm run reset-inbox`,
  which needs access to the deployment.
- If the WhatsApp Web protocol changes, `whatsapp-web.js` sometimes needs a
  library update to keep working — keep an eye on its GitHub releases/issues
  if things break again.
