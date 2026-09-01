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

## Adding / removing people

Edit the `USERS` array near the top of `index.js`:

```js
const USERS = [
  { id: 'melissa', name: 'Melissa' },
  { id: 'friend2', name: 'Friend 2' },
];
```

`id` is used in URLs and as the session folder name — keep it lowercase,
no spaces. Each person gets their own:
- QR page: `/<id>/qr`
- Viewer page: `/<id>`
- Session folder on disk: `<SESSION_PATH>/<id>/`

Restart the service after editing the list.

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
- Only text message bodies are shown — media (images, voice notes, etc.)
  isn't downloaded or rendered in this minimal version.
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
