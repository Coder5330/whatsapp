FROM node:20-slim

# Baileys talks to WhatsApp over a WebSocket, so there is no browser to
# install. The previous image pulled in Chromium and about thirty X11 and
# font libraries to run it — that is all gone, along with ~250MB of memory
# per inbox and the build time that came with it.
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# One folder per inbox holds that person's WhatsApp credentials — mount a
# Railway volume at /data so nobody has to rescan their QR code on redeploy.
ENV SESSION_PATH=/data/sessions

EXPOSE 3000

CMD ["node", "index.js"]
