// The WhatsApp connection, on Baileys.
//
// This replaces whatsapp-web.js, which drove a headless Chromium against
// web.whatsapp.com. That cost ~250MB per inbox and broke whenever WhatsApp
// changed its web client — in the end it would pair on the phone and never
// finish signing in here. Baileys speaks WhatsApp's protocol over a
// WebSocket instead: no browser, a few tens of MB per inbox, and no
// dependency on a page's internals.
//
// The tradeoff is that Baileys keeps nothing. There is no chat list and no
// history unless we store what arrives, so everything the socket reports is
// written to Postgres and the viewer reads from there.

const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} = require('baileys');

const db = require('./db');

const MAX_START_ATTEMPTS = 5;
const START_BASE_DELAY_MS = 5000;

// ---- Shaping what the socket reports into what the viewer stores ----

function jidOf(value) {
  return typeof value === 'string' ? value : '';
}

function isGroupJid(jid) {
  return jidOf(jid).endsWith('@g.us');
}

// A WhatsApp message is a union of a few dozen shapes. Reduce it to the
// handful the viewer knows how to draw, and to the text worth showing.
function describeMessage(waMessage) {
  const inner = waMessage.message || {};
  const unwrapped =
    inner.ephemeralMessage?.message ||
    inner.viewOnceMessage?.message ||
    inner.viewOnceMessageV2?.message ||
    inner.documentWithCaptionMessage?.message ||
    inner;

  const kinds = [
    ['imageMessage', 'image'],
    ['stickerMessage', 'sticker'],
    ['videoMessage', 'video'],
    ['audioMessage', 'audio'],
    ['documentMessage', 'document']
  ];

  for (const [field, kind] of kinds) {
    const node = unwrapped[field];
    if (!node) continue;
    // A voice note is an audio message flagged as push-to-talk.
    const resolved = kind === 'audio' && node.ptt ? 'voice' : kind;
    return { mediaKind: resolved, body: node.caption || '' };
  }

  const text =
    unwrapped.conversation ||
    unwrapped.extendedTextMessage?.text ||
    unwrapped.buttonsResponseMessage?.selectedDisplayText ||
    unwrapped.listResponseMessage?.title ||
    '';

  return { mediaKind: null, body: text };
}

function messageRow(waMessage, contactNames) {
  const key = waMessage.key || {};
  const chatId = jidOf(key.remoteJid);
  if (!chatId || !key.id) return null;

  const { mediaKind, body } = describeMessage(waMessage);
  const participant = jidOf(key.participant);
  const senderJid = participant || chatId;

  return {
    id: key.id,
    chatId,
    fromMe: !!key.fromMe,
    senderName:
      waMessage.pushName ||
      contactNames.get(senderJid) ||
      senderJid.split('@')[0] ||
      null,
    body,
    ts: Number(waMessage.messageTimestamp) || 0,
    mediaKind,
    // Kept so the media can be fetched later: downloading needs the
    // protocol message, and re-requesting it from WhatsApp is not possible
    // once the socket has moved on.
    raw: mediaKind ? waMessage : null
  };
}

function chatRowFromMessage(row, contactNames) {
  return {
    id: row.chatId,
    name: isGroupJid(row.chatId)
      ? contactNames.get(row.chatId) || null
      : contactNames.get(row.chatId) || (row.fromMe ? null : row.senderName),
    isGroup: isGroupJid(row.chatId),
    // A message says nothing about unread counts; leave that to the chat list.
    unreadCount: null,
    lastTs: row.ts,
    lastText: row.body,
    lastMedia: row.mediaKind
  };
}

// ---- One connection per inbox ----

function createInboxConnection(user, sessionRoot, options = {}) {
  const state = {
    latestQr: null,
    isReady: false,
    statusText: 'Starting up...',
    sawQrThisRun: false,
    claimCodePlain: null,
    codeVisibleUntil: 0,
    startupError: null,
    attempts: 0,
    needsRelink: false,
    restarting: false,
    authenticating: false,
    everAuthenticated: false,
    pairingFailures: 0,
    qrCount: 0,
    socket: null,
    contactNames: new Map(),
    dormant: false
  };

  const authDir = path.join(sessionRoot, user.id);
  const onClaimCode = options.onClaimCode || (() => {});

  async function persistHistory({ chats = [], contacts = [], messages = [] }) {
    for (const contact of contacts) {
      const jid = jidOf(contact.id);
      const name = contact.name || contact.notify || contact.verifiedName;
      if (jid && name) state.contactNames.set(jid, name);
    }

    const chatRows = chats
      .map((c) => {
        const id = jidOf(c.id);
        if (!id) return null;
        if (c.name) state.contactNames.set(id, c.name);
        return {
          id,
          name: c.name || state.contactNames.get(id) || null,
          isGroup: isGroupJid(id),
          unreadCount: Number(c.unreadCount) || 0,
          lastTs: Number(c.conversationTimestamp) || null,
          lastText: null,
          lastMedia: null
        };
      })
      .filter(Boolean);

    const messageRows = messages
      .map((m) => messageRow(m, state.contactNames))
      .filter(Boolean);

    try {
      if (chatRows.length) await db.upsertChats(user.id, chatRows);
      if (messageRows.length) {
        await db.upsertMessages(user.id, messageRows);
        // Chats can arrive without a preview, so derive one from the
        // newest message we saw for each.
        const newest = new Map();
        for (const row of messageRows) {
          const seen = newest.get(row.chatId);
          if (!seen || row.ts > seen.ts) newest.set(row.chatId, row);
        }
        await db.upsertChats(
          user.id,
          [...newest.values()].map((row) => chatRowFromMessage(row, state.contactNames))
        );
      }
      if (chatRows.length || messageRows.length) {
        console.log(
          `[${user.id}] Stored ${chatRows.length} chats and ${messageRows.length} messages.`
        );
      }
    } catch (err) {
      console.error(`[${user.id}] Could not store history:`, err.message);
    }
  }

  async function connect() {
    state.attempts += 1;
    state.statusText =
      state.attempts === 1 ? 'Starting up...' : `Starting up... (attempt ${state.attempts})`;

    let version;
    try {
      // Ask WhatsApp which protocol version is current rather than shipping
      // a hardcoded one that goes stale — the failure mode this whole
      // rewrite exists to escape.
      ({ version } = await fetchLatestBaileysVersion());
    } catch (err) {
      console.warn(`[${user.id}] Could not fetch the current protocol version:`, err.message);
    }

    fs.mkdirSync(authDir, { recursive: true });
    const { state: authState, saveCreds } = await useMultiFileAuthState(authDir);

    const socket = makeWASocket({
      auth: authState,
      version,
      // The QR is rendered as an image on the inbox's page instead.
      printQRInTerminal: false,
      syncFullHistory: true,
      browser: ['WhatsApp Viewer', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false
    });
    state.socket = socket;

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('messaging-history.set', (payload) => {
      persistHistory(payload);
    });

    socket.ev.on('contacts.upsert', (contacts) => {
      for (const c of contacts) {
        const jid = jidOf(c.id);
        const name = c.name || c.notify;
        if (jid && name) state.contactNames.set(jid, name);
      }
    });

    socket.ev.on('chats.upsert', (chats) => persistHistory({ chats }));

    socket.ev.on('messages.upsert', ({ messages }) => {
      persistHistory({ messages: messages || [] });
    });

    socket.ev.on('connection.update', (update) => {
      handleConnectionUpdate(update).catch((err) =>
        console.error(`[${user.id}] connection update failed:`, err.message)
      );
    });

    return socket;
  }

  async function handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      state.sawQrThisRun = true;
      state.startupError = null;
      state.qrCount += 1;
      try {
        state.latestQr = await qrcode.toDataURL(qr);
      } catch (err) {
        console.error(`[${user.id}] Could not render QR code:`, err.message);
        return;
      }
      state.statusText = 'Scan the QR code below with WhatsApp on your phone.';
      console.log(
        `[${user.id}] QR code updated (#${state.qrCount}). Visit /${user.id}/qr to scan it.`
      );
      return;
    }

    if (connection === 'open') {
      state.latestQr = null;
      state.startupError = null;
      state.needsRelink = false;
      state.authenticating = false;
      state.everAuthenticated = true;
      state.pairingFailures = 0;
      state.attempts = 0;
      state.isReady = true;
      state.statusText = 'Connected.';
      console.log(`[${user.id}] Connected. Syncing history in the background.`);
      onClaimCode(user, state);
      return;
    }

    if (connection === 'connecting') {
      if (!state.latestQr) state.statusText = 'Connecting to WhatsApp...';
      return;
    }

    if (connection !== 'close') return;

    const statusCode =
      lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.status ?? null;
    const reason =
      Object.keys(DisconnectReason).find((k) => DisconnectReason[k] === statusCode) ||
      String(statusCode);

    state.isReady = false;
    state.authenticating = false;
    state.latestQr = null;

    // loggedOut means the credentials are dead and reconnecting with them
    // will fail identically. Everything else is worth retrying on the
    // session we have.
    const loggedOut = statusCode === DisconnectReason.loggedOut;

    if (loggedOut) {
      if (state.everAuthenticated || !state.sawQrThisRun) {
        console.warn(`[${user.id}] Logged out (${reason}). Clearing the stored session.`);
        await teardown();
        parkAuthDir();
        try {
          await db.clearInboxHistory(user.id);
        } catch (err) {
          console.warn(`[${user.id}] Could not clear stored history:`, err.message);
        }
        state.needsRelink = true;
        state.everAuthenticated = false;
        state.statusText = 'The saved WhatsApp link is no longer valid. Scan the new code.';
      } else {
        // Logged out after showing a code but before ever connecting: the
        // pairing did not complete. The credentials on disk are the ones
        // that attempt just wrote, so keep them.
        state.pairingFailures += 1;
        console.warn(
          `[${user.id}] Pairing did not complete (${state.pairingFailures}/3), keeping the session.`
        );
        await teardown();
        if (state.pairingFailures >= 3) {
          state.startupError = 'Pairing kept failing. Restart the service rather than rescanning.';
          state.statusText = state.startupError;
          console.error(`[${user.id}] Giving up after ${state.pairingFailures} failed pairings.`);
          return;
        }
      }
      state.attempts = 0;
      scheduleReconnect(0);
      return;
    }

    console.warn(`[${user.id}] Disconnected (${reason}). Reconnecting...`);
    state.statusText = `Disconnected (${reason}). Reconnecting...`;
    await teardown();

    if (state.attempts >= MAX_START_ATTEMPTS) {
      state.startupError = `Could not stay connected (${reason}).`;
      state.statusText = 'Not connecting. Restart the service to try again.';
      console.error(`[${user.id}] Giving up after ${state.attempts} attempts.`);
      return;
    }
    scheduleReconnect(Math.min(60000, START_BASE_DELAY_MS * 2 ** Math.max(0, state.attempts - 1)));
  }

  function scheduleReconnect(delay) {
    if (state.restarting) return;
    state.restarting = true;
    setTimeout(() => {
      state.restarting = false;
      start().catch((err) => console.error(`[${user.id}] Reconnect failed:`, err.message));
    }, delay);
  }

  async function teardown() {
    const socket = state.socket;
    state.socket = null;
    if (!socket) return;
    try {
      socket.ev.removeAllListeners();
      socket.end(undefined);
    } catch {
      /* already gone */
    }
  }

  // Revoked credentials are moved aside rather than deleted, keeping one
  // previous copy so the volume cannot fill with them.
  function parkAuthDir() {
    if (!fs.existsSync(authDir)) return;
    try {
      fs.renameSync(authDir, `${authDir}.loggedout-${Date.now()}`);
    } catch (err) {
      console.warn(`[${user.id}] Could not park the revoked session:`, err.message);
      return;
    }
    try {
      const parent = path.dirname(authDir);
      const stale = fs
        .readdirSync(parent)
        .filter((n) => n.startsWith(`${user.id}.loggedout-`))
        .sort();
      for (const name of stale.slice(0, -1)) {
        fs.rmSync(path.join(parent, name), { recursive: true, force: true });
      }
    } catch {
      /* pruning is best effort */
    }
  }

  async function start() {
    try {
      await connect();
      state.startupError = null;
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      console.error(`[${user.id}] Start attempt ${state.attempts} failed:`, message);
      state.startupError = message;
      await teardown();

      if (state.attempts >= MAX_START_ATTEMPTS) {
        state.statusText = 'WhatsApp did not start. Restart the service to try again.';
        console.error(`[${user.id}] Giving up after ${state.attempts} attempts.`);
        return;
      }
      const delay = Math.min(60000, START_BASE_DELAY_MS * 2 ** (state.attempts - 1));
      state.statusText = `Did not start. Retrying in ${Math.round(delay / 1000)}s...`;
      scheduleReconnect(delay);
    }
  }

  state.start = start;
  state.stop = teardown;
  return state;
}

// Media is not stored, only the message that describes it, so downloading
// asks WhatsApp for the bytes on demand.
async function fetchMedia(rawMessage) {
  const buffer = await downloadMediaMessage(rawMessage, 'buffer', {});
  const inner = rawMessage.message || {};
  const unwrapped =
    inner.ephemeralMessage?.message ||
    inner.viewOnceMessage?.message ||
    inner.viewOnceMessageV2?.message ||
    inner.documentWithCaptionMessage?.message ||
    inner;
  const node =
    unwrapped.imageMessage ||
    unwrapped.stickerMessage ||
    unwrapped.videoMessage ||
    unwrapped.audioMessage ||
    unwrapped.documentMessage ||
    {};

  return {
    buffer,
    mimetype: node.mimetype || 'application/octet-stream',
    filename: node.fileName || null
  };
}

module.exports = { createInboxConnection, fetchMedia };
