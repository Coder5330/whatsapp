# WhatsApp Viewer (multi-user)

Minimal WhatsApp message viewer. Each person links their own WhatsApp
account, sets their own password, and browses their own chats.

It runs on [Baileys](https://github.com/WhiskeySockets/Baileys), which
speaks WhatsApp's protocol over a WebSocket. There is no browser: the
previous version drove a headless Chromium against web.whatsapp.com, which
cost roughly 250MB per person and stopped being able to link at all once
WhatsApp's web client moved on from what the library expected.

Baileys keeps nothing of its own — no chat list, no history — so everything
the socket reports is written to Postgres and the viewer reads from there.
That means history survives a restart instead of being re-synced on every
boot, and the chat list loads whether or not the connection happens to be
up at that moment.

**Important:** this uses an unofficial library. It is not sanctioned by
Meta and could, in principle, get an account flagged if it behaves too much
like a bot. Use it for a personal viewer, not for anything high-volume or
automated.

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

### Clearing a dead WhatsApp session

If an inbox's stored session can no longer work — the device was unpaired
from the phone, or the session is stuck — set `RESET_SESSIONS` to the inbox
ids to clear (or `all`), deploy once, then remove the variable:

```bash
RESET_SESSIONS=joshua,marshall
```

Those inboxes start from a fresh QR code. The old session is moved aside as
`<id>.loggedout-<timestamp>` rather than deleted, and inbox passwords are
untouched — this only clears the WhatsApp link, not the account.

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

**Four inboxes at once, maximum.** This is now a policy rather than a
memory ceiling — each connection is a WebSocket costing tens of MB, not a
browser costing hundreds. To change it, edit `MAX_INBOXES` in `db.js`.

The name becomes a URL slug — "Dan Lee" becomes `dan-lee` — used for:
- QR page: `/<id>/qr`
- Viewer page: `/<id>`
- Session folder on disk: `<SESSION_PATH>/<id>/`

The people who were hardcoded before are inserted into the database on first
boot, so their existing linked sessions keep working.

Ids are always lowercase. An earlier version seeded them straight from the
hardcoded list, which used capitals (`Marshall`), and because Postgres text
keys are case-sensitive that could leave both `Marshall` and `marshall` in
the table — two inboxes, two connections, one of them pointing at an empty
session. On boot the app now folds any mixed-case row down onto its
lowercase id, keeping whichever of the two had a password actually set, and
moves the session directory to match. If both directories hold a real
session it refuses to overwrite either and says so in the logs; check for
`Not moving ...` there, since the leftover directory can then be deleted by
hand once you know which one is live.

### Locking down who can add one

By default anyone who can reach the home page can create an inbox, up to the
cap. Set `INVITE_CODE` to require a shared secret in the form as well:

```bash
INVITE_CODE='something-only-your-friends-know'
```

Worth doing on a public URL — a stranger cannot read anyone's messages, but
they can burn a slot and open a WhatsApp connection from your server.

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

- Each connection is a WebSocket rather than a browser, so an inbox costs
  tens of MB rather than hundreds. `MAX_ACTIVE_INBOXES` still exists but
  should not normally be needed; `0` pauses linking entirely.
- History is whatever WhatsApp sends on link. A newly linked account syncs
  in the background and can take a few minutes to fill in, so the chat list
  may be empty or partial at first.
- Media is not stored — only the message describing it. The bytes are
  fetched from WhatsApp on demand and cached in memory (40 items / 64MB).
  WhatsApp expires media after a while, so older messages can show
  "unavailable" where the file is simply gone.
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
- The protocol version is fetched from WhatsApp at connect time rather than
  hardcoded, so it does not go stale the way a pinned page build did.
- If WhatsApp changes its protocol, Baileys sometimes needs a library update
  to keep working — keep an eye on its GitHub releases/issues if things
  break again.
