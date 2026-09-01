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
node index.js
```

Then open `http://localhost:3000` to see the list of configured people, and
`http://localhost:3000/<id>/qr` for each person to scan their own QR code
(WhatsApp app → Settings → Linked Devices → Link a Device). Once connected,
`http://localhost:3000/<id>` shows that person's chats.

Session data is stored under `./data/sessions/<id>/` locally (or wherever
`SESSION_PATH` points) so nobody has to rescan on restart.

## Deploy to Railway

1. Push this folder to a GitHub repo.
2. In Railway: **New Project → Deploy from GitHub repo**, pick this repo.
   Railway detects the `Dockerfile` and `railway.json` and builds with
   Docker automatically.
3. **Add a volume**: right-click empty space on the project canvas → New →
   Volume → attach it to this service → set the mount path to `/data`.
   This is what makes every person's session survive redeploys — without
   it, everyone has to rescan their QR code each time the service restarts.
4. Deploy. Once it's up, visit `https://<your-app>.up.railway.app/<id>/qr`
   for each person and have them scan their own code.
5. After that, `https://<your-app>.up.railway.app/<id>` shows that
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
- There's no authentication on the viewer itself — anyone who knows a
  person's `/<id>` URL can read their messages. Fine for a private setup
  among people who trust each other; not safe to expose publicly as-is.
- If the WhatsApp Web protocol changes, `whatsapp-web.js` sometimes needs a
  library update to keep working — keep an eye on its GitHub releases/issues
  if things break again.
