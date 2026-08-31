# WhatsApp Viewer

Minimal WhatsApp message viewer built on `whatsapp-web.js`. Runs a headless
Chromium session logged into your WhatsApp account, and serves a simple web
UI to browse chats and messages.

**Important:** this uses an unofficial library that automates WhatsApp Web.
It's not sanctioned by Meta and could, in principle, get your account
flagged if it behaves too much like a bot. Use it for a personal viewer, not
for anything high-volume or automated.

## Run locally

```bash
npm install
node index.js
```

Then open `http://localhost:3000/qr`, scan the QR code with WhatsApp on your
phone (Settings → Linked Devices → Link a Device), and once connected go to
`http://localhost:3000` to browse chats.

Session data is stored under `./data/session` locally (or wherever
`SESSION_PATH` points) so you don't have to rescan every restart.

## Deploy to Railway

1. Push this folder to a GitHub repo.
2. In Railway: **New Project → Deploy from GitHub repo**, pick this repo.
   Railway will detect the `Dockerfile` and `railway.json` and build with
   Docker automatically.
3. **Add a volume**: in the service settings, add a volume and mount it at
   `/data`. This is what makes the WhatsApp session survive redeploys —
   without it you'll have to rescan the QR code every time the service
   restarts.
4. Deploy. Watch the logs, or visit `https://<your-app>.up.railway.app/qr`
   once the service is up, and scan the QR code.
5. After that, visit the root URL to see the chat viewer.

## Notes / limitations

- Only text message bodies are shown — media (images, voice notes, etc.)
  isn't downloaded or rendered in this minimal version.
- `fetchMessages` pulls up to 100 recent messages per chat on open; older
  history depends on what WhatsApp Web itself has synced.
- There's no authentication on the viewer itself — anyone who can reach the
  URL can read your messages. If you deploy this publicly, put it behind
  Railway's private networking, a basic-auth proxy, or restrict access some
  other way before relying on it.
- If the WhatsApp Web protocol changes, `whatsapp-web.js` sometimes needs a
  version bump to keep working — keep an eye on its GitHub releases if
  things break.
