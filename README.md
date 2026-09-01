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

## Password protection

The whole viewer sits behind a single shared password, set with the
`APP_PASSWORD` environment variable:

```bash
APP_PASSWORD='something-long-and-random' node index.js
```

There is no default and no way to opt out. If `APP_PASSWORD` is unset the
app starts but locks every page and shows a setup notice instead — it fails
closed rather than quietly serving everyone's messages to the open internet.

Once signed in, a signed, `HttpOnly` cookie keeps you logged in for 7 days.
The cookie is signed with a key derived from the password, so **changing
`APP_PASSWORD` immediately signs everyone out**. Set `SESSION_SECRET`
explicitly if you'd rather control that key yourself.

Failed logins are throttled per IP: 8 wrong guesses within 15 minutes locks
that address out for 15 minutes.

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
APP_PASSWORD='pick-a-password' node index.js
```

Then open `http://localhost:3000` and sign in with that password to see the
list of configured people, and visit `http://localhost:3000/<id>/qr` for
each person to scan their own QR code
(WhatsApp app → Settings → Linked Devices → Link a Device). Once connected,
`http://localhost:3000/<id>` shows that person's chats.

Session data is stored under `./data/sessions/<id>/` locally (or wherever
`SESSION_PATH` points) so nobody has to rescan on restart.

## Deploy to Railway

1. Push this folder to a GitHub repo.
2. In Railway: **New Project → Deploy from GitHub repo**, pick this repo.
   Railway detects the `Dockerfile` and `railway.json` and builds with
   Docker automatically.
3. **Set `APP_PASSWORD`**: open the service → **Variables** tab → add
   `APP_PASSWORD` with a long random value. Until you do, the deployed app
   locks itself and shows a setup notice. Share that one password with
   whoever should be able to read these inboxes.
4. **Add a volume**: right-click empty space on the project canvas → New →
   Volume → attach it to this service → set the mount path to `/data`.
   This is what makes every person's session survive redeploys — without
   it, everyone has to rescan their QR code each time the service restarts.
5. Deploy. Once it's up, visit `https://<your-app>.up.railway.app/<id>/qr`
   for each person and have them scan their own code.
6. After that, `https://<your-app>.up.railway.app/<id>` shows that
   person's chats, and the home page (`/`) lists everyone.

## Notes / limitations

- Each linked person runs their own headless Chromium instance
  simultaneously — this uses meaningfully more RAM per person (roughly
  150–300MB each). Keep an eye on Railway's memory graph as you add people;
  you may need to bump the service's plan/resources.
- Only text message bodies are shown — media (images, voice notes, etc.)
  isn't downloaded or rendered in this minimal version.
- `fetchMessages` pulls up to 100 recent messages per chat on open; older
  history depends on what WhatsApp Web itself has synced.
- The password is *shared*, not per-person: anyone who can sign in can read
  every configured person's inbox, not just their own. Everyone behind that
  one password should already trust each other with these messages.
- Login attempts are throttled in memory only, so the counter resets when the
  service restarts and isn't shared across replicas.
- If the WhatsApp Web protocol changes, `whatsapp-web.js` sometimes needs a
  library update to keep working — keep an eye on its GitHub releases/issues
  if things break again.
