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

// WhatsApp rotates the linking code every twenty seconds or so, and limits
// how often an account may link a device. An inbox nobody is scanning will
// happily spend that allowance all day — thirty codes in a few minutes, for
// a page no one has open. Stop offering codes after this many and wait to
// be asked again.
const MAX_QR_PER_RUN = 10;

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
function realJid(jid, phoneJid, lidToPn) {
  const normalized = jidOf(jid) ? jidNormalizedUser(jidOf(jid)) : '';
  if (!isLidUser(normalized)) return normalized;

  const pn = jidOf(phoneJid);
  if (pn) return jidNormalizedUser(pn);

  // The key did not carry the number this time, but an earlier one may
  // have. Without this the same person is two chats: outgoing messages
  // filed under their number, replies under their LID.
  const known = lidToPn && lidToPn.get(normalized);
  return known || normalized;
}

// Every pair a message key reveals, so a LID seen alone later can still be
// resolved.
function lidPairsFrom(key) {
  const pairs = [];
  const add = (lid, pn) => {
    const l = jidOf(lid);
    const p = jidOf(pn);
    if (!l || !p || !isLidUser(l)) return;
    pairs.push({ lid: jidNormalizedUser(l), pn: jidNormalizedUser(p) });
  };
  add(key.remoteJid, key.senderPn);
  add(key.participant, key.participantPn);
  add(key.senderLid, key.senderPn);
  add(key.participantLid, key.participantPn);
  return pairs;
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

// What gets stored is the message, not the file — a 100MB video costs a row,
// not 100MB. But two fields in that row are large and never read back.
//
// `streamingSidecar` is per-chunk MAC data for seeking within a video while
// it streams; it grows with the length of the video and the download path
// never touches it. `contextInfo.quotedMessage` is a whole nested copy of
// the message being replied to, thumbnail and all, and the viewer does not
// render quotes.
//
// The thumbnails themselves stay — those are what make a picture appear
// instantly instead of after a download.
function slimForStorage(waMessage) {
  if (!waMessage || !waMessage.message) return waMessage;

  // Go through protobuf's own toJSON first. Spreading the message object
  // directly would drop that method, and every byte field would then
  // serialise as {"type":"Buffer","data":[...]} — several times larger than
  // the base64 it should be, and a shape the download path cannot read the
  // media key back out of.
  let plain;
  try {
    plain = JSON.parse(JSON.stringify(waMessage));
  } catch {
    return waMessage;
  }
  if (!plain || !plain.message) return waMessage;

  for (const node of Object.values(plain.message)) {
    if (!node || typeof node !== 'object') continue;
    delete node.streamingSidecar;
    if (node.contextInfo) delete node.contextInfo.quotedMessage;
  }
  return plain;
}

function messageRow(waMessage, contactNames, lidToPn) {
  const key = waMessage.key || {};
  const chatId = realJid(key.remoteJid, key.senderPn, lidToPn);
  if (!chatId || !key.id) return null;

  const { mediaKind, body } = describeMessage(waMessage);
  const rawSender = jidOf(key.participant) || jidOf(key.remoteJid);
  const senderJid = realJid(rawSender, key.participantPn || key.senderPn, lidToPn);

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
    raw: mediaKind ? slimForStorage(waMessage) : null
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
    // Stopped offering linking codes because nobody was scanning them —
    // waiting to be asked, not broken.
    pausedForScan: false,
    // Set once a person has asked for a code, so reconnects after that do
    // not fall straight back into waiting.
    linkRequested: false,
    socket: null,
    contactNames: new Map(),
    dormant: false
  };

  const authDir = path.join(sessionRoot, user.id);
  const onClaimCode = options.onClaimCode || (() => {});

  // Names learned this run that are not yet on disk.
  const pendingContacts = new Map();

  // lid -> phone jid, loaded at startup and added to as keys reveal pairs.
  const lidToPn = new Map();
  const pendingLidPairs = new Map();

  // A newly learned pair usually means there are already two chats for one
  // person — what was sent filed under the number, what came back under the
  // LID. Fold them together.
  async function learnLidPairs(keys) {
    const fresh = [];
    for (const key of keys) {
      for (const pair of lidPairsFrom(key || {})) {
        if (lidToPn.get(pair.lid) === pair.pn) continue;
        lidToPn.set(pair.lid, pair.pn);
        pendingLidPairs.set(pair.lid, pair.pn);
        fresh.push(pair);
      }
    }
    if (!fresh.length) return;

    const pairs = [...pendingLidPairs].map(([lid, pn]) => ({ lid, pn }));
    pendingLidPairs.clear();
    try {
      await db.upsertLidMap(user.id, pairs);
    } catch (err) {
      for (const p of pairs) pendingLidPairs.set(p.lid, p.pn);
      console.warn(`[${user.id}] Could not store lid mapping:`, err.message);
    }

    for (const pair of fresh) {
      try {
        if (await db.mergeChats(user.id, pair.lid, pair.pn)) {
          console.log(`[${user.id}] Merged the duplicate chat ${pair.lid} into ${pair.pn}.`);
        }
      } catch (err) {
        console.warn(`[${user.id}] Could not merge ${pair.lid}:`, err.message);
      }
    }
  }

  // WhatsApp will re-deliver a message it thinks was not acknowledged, and
  // Baileys re-emits it every time — the same message can arrive many times
  // a second, and each arrival was a write to Postgres. Remember what has
  // just been stored and let the repeats fall on the floor.
  const RECENT_TTL_MS = 5 * 60 * 1000;
  const RECENT_MAX = 2000;
  const recentlyStored = new Map();
  let suppressed = 0;
  let suppressedLoggedAt = 0;

  // Identity plus the parts that could legitimately change, so a message
  // that genuinely gains content is still written.
  function fingerprint(row) {
    return `${row.id}|${row.ts}|${row.mediaKind || ''}|${(row.body || '').length}`;
  }

  function isRepeat(row) {
    const key = fingerprint(row);
    const seen = recentlyStored.get(key);
    const now = Date.now();
    if (seen && now - seen < RECENT_TTL_MS) return true;
    recentlyStored.set(key, now);
    if (recentlyStored.size > RECENT_MAX) {
      // Oldest first: Map preserves insertion order.
      for (const k of recentlyStored.keys()) {
        recentlyStored.delete(k);
        if (recentlyStored.size <= RECENT_MAX * 0.8) break;
      }
    }
    return false;
  }

  function noteSuppressed(n) {
    if (!n) return;
    suppressed += n;
    const now = Date.now();
    // One line a minute at most; the point is to show it is happening, not
    // to replace one flood of logging with another.
    if (now - suppressedLoggedAt < 60000) return;
    suppressedLoggedAt = now;
    console.log(
      `[${user.id}] Ignored ${suppressed} re-delivered message(s) that were already stored.`
    );
    suppressed = 0;
  }

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
      const jid = realJid(contact.id, contact.phoneNumber, lidToPn);
      learnName(jid, contact.name || contact.verifiedName || contact.notify);
    }

    const chatRows = chats
      .map((c) => {
        const id = realJid(c.id, c.phoneNumber, lidToPn);
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

    // Learn who is who before shaping the rows, so a message that reveals a
    // pair is itself filed under the number rather than the LID.
    if (messages.length) await learnLidPairs(messages.map((m) => m && m.key));

    const allMessageRows = messages
      .map((m) => messageRow(m, state.contactNames, lidToPn))
      .filter(Boolean);

    const messageRows = allMessageRows.filter((row) => !isRepeat(row));
    noteSuppressed(allMessageRows.length - messageRows.length);

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
  // One batch per connection left everything past the first 60 chats
  // waiting for the next restart. Keep going until nothing is stale.
  const AVATAR_MAX_PASSES = 20;
  // How many times a chat may fail to answer before it is written off. A
  // blip should not be permanent, and a permanent failure should not be
  // retried forever.
  const AVATAR_MAX_FAILURES = 5;
  // Long enough to be out of the way of the connection settling, short
  // enough to run before anything can idle this process out.
  //
  // This was forty-five seconds on the theory that the 500s came from
  // asking during Baileys' sync window. That theory was wrong — they were
  // groups being asked the wrong way — and the long wait introduced a
  // worse problem: on a host that suspends an idle container, a timer that
  // far out never fires at all, so the check silently stopped happening.
  const AVATAR_FIRST_DELAY_MS = 8000;

  // Baileys waits a full minute for an answer that may never come
  // (defaultQueryTimeoutMs). Fifteen chats that do not answer is then a
  // fifteen-minute pass that looks, from outside, exactly like a hang.
  const AVATAR_QUERY_TIMEOUT_MS = 10000;

  // And a ceiling on the pass as a whole, so it always reports what it got
  // rather than grinding on. Whatever is left is still due next sweep.
  const AVATAR_PASS_BUDGET_MS = 120000;

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

  // Baileys bounds opening the socket (connectTimeoutMs) but not the login
  // that follows it. A connection can sit at "connected to WA" forever with
  // no close event, and nothing here would ever notice: no error, no
  // disconnect, no retry. Give signing in a deadline of its own.
  const LOGIN_TIMEOUT_MS = 90000;
  let loginTimer = null;

  function armLoginWatchdog() {
    clearTimeout(loginTimer);
    loginTimer = setTimeout(() => {
      if (state.isReady || state.latestQr) return;
      console.warn(
        `[${user.id}] Still not signed in ${LOGIN_TIMEOUT_MS / 1000}s after connecting. ` +
          'Dropping this socket and trying again.'
      );
      state.statusText = 'Sign-in stalled. Reconnecting...';
      teardown()
        .then(() => scheduleReconnect(backoffFor(state.attempts)))
        .catch((err) => console.warn(`[${user.id}] Could not restart:`, err.message));
    }, LOGIN_TIMEOUT_MS);
    if (loginTimer.unref) loginTimer.unref();
  }

  let refreshingAvatars = false;
  let avatarTimer = null;
  let avatarCycle = null;

  // The twelve-hour staleness check only ever ran five seconds after a
  // connection opened, so on a link that stays up it never ran again: a
  // chat that had no picture when first asked would never be asked twice,
  // and someone changing their photo would never be noticed. Sweep on a
  // cycle while connected instead.
  const AVATAR_SWEEP_MS = 6 * 60 * 60 * 1000;

  // A profile picture preview is a few KB. Anything wildly bigger is not
  // what we asked for and is not worth putting in a row.
  const AVATAR_MAX_BYTES = 512 * 1024;
  const AVATAR_TIMEOUT_MS = 10000;

  async function downloadAvatar(url) {
    const stop = AbortSignal.timeout
      ? AbortSignal.timeout(AVATAR_TIMEOUT_MS)
      : undefined;
    const res = await fetch(url, { signal: stop });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length) throw new Error('empty');
    if (buffer.length > AVATAR_MAX_BYTES) throw new Error(`too large (${buffer.length}B)`);

    const mimetype = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    return { buffer, mimetype };
  }

  // Profile pictures are signed URLs that expire, so this re-asks on a long
  // cycle. A chat with no picture is recorded as checked too, so the ones
  // without are not asked about again every sync.
  // WhatsApp's answers fall into two kinds, and treating them alike is what
  // left fourteen chats permanently blank: 401/403 (their privacy settings)
  // and 404 (no picture set) are answers — record them and stop asking. A
  // 500, a 408, or a dropped socket is not an answer, it is a failure to
  // ask, and recording it as "checked" means never asking again.
  // 401 and 403 are privacy settings; 404 is no picture set. 500 belongs
  // here too, despite reading like a server fault: it is what WhatsApp
  // returns for a group with no picture, and treating it as a failure to
  // ask meant retrying it forever. Settling is not permanent — the row is
  // simply marked checked, and the twelve-hour sweep asks again — so the
  // cost of being wrong about it is one stale avatar for half a day.
  const DEFINITIVE = new Set([401, 403, 404, 500]);

  function isDefinitive(err) {
    const code = err && (err.output?.statusCode ?? err.status);
    return DEFINITIVE.has(Number(code));
  }

  // None of these is a person or a group, so none has a picture to fetch.
  // `0@s.whatsapp.net` is WhatsApp's own system account, which appears in
  // chat lists and times out when asked.
  function canHaveAvatar(jid) {
    const value = String(jid);
    if (/@(broadcast|newsletter)$/.test(value)) return false;
    if (value === 'status@broadcast' || value === '0@s.whatsapp.net') return false;
    return true;
  }

  // Addressing the query straight at a group was tried, on the theory that
  // the 500s came from Baileys routing it via s.whatsapp.net. It was worse:
  // WhatsApp did not answer at all, so a fast error became a ten-second
  // timeout. Baileys' own helper is the right call for everyone.
  function pictureUrlFor(socket, jid) {
    return socket.profilePictureUrl(jid, 'preview', AVATAR_QUERY_TIMEOUT_MS);
  }

  async function refreshAvatars() {
    // Silence here has been mistaken for a bug three times. If the pass
    // declines to run, say so rather than leaving nothing in the log.
    if (refreshingAvatars) {
      console.log(`[${user.id}] Profile pictures: a check is already running.`);
      return;
    }
    if (!state.isReady) {
      console.log(`[${user.id}] Profile pictures: skipped, the connection is not up.`);
      return;
    }
    refreshingAvatars = true;
    // Printed before the first database call, so a pass that starts and
    // then hangs is distinguishable from one that never started.
    console.log(`[${user.id}] Profile pictures: checking now.`);
    let checked = 0;
    let found = 0;
    let deferred = 0;
    let exhausted = 0;
    const reasons = new Map();
    const examples = new Map();
    // Asked about in this run, so a row left unrecorded on purpose is not
    // picked straight back up by the next pass.
    const attempted = new Set();

    const until = Date.now() + AVATAR_PASS_BUDGET_MS;
    let ranOut = false;

    try {
      for (let pass = 0; pass < AVATAR_MAX_PASSES; pass++) {
        if (Date.now() > until) { ranOut = true; break; }
        const batch = await db.chatsNeedingAvatar(user.id, Date.now() - AVATAR_TTL_MS, AVATAR_BATCH);
        const ids = batch.filter((id) => !attempted.has(id));
        if (!ids.length) break;

        for (const id of ids) {
          const socket = state.socket;
          if (!socket || !state.isReady) break;
          if (Date.now() > until) { ranOut = true; break; }
          attempted.add(id);

          if (!canHaveAvatar(id)) {
            await db.setChatAvatar(user.id, id, null).catch(() => {});
            checked += 1;
            continue;
          }

          let url = null;
          let picture = null;
          let answered = true;

          try {
            url = await pictureUrlFor(socket, id);
            // Fetch it now, while the signature on the URL is still valid.
            if (url) picture = await downloadAvatar(url);
          } catch (err) {
            const code = (err && (err.output?.statusCode ?? err.status)) || null;
            const why = String(code || (err && err.message) || 'unknown');
            reasons.set(why, (reasons.get(why) || 0) + 1);
            if (!examples.has(why)) examples.set(why, id);
            // A URL that arrived but would not download is a real failure of
            // ours, not WhatsApp's answer, so it is worth retrying too.
            answered = url ? false : isDefinitive(err);
            url = null;
          }

          if (!answered) {
            // Leave the row for a later sweep — but not forever. A jid that
            // fails this way every time would otherwise be re-asked every
            // six hours for good, so after enough tries it is settled as
            // having no picture and stops costing queries.
            let fails = 0;
            try {
              fails = await db.noteAvatarFailure(user.id, id);
            } catch {
              /* the counter is an optimisation */
            }
            if (fails >= AVATAR_MAX_FAILURES) {
              await db.setChatAvatar(user.id, id, null).catch(() => {});
              exhausted += 1;
            } else {
              deferred += 1;
            }
            await pause(LOOKUP_GAP_MS);
            continue;
          }

          try {
            await db.setChatAvatar(user.id, id, {
              url,
              bytes: picture ? picture.buffer : null,
              mimetype: picture ? picture.mimetype : null
            });
          } catch (err) {
            console.warn(`[${user.id}] Could not store an avatar:`, err.message);
          }
          checked += 1;
          if (picture) found += 1;
          await pause(LOOKUP_GAP_MS);
        }
        if (!state.isReady || ranOut) break;
      }

      // Always say something. Twice now, profile pictures have "not worked"
      // and the log has been silent — and silence could mean the pass never
      // ran, or ran and found nothing, or had nothing left to do. Those need
      // telling apart from the outside.
      // Name one jid per reason: whether the failures are groups, LIDs or
      // ordinary numbers is the thing that has been impossible to tell from
      // a bare count.
      const why = [...reasons]
        .map(([k, n]) => `${k}×${n} (e.g. ${examples.get(k)})`)
        .join(', ');
      let tally = '';
      try {
        const { total, withPicture } = await db.countChatsWithAvatar(user.id);
        tally = ` ${withPicture}/${total} chats now have one.`;
      } catch {
        /* the tally is a nicety */
      }
      if (checked || deferred || exhausted) {
        console.log(
          `[${user.id}] Profile pictures: settled ${checked}, downloaded ${found}` +
            (deferred ? `, ${deferred} could not be asked and will be retried` : '') +
            (exhausted ? `, ${exhausted} gave up after ${AVATAR_MAX_FAILURES} tries` : '') +
            (ranOut ? ', out of time — the rest are still due' : '') +
            (why ? `. Reasons: ${why}.` : '.') + tally
        );
      } else {
        console.log(
          `[${user.id}] Profile pictures: nothing due a check right now.` + tally
        );
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
    // From here on, signing in has a deadline.
    armLoginWatchdog();

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('messaging-history.set', (payload) => {
      persistHistory(payload);
    });

    const onContacts = (contacts) => {
      for (const c of contacts || []) {
        learnName(realJid(c.id, c.phoneNumber, lidToPn), c.name || c.verifiedName || c.notify);
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
      state.pausedForScan = false;
      // Waiting for someone to scan is not a stall.
      clearTimeout(loginTimer);
      loginTimer = null;
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

      if (state.qrCount >= MAX_QR_PER_RUN) {
        // Generating codes nobody scans is not free: it spends this
        // account's device-linking allowance and can get further attempts
        // refused. Stop until a person asks for a new one.
        state.latestQr = null;
        state.pausedForScan = true;
        state.startupError =
          `No one scanned the code after ${state.qrCount} tries, so this inbox stopped ` +
          'generating them — each one uses up part of WhatsApp\'s linking allowance. ' +
          'Press the button below when you are ready to scan.';
        state.statusText = 'Paused. Nobody scanned the QR code.';
        console.warn(
          `[${user.id}] Stopping after ${state.qrCount} unscanned QR codes, to stop ` +
            'spending this account\'s linking allowance. Use the inbox page to start over.'
        );
        await teardown();
      }
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
      state.pausedForScan = false;
      state.isReady = true;
      clearTimeout(loginTimer);
      loginTimer = null;
      state.statusText = 'Connected.';
      console.log(`[${user.id}] Connected. Syncing history in the background.`);
      onClaimCode(user, state);
      // Pictures are a nicety, so they wait until the socket has settled and
      // never block the inbox coming up. Tracked so a socket that drops in
      // the meantime takes the pending lookup down with it.
      clearTimeout(avatarTimer);
      avatarTimer = setTimeout(() => refreshAvatars(), AVATAR_FIRST_DELAY_MS);
      console.log(
        `[${user.id}] Profile pictures: checking in ${AVATAR_FIRST_DELAY_MS / 1000}s.`
      );
      clearInterval(avatarCycle);
      avatarCycle = setInterval(() => refreshAvatars(), AVATAR_SWEEP_MS);
      if (avatarCycle.unref) avatarCycle.unref();
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
    clearTimeout(loginTimer);
    loginTimer = null;
    clearTimeout(avatarTimer);
    avatarTimer = null;
    clearInterval(avatarCycle);
    avatarCycle = null;
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
      const pairs = await db.listLidMap(user.id);
      for (const p of pairs) lidToPn.set(p.lid, p.pn);
      if (pairs.length) console.log(`[${user.id}] Recalled ${pairs.length} lid mappings.`);

      // Duplicates created before a pair was known are still sitting there.
      // Folding them is idempotent — a merge whose source no longer exists
      // reports false — so this can simply run every boot.
      let merged = 0;
      for (const p of pairs) {
        if (await db.mergeChats(user.id, p.lid, p.pn)) merged += 1;
      }
      if (merged) {
        console.log(`[${user.id}] Merged ${merged} chat(s) that were split across two ids.`);
      }
    } catch (err) {
      console.warn(`[${user.id}] Could not read lid mappings:`, err.message);
    }
    try {
      // Name every chat that has ever received a message, before reading
      // the list back — otherwise those names only appear as new messages
      // arrive, which is why they used to trickle in.
      const filled = await db.backfillContactNames(user.id);
      if (filled) console.log(`[${user.id}] Named ${filled} chats from messages already stored.`);
    } catch (err) {
      console.warn(`[${user.id}] Could not backfill names:`, err.message);
    }
    try {
      const rows = await db.listContacts(user.id);
      for (const r of rows) state.contactNames.set(r.jid, r.name);
      if (rows.length) console.log(`[${user.id}] Recalled ${rows.length} contact names.`);
    } catch (err) {
      console.warn(`[${user.id}] Could not read stored contact names:`, err.message);
    }
  }

  // A linked inbox has credentials on disk and reconnects without ever
  // showing a code. One with none can only come up by someone scanning, and
  // scanning needs a person present — so starting it at boot just spends
  // WhatsApp's linking allowance at an empty page, ten codes every deploy.
  function hasStoredSession() {
    try {
      return fs.existsSync(path.join(authDir, 'creds.json'));
    } catch {
      return false;
    }
  }

  async function start(options = {}) {
    if (options.requested) state.linkRequested = true;

    if (!state.linkRequested && !hasStoredSession()) {
      state.latestQr = null;
      state.pausedForScan = true;
      state.startupError =
        'This inbox is not linked to WhatsApp yet. Codes are only generated while ' +
        'someone is waiting to scan one, because each code uses up part of ' +
        "WhatsApp's linking allowance. Press the button when you are ready.";
      state.statusText = 'Not linked. Ask for a code when someone can scan it.';
      console.log(
        `[${user.id}] No stored session — not generating codes until someone asks for one.`
      );
      return;
    }

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
  // Exposed so the picture pass can be driven directly, in tests and if it
  // ever needs triggering by hand.
  state.refreshAvatars = refreshAvatars;
  return state;
}

// The small preview WhatsApp embeds in the message itself. It is already in
// Postgres, so this costs a row read rather than a round trip to WhatsApp —
// the difference between a picture appearing at once and appearing in a
// second or two. Stored as base64 because that is what protobuf's toJSON
// does with the bytes on the way into the JSONB column.
function thumbnailOf(rawMessage) {
  const node = mediaNodeOf(rawMessage);
  if (!node) return null;

  // Pictures and videos carry a JPEG preview; stickers carry a PNG one under
  // a different field name entirely. Audio carries nothing — there is
  // nothing to preview.
  const raw = node.jpegThumbnail || node.pngThumbnail;
  if (!raw) return null;
  const mimetype = node.pngThumbnail && !node.jpegThumbnail ? 'image/png' : 'image/jpeg';

  try {
    let buffer;
    if (typeof raw === 'string') buffer = Buffer.from(raw, 'base64');
    else if (Buffer.isBuffer(raw)) buffer = raw;
    else if (raw.data) buffer = Buffer.from(raw.data); // {type:'Buffer',data:[...]}
    else buffer = Buffer.from(Object.values(raw));
    return buffer.length ? { buffer, mimetype } : null;
  } catch {
    return null;
  }
}

function mediaNodeOf(rawMessage) {
  const inner = (rawMessage && rawMessage.message) || {};
  const unwrapped =
    inner.ephemeralMessage?.message ||
    inner.viewOnceMessage?.message ||
    inner.viewOnceMessageV2?.message ||
    inner.documentWithCaptionMessage?.message ||
    inner;
  return (
    unwrapped.imageMessage ||
    unwrapped.stickerMessage ||
    unwrapped.videoMessage ||
    unwrapped.audioMessage ||
    unwrapped.documentMessage ||
    null
  );
}

// Media is not stored, only the message that describes it, so downloading
// asks WhatsApp for the bytes on demand.
//
// `socket` is optional but worth passing: WhatsApp expires the URL in a
// message after a while, and the only way back is to ask it to re-upload
// the file. Without a socket that path cannot run and an older sticker or
// voice note simply fails, which is why some rendered and some did not.
async function fetchMedia(rawMessage, socket) {
  const ctx = socket
    ? { reuploadRequest: socket.updateMediaMessage, logger: socket.logger || console }
    : undefined;
  const buffer = await downloadMediaMessage(rawMessage, 'buffer', {}, ctx);
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
  thumbnailOf,
  // Exposed for tests: these are pure, and the jid shapes they handle are
  // fiddly enough to be worth pinning down without a live socket.
  __test: { messageRow, chatRowFromMessage, describeMessage, displayNumber, realJid, slimForStorage, lidPairsFrom }
};
