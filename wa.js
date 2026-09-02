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
  downloadMediaMessage,
  jidNormalizedUser,
  isLidUser
} = require('baileys');

const db = require('./db');

// A dropped socket is the normal case, not the exceptional one: WhatsApp
// closes connections it considers idle, containers lose their network for a
// moment, and the protocol itself asks for a reconnect right after pairing.
// So there is no attempt limit — an inbox that stops trying can only be
// revived by a redeploy, which is exactly the dead end this is here to
// avoid. What is bounded is the rate: back off to one attempt a minute so a
// genuinely unreachable server is not hammered.
const RETRY_BASE_DELAY_MS = 2000;
const RETRY_MAX_DELAY_MS = 60000;

// The first couple of retries are ordinary and pass in silence. Past this
// many in a row, the page stops showing a bare spinner and says what keeps
// going wrong.
const RETRY_NOISY_AFTER = 3;

function backoffFor(attempts) {
  const steps = Math.min(Math.max(0, attempts - 1), 10);
  return Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** steps);
}

// ---- Shaping what the socket reports into what the viewer stores ----

function jidOf(value) {
  return typeof value === 'string' ? value : '';
}

function isGroupJid(jid) {
  return jidOf(jid).endsWith('@g.us');
}

// WhatsApp has been moving to LID addressing, where a person shows up as
// `165257557311725@lid` instead of their phone number. A LID is not a phone
// number and rendering it as one is how a chat ends up titled with a
// meaningless 15-digit string. The real jid rides along on the key as
// senderPn/participantPn, so prefer that and keep the LID only as a key to
// look names up by.
function realJid(jid, phoneJid) {
  const normalized = jidOf(jid) ? jidNormalizedUser(jidOf(jid)) : '';
  if (!isLidUser(normalized)) return normalized;
  const pn = jidOf(phoneJid);
  return pn ? jidNormalizedUser(pn) : normalized;
}

// The digits to show when nothing better is known. A LID has no digits
// worth showing, so it gets nothing and the caller falls back further.
function displayNumber(jid) {
  const value = jidOf(jid);
  if (!value || isLidUser(value)) return null;
  const user = value.split('@')[0];
  return /^[0-9]{5,}$/.test(user) ? user : null;
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
  const chatId = realJid(key.remoteJid, key.senderPn);
  if (!chatId || !key.id) return null;

  const { mediaKind, body } = describeMessage(waMessage);
  const rawSender = jidOf(key.participant) || jidOf(key.remoteJid);
  const senderJid = realJid(rawSender, key.participantPn || key.senderPn);

  return {
    id: key.id,
    chatId,
    fromMe: !!key.fromMe,
    // pushName is the name the sender set on their own phone, and is the
    // only name that arrives with a message. A number is a last resort and
    // never a name — see chatRowFromMessage.
    senderName:
      waMessage.pushName ||
      contactNames.get(senderJid) ||
      contactNames.get(rawSender) ||
      displayNumber(senderJid) ||
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
  // Only a real name may be written here. Storing the phone number was what
  // made chats show up titled `6596393236`: the column is COALESCEd on write,
  // so a number counts as a value and outranks the actual name whenever it
  // arrives later. The number is a fine thing to *display*, and listChats
  // derives it from the jid — it just must not be persisted as the name.
  const known = contactNames.get(row.chatId) || null;
  const fromPush = isGroupJid(row.chatId) || row.fromMe ? null : row.senderName;
  const name = known || (fromPush && fromPush !== displayNumber(row.chatId) ? fromPush : null);

  return {
    id: row.chatId,
    name,
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
    // Set once retrying stops being routine, so the page can say what keeps
    // failing. Distinct from `startupError`, which means this inbox has
    // stopped trying and needs a person.
    retryNotice: null,
    // Which kind of trouble the notice is about: a socket that keeps
    // dropping reads very differently from a process that cannot write to
    // its own volume, and saying "probably a network blip" under an ENOSPC
    // sends someone looking in the wrong place entirely.
    retryKind: null,
    diskFull: false,
    socket: null,
    contactNames: new Map(),
    dormant: false
  };

  const authDir = path.join(sessionRoot, user.id);
  const onClaimCode = options.onClaimCode || (() => {});

  // Names learned this run that are not yet on disk.
  const pendingContacts = new Map();

  function learnName(jid, name) {
    const key = jidOf(jid);
    if (!key || !name) return;
    // An address-book name beats a self-set pushName, and a pushName beats
    // nothing — but never let a bare number in, or it becomes sticky.
    if (name === displayNumber(key)) return;
    if (state.contactNames.get(key) === name) return;
    state.contactNames.set(key, name);
    pendingContacts.set(key, name);
  }

  async function flushContacts() {
    if (!pendingContacts.size) return;
    const rows = [...pendingContacts].map(([jid, name]) => ({ jid, name }));
    pendingContacts.clear();
    try {
      await db.upsertContacts(user.id, rows);
    } catch (err) {
      // Put them back so the next flush retries rather than losing a name.
      for (const r of rows) pendingContacts.set(r.jid, r.name);
      console.warn(`[${user.id}] Could not store ${rows.length} contact names:`, err.message);
    }
  }

  async function persistHistory({ chats = [], contacts = [], messages = [] }) {
    for (const contact of contacts) {
      const jid = realJid(contact.id, contact.phoneNumber);
      learnName(jid, contact.name || contact.verifiedName || contact.notify);
    }

    const chatRows = chats
      .map((c) => {
        const id = realJid(c.id, c.phoneNumber);
        if (!id) return null;
        // A group's subject arrives as the chat name; a person's does not.
        learnName(id, c.name);
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
      await flushContacts();
      if (chatRows.length || messageRows.length) {
        console.log(
          `[${user.id}] Stored ${chatRows.length} chats and ${messageRows.length} messages.`
        );
      }
      // A group is only ever named by asking, so ask once per group seen.
      const groups = chatRows.filter((r) => r.isGroup && !r.name).map((r) => r.id);
      if (groups.length) resolveGroupNames(groups);
    } catch (err) {
      console.error(`[${user.id}] Could not store history:`, err.message);
    }
  }

  // WhatsApp throttles hard on bulk metadata lookups, so everything below
  // goes one at a time with a gap, and only for chats the viewer will
  // actually show.
  const LOOKUP_GAP_MS = 400;
  const AVATAR_TTL_MS = 12 * 60 * 60 * 1000;
  const AVATAR_BATCH = 60;

  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let resolvingGroups = false;
  const groupQueue = new Set();

  function resolveGroupNames(ids) {
    for (const id of ids) groupQueue.add(id);
    if (resolvingGroups) return;
    resolvingGroups = true;

    (async () => {
      while (groupQueue.size) {
        const id = groupQueue.values().next().value;
        groupQueue.delete(id);
        const socket = state.socket;
        if (!socket) break;
        try {
          const meta = await socket.groupMetadata(id);
          if (meta && meta.subject) {
            learnName(id, meta.subject);
            await db.upsertChats(user.id, [
              { id, name: meta.subject, isGroup: true, unreadCount: null, lastTs: null,
                lastText: null, lastMedia: null }
            ]);
          }
        } catch (err) {
          // Left the group, or WhatsApp declined. Either way there is no
          // subject to be had; the number-free fallback stands.
          console.warn(`[${user.id}] No subject for group ${id}:`, err.message);
        }
        await pause(LOOKUP_GAP_MS);
      }
      await flushContacts();
      resolvingGroups = false;
    })().catch((err) => {
      resolvingGroups = false;
      console.warn(`[${user.id}] Group name lookup stopped:`, err.message);
    });
  }

  let refreshingAvatars = false;
  let avatarTimer = null;

  // Profile pictures are signed URLs that expire, so this re-asks on a long
  // cycle. A chat with no picture is recorded as checked too, so the ones
  // without are not asked about again every sync.
  async function refreshAvatars() {
    if (refreshingAvatars || !state.isReady) return;
    refreshingAvatars = true;
    let found = 0;
    try {
      const ids = await db.chatsNeedingAvatar(user.id, Date.now() - AVATAR_TTL_MS, AVATAR_BATCH);
      for (const id of ids) {
        const socket = state.socket;
        if (!socket || !state.isReady) break;
        let url = null;
        try {
          url = await socket.profilePictureUrl(id, 'preview');
        } catch {
          // No picture, or hidden by that person's privacy settings.
          url = null;
        }
        try {
          await db.setChatAvatar(user.id, id, url);
        } catch (err) {
          console.warn(`[${user.id}] Could not store an avatar:`, err.message);
        }
        if (url) found += 1;
        await pause(LOOKUP_GAP_MS);
      }
      if (ids.length) {
        console.log(`[${user.id}] Checked ${ids.length} profile pictures, found ${found}.`);
      }
    } catch (err) {
      console.warn(`[${user.id}] Profile picture refresh failed:`, err.message);
    } finally {
      refreshingAvatars = false;
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

    const onContacts = (contacts) => {
      for (const c of contacts || []) {
        learnName(realJid(c.id, c.phoneNumber), c.name || c.verifiedName || c.notify);
      }
      flushContacts().catch(() => {});
    };
    socket.ev.on('contacts.upsert', onContacts);
    // Renames arrive here rather than as a fresh contact.
    socket.ev.on('contacts.update', onContacts);

    // A group renamed while we were connected.
    socket.ev.on('groups.update', (updates) => {
      const stale = [];
      for (const g of updates || []) {
        const id = jidOf(g.id);
        if (!id) continue;
        if (g.subject) learnName(id, g.subject);
        else stale.push(id);
      }
      if (stale.length) resolveGroupNames(stale);
      flushContacts().catch(() => {});
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
      state.retryNotice = null;
      // A code only arrives over a working socket, so whatever backoff the
      // earlier failures earned is stale. Start counting again from zero.
      state.attempts = 0;
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
      state.retryNotice = null;
      state.retryKind = null;
      state.diskFull = false;
      state.isReady = true;
      state.statusText = 'Connected.';
      console.log(`[${user.id}] Connected. Syncing history in the background.`);
      onClaimCode(user, state);
      // Pictures are a nicety, so they wait until the socket has settled and
      // never block the inbox coming up. Tracked so a socket that drops in
      // the meantime takes the pending lookup down with it.
      clearTimeout(avatarTimer);
      avatarTimer = setTimeout(() => refreshAvatars(), 15000);
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
    state.latestQr = null;

    // WhatsApp closes the socket the moment a scan is accepted and expects
    // to be reconnected with the credentials it just wrote. That is the last
    // step of linking, not a failure: reconnect at once, and charge it
    // nothing in backoff.
    if (statusCode === DisconnectReason.restartRequired) {
      if (state.sawQrThisRun) state.authenticating = true;
      state.retryNotice = null;
      state.statusText = state.authenticating
        ? 'Scan accepted. Finishing sign-in...'
        : 'WhatsApp asked for a reconnect. Reconnecting...';
      console.log(`[${user.id}] ${reason}: reconnecting with the session just written.`);
      await teardown();
      state.attempts = 0;
      scheduleReconnect(0);
      return;
    }

    state.authenticating = false;

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

    // Everything left is a transient network condition: connectionLost and
    // timedOut (both 408), connectionClosed, connectionReplaced,
    // unavailableService. None of them mean the session is bad, so none of
    // them may end in giving up — the inbox has to come back on its own once
    // WhatsApp is reachable again, without anyone redeploying.
    await teardown();

    const delay = backoffFor(state.attempts);
    const seconds = Math.max(1, Math.round(delay / 1000));
    state.statusText = `Disconnected (${reason}). Reconnecting in ${seconds}s...`;

    if (state.attempts >= RETRY_NOISY_AFTER) {
      state.retryKind = 'drop';
      state.retryNotice = `Could not stay connected (${reason}) — ${state.attempts} attempts so far.`;
      console.warn(
        `[${user.id}] Disconnected (${reason}) on attempt ${state.attempts}. ` +
          `Still retrying, next in ${seconds}s.`
      );
    } else {
      console.warn(`[${user.id}] Disconnected (${reason}). Reconnecting in ${seconds}s.`);
    }
    scheduleReconnect(delay);
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
    clearTimeout(avatarTimer);
    avatarTimer = null;
    groupQueue.clear();
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

  // Names learned in earlier runs. Without this a restart begins with an
  // empty map and every chat falls back to its number until WhatsApp
  // happens to send the address book again — which, after the first sync,
  // it does not.
  async function loadStoredNames() {
    try {
      const rows = await db.listContacts(user.id);
      for (const r of rows) state.contactNames.set(r.jid, r.name);
      if (rows.length) console.log(`[${user.id}] Recalled ${rows.length} contact names.`);
    } catch (err) {
      console.warn(`[${user.id}] Could not read stored contact names:`, err.message);
    }
  }

  async function start() {
    try {
      if (!state.contactNames.size) await loadStoredNames();
      await connect();
      state.startupError = null;
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      console.error(`[${user.id}] Start attempt ${state.attempts} failed:`, message);
      await teardown();

      // The usual causes — no network yet, a full volume, WhatsApp refusing
      // the handshake — all clear on their own, so this keeps trying too.
      const delay = backoffFor(state.attempts);
      const seconds = Math.max(1, Math.round(delay / 1000));
      // ENOSPC is not a WhatsApp problem and never clears by itself. It
      // still retries — the moment space is freed the inbox comes back with
      // no redeploy — but it must say what is actually wrong.
      state.diskFull = err && err.code === 'ENOSPC';
      state.retryKind = 'start';
      state.retryNotice = state.diskFull
        ? `The server has run out of disk space, so this inbox cannot store its WhatsApp session (${message}).`
        : state.attempts >= RETRY_NOISY_AFTER
          ? `WhatsApp did not start: ${message}`
          : null;
      if (state.diskFull) {
        console.error(
          `[${user.id}] Out of disk space on the session volume. ` +
            'Free space or grow the volume; this inbox retries until then.'
        );
      }
      state.statusText = state.diskFull
        ? `Out of disk space. Retrying in ${seconds}s...`
        : `Did not start. Retrying in ${seconds}s...`;
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

module.exports = {
  createInboxConnection,
  fetchMedia,
  // Exposed for tests: these are pure, and the jid shapes they handle are
  // fiddly enough to be worth pinning down without a live socket.
  __test: { messageRow, chatRowFromMessage, describeMessage, displayNumber, realJid }
};
