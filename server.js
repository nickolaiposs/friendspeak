// friendspeak server: hosts text channels, voice signaling, custom emojis, the
// penguin game worlds (Yukon), and serves the web client. Run with
// `npm start` (or Docker); friends connect by IP:port. The desktop app is a
// client only and never hosts.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');
const crypto = require('crypto');
const { pipeline } = require('stream');
const express = require('express');
const { Server } = require('socket.io');
const { startGame } = require('./game');
const { createUpdater } = require('./updater');
const logbuffer = require('./logbuffer');
const { createCrashLog } = require('./crashlog');
const { createAdmin } = require('./admin');

const VERSION = require('./package.json').version;

// The running server's crash handling (#50, #51): the process-wide handlers below
// use whichever startServer ran last, and the CLI's failure handler uses it too
let crashState = null; // { crashes, logs, saveNow(), clearMarker() }
let crashHandlers = false;
const recentRejections = new Map(); // stack or message -> when it was last reported

function installCrashHandlers() {
  if (crashHandlers) return;
  crashHandlers = true;
  let dying = false;
  process.on('uncaughtException', (err) => {
    if (dying) return;
    dying = true;
    try {
      console.error('[crash] uncaught exception:', err);
    } catch {}
    const c = crashState;
    c?.crashes.write('uncaughtException', err, { fatal: true });
    c?.saveNow();
    c?.clearMarker();
    c?.logs?.flushSync();
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[crash] unhandled rejection:', reason);
    const key = String(reason instanceof Error ? `${reason.name}: ${reason.message}` : reason).slice(0, 500);
    const now = Date.now();
    for (const [k, t] of recentRejections) if (now - t > 60e3) recentRejections.delete(k);
    if (recentRejections.has(key)) return;
    recentRejections.set(key, now);
    crashState?.crashes.write('unhandledRejection', reason, { fatal: false });
  });
}

async function startServer(opts = {}) {
  const PORT = opts.port ?? 3000;
  const HOST = opts.host;
  const USE_HTTPS = !!opts.https;
  const GIPHY_API_KEY = opts.giphyKey || '';
  let fingerprint = null; // SHA-256 of the self-signed certificate, when HTTPS
  const DATA_DIR = opts.dataDir || path.join(__dirname, 'data');
  // Keep the console lines for the admin dashboard (D34), in memory and on disk (#50)
  const logs =
    opts.captureLogs === false ? null : logbuffer.install({ dir: path.join(DATA_DIR, 'logs'), retentionDays: opts.logs?.retentionDays ?? 14, maxBytes: opts.logs?.maxBytes ?? 50 * 1024 ** 2 });
  if (logs) for (const secret of [GIPHY_API_KEY, opts.admin?.key, opts.update?.token, opts.update?.watchtowerToken]) logs.redact(secret);
  const bootTime = Date.now();
  const earlierLines = logs && opts.crashReports ? logs.tail(200) : []; // from before this boot, read before it logs anything
  let usersRef = null;
  const crashes = createCrashLog({ dir: path.join(DATA_DIR, 'crashes'), logs, version: VERSION, context: () => ({ online: usersRef ? usersRef.size : 0, docker: !!opts.update?.inDocker }) });
  const MARKER = path.join(DATA_DIR, 'logs', '.running');
  let ownsMarker = false;
  const clearMarker = () => {
    if (!ownsMarker) return;
    ownsMarker = false;
    try {
      fs.rmSync(MARKER, { force: true });
    } catch {}
  };
  crashState = { crashes, logs, saveNow: () => {}, clearMarker };
  if (opts.crashReports) {
    installCrashHandlers();
    // A marker left behind means the last run never got to close()
    let prev = null;
    try {
      prev = JSON.parse(fs.readFileSync(MARKER, 'utf8'));
    } catch {}
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return err.code === 'EPERM';
      }
    };
    const another = prev && Number.isInteger(prev.pid) && prev.pid !== process.pid && alive(prev.pid); // another server on this data dir: leave it alone
    if (!another) {
      if (prev) {
        crashes.write('unclean-exit', 'The server stopped without shutting down (killed, out of memory or power loss)', {
          fatal: true,
          // uptime, memory and who was online are this process's, not the one that died
          extra: { uptime: null, memory: null, online: null, startedAt: Number(prev.startedAt) || null, previousVersion: typeof prev.version === 'string' ? prev.version.slice(0, 40) : null, lines: earlierLines.filter((l) => l.ts < bootTime) },
        });
        console.warn('[server] the previous run did not shut down cleanly');
      }
      try {
        fs.mkdirSync(path.dirname(MARKER), { recursive: true, mode: 0o700 });
        fs.writeFileSync(MARKER, JSON.stringify({ pid: process.pid, startedAt: bootTime, version: VERSION }), { mode: 0o600 });
        ownsMarker = true;
      } catch {}
    }
  }
  const STATE_FILE = path.join(DATA_DIR, 'state.json');
  const MAX_HISTORY = 500;
  const MAX_SEARCH_RESULTS = 50;
  const MAX_MESSAGE_LEN = 4000;
  const MAX_EMOJI_BYTES = 256 * 1024;
  const MAX_AVATAR_BYTES = 384 * 1024;
  const MAX_BANNER_BYTES = 640 * 1024; // profile background
  const MAX_ICON_BYTES = 512 * 1024;
  const AUDIO_QUALITIES = ['low', 'standard', 'high', 'max']; // voice quality levels, lowest first
  const MAX_ROLES = 50;
  const MAX_ROLES_PER_MEMBER = 10;
  const MAX_ROLE_NAME = 32;
  const MAX_CHANNEL_NAME = 48; // room for emojis, incl. :custom: ones
  // Server-wide permissions (docs/ARCHITECTURE.md → Permissions). Until someone holds
  // an Administrator role the server is in "open mode" and everyone can do everything.
  const PERM_KEYS = ['admin', 'view', 'send', 'mentionRoles', 'mentionEveryone', 'kick', 'voiceKick', 'ban', 'forceMute', 'manageRoles', 'manageChannels', 'manageEmojis', 'manageFiles', 'manageMessages', 'createInvites'];
  const CHANNEL_PERM_KEYS = ['view', 'send', 'manage'];
  // createInvites is off unless a role or the defaults turn it on (D51)
  const DEFAULT_PERMS = Object.fromEntries(PERM_KEYS.map((k) => [k, ['view', 'send', 'mentionRoles', 'mentionEveryone'].includes(k)]));
  const OPEN_ROLES_ERROR = 'Roles are set up in the admin dashboard until someone on this server is an admin';
  // Invites (D51): the tokens people join with
  const INVITE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O or U
  const INVITE_CHARS = 16; // 80 random bits
  const MAX_INVITES = 200;
  const MAX_INVITE_USES = 10000;
  const MAX_INVITE_AGE = 365 * 864e5;
  const MAX_INVITE_JOINS = 100; // who joined with an invite: the latest are kept, `uses` counts them all
  const MAX_INVITE_LABEL = 40;
  const INVITE_FAILURES = 10; // wrong invites from one address before it has to wait
  const INVITE_WINDOW = 10 * 60e3;
  const MAX_STORAGE = parseSize(opts.maxStorage, 2 * 1024 ** 3); // all uploaded files together
  const MAX_FILES_PER_MESSAGE = 10;
  const FILES_DIR = path.join(DATA_DIR, 'files');
  // Mailboxes for direct messages (D32): sealed blobs the server can't read
  const DM_GUESTS = opts.dmGuests !== false;
  const MAIL_FILE = path.join(DATA_DIR, 'mail.json');
  const MAX_MAIL_BLOB = 160 * 1024; // one sealed op (MAX_BLOB in dm.js)
  const MAX_MAILBOX_ITEMS = 500;
  const MAX_MAILBOX_BYTES = 8 * 1024 * 1024;
  const MAX_MAILBOXES = 5000;
  const MAIL_TTL = 30 * 864e5; // mail nobody collected
  const MAILBOX_IDLE = 90 * 864e5; // an empty mailbox whose owner never came back

  fs.mkdirSync(FILES_DIR, { recursive: true });

  // Self-update from GitHub Releases (updater.js, D29). Clients learn about a
  // scheduled update from `server:update` and show a maintenance warning.
  const ioRef = { current: null };
  const adminRef = { current: null }; // the admin dashboard, created once everything it reads exists

  // ---------- persistent state ----------

  const id = () => crypto.randomBytes(8).toString('hex');

  function defaultState() {
    return {
      name: opts.serverName || 'friendspeak', // renamed from Settings → Server
      icon: '', // data: image, set from Settings → Server
      channels: [
        { id: id(), name: 'general', type: 'text' },
        { id: id(), name: 'memes', type: 'text' },
        { id: id(), name: 'Lounge', type: 'voice' },
        { id: id(), name: 'Gaming', type: 'voice' },
      ],
      messages: {},
      emojis: [], // { name, url(dataURL), by }
      profiles: {}, // profileId -> { name, color, avatar, banner, status, seen }
      bans: [], // { id, profileId, name, ip, by, ts } (ip is never sent to clients)
      files: [], // uploaded files: { id, name, size, type, channelId, messageId, by, byName, ts }
      gameEnabled: true, // game on/off, from Settings → Server (only takes effect with assets)
      audioQuality: 'max', // voice bitrate in the voice channels, from Settings → Server: a key of AUDIO_QUALITY in the client's voice.js (D38)
      roles: [], // { id, name, color, perms, grantable }, first = highest; managed in the dashboard and, with permissions, in the app (D34, D43)
      defaultPerms: { ...DEFAULT_PERMS }, // what everybody gets unless a role they hold says otherwise
      defaultGrantable: [], // role ids everyone may hand out when defaultPerms.manageRoles is on
      permissionsOn: false, // false = open mode (everyone can do everything); sticky once someone holds an Administrator role
      forceMuted: [], // profile ids a moderator force-muted
      updateSettings: {}, // { mode?, cron? } overriding AUTO_UPDATE / MAINTENANCE_CRON, set in the admin dashboard; never sent to clients
      memberRoles: {}, // profileId -> [roleId], only profiles with a role; kept beside profiles because storedProfile() rebuilds those
      inviteOnly: true, // joining takes an invite (D51); from Settings → Server. `invites` is added below, so a first start can be told apart
      pins: {}, // profileId -> the Ed25519 public key that must sign its hello (D42); kept when a member is removed; never sent to clients
    };
  }

  let state;
  let pinsMissing = false; // a state.json from before D42: pin the keys its profiles already have
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    pinsMissing = !state.pins;
    state = { ...defaultState(), ...state };
    delete state.dms; // DMs used to be stored here; they're peer to peer now (D28)
  } catch {
    state = defaultState();
  }
  // What message links name this server by: made once, the same at every address it has
  const newServerId = typeof state.id !== 'string' || !/^[\w-]{8,64}$/.test(state.id);
  if (newServerId) state.id = crypto.randomBytes(8).toString('hex');

  // A hand-edited or damaged state.json must not crash the role code
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  // Explicit permission settings only: key -> true|false, 'admin' only ever true. Unknown keys and bad values dropped.
  function cleanPermMap(raw) {
    const out = {};
    if (!isObj(raw)) return out;
    for (const k of PERM_KEYS) if (Object.hasOwn(raw, k) && typeof raw[k] === 'boolean' && (k !== 'admin' || raw[k])) out[k] = raw[k];
    return out;
  }
  const cleanIdList = (raw, known) => (Array.isArray(raw) ? [...new Set(raw.filter((x) => typeof x === 'string' && known.has(x)))].slice(0, 200) : []);
  // { [roleId | 'everyone']: { view?, send?, manage? } } with unknown roles and empty entries dropped (null prototype: ids come from clients)
  function cleanOverrides(raw, known) {
    const out = Object.create(null);
    if (!isObj(raw)) return out;
    for (const [key, v] of Object.entries(raw)) {
      if ((key !== 'everyone' && !known.has(key)) || !isObj(v)) continue;
      const o = {};
      for (const k of CHANNEL_PERM_KEYS) if (typeof v[k] === 'boolean') o[k] = v[k];
      if (Object.keys(o).length) out[key] = o;
    }
    return out;
  }
  function cleanRoleState() {
    const roles = (Array.isArray(state.roles) ? state.roles : []).filter((r) => r && typeof r.id === 'string' && typeof r.name === 'string' && typeof r.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color));
    const known = new Set(roles.map((r) => r.id));
    const memberRoles = {};
    if (state.memberRoles && typeof state.memberRoles === 'object' && !Array.isArray(state.memberRoles)) {
      for (const [pid, list] of Object.entries(state.memberRoles)) {
        const ids = Array.isArray(list) ? [...new Set(list.filter((x) => typeof x === 'string' && known.has(x)))].slice(0, MAX_ROLES_PER_MEMBER) : [];
        if (ids.length) Object.defineProperty(memberRoles, pid, { value: ids, enumerable: true, writable: true, configurable: true });
      }
    }
    state.roles = roles.slice(0, MAX_ROLES).map((r) => ({ id: r.id, name: r.name, color: r.color, perms: cleanPermMap(r.perms), grantable: cleanIdList(r.grantable, known) }));
    state.memberRoles = memberRoles;
    state.defaultPerms = { ...DEFAULT_PERMS, ...cleanPermMap(state.defaultPerms) };
    state.defaultGrantable = cleanIdList(state.defaultGrantable, known);
    state.permissionsOn = state.permissionsOn === true;
    state.forceMuted = [...new Set((Array.isArray(state.forceMuted) ? state.forceMuted : []).filter((x) => typeof x === 'string' && x && x.length <= 64))];
    for (const ch of Array.isArray(state.channels) ? state.channels : []) {
      const ov = cleanOverrides(ch.overrides, known);
      if (Object.keys(ov).length) ch.overrides = ov;
      else delete ch.overrides;
    }
  }
  cleanRoleState();

  // ---------- invites (D51) ----------

  // An invite is a random token that lets a profile join: for good, a number of times, or until
  // a date. The token is kept next to its SHA-256, so an administrator or the dashboard can
  // read a working invite again and hand it to someone else. Once in, a member is known by
  // their pinned key (D42) and needs no invite to come back.
  // { id, hash, token|null (null: made when only the hash was kept), label, maxUses|null, uses, expires|null, by: { id|null, name }, ts, revoked: null | { ts, by }, joins: [{ id, name, ts }] }
  const firstStart = !Array.isArray(state.invites);
  const cleanLabel = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_INVITE_LABEL) : '');
  const posInt = (v, max) => (Number.isInteger(v) && v >= 1 ? Math.min(v, max) : null);
  const ts0 = (v) => (Number.isFinite(v) && v > 0 ? v : null);
  state.inviteOnly = state.inviteOnly !== false;
  state.invites = (firstStart ? [] : state.invites)
    .filter((v) => isObj(v) && typeof v.id === 'string' && typeof v.hash === 'string' && /^[0-9a-f]{64}$/.test(v.hash))
    .slice(0, MAX_INVITES)
    .map((v) => ({
      id: v.id.slice(0, 32),
      hash: v.hash,
      token: typeof v.token === 'string' ? v.token.slice(0, 64) : null, // checked against the hash below
      label: cleanLabel(v.label),
      maxUses: posInt(v.maxUses, MAX_INVITE_USES),
      uses: Number.isInteger(v.uses) && v.uses > 0 ? v.uses : 0,
      expires: ts0(v.expires),
      by: { id: typeof v.by?.id === 'string' ? v.by.id.slice(0, 64) : null, name: cleanLabel(v.by?.name) || '?' },
      ts: ts0(v.ts) || Date.now(),
      revoked: isObj(v.revoked) ? { ts: ts0(v.revoked.ts) || Date.now(), by: cleanLabel(v.revoked.by) || '?' } : null,
      joins: (Array.isArray(v.joins) ? v.joins : []).filter((j) => isObj(j) && typeof j.id === 'string').slice(-MAX_INVITE_JOINS).map((j) => ({ id: j.id.slice(0, 64), name: cleanLabel(j.name) || 'anon', ts: ts0(j.ts) || 0 })),
    }));

  // 16 characters in groups of four. 256 is a multiple of 32, so a byte's low five bits are uniform.
  const newInviteToken = () => [...crypto.randomBytes(INVITE_CHARS)].map((b) => INVITE_ALPHABET[b & 31]).join('').replace(/(.{4})(?=.)/g, '$1-');
  // What someone typed or pasted, as the 16 characters: any case, dashes and spaces dropped, look-alikes mapped. '' when it can't be a token.
  function normInvite(v) {
    if (typeof v !== 'string' || v.length > 64) return '';
    const t = v.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    return t.length === INVITE_CHARS && [...t].every((ch) => INVITE_ALPHABET.includes(ch)) ? t : '';
  }
  const inviteHash = (norm) => crypto.createHash('sha256').update('friendspeak-invite-v1|' + norm).digest();
  // 'active', or why it no longer lets anyone in: 'revoked', 'expired', 'used'
  const inviteStatus = (v, now = Date.now()) => (v.revoked ? 'revoked' : v.expires && v.expires <= now ? 'expired' : v.maxUses && v.uses >= v.maxUses ? 'used' : 'active');
  // The invite a token belongs to if it still works, else null. Every stored hash is compared, in constant time.
  function inviteFor(token) {
    const norm = normInvite(token);
    if (!norm) return null;
    const given = inviteHash(norm);
    let hit = null;
    for (const v of state.invites) if (crypto.timingSafeEqual(given, Buffer.from(v.hash, 'hex'))) hit = v;
    return hit && inviteStatus(hit) === 'active' ? hit : null;
  }
  for (const v of state.invites) if (v.token && inviteHash(normInvite(v.token)).toString('hex') !== v.hash) v.token = null;
  // What the app and the dashboard list: never the hash. The token of a working invite goes to
  // whoever may hand it out: `all` (an administrator, the dashboard), else only to who made it.
  const publicInvites = (all, pid = null) => state.invites.map(({ hash, token, ...v }) => ({ ...v, token: inviteStatus(v) === 'active' && (all || (pid && v.by.id === pid)) ? token : null }));
  // Make and store an invite
  function addInvite({ label = '', maxUses = null, expires = null, by }) {
    const token = newInviteToken();
    const invite = { id: id(), hash: inviteHash(normInvite(token)).toString('hex'), token, label, maxUses, uses: 0, expires, by, ts: Date.now(), revoked: null, joins: [] };
    state.invites.push(invite);
    return { invite, token };
  }
  // A server with no invite list yet (a new one, or one from before invites): one that never
  // expires, shown by the CLI. It goes to stdout only, never through the log.
  const firstInvite = firstStart ? addInvite({ label: 'First start', by: { id: null, name: 'Server' } }).token : null;

  // Wrong invites per address: after INVITE_FAILURES in INVITE_WINDOW it waits out the window (memory only)
  const inviteFails = new Map(); // ip -> { n, since }
  function inviteBlocked(ip, now = Date.now()) {
    const f = inviteFails.get(ip);
    if (f && now - f.since > INVITE_WINDOW) inviteFails.delete(ip);
    return (inviteFails.get(ip)?.n || 0) >= INVITE_FAILURES;
  }
  function inviteFailed(ip, now = Date.now()) {
    if (!inviteFails.has(ip) && inviteFails.size >= 5000) {
      for (const [k, f] of inviteFails) if (now - f.since > INVITE_WINDOW) inviteFails.delete(k);
      if (inviteFails.size >= 5000) inviteFails.delete(inviteFails.keys().next().value);
    }
    const f = inviteFails.get(ip) || { n: 0, since: now };
    f.n++;
    inviteFails.set(ip, f);
  }

  // Update mode and maintenance window set in the admin dashboard; they override
  // AUTO_UPDATE / MAINTENANCE_CRON. Only strings get through: updater.js checks the rest.
  state.updateSettings = Object.fromEntries(
    ['mode', 'cron'].filter((k) => state.updateSettings && typeof state.updateSettings === 'object' && typeof state.updateSettings[k] === 'string').map((k) => [k, state.updateSettings[k].slice(0, 100)])
  );

  // The updater needs the saved overrides, so it is created once the state is loaded
  const updater = createUpdater({
    ...opts.update,
    version: VERSION,
    overrides: state.updateSettings,
    onChange: (info) => {
      ioRef.current?.emit('server:update', info);
      adminRef.current?.notify('update');
    },
  });

  let saveTimer = null;
  // A full disk or a read-only volume fails every save: say so, but not on every one
  let lastSaveError = 0;
  function saveFailed(what, err) {
    if (Date.now() - lastSaveError < 60e3) return;
    lastSaveError = Date.now();
    console.error(`[server] could not save ${what}: ${err.message}`);
  }
  function writeState() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE);
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        writeState();
      } catch (err) {
        saveFailed('the server state', err);
      }
    }, 500);
    adminRef.current?.notify('state');
  }
  save();

  // ---------- helpers ----------

  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  // Who a log line is about: a name is user input, so no control characters; plus the start of the id
  const whoIs = (p) => `${String(p?.name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 32) || 'anon'} (${String(p?.id ?? '').slice(0, 8)})`;
  const channel = (cid) => state.channels.find((c) => c.id === cid);
  const isDataImage = (v, max) =>
    typeof v === 'string' && /^data:image\/(png|jpe?g|gif|webp);base64,/.test(v) && v.length <= max * 1.4;
  // An uploaded image (data URL) or a linked one (https only, e.g. a GIPHY GIF)
  const isImageRef = (v, max) => isDataImage(v, max) || (typeof v === 'string' && v.length <= 1000 && /^https:\/\/[^\s"'<>]+$/.test(v));
  const isHexColor = (v) => /^#[0-9a-f]{6}$/i.test(v);
  const isKey = (v, len) => typeof v === 'string' && v.length === len && /^[A-Za-z0-9_-]+$/.test(v);
  // A profile's public keys for direct messages (D32). The server only passes
  // the card on; clients check its signature and pin it themselves.
  const cleanCard = (c, pid) => (c && typeof c === 'object' && c.id === pid && isKey(c.s, 43) && isKey(c.d, 43) && isKey(c.sig, 86) ? { id: pid, s: c.s, d: c.d, sig: c.sig } : undefined);

  // Whether `sig` is an Ed25519 signature of `text` by the public key `s` (both base64url)
  const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
  function verifySig(s, sig, text) {
    try {
      const raw = Buffer.from(s, 'base64url');
      if (raw.length !== 32 || typeof sig !== 'string') return false;
      const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw]), format: 'der', type: 'spki' });
      return crypto.verify(null, Buffer.from(text), key, Buffer.from(sig, 'base64url'));
    } catch {
      return false;
    }
  }
  // A card signed by its own key (identity.js makes them)
  const cardValid = (c) => !!c && verifySig(c.s, c.sig, 'friendspeak-card-v1|' + c.id + '|' + c.d);

  // ---------- profile keys (D42) ----------

  // A profile id belongs to the first key that proves it holds it here: every
  // later hello with that id must be signed by the same key. The key travels
  // only inside an exported profile file, so copying an id is no longer enough.
  // Null prototype: profile ids come from clients and could be "__proto__".
  state.pins = Object.assign(
    Object.create(null),
    Object.fromEntries(Object.entries(state.pins && typeof state.pins === 'object' ? state.pins : {}).filter(([pid, s]) => pid && pid.length <= 64 && isKey(s, 43)))
  );
  // Profiles from before this already sent a self-signed card (D32): pin it once, now,
  // rather than leave the id to whoever signs first after the update
  if (pinsMissing) {
    for (const [pid, p] of Object.entries(state.profiles || {})) {
      const card = cleanCard(p?.card, pid);
      if (card && cardValid(card)) state.pins[pid] = card.s;
    }
  }
  const pinOf = (pid) => state.pins[pid] || null;
  if (newServerId) save(); // links made today must still name this server after a restart
  // What a client signs to say hello: the socket id is a fresh value the server
  // chose, and the host it dialed stops another server from passing its hello on
  const helloText = (sid, host) => 'friendspeak-hello-v1|' + sid + '|' + host;
  const hostOf = (socket) => String(socket.handshake.headers.host || '').toLowerCase();

  // ---------- permissions ----------

  // A role with no settings and nothing to grant is just a label ("aesthetic"): anyone
  // with manageRoles may handle those, and unpinned (old app) profiles may hold them.
  const isAesthetic = (r) => !Object.keys(r.perms).length && !r.grantable.length;
  const holdsRole = (pid, rid) => Object.hasOwn(state.memberRoles, pid) && state.memberRoles[pid].includes(rid);
  // A profile without a pinned key can be anyone (D42), so roles with permissions don't count for it
  const heldRoles = (pid) => {
    const pinned = !!pinOf(pid);
    return state.roles.filter((r) => holdsRole(pid, r.id) && (pinned || isAesthetic(r)));
  };
  const holdsAdminRole = (pid) => heldRoles(pid).some((r) => r.perms.admin === true);
  const isAdminPid = (pid) => state.permissionsOn && (!!state.defaultPerms.admin || holdsAdminRole(pid));

  // What a profile may do: { open, admin, ...PERM_KEYS, grantable, channels: { [channelId]: { view, send, manage } } }
  // (only channels it can see). Open mode: everything but role management and invites (those are the dashboard's until someone is an admin).
  function permsOf(pid) {
    const open = !state.permissionsOn;
    const held = open ? [] : heldRoles(pid);
    const admin = !open && (!!state.defaultPerms.admin || held.some((r) => r.perms.admin === true));
    const g = { open, admin };
    for (const k of PERM_KEYS) {
      if (k === 'admin') continue;
      if (open) g[k] = k !== 'manageRoles' && k !== 'createInvites';
      else if (admin) g[k] = true;
      else {
        const r = held.find((x) => typeof x.perms[k] === 'boolean');
        g[k] = r ? r.perms[k] : !!state.defaultPerms[k];
      }
    }
    if (open) g.grantable = [];
    else if (admin) g.grantable = state.roles.map((r) => r.id);
    else if (!g.manageRoles) g.grantable = [];
    else g.grantable = [...new Set([...(state.defaultPerms.manageRoles ? state.defaultGrantable : []), ...held.flatMap((r) => r.grantable)])];
    g.channels = {};
    for (const ch of state.channels) {
      let c = { view: true, send: true, manage: true };
      if (!open && !admin) {
        const pick = (k, base) => {
          const ov = ch.overrides;
          if (!ov) return base;
          for (const r of held) if (Object.hasOwn(ov, r.id) && typeof ov[r.id][k] === 'boolean') return ov[r.id][k];
          if (Object.hasOwn(ov, 'everyone') && typeof ov.everyone[k] === 'boolean') return ov.everyone[k];
          return base;
        };
        const view = pick('view', g.view);
        c = { view, send: view && pick('send', g.send), manage: view && pick('manage', g.manageChannels) };
      }
      if (c.view) g.channels[ch.id] = c;
    }
    return g;
  }
  const canView = (pid, cid) => !!permsOf(pid).channels[cid]?.view;
  // The actor of an action is { profileId } (the app) or { dashboard: true } (the admin dashboard, which may do anything valid)
  const isDash = (actor) => actor?.dashboard === true;
  const noPerm = (what) => ({ error: `You don’t have permission to ${what}` });
  // null when the actor holds `key`, else the { error } to answer with
  const need = (actor, key, what) => (isDash(actor) || (typeof actor?.profileId === 'string' && permsOf(actor.profileId)[key]) ? null : noPerm(what));
  // Nobody but an admin acts on an admin
  const touchable = (actor, targetPid) => isDash(actor) || !isAdminPid(targetPid) || isAdminPid(actor.profileId);
  const ADMIN_TARGET = { error: 'Only an administrator can do that to an administrator' };

  function cleanProfile(p = {}) {
    const pid = str(p.id, 64) || id();
    return {
      id: pid,
      card: cleanCard(p.card, pid),
      name: str(p.name, 32).trim() || 'anon',
      color: isHexColor(p.color) ? p.color : '#8b6cf6',
      avatar: isImageRef(p.avatar, MAX_AVATAR_BYTES) ? p.avatar : str(p.avatar, 16), // image or emoji
      banner: isImageRef(p.banner, MAX_BANNER_BYTES) || isHexColor(p.banner) ? p.banner : '', // profile background: image or color
      status: str(p.status, 64),
    };
  }
  // `seen`: when the profile was last online (the member list's "Offline" section)
  const storedProfile = (p, seen = Date.now()) => ({ name: p.name, color: p.color, avatar: p.avatar, banner: p.banner, status: p.status, card: p.card, seen });

  // The messages of a text channel; null if there's no such channel
  function thread(cid) {
    const ch = channel(cid);
    if (!ch || ch.type !== 'text') return null;
    return (state.messages[cid] ||= []);
  }

  // ---------- mentions ----------

  // Who a message mentions: { users: [profileId], roles: [roleId], everyone: true }, empty parts left out
  // (null when nobody). Same rules as findMentions() in public/js/util.js, which is an ES module
  // the server can't import, so keep the two in step: '@' at the start or after whitespace, then a
  // name (case-insensitive, may have spaces), then the end or a char outside [\w-]; longest name
  // wins; code spans are ignored. Replying to someone mentions them.
  function mentionsOf(text, replied, senderId) {
    // Code is blanked to the same length, so positions still point into the stored text
    const plain = text.replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => ' '.repeat(m.length));
    // Without the permission a mention of roles or @everyone is plain text: no spans either
    const may = permsOf(senderId);
    const names = may.mentionEveryone ? [{ name: 'everyone', kind: 'everyone', id: '' }] : [];
    if (may.mentionRoles) for (const r of state.roles) names.push({ name: r.name, kind: 'role', id: r.id });
    // People also answer to name#tag, which tells apart people with the same name
    for (const [pid, p] of Object.entries(state.profiles)) if (p.name) names.push({ name: p.name, kind: 'user', id: pid }, { name: `${p.name}#${mentionTag(pid)}`, kind: 'user', id: pid });
    names.sort((a, b) => b.name.length - a.name.length);
    const users = new Set();
    const roles = new Set();
    const spans = []; // [at, length, kind, id]: lets clients draw a mention with the current name
    let everyone = false;
    for (let i = plain.indexOf('@'); i >= 0; i = plain.indexOf('@', i + 1)) {
      if (i > 0 && !/\s/.test(plain[i - 1])) continue;
      const fits = (n) => plain.slice(i + 1, i + 1 + n.name.length).toLowerCase() === n.name.toLowerCase() && !/[\w-]/.test(plain[i + 1 + n.name.length] || '');
      const hit = names.find(fits);
      if (!hit) continue;
      // An untagged name more than one person has mentions all of them
      for (const n of names.filter((n) => n.name.length === hit.name.length && fits(n))) {
        if (n.kind === 'everyone') everyone = true;
        else (n.kind === 'role' ? roles : users).add(n.id);
        spans.push([i, 1 + n.name.length, n.kind, n.id]);
      }
    }
    if (replied && replied.author !== senderId) users.add(replied.author);
    users.delete(senderId);
    if (!users.size && !roles.size && !everyone && !spans.length) return null;
    const out = {};
    if (users.size) out.users = [...users];
    if (roles.size) out.roles = [...roles];
    if (everyone) out.everyone = true;
    if (spans.length) out.spans = spans;
    return out;
  }

  // Same as mentionTag() in public/js/util.js: a short tag from a profile id
  function mentionTag(id) {
    let h = 0;
    for (const ch of String(id)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0; // spread it, so similar ids get unlike tags
    h = (h ^ (h >>> 16)) >>> 0;
    return (h % 1679616).toString(36).padStart(4, '0');
  }

  // ---------- channel links, message links, search ----------

  // The text channels a message links with #name: [[at, length, channelId]], positions in `text`
  // like the mention spans, so clients draw each with today's name (null when none). Only channels
  // the sender can read. Same rules as mentions, and as formatText()'s `channels` in util.js:
  // '#' at the start or after whitespace, then a name, then the end or a char outside [\w-].
  function channelLinksOf(text, senderId) {
    if (!text.includes('#')) return null;
    const plain = text.replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => ' '.repeat(m.length));
    const may = permsOf(senderId).channels;
    const names = state.channels.filter((c) => c.type === 'text' && c.name && may[c.id]?.view).sort((a, b) => b.name.length - a.name.length);
    const spans = [];
    for (let i = plain.indexOf('#'); i >= 0; i = plain.indexOf('#', i + 1)) {
      if (i > 0 && !/\s/.test(plain[i - 1])) continue;
      const hit = names.find((c) => plain.slice(i + 1, i + 1 + c.name.length).toLowerCase() === c.name.toLowerCase() && !/[\w-]/.test(plain[i + 1 + c.name.length] || ''));
      if (hit) spans.push([i, 1 + hit.name.length, hit.id]);
    }
    return spans.length ? spans : null;
  }

  // What a link to a message shows (D54): a short preview, only for someone who can read the
  // channel. One answer for "no such message" and "not for you".
  function peekMessage(pid, channelId, messageId) {
    const cid = str(channelId, 64);
    const mid = str(messageId, 64);
    const m = cid && mid && canView(pid, cid) && thread(cid)?.find((x) => x.id === mid);
    if (!m) return { error: 'unavailable' };
    return {
      message: { id: m.id, channelId: cid, channelName: channel(cid).name, author: m.author, name: m.name, text: String(m.text || '').slice(0, 300), ts: m.ts, gif: m.gif ? true : undefined, files: m.files?.length || undefined },
    };
  }

  // The text around a match, on one line. snippetAround() in public/js/util.js is the same.
  function snippetAround(text, at, len) {
    const from = Math.max(0, at - 40);
    const to = Math.min(text.length, at + len + 120);
    return (from > 0 ? '…' : '') + text.slice(from, to).replace(/\s+/g, ' ').trim() + (to < text.length ? '…' : '');
  }

  // What `has:` in a search can ask for. hasKind() in public/js/main.js is the same.
  const SEARCH_HAS = ['file', 'image', 'gif', 'link'];
  const hasKind = (m, k) =>
    k === 'gif' ? !!m.gif : k === 'link' ? /https?:\/\//.test(m.text || '') : Array.isArray(m.files) && (k === 'image' ? m.files.some((f) => /^image\//.test(f?.type || '')) : m.files.length > 0);

  // Messages whose text or file names contain `q`, newest first, in the text channels `pid` can
  // read (or just the one). f narrows it: { from: [profileId], before, after (times), has: [kind] }
  function searchMessages(pid, q, channelId, f) {
    const may = permsOf(pid).channels;
    const hits = [];
    for (const ch of state.channels) {
      if (ch.type !== 'text' || !may[ch.id]?.view || (channelId && ch.id !== channelId)) continue;
      for (const m of state.messages[ch.id] || []) {
        if ((f.from.length && !f.from.includes(m.author)) || (f.before != null && !(m.ts < f.before)) || (f.after != null && !(m.ts >= f.after)) || !f.has.every((k) => hasKind(m, k))) continue;
        const text = typeof m.text === 'string' ? m.text : '';
        const at = text.toLowerCase().indexOf(q); // 0 for a search by filters alone
        const file = at < 0 && Array.isArray(m.files) && m.files.find((f) => typeof f?.name === 'string' && f.name.toLowerCase().includes(q));
        if (at >= 0 || file) hits.push({ channelId: ch.id, id: m.id, author: m.author, name: m.name, ts: m.ts, text: snippetAround(text, Math.max(0, at), at < 0 ? 0 : q.length), file: file ? file.name : undefined });
      }
    }
    hits.sort((a, b) => b.ts - a.ts);
    return { results: hits.slice(0, MAX_SEARCH_RESULTS), more: hits.length > MAX_SEARCH_RESULTS };
  }

  // ---------- bans ----------

  // Bans match the profile id and, optionally, the IP it last connected from.
  // Identities are spoofable (D3), so this keeps out a friend who's not
  // welcome any more, not a determined attacker (D27).
  const clientIp = (socket) => String(socket.handshake.address || '').replace(/^::ffff:/, '');
  const isLoopback = (ip) => ip === '::1' || ip.startsWith('127.');
  const lastIp = new Map(); // profileId -> IP, for banning people who already left (memory only)
  const banFor = (pid, ip) => state.bans.find((b) => b.profileId === pid || (b.ip && b.ip === ip));
  const publicBans = () => state.bans.map(({ ip, ...b }) => ({ ...b, ip: !!ip }));

  // ---------- uploaded files ----------

  // Files live in DATA_DIR/files/<id>; metadata lives in state.files. A file
  // is uploaded over HTTP first (unattached), then attached by msg:send.
  // Unattached uploads (the send never happened) are swept after an hour.
  const fileById = (fid) => state.files.find((f) => f.id === fid);
  const filePath = (fid) => path.join(FILES_DIR, fid);
  let reserved = 0; // bytes of uploads in progress
  const usedBytes = () => state.files.reduce((n, f) => n + f.size, 0);
  const usage = () => ({ used: usedBytes(), max: MAX_STORAGE });
  const publicFile = ({ id: fid, name, size, type, channelId, messageId, by, byName, ts }) => ({ id: fid, name, size, type, channelId, messageId, by, byName, ts });

  function sweepFiles() {
    const cutoff = Date.now() - 60 * 60e3;
    const stale = state.files.filter((f) => !f.messageId && f.ts < cutoff);
    if (stale.length) {
      state.files = state.files.filter((f) => !stale.includes(f));
      for (const f of stale) fs.rm(filePath(f.id), { force: true }, () => {});
      save();
    }
    // Leftovers on disk that no metadata points to (e.g. interrupted uploads)
    const known = new Set(state.files.map((f) => f.id));
    for (const name of fs.readdirSync(FILES_DIR)) {
      if (known.has(name)) continue;
      const full = path.join(FILES_DIR, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff || !name.endsWith('.part')) fs.rmSync(full, { force: true });
      } catch {}
    }
  }
  sweepFiles();
  const sweepTimer = setInterval(sweepFiles, 10 * 60e3);
  sweepTimer.unref();

  // Types that are safe to show inline from this origin. Everything else is
  // served as a download so an uploaded .html or .svg can't run script here.
  const INLINE_TYPES =
    /^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/(mp4|webm|ogg|quicktime)|audio\/(mpeg|mp3|ogg|wav|x-wav|wave|webm|mp4|aac|flac|x-flac|x-m4a)|text\/plain)$/;

  // ---------- http ----------

  const app = express();
  // The server hosts no chat UI: the client ships only in the desktop app (D26).
  // The admin dashboard is the one exception (D34), at a path of its own (D52).
  app.get('/', (_req, res) => res.type('text/plain').send('This is a friendspeak server. Connect to it with the friendspeak desktop app.\n'));
  // `password`: apps from before invites ask for one when it is set, and send what was typed as the invite
  app.get('/api/info', (_req, res) => res.json({ name: state.name, icon: state.icon, invite: state.inviteOnly, password: state.inviteOnly, version: VERSION }));

  // Clients are often served from another origin (desktop app, another server),
  // and authenticate uploads with their socket id, never cookies, so * is fine.
  const cors = (res) =>
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type, x-friendspeak-sid, x-file-name',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
  app.options('/api/files', (_req, res) => cors(res).sendStatus(204));

  // Upload one file: raw body, name in x-file-name (URI-encoded), uploader
  // identified by x-friendspeak-sid (a socket that passed `hello`).
  app.post('/api/files', (req, res) => {
    cors(res);
    const u = users.get(String(req.get('x-friendspeak-sid') || ''));
    if (!u) return res.status(401).json({ error: 'Not connected to this server' });
    const ch = channel(String(req.query.channelId || ''));
    if (!ch || ch.type !== 'text') {
      console.warn(`[files] upload by ${whoIs(u.profile)} refused: no such text channel`);
      return res.status(400).json({ error: 'No such channel' });
    }
    if (!permsOf(u.profile.id).channels[ch.id]?.send) {
      console.warn(`[files] upload by ${whoIs(u.profile)} refused: no permission to send in #${ch.name}`);
      return res.status(403).json({ error: noPerm('send messages here').error });
    }
    const size = Number(req.get('content-length'));
    if (!Number.isInteger(size) || size <= 0) {
      console.warn(`[files] upload by ${whoIs(u.profile)} refused: empty or unsized body`);
      return res.status(400).json({ error: 'Empty file' });
    }
    const free = MAX_STORAGE - usedBytes() - reserved;
    if (size > free) {
      console.warn(`[files] upload by ${whoIs(u.profile)} refused: ${size} bytes, only ${Math.max(0, free)} free of ${MAX_STORAGE}`);
      return res.status(413).json({ error: `Not enough storage on this server (${fmtBytes(Math.max(0, free))} free)` });
    }
    let name;
    try {
      name = decodeURIComponent(String(req.get('x-file-name') || ''));
    } catch {
      name = '';
    }
    name = name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim().slice(0, 200) || 'file';
    const type = String(req.get('content-type') || '').toLowerCase().split(';')[0].trim();

    const fid = crypto.randomBytes(16).toString('hex'); // unguessable: the URL is the capability
    const tmp = filePath(fid) + '.part';
    reserved += size;
    let got = 0;
    let finished = false;
    const finish = (err) => {
      if (finished) return;
      finished = true;
      reserved -= size;
      if (!err && got !== size) err = new Error('Upload was cut short');
      if (!err) {
        try {
          fs.renameSync(tmp, filePath(fid));
        } catch (e) {
          err = Object.assign(new Error('Could not store the file'), { status: 500, cause: e });
        }
      }
      if (err) {
        console.warn(`[files] upload by ${whoIs(u.profile)} failed: ${err.cause ? err.cause.message : err.message} (${got} of ${size} bytes)`);
        fs.rm(tmp, { force: true }, () => {});
        if (!res.headersSent) res.status(err.status || 400).json({ error: err.message });
        return;
      }
      const f = {
        id: fid,
        name,
        size,
        type: /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : 'application/octet-stream',
        channelId: ch.id,
        messageId: null,
        by: u.profile.id,
        byName: u.profile.name,
        ts: Date.now(),
      };
      state.files.push(f);
      save();
      res.json({ ok: true, file: publicFile(f) });
    };
    req.on('data', (chunk) => {
      got += chunk.length;
      if (got > size) req.destroy(Object.assign(new Error('File is larger than announced'), { status: 413 }));
    });
    pipeline(req, fs.createWriteStream(tmp), finish);
  });

  app.get('/files/:id/:name', (req, res) => {
    const f = fileById(req.params.id);
    if (!f || !f.messageId) return res.sendStatus(404);
    const inline = !('download' in req.query) && INLINE_TYPES.test(f.type);
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    res.type(inline ? f.type : 'application/octet-stream');
    res.sendFile(f.id, { root: FILES_DIR }, (err) => err && !res.headersSent && res.sendStatus(404));
  });

  async function createServer() {
    if (!USE_HTTPS) return http.createServer(app);
    const keyFile = path.join(DATA_DIR, 'key.pem');
    const certFile = path.join(DATA_DIR, 'cert.pem');
    if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
      const selfsigned = require('selfsigned');
      const now = new Date();
      const pems = await selfsigned.generate([{ name: 'commonName', value: 'friendspeak' }], {
        keySize: 2048,
        algorithm: 'sha256',
        notBeforeDate: now,
        notAfterDate: new Date(now.getTime() + 10 * 365 * 864e5),
      });
      fs.writeFileSync(keyFile, pems.private);
      fs.writeFileSync(certFile, pems.cert);
    }
    const cert = fs.readFileSync(certFile);
    fingerprint = new crypto.X509Certificate(cert).fingerprint256;
    return https.createServer({ key: fs.readFileSync(keyFile), cert }, app);
  }

  // ---------- DM mailboxes (D32) ----------

  // Messages for people who are away, left by their friends. Each is sealed
  // end to end, so the server stores it without being able to read it. A
  // mailbox is filed under the hash of its owner's public key, and only
  // someone who proves they hold that key gets its contents.
  // address -> { seen, items: [{ id, blob, ts }] }
  let mail = new Map();
  try {
    mail = new Map(Object.entries(JSON.parse(fs.readFileSync(MAIL_FILE, 'utf8'))));
  } catch {}
  let mailTimer = null;
  let closing = false; // close() was called: sockets are going away with the server
  function writeMail() {
    clearTimeout(mailTimer);
    mailTimer = null;
    const tmp = MAIL_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(mail)));
    fs.renameSync(tmp, MAIL_FILE);
  }
  const saveMail = () =>
    (mailTimer ||= setTimeout(() => {
      try {
        writeMail();
      } catch (err) {
        saveFailed('the mailboxes', err);
      }
    }, 1000));
  function sweepMail() {
    const now = Date.now();
    for (const [addr, box] of mail) {
      const kept = box.items.filter((it) => it.ts > now - MAIL_TTL);
      if (kept.length !== box.items.length) (box.items = kept), saveMail();
      if (!kept.length && box.seen < now - MAILBOX_IDLE) mail.delete(addr), saveMail();
    }
  }
  sweepMail();
  const mailSweepTimer = setInterval(sweepMail, 60 * 60e3);
  mailSweepTimer.unref();

  // The address (mailbox name) of whoever signed `nonce` with the Ed25519 key `s`, or null
  const mailAddress = (s, sig, nonce) =>
    verifySig(s, sig, 'friendspeak-dm-auth-v1|' + nonce) ? crypto.createHash('sha256').update(Buffer.from(s, 'base64url')).digest('base64url') : null;

  // ---------- realtime ----------

  // socket.id -> { profile, voice: channelId|null, muted, deafened, sharing, camera, since, ip }
  // (`since` and `ip` are for the admin dashboard only; userList() never sends them)
  const users = new Map();
  usersRef = users;
  // On a crash: what close() would write, each in its own try
  crashState.saveNow = () => {
    try {
      writeState();
    } catch {}
    try {
      if (mailTimer) writeMail();
    } catch {}
  };
  // Who an action is credited to in the log: a member, or the dashboard (with the key that signed in)
  const actorName = (actor) => (isDash(actor) ? 'Admin dashboard' + (actor.label ? ` (${String(actor.label).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 40)})` : '') : whoIs({ ...state.profiles[actor?.profileId], id: actor?.profileId }));

  // Everyone online. `g`: the perms of whoever this is for; a voice channel they can't see is left out.
  // A force-muted person is muted whatever they send, unless they may lift it themselves.
  function userList(g) {
    return [...users.entries()].map(([sid, { profile: { banner, ...profile }, ...u }]) => {
      const forceMuted = state.forceMuted.includes(profile.id);
      return {
        sid,
        ...profile, // minus the banner: this is re-sent on every mute toggle; clients get banners from `profiles`
        voice: !g || !u.voice || g.channels[u.voice]?.view ? u.voice : null,
        muted: u.muted || (forceMuted && !permsOf(profile.id).forceMute),
        forceMuted,
        deafened: u.deafened,
        sharing: u.sharing,
        camera: u.camera,
        playing: u.playing,
      };
    });
  }

  // A hand-edited state.json may hold anything
  const audioQuality = () => (AUDIO_QUALITIES.includes(state.audioQuality) ? state.audioQuality : 'max');

  // The channels `g` can see; they carry their permission overrides
  const channelsFor = (g) => state.channels.filter((c) => g.channels[c.id]);

  function publicState(g) {
    return {
      id: state.id,
      name: state.name,
      icon: state.icon,
      audioQuality: audioQuality(),
      channels: channelsFor(g),
      emojis: state.emojis,
      profiles: state.profiles,
      bans: publicBans(),
      roles: state.roles,
      memberRoles: state.memberRoles,
      defaultPerms: state.defaultPerms,
      defaultGrantable: state.defaultGrantable,
      permissionsOn: state.permissionsOn,
      forceMuted: state.forceMuted,
      inviteOnly: state.inviteOnly,
      storage: usage(),
      game: gameInfo(),
      update: updater.info(),
    };
  }

  // `available`: built, has assets and started. `enabled`: switched on in Settings → Server.
  function gameInfo() {
    const g = gameRef.current;
    return g
      ? { available: !!g.available, enabled: !!g.available && state.gameEnabled !== false, reason: g.reason, world: g.worldName }
      : { available: false, enabled: false, reason: 'Starting…' };
  }

  const gameRef = { current: null };

  function attach(server) {
    const io = new Server(server, {
      cors: { origin: '*' }, // clients connect from the desktop app's friendspeak:// origin
      serveClient: false, // the desktop app bundles socket.io.js itself
      maxHttpBufferSize: 4e6, // hello/profile:update carry the avatar and background images
      destroyUpgrade: false, // the game worlds share this http server on other paths
    });

    const rolesPayload = () => ({ roles: state.roles, memberRoles: state.memberRoles, defaultPerms: state.defaultPerms, defaultGrantable: state.defaultGrantable, permissionsOn: state.permissionsOn });
    // '' when it isn't 1 to 32 characters once control characters are gone and it's trimmed
    const cleanRoleName = (v) => {
      const n = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
      return n.length <= MAX_ROLE_NAME ? n : '';
    };
    // A role's explicit settings from a request: key -> true|false, null (or missing) = inherit
    function cleanPerms(raw) {
      if (!isObj(raw)) return { error: 'Permissions must be an object' };
      const perms = {};
      for (const k of PERM_KEYS) {
        if (!Object.hasOwn(raw, k) || raw[k] === null) continue;
        if (typeof raw[k] !== 'boolean') return { error: `Permission ${k} must be true, false or null` };
        if (k !== 'admin' || raw[k]) perms[k] = raw[k];
      }
      return { perms };
    }
    function cleanGrantable(raw) {
      if (!Array.isArray(raw)) return { error: 'Grantable roles must be a list' };
      return { grantable: cleanIdList(raw, new Set(state.roles.map((r) => r.id))) };
    }
    const isColor = (v) => typeof v === 'string' && isHexColor(v);
    const roleNamed = (name, except) => state.roles.some((r) => r !== except && r.name.toLowerCase() === name.toLowerCase());

    // `users` goes out per socket: voice channels a socket can't see are left out
    const broadcastUsers = () => {
      for (const [sid, u] of users) io.to(sid).emit('users', userList(permsOf(u.profile.id)));
      adminRef.current?.notify('users');
    };

    // Send an event for a channel only to the sockets that can see it
    const toViewers = (cid, event, payload, exceptSid) => {
      for (const [sid, u] of users) if (sid !== exceptSid && canView(u.profile.id, cid)) io.to(sid).emit(event, payload);
    };

    // Something changed who can do or see what (roles, role holders, default or channel permissions,
    // or the channels themselves): tell everyone, take people out of voice channels they lost, and
    // turn permissions on the first time someone is an administrator.
    function permsChanged({ roles = true } = {}) {
      if (!state.permissionsOn && (state.defaultPerms.admin || Object.keys(state.memberRoles).some(holdsAdminRole))) state.permissionsOn = true;
      save();
      if (roles) io.emit('roles', rolesPayload());
      for (const [sid, u] of users) {
        const s = io.sockets.sockets.get(sid);
        if (!s) continue;
        const g = permsOf(u.profile.id);
        s.emit('perms', g);
        s.emit('channels', channelsFor(g));
        if (u.voice && !g.channels[u.voice]?.send) {
          leaveVoice(s);
          s.emit('voice:kicked', { reason: 'perms' });
        }
      }
      broadcastUsers();
    }

    // The invite list changed: tell the sockets that may see it (nobody else is sent any of it)
    function invitesChanged() {
      for (const [sid, u] of users) {
        const g = permsOf(u.profile.id);
        if (g.createInvites) io.to(sid).emit('invites', { invites: publicInvites(g.admin, u.profile.id) });
      }
    }

    // Disconnect every chat and DM-signaling socket that matches, telling it why
    // ('banned' or 'removed'). Clients don't auto-reconnect after this.
    function kick(match, reason) {
      for (const s of [...io.sockets.sockets.values(), ...dm.sockets.values()]) {
        if (!match(s)) continue;
        if (users.has(s.id)) {
          leaveVoice(s);
          users.delete(s.id);
        }
        s.emit(reason);
        s.disconnect(true);
      }
      broadcastUsers();
    }

    // --- DM signaling and mailboxes (D28, D32) ---
    // Direct messages are peer to peer. Clients keep a socket on this
    // namespace for every server they have bookmarked, so friends who share
    // any server can find each other. The server says who is reachable,
    // relays WebRTC handshakes, and keeps sealed mail for people who are away.
    // It never sees a message.
    //
    // Members are the profiles that joined (with an invite, when the server asks
    // for one, D51). Guests are everyone else, sent here by a friend's friend
    // code. They can reach the people whose profile id or mailbox address
    // they already know, and nothing else: no member list, no mailbox.
    const dm = io.of('/dm');
    const dmOnline = () => [...new Set([...dm.sockets.values()].filter((s) => s.data.verified).map((s) => s.data.profileId))];
    const presenceRooms = (pid) => ['members', 'w:' + pid];
    dm.use((socket, next) => {
      const { profileId, guest } = socket.handshake.auth || {};
      const pid = str(profileId, 64);
      // On an invite-only server a member is a profile that joined and has a key pinned,
      // which it proves in `identify` below; nothing a socket says here makes it one
      const outsider = state.inviteOnly && !(pid && Object.hasOwn(state.profiles, pid) && pinOf(pid));
      // A guest can't use the profile id of someone on this server. ("password": apps from before invites stop retrying on it.)
      if (outsider && !(DM_GUESTS && guest === true && pid && !Object.hasOwn(state.profiles, pid) && !pinOf(pid))) return next(new Error('Not a member of this server (no valid invite or password)'));
      if (!pid) return next(new Error('No profile'));
      if (banFor(pid, clientIp(socket))) return next(new Error('banned'));
      socket.data.profileId = pid;
      socket.data.guest = outsider;
      socket.data.mustProve = state.inviteOnly && !outsider;
      next();
    });
    dm.on('connection', (socket) => {
      const pid = socket.data.profileId;
      const guest = socket.data.guest;
      // A profile id with a key pinned here (D42) is only someone once they sign
      // the challenge below with that key. Until then the socket can use
      // mailboxes, but it isn't present, can't signal and replaces no one.
      const arrive = () => {
        socket.data.verified = true;
        // Newest wins, like chat sessions: a reconnect replaces the stale socket
        for (const s of dm.sockets.values()) if (s !== socket && s.data.profileId === pid) s.disconnect(true);
        socket.join('p:' + pid);
        if (!guest) {
          socket.join('members');
          socket.emit('online', dmOnline());
        }
        socket.to(presenceRooms(pid)).emit('presence', { id: pid, online: true });
      };
      if (!pinOf(pid)) arrive();
      socket.on('signal', ({ to, data } = {}) => {
        to = str(to, 64);
        if (socket.data.verified && to && to !== pid && data && typeof data === 'object') dm.to('p:' + to).emit('signal', { from: pid, data });
      });
      // Guests name the people they want presence for
      socket.on('watch', (ids, ack) => {
        if (typeof ack !== 'function') return;
        if (!socket.data.verified) return ack({ online: [] });
        const list = [...new Set((Array.isArray(ids) ? ids : []).slice(0, 200).map((v) => str(v, 64)).filter(Boolean))];
        for (const room of socket.rooms) if (room.startsWith('w:')) socket.leave(room);
        for (const v of list) socket.join('w:' + v);
        const online = dmOnline();
        ack({ online: list.filter((v) => online.includes(v)) });
      });

      // Mailboxes: prove who you are by signing this nonce
      const nonce = crypto.randomBytes(16).toString('base64url');
      socket.emit('challenge', { nonce, server: state.id });
      socket.on('identify', ({ s, sig } = {}, ack) => {
        if (typeof ack !== 'function') return;
        const addr = mailAddress(str(s, 64), str(sig, 128), nonce);
        if (!addr) return ack({ error: 'Bad signature' });
        if (!socket.data.verified && s === pinOf(pid)) arrive();
        if (socket.data.addr) socket.leave('a:' + socket.data.addr);
        socket.data.addr = addr;
        socket.join('a:' + addr);
        // A claimed member of an invite-only server has a mailbox once the pinned key has signed
        const member = !guest && (!socket.data.mustProve || socket.data.verified);
        let box = member ? mail.get(addr) : null;
        if (member && !box && mail.size < MAX_MAILBOXES) mail.set(addr, (box = { seen: 0, items: [] }));
        if (box) {
          box.seen = Date.now();
          saveMail();
          for (let i = 0; i < box.items.length; i += 20) socket.emit('mail', box.items.slice(i, i + 20).map(({ id, blob }) => ({ id, blob })));
        }
        ack({ ok: true, mailbox: !!box });
      });
      socket.on('mail:put', ({ to, blob } = {}, ack) => {
        if (typeof ack !== 'function') return;
        if (!isKey(to, 43) || typeof blob !== 'string' || !blob || blob.length > MAX_MAIL_BLOB) return ack({ error: 'Bad mail' });
        const now = Date.now();
        if (now - (socket.data.mailFrom || 0) > 60e3) Object.assign(socket.data, { mailFrom: now, mailCount: 0 });
        if (++socket.data.mailCount > 240) return ack({ error: 'Too much mail, slow down' });
        const box = mail.get(to);
        // No mailbox here (a guest, or someone who never came by): pass it on if they're connected
        if (!box) {
          if (!dm.adapter.rooms.get('a:' + to)?.size) return ack({ error: 'No mailbox' });
          dm.to('a:' + to).emit('mail', [{ id: null, blob }]);
          return ack({ ok: true });
        }
        if (box.items.length >= MAX_MAILBOX_ITEMS || box.items.reduce((n, it) => n + it.blob.length, blob.length) > MAX_MAILBOX_BYTES) return ack({ error: 'Mailbox full' });
        const item = { id: id(), blob, ts: now };
        box.items.push(item);
        saveMail();
        dm.to('a:' + to).emit('mail', [{ id: item.id, blob }]);
        ack({ ok: true });
      });
      // A message link in a DM (D54): its preview, for a member who can read the channel
      socket.on('msg:peek', ({ channelId, messageId } = {}, ack) => {
        if (typeof ack !== 'function') return;
        if (!socket.data.verified || guest || !Object.hasOwn(state.profiles, pid)) return ack({ error: 'unavailable' });
        ack(peekMessage(pid, channelId, messageId));
      });
      // Collected: the owner has it now
      socket.on('mail:ack', ({ ids } = {}) => {
        const box = mail.get(socket.data.addr);
        if (guest || !box || !Array.isArray(ids)) return;
        const gone = new Set(ids);
        const kept = box.items.filter((it) => !gone.has(it.id));
        if (kept.length !== box.items.length) (box.items = kept), saveMail();
      });
      socket.on('disconnect', () => {
        // Shutting down disconnects everyone: that's not them leaving, and
        // their direct connections don't need this server (D39)
        if (closing || !socket.data.verified) return;
        if (!dmOnline().includes(pid)) dm.to(presenceRooms(pid)).emit('presence', { id: pid, online: false });
      });
    });

    // Delete files from disk and state, and drop them from their messages
    // (a message left with nothing in it is deleted too).
    function deleteFiles(ids) {
      ids = new Set(ids);
      const gone = state.files.filter((f) => ids.has(f.id));
      if (!gone.length) return;
      state.files = state.files.filter((f) => !ids.has(f.id));
      for (const f of gone) {
        fs.rm(filePath(f.id), { force: true }, () => {});
        const list = state.messages[f.channelId] || [];
        const i = list.findIndex((m) => m.id === f.messageId);
        const m = list[i];
        if (!m?.files) continue;
        m.files = m.files.filter((x) => x.id !== f.id);
        if (!m.text && !m.gif && !m.files.length) {
          list.splice(i, 1);
          toViewers(f.channelId, 'msg:deleted', { channelId: f.channelId, messageId: m.id });
        } else toViewers(f.channelId, 'msg:update', { channelId: f.channelId, message: m });
      }
      save();
      io.emit('files:deleted', { ids: gone.map((f) => f.id), storage: usage() });
    }

    function leaveVoice(socket) {
      const u = users.get(socket.id);
      if (!u || !u.voice) return;
      socket.to('voice:' + u.voice).emit('voice:peer-left', { sid: socket.id });
      socket.leave('voice:' + u.voice);
      u.voice = null;
      u.sharing = false;
      u.camera = false;
    }

    // Someone stops being a member (removed, banned or left): their stored profile and role
    // assignments go, so coming back takes an invite again (D51). Their pinned key stays (D42).
    function endMembership(profileId) {
      const hadProfile = Object.hasOwn(state.profiles, profileId);
      const hadRoles = Object.hasOwn(state.memberRoles, profileId);
      if (hadProfile) delete state.profiles[profileId];
      if (hadRoles) delete state.memberRoles[profileId];
      save();
      if (hadProfile) io.emit('profile:removed', { id: profileId });
      if (hadRoles) permsChanged();
    }

    // What people can do to the server, shared by the chat sockets below and the
    // admin dashboard (admin.js). `actor` is { profileId } for the app and
    // { dashboard: true } for the dashboard, which may do anything that is valid.
    // Each returns { ok: true, … } or { error }.
    const actions = {
      // by: who gets the credit; selfIp: the caller's address (never banned along with someone else)
      ban(actor, { profileId, ip, by, selfIp }) {
        const denied = need(actor, 'ban', 'ban members');
        if (denied) return denied;
        profileId = str(profileId, 64);
        if (!profileId || !Object.hasOwn(state.profiles, profileId)) return { error: 'Unknown user' };
        if (actor.profileId && profileId === actor.profileId) return { error: 'You can’t ban yourself' };
        if (!touchable(actor, profileId)) return ADMIN_TARGET;
        if (state.bans.some((b) => b.profileId === profileId)) return { error: 'Already banned' };
        // Skip the IP if it's shared with the person banning (same network,
        // reverse proxy, or the host's own machine): it would ban them too.
        let banIp = ip ? lastIp.get(profileId) || '' : '';
        const ipSkipped = !!ip && (!banIp || banIp === selfIp || isLoopback(banIp));
        if (ipSkipped) banIp = '';
        const ban = { id: id(), profileId, name: state.profiles[profileId].name, ip: banIp, by, ts: Date.now() };
        state.bans.push(ban);
        kick((s) => s.data.profileId === profileId || (banIp && clientIp(s) === banIp), 'banned');
        console.log(`[mod] ${actorName(actor)} banned ${whoIs({ ...state.profiles[profileId], id: profileId })}${banIp ? ' and their IP' : ''}`);
        io.emit('bans', publicBans());
        endMembership(profileId); // unbanned, they need an invite to come back
        return { ok: true, ipSkipped };
      },

      unban(actor, banId) {
        const denied = need(actor, 'ban', 'unban members');
        if (denied) return denied;
        const lifted = state.bans.find((b) => b.id === banId);
        state.bans = state.bans.filter((b) => b.id !== banId);
        save();
        io.emit('bans', publicBans());
        if (lifted) endMembership(lifted.profileId); // a ban from before bans ended membership
        if (lifted) console.log(`[mod] ${actorName(actor)} unbanned ${whoIs({ name: lifted.name, id: lifted.profileId })}`);
        return { ok: true };
      },

      removeMember(actor, { profileId }) {
        const denied = need(actor, 'kick', 'remove members');
        if (denied) return denied;
        profileId = str(profileId, 64);
        if (!profileId || !Object.hasOwn(state.profiles, profileId)) return { error: 'Unknown user' };
        if (actor.profileId && profileId === actor.profileId) return { error: 'You can’t remove yourself' };
        if (!touchable(actor, profileId)) return ADMIN_TARGET;
        kick((s) => s.data.profileId === profileId, 'removed');
        console.log(`[mod] ${actorName(actor)} removed ${whoIs({ ...state.profiles[profileId], id: profileId })} from the server`);
        endMembership(profileId);
        return { ok: true };
      },

      // Name, icon, voice quality and the game: admin only (open mode: anyone, as before).
      // inviteOnly (whether joining takes an invite): an admin or the dashboard, never open mode.
      updateServer(actor, { name, icon, game, audioQuality: quality, inviteOnly }) {
        if (!isDash(actor)) {
          const g = permsOf(actor.profileId);
          if (!g.open && !g.admin) return noPerm('change the server settings');
          if (inviteOnly !== undefined && !g.admin) return noPerm('change who can join');
        }
        if (inviteOnly !== undefined && typeof inviteOnly !== 'boolean') return { error: 'inviteOnly must be true or false' };
        if (name !== undefined) {
          name = str(name, 40).trim();
          if (!name) return { error: 'Server name required' };
          state.name = name;
        }
        if (icon !== undefined) {
          if (icon && !isImageRef(icon, MAX_ICON_BYTES)) return { error: 'Icon must be an https image link, or png/jpg/gif/webp under 512KB' };
          state.icon = icon || '';
        }
        if (quality !== undefined) {
          if (!AUDIO_QUALITIES.includes(quality)) return { error: 'Voice quality must be one of ' + AUDIO_QUALITIES.join(', ') };
          state.audioQuality = quality;
        }
        if (game !== undefined) {
          if (game && !gameRef.current?.available) return { error: gameInfo().reason || 'The game is not available on this server' };
          state.gameEnabled = !!game;
          if (!game) for (const u of users.values()) u.playing = false;
        }
        if (inviteOnly !== undefined) state.inviteOnly = inviteOnly;
        save();
        const what = [name !== undefined && 'name', icon !== undefined && (icon ? 'icon' : 'icon removed'), quality !== undefined && `voice quality ${quality}`, game !== undefined && (game ? 'game on' : 'game off'), inviteOnly !== undefined && (inviteOnly ? 'invites required' : 'invites not required')].filter(Boolean);
        console.log(`[server] ${actorName(actor)} changed the server settings: ${what.join(', ') || 'no change'}`);
        io.emit('server', { name: state.name, icon: state.icon, game: gameInfo(), audioQuality: audioQuality(), inviteOnly: state.inviteOnly });
        if (game === false) broadcastUsers();
        return { ok: true };
      },

      // Forget the key a profile id is pinned to (D42), for someone who lost it:
      // the next hello that signs with any key claims the id. Dashboard only,
      // or anyone could take over anyone's profile.
      resetKey(profileId, dashActor = { dashboard: true }) {
        profileId = str(profileId, 64);
        if (!profileId || !pinOf(profileId)) return { error: 'That profile has no key here' };
        delete state.pins[profileId];
        // The old card would mislead DM contacts until the new key says hello
        if (Object.hasOwn(state.profiles, profileId)) {
          delete state.profiles[profileId].card;
          io.emit('profile', { id: profileId, ...state.profiles[profileId] });
        }
        // Whoever claims the id next must not inherit roles with permissions
        if (Object.hasOwn(state.memberRoles, profileId)) {
          const aesthetic = state.memberRoles[profileId].filter((x) => isAesthetic(state.roles.find((r) => r.id === x)));
          if (aesthetic.length !== state.memberRoles[profileId].length) {
            if (aesthetic.length) state.memberRoles[profileId] = aesthetic;
            else delete state.memberRoles[profileId];
            permsChanged();
          }
        }
        save();
        console.log(`[mod] ${actorName(dashActor)} reset the profile key of ${whoIs({ ...state.profiles[profileId], id: profileId })}`);
        return { ok: true };
      },

      // --- invites (D51) ---

      listInvites(actor) {
        return need(actor, 'createInvites', 'see invites') || { ok: true, invites: publicInvites(isDash(actor) || permsOf(actor.profileId).admin, actor.profileId), inviteOnly: state.inviteOnly };
      },

      // maxUses: how many people it lets in (null: any number). expiresIn: ms from now (null: never).
      // Neither: it works until it is revoked.
      createInvite(actor, { label, maxUses = null, expiresIn = null } = {}) {
        const denied = need(actor, 'createInvites', 'create invites');
        if (denied) return denied;
        if (label !== undefined && typeof label !== 'string') return { error: 'The note must be text' };
        if (maxUses !== null && !(Number.isInteger(maxUses) && maxUses >= 1 && maxUses <= MAX_INVITE_USES)) return { error: `Uses must be a whole number from 1 to ${MAX_INVITE_USES}` };
        if (expiresIn !== null && !(Number.isFinite(expiresIn) && expiresIn >= 60e3 && expiresIn <= MAX_INVITE_AGE)) return { error: 'An invite can last from a minute to a year' };
        // Room for it: invites that no longer work go first, oldest first
        while (state.invites.length >= MAX_INVITES) {
          const i = state.invites.findIndex((v) => inviteStatus(v) !== 'active');
          if (i < 0) return { error: `This server has ${MAX_INVITES} working invites. Revoke one first.` };
          state.invites.splice(i, 1);
        }
        const by = isDash(actor) ? { id: null, name: actorName(actor) } : { id: actor.profileId, name: state.profiles[actor.profileId]?.name || 'anon' };
        const { invite, token } = addInvite({ label: cleanLabel(label), maxUses, expires: expiresIn === null ? null : Date.now() + Math.round(expiresIn), by });
        save();
        invitesChanged();
        console.log(`[mod] ${actorName(actor)} created invite ${invite.id.slice(0, 8)}: ${maxUses === null ? 'any number of uses' : maxUses === 1 ? 'one use' : maxUses + ' uses'}, ${expiresIn === null ? 'no end date' : 'expires ' + new Date(invite.expires).toISOString()}`);
        const { hash, ...pub } = invite;
        return { ok: true, invite: pub, token }; // `token` on its own too: what apps from before tokens were listed read
      },

      // A working invite is revoked and stays listed (with who joined); one that no longer works is
      // taken off the list. Other people's invites: an admin or the dashboard.
      removeInvite(actor, inviteId) {
        const denied = need(actor, 'createInvites', 'revoke invites');
        if (denied) return denied;
        const i = state.invites.findIndex((v) => v.id === inviteId);
        if (i < 0) return { error: 'No such invite' };
        const invite = state.invites[i];
        if (!isDash(actor) && invite.by.id !== actor.profileId && !permsOf(actor.profileId).admin) return noPerm('revoke an invite someone else made');
        const revoked = inviteStatus(invite) === 'active';
        if (revoked) invite.revoked = { ts: Date.now(), by: isDash(actor) ? actorName(actor) : state.profiles[actor.profileId]?.name || 'anon' };
        else state.invites.splice(i, 1);
        save();
        invitesChanged();
        console.log(`[mod] ${actorName(actor)} ${revoked ? 'revoked' : 'removed'} invite ${invite.id.slice(0, 8)}`);
        return { ok: true, revoked };
      },

      // --- roles and permissions ---

      // The app can only touch roles once someone is an administrator (until then they are set up in
      // the dashboard); after that it takes manageRoles. null when allowed.
      roleGate(actor) {
        if (isDash(actor)) return null;
        if (!state.permissionsOn) return { error: OPEN_ROLES_ERROR };
        return need(actor, 'manageRoles', 'manage roles');
      },

      createRole(actor, { name, color, perms, grantable } = {}) {
        const denied = actions.roleGate(actor);
        if (denied) return denied;
        name = cleanRoleName(name);
        if (!name) return { error: `Role name must be 1 to ${MAX_ROLE_NAME} characters` };
        if (!isColor(color)) return { error: 'Color must look like #8b6cf6' };
        if (roleNamed(name)) return { error: 'A role with that name already exists' };
        if (state.roles.length >= MAX_ROLES) return { error: `At most ${MAX_ROLES} roles` };
        const p = perms === undefined ? { perms: {} } : cleanPerms(perms);
        if (p.error) return p;
        const gr = grantable === undefined ? { grantable: [] } : cleanGrantable(grantable);
        if (gr.error) return gr;
        if ((Object.keys(p.perms).length || gr.grantable.length) && !isDash(actor) && !permsOf(actor.profileId).admin) return noPerm('give roles permissions');
        const role = { id: id(), name, color: color.toLowerCase(), perms: p.perms, grantable: gr.grantable };
        state.roles.push(role);
        permsChanged();
        console.log(`[mod] ${actorName(actor)} created the role "${role.name}"`);
        return { ok: true, role };
      },

      // position: zero-based index to move the role to. perms: key -> true|false|null (null = inherit),
      // replaces the role's whole set. grantable: role ids it may hand out. Position, perms and
      // grantable are for administrators; others only rename and recolor aesthetic roles.
      updateRole(actor, roleId, { name, color, position, perms, grantable } = {}) {
        const denied = actions.roleGate(actor);
        if (denied) return denied;
        const role = typeof roleId === 'string' && state.roles.find((r) => r.id === roleId);
        if (!role) return { error: 'Unknown role' };
        if (!isDash(actor) && !permsOf(actor.profileId).admin) {
          if (position !== undefined || perms !== undefined || grantable !== undefined) return noPerm('change role permissions or order');
          if (!isAesthetic(role)) return noPerm('edit that role');
        }
        if (name !== undefined) {
          name = cleanRoleName(name);
          if (!name) return { error: `Role name must be 1 to ${MAX_ROLE_NAME} characters` };
          if (roleNamed(name, role)) return { error: 'A role with that name already exists' };
        }
        if (color !== undefined && !isColor(color)) return { error: 'Color must look like #8b6cf6' };
        if (position !== undefined && !Number.isInteger(position)) return { error: 'Position must be a whole number' };
        let newPerms, newGrantable;
        if (perms !== undefined) {
          const p = cleanPerms(perms);
          if (p.error) return p;
          newPerms = p.perms;
        }
        if (grantable !== undefined) {
          const gr = cleanGrantable(grantable);
          if (gr.error) return gr;
          newGrantable = gr.grantable;
        }
        if (newPerms || newGrantable) {
          const after = { perms: newPerms || role.perms, grantable: newGrantable || role.grantable };
          if (!isAesthetic(after)) {
            const pid = Object.keys(state.memberRoles).find((x) => holdsRole(x, roleId) && !pinOf(x));
            if (pid) return { error: `${state.profiles[pid]?.name || pid} uses an old app without a profile key and holds this role, so it can only be a role without permissions` };
          }
        }
        if (name !== undefined) role.name = name;
        if (color !== undefined) role.color = color.toLowerCase();
        if (newPerms) role.perms = newPerms;
        if (newGrantable) role.grantable = newGrantable;
        if (position !== undefined) {
          state.roles.splice(state.roles.indexOf(role), 1);
          state.roles.splice(Math.max(0, Math.min(position, state.roles.length)), 0, role);
        }
        permsChanged();
        console.log(`[mod] ${actorName(actor)} updated the role "${role.name}": ${[name !== undefined && 'name', color !== undefined && 'color', position !== undefined && 'position', (newPerms || newGrantable) && 'permissions'].filter(Boolean).join(', ') || 'no change'}`);
        return { ok: true, role };
      },

      deleteRole(actor, roleId) {
        const denied = actions.roleGate(actor);
        if (denied) return denied;
        const role = typeof roleId === 'string' && state.roles.find((r) => r.id === roleId);
        if (!role) return { error: 'Unknown role' };
        if (!isDash(actor) && !permsOf(actor.profileId).admin && !isAesthetic(role)) return noPerm('delete that role');
        state.roles = state.roles.filter((r) => r !== role);
        for (const pid of Object.keys(state.memberRoles)) {
          const kept = state.memberRoles[pid].filter((x) => x !== roleId);
          if (kept.length) state.memberRoles[pid] = kept;
          else delete state.memberRoles[pid];
        }
        for (const r of state.roles) r.grantable = r.grantable.filter((x) => x !== roleId);
        state.defaultGrantable = state.defaultGrantable.filter((x) => x !== roleId);
        for (const ch of state.channels) {
          if (ch.overrides && Object.hasOwn(ch.overrides, roleId)) {
            delete ch.overrides[roleId];
            if (!Object.keys(ch.overrides).length) delete ch.overrides;
          }
        }
        permsChanged();
        console.log(`[mod] ${actorName(actor)} deleted the role "${role.name}"`);
        return { ok: true };
      },

      // The profile's full new list: unknown ids and duplicates dropped, at most 10. Other than for
      // administrators, every role added or removed must be an aesthetic one the actor may grant.
      setMemberRoles(actor, profileId, roleIds) {
        const denied = actions.roleGate(actor);
        if (denied) return denied;
        profileId = str(profileId, 64);
        if (!profileId || !Object.hasOwn(state.profiles, profileId)) return { error: 'Unknown user' };
        if (!Array.isArray(roleIds)) return { error: 'Roles must be a list' };
        if (!touchable(actor, profileId)) return ADMIN_TARGET;
        const known = new Set(state.roles.map((r) => r.id));
        const list = [...new Set(roleIds.filter((x) => typeof x === 'string' && known.has(x)))].slice(0, MAX_ROLES_PER_MEMBER);
        const before = Object.hasOwn(state.memberRoles, profileId) ? state.memberRoles[profileId] : [];
        const changed = [...list.filter((x) => !before.includes(x)), ...before.filter((x) => !list.includes(x))];
        const byId = (rid) => state.roles.find((r) => r.id === rid);
        if (!isDash(actor)) {
          const g = permsOf(actor.profileId);
          if (!g.admin) {
            const bad = changed.map(byId).find((r) => r && (!g.grantable.includes(r.id) || !isAesthetic(r)));
            if (bad) return noPerm(`change the role ${bad.name}`);
          }
        }
        if (!pinOf(profileId)) {
          const bad = list.map(byId).find((r) => !before.includes(r.id) && !isAesthetic(r));
          if (bad) return { error: `${state.profiles[profileId].name} uses an old app without a profile key, so they can only get roles without permissions` };
        }
        if (changed.length) {
          if (list.length) state.memberRoles[profileId] = list;
          else delete state.memberRoles[profileId];
          permsChanged();
          console.log(`[mod] ${actorName(actor)} changed the roles of ${whoIs({ ...state.profiles[profileId], id: profileId })}: ${list.map((x) => byId(x)?.name || '?').join(', ') || 'none'}`);
        }
        return { ok: true, roles: list };
      },

      // What everybody gets (admin only): perms is a partial key -> bool, grantable replaces the list
      setDefaultPerms(actor, { perms, grantable } = {}) {
        if (!isDash(actor)) {
          if (!state.permissionsOn) return { error: OPEN_ROLES_ERROR };
          if (!permsOf(actor.profileId).admin) return noPerm('change the default permissions');
        }
        const next = { ...state.defaultPerms };
        if (perms !== undefined) {
          if (!isObj(perms)) return { error: 'Permissions must be an object' };
          for (const k of PERM_KEYS) {
            if (!Object.hasOwn(perms, k)) continue;
            if (typeof perms[k] !== 'boolean') return { error: `Permission ${k} must be true or false` };
            next[k] = perms[k];
          }
        }
        let list = state.defaultGrantable;
        if (grantable !== undefined) {
          const gr = cleanGrantable(grantable);
          if (gr.error) return gr;
          list = gr.grantable;
        }
        state.defaultPerms = next;
        state.defaultGrantable = list;
        permsChanged();
        console.log(`[mod] ${actorName(actor)} changed the default permissions`);
        return { ok: true, defaultPerms: state.defaultPerms, defaultGrantable: state.defaultGrantable };
      },
    };

    io.on('connection', (socket) => {
      const authed = () => users.has(socket.id);
      const on = (event, fn) =>
        socket.on(event, (payload, ack) => {
          if (!authed()) return typeof ack === 'function' && ack({ error: 'not authenticated' });
          try {
            fn(payload || {}, typeof ack === 'function' ? ack : () => {});
          } catch (err) {
            console.error(`[socket] ${event}:`, err);
          }
        });

      // `invite`: the token of someone joining. Apps from before invites send what was typed as `password`.
      socket.on('hello', ({ profile, invite, password, proof } = {}, ack) => {
        if (typeof ack !== 'function') return;
        const p = cleanProfile(profile);
        if (banFor(p.id, clientIp(socket))) {
          console.warn(`[auth] banned ${whoIs(p)} refused`);
          return ack({ error: 'You are banned from this server', banned: true });
        }
        // Prove the profile's key (D42). Apps from before D42 send no proof: they
        // can still use a profile id that no key has claimed yet, as before.
        const pin = pinOf(p.id);
        const card = p.card && cardValid(p.card) ? p.card : undefined;
        const signed = !!card && verifySig(card.s, str(proof, 128), helloText(socket.id, hostOf(socket)));
        // A proof that doesn't check out is a bug or a proxy that rewrites Host, never a reason to go on unprotected
        const refuse = (why, res) => (console.warn(`[auth] ${whoIs(p)} refused: ${why}`), ack(res));
        if (proof && !signed) return refuse('the profile key proof did not verify (a proxy that rewrites Host?)', { error: 'Could not verify your profile key. If this server is behind a reverse proxy, it must pass the original Host header.', key: true });
        // Joining takes an invite (D51). A member is a profile that joined and signs with its pinned
        // key: it needs none, and one it still sends is not looked at, so coming back uses nothing up.
        const member = signed && !!pin && card.s === pin && Object.hasOwn(state.profiles, p.id);
        let joinedWith = null;
        if (state.inviteOnly && !member) {
          const ip = clientIp(socket);
          if (inviteBlocked(ip)) return ack({ error: 'Too many wrong invites from your address. Try again in a few minutes.', invite: true });
          joinedWith = inviteFor(invite ?? password);
          if (!joinedWith) {
            inviteFailed(ip);
            console.warn(`[auth] no valid invite from ${ip}`);
            return ack({ error: 'This server needs an invite. The one you entered is wrong, used up, expired or revoked.', invite: true });
          }
          // Only a key can say who used an invite, and who may come back without one
          if (!signed) return refuse('an invite needs a signed hello and the app sent none', { error: 'Update friendspeak to join this server with an invite.', key: true });
        }
        if (pin && !signed) return refuse('the profile is pinned to a key and the app sent none', { error: 'This profile is protected by a key on this server. Update friendspeak to connect with it.', key: true });
        if (pin && card.s !== pin) return refuse('signed with a different key than the one pinned (D42)', { error: 'This profile belongs to a different key on this server. To use it on this device, import its profile file from the device you made it on.', key: true });
        if (signed && !pin) state.pins[p.id] = card.s;
        p.card = card;
        lastIp.set(p.id, clientIp(socket));
        // One live session per profile. After a network drop the old socket
        // lingers until its ping times out (~45 s), so a reconnect would show
        // the person twice (and twice in voice). The newest session wins.
        for (const [sid, other] of users) {
          if (sid === socket.id || other.profile.id !== p.id) continue;
          const old = io.sockets.sockets.get(sid);
          if (old) {
            leaveVoice(old);
            old.emit('session:replaced');
            old.disconnect(true);
          } else if (other.voice) io.to('voice:' + other.voice).emit('voice:peer-left', { sid });
          users.delete(sid);
        }
        if (joinedWith) {
          joinedWith.uses++;
          joinedWith.joins = [...joinedWith.joins, { id: p.id, name: p.name, ts: Date.now() }].slice(-MAX_INVITE_JOINS);
          console.log(`[auth] ${whoIs(p)} joined with invite ${joinedWith.id.slice(0, 8)}`);
        } else if (!Object.hasOwn(state.profiles, p.id)) console.log(`[auth] ${whoIs(p)} joined for the first time`);
        socket.data.profileId = p.id;
        users.set(socket.id, { profile: p, voice: null, muted: false, deafened: false, sharing: false, camera: false, since: Date.now(), ip: clientIp(socket) });
        state.profiles[p.id] = storedProfile(p);
        save();
        const g = permsOf(p.id);
        console.log(`[server] ${whoIs(p)} connected`);
        ack({ ok: true, sid: socket.id, server: publicState(g), users: userList(g), perms: g });
        socket.broadcast.emit('profile', { id: p.id, ...storedProfile(p) });
        broadcastUsers();
        if (joinedWith) invitesChanged();
      });

      on('profile:update', (profile) => {
        const u = users.get(socket.id);
        const p = cleanProfile({ ...profile, id: u.profile.id });
        p.card = u.profile.card; // checked at hello; it can't change during a session
        u.profile = p;
        state.profiles[p.id] = storedProfile(p);
        save();
        io.emit('profile', { id: p.id, ...storedProfile(p) });
        broadcastUsers();
      });

      // --- text ---

      const myId = () => users.get(socket.id).profile.id;
      // What this socket's profile may do in a channel: { view, send, manage }
      const inChannel = (cid) => permsOf(myId()).channels[cid] || { view: false, send: false, manage: false };

      on('msg:history', ({ channelId, before }, ack) => {
        const list = thread(channelId);
        if (!list || !inChannel(channelId).view) return ack({ messages: [] });
        const end = before ? list.findIndex((m) => m.id === before) : list.length;
        ack({ messages: list.slice(Math.max(0, end - 50), end < 0 ? list.length : end) });
      });

      on('msg:get', ({ channelId, messageId }, ack) => ack(peekMessage(myId(), channelId, messageId)));

      // The query is never logged (D49)
      on('msg:search', ({ q, channelId, from, before, after, has }, ack) => {
        q = str(q, 100).trim().toLowerCase();
        const f = {
          from: Array.isArray(from) ? from.slice(0, 50).map((v) => str(v, 64)).filter(Boolean) : [],
          before: Number.isFinite(before) ? before : null,
          after: Number.isFinite(after) ? after : null,
          has: Array.isArray(has) ? SEARCH_HAS.filter((k) => has.includes(k)) : [],
        };
        if (!q && !f.from.length && f.before == null && f.after == null && !f.has.length) return ack({ results: [] });
        ack(searchMessages(myId(), q, str(channelId, 64), f));
      });

      on('msg:send', ({ channelId, text, gif, replyTo, files }, ack) => {
        const list = thread(channelId);
        if (!list) return ack({ error: 'no such channel' });
        if (!inChannel(channelId).send) return ack(noPerm('send messages here'));
        text = str(text, MAX_MESSAGE_LEN).trim();
        const g =
          gif && typeof gif.url === 'string' && /^https:\/\//.test(gif.url)
            ? { url: gif.url.slice(0, 500), w: +gif.w || 200, h: +gif.h || 200, title: str(gif.title, 200) }
            : null;
        const u = users.get(socket.id);
        // Only your own fresh uploads to this channel can be attached
        const attached = (Array.isArray(files) ? files.slice(0, MAX_FILES_PER_MESSAGE) : [])
          .map((fid) => fileById(str(fid, 64)))
          .filter((f, i, a) => f && !f.messageId && f.channelId === channelId && f.by === u.profile.id && a.indexOf(f) === i);
        if (!text && !g && !attached.length) return ack({ error: 'empty' });
        const replied = (replyTo = str(replyTo, 32)) ? list.find((m) => m.id === replyTo) : null;
        const mentions = mentionsOf(text, replied, u.profile.id);
        const msg = {
          id: id(),
          author: u.profile.id,
          name: u.profile.name,
          text,
          gif: g,
          files: attached.length ? attached.map((f) => ({ id: f.id, name: f.name, size: f.size, type: f.type })) : undefined,
          replyTo: replyTo || null,
          mentions: mentions || undefined,
          channels: channelLinksOf(text, u.profile.id) || undefined,
          reactions: {}, // emoji -> [profileId]
          ts: Date.now(),
        };
        list.push(msg);
        if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
        for (const f of attached) f.messageId = msg.id;
        save();
        toViewers(channelId, 'msg:new', { channelId, message: msg });
        // People with this server bookmarked but not open hear about mentions over /dm (D41)
        if (mentions) {
          // Only people who can read the channel hear about it
          const targets = new Set(mentions.everyone ? Object.keys(state.profiles) : mentions.users);
          if (!mentions.everyone) for (const [pid, held] of Object.entries(state.memberRoles)) if (held.some((r) => mentions.roles?.includes(r))) targets.add(pid);
          const rooms = [...targets].filter((pid) => canView(pid, channelId)).map((pid) => 'p:' + pid);
          if (rooms.length) {
            dm.to(rooms).except('p:' + msg.author).emit('mention', {
              channelId,
              channelName: channel(channelId).name,
              serverName: state.name,
              message: { id: msg.id, author: msg.author, name: msg.name, text: text.slice(0, 300), ts: msg.ts, replyTo: msg.replyTo, mentions },
            });
          }
        }
        if (attached.length) toViewers(channelId, 'files:new', { files: attached.map(publicFile), storage: usage() });
        ack({ ok: true });
      });

      on('msg:edit', ({ channelId, messageId, text }, ack) => {
        const m = thread(channelId)?.find((x) => x.id === messageId);
        const u = users.get(socket.id);
        text = str(text, MAX_MESSAGE_LEN).trim();
        if (!m || m.author !== u.profile.id || !text) return;
        if (!inChannel(channelId).send) return ack(noPerm('send messages here'));
        m.text = text;
        m.edited = Date.now();
        const mentions = mentionsOf(text, m.replyTo && thread(channelId).find((x) => x.id === m.replyTo), m.author);
        if (mentions) m.mentions = mentions;
        else delete m.mentions;
        const links = channelLinksOf(text, m.author);
        if (links) m.channels = links;
        else delete m.channels;
        save();
        toViewers(channelId, 'msg:update', { channelId, message: m });
      });

      // Your own messages, or anyone's with manageMessages (and sight of the channel)
      on('msg:delete', ({ channelId, messageId }, ack) => {
        const list = thread(channelId) || [];
        const i = list.findIndex((x) => x.id === messageId);
        if (i < 0) return ack({ error: 'no such message' });
        const g = permsOf(myId());
        if (list[i].author !== myId() && !(g.manageMessages && g.channels[channelId]?.view)) return ack(noPerm('delete other people’s messages'));
        const [m] = list.splice(i, 1);
        if (m.author !== myId()) console.log(`[mod] ${whoIs(users.get(socket.id).profile)} deleted a message by ${whoIs({ name: m.name, id: m.author })} in #${channel(channelId).name}`);
        save();
        toViewers(channelId, 'msg:deleted', { channelId, messageId });
        if (m.files?.length) deleteFiles(m.files.map((f) => f.id));
        ack({ ok: true });
      });

      on('msg:react', ({ channelId, messageId, emoji }, ack) => {
        const m = thread(channelId)?.find((x) => x.id === messageId);
        emoji = str(emoji, 64);
        if (!m || !emoji) return;
        if (!inChannel(channelId).send) return ack(noPerm('react here'));
        const pid = users.get(socket.id).profile.id;
        const who = (m.reactions[emoji] ||= []);
        const i = who.indexOf(pid);
        if (i >= 0) who.splice(i, 1);
        else who.push(pid);
        if (!who.length) delete m.reactions[emoji];
        save();
        toViewers(channelId, 'msg:update', { channelId, message: m });
      });

      on('typing', ({ channelId }) => {
        if (!thread(channelId) || !inChannel(channelId).send) return;
        toViewers(channelId, 'typing', { channelId, sid: socket.id, name: users.get(socket.id).profile.name }, socket.id);
      });

      // --- bans, removing members, server settings: by permission (open mode: anyone, D3, D27, D43) ---

      on('ban:add', ({ profileId, ip }, ack) => {
        ack(actions.ban({ profileId: myId() }, { profileId, ip, by: users.get(socket.id).profile.name, selfIp: clientIp(socket) }));
      });

      // Remove someone from the server: disconnect them and drop them from the
      // member list. Unlike a ban they can come back (and reappear).
      on('member:remove', ({ profileId }, ack) => {
        ack(actions.removeMember({ profileId: myId() }, { profileId }));
      });

      on('ban:remove', ({ id: banId }, ack) => {
        ack(actions.unban({ profileId: myId() }, banId));
      });

      // Removing the server from the app's list: the profile stops being a member
      on('server:leave', (_p, ack) => {
        const pid = myId();
        console.log(`[server] ${whoIs({ ...state.profiles[pid], id: pid })} left the server`);
        ack({ ok: true });
        kick((s) => s.data.profileId === pid, 'left');
        endMembership(pid);
      });

      on('server:update', ({ name, icon, game, audioQuality, inviteOnly }, ack) => {
        ack(actions.updateServer({ profileId: myId() }, { name, icon, game, audioQuality, inviteOnly }));
      });

      // --- invites: only for people who may create them (D51) ---

      on('invite:list', (_p, ack) => ack(actions.listInvites({ profileId: myId() })));
      on('invite:create', ({ label, maxUses, expiresIn }, ack) => ack(actions.createInvite({ profileId: myId() }, { label, maxUses: maxUses ?? null, expiresIn: expiresIn ?? null })));
      on('invite:remove', ({ id: inviteId }, ack) => ack(actions.removeInvite({ profileId: myId() }, inviteId)));

      // --- roles and permissions ---

      on('role:create', ({ name, color, perms, grantable }, ack) => ack(actions.createRole({ profileId: myId() }, { name, color, perms, grantable })));
      on('role:update', ({ id: rid, ...patch }, ack) => {
        const { name, color, position, perms, grantable } = patch;
        ack(actions.updateRole({ profileId: myId() }, rid, { name, color, position, perms, grantable }));
      });
      on('role:delete', ({ id: rid }, ack) => ack(actions.deleteRole({ profileId: myId() }, rid)));
      on('member:roles', ({ profileId, roles }, ack) => ack(actions.setMemberRoles({ profileId: myId() }, profileId, roles)));
      on('perms:default', ({ perms, grantable }, ack) => ack(actions.setDefaultPerms({ profileId: myId() }, { perms, grantable })));

      // --- channels ---

      on('channel:create', ({ name, type }, ack) => {
        if (!permsOf(myId()).manageChannels) return ack(noPerm('create channels'));
        type = type === 'voice' ? 'voice' : 'text';
        name = str(name, MAX_CHANNEL_NAME).trim();
        if (type === 'text') name = name.toLowerCase().replace(/\s+/g, '-');
        if (!name) return ack({ error: 'name required' });
        const ch = { id: id(), name, type };
        state.channels.push(ch);
        permsChanged({ roles: false });
        console.log(`[mod] ${whoIs(users.get(socket.id).profile)} created the ${type} channel "${name}"`);
        ack({ ok: true, channel: ch });
      });

      on('channel:rename', ({ id: cid, name }, ack) => {
        const ch = channel(cid);
        name = str(name, MAX_CHANNEL_NAME).trim();
        if (!ch || !name) return ack({ error: 'no such channel' });
        if (!inChannel(cid).manage) return ack(noPerm('manage that channel'));
        const was = ch.name;
        ch.name = ch.type === 'text' ? name.toLowerCase().replace(/\s+/g, '-') : name;
        console.log(`[mod] ${whoIs(users.get(socket.id).profile)} renamed the channel "${was}" to "${ch.name}"`);
        save();
        for (const [sid, u] of users) if (canView(u.profile.id, cid)) io.to(sid).emit('channels', channelsFor(permsOf(u.profile.id)));
        ack({ ok: true });
      });

      // The full new overrides object of a channel: { [roleId | 'everyone']: { view?, send?, manage? } }
      on('channel:perms', ({ id: cid, overrides }, ack) => {
        const ch = channel(cid);
        if (!ch) return ack({ error: 'no such channel' });
        if (!inChannel(cid).manage) return ack(noPerm('manage that channel'));
        if (!isObj(overrides)) return ack({ error: 'Overrides must be an object' });
        const ov = cleanOverrides(overrides, new Set(state.roles.map((r) => r.id)));
        if (Object.keys(ov).length) ch.overrides = ov;
        else delete ch.overrides;
        permsChanged({ roles: false });
        console.log(`[mod] ${whoIs(users.get(socket.id).profile)} changed the permissions of the channel "${ch.name}"`);
        ack({ ok: true });
      });

      on('channel:delete', ({ id: cid }, ack) => {
        const ch = channel(cid);
        if (!ch) return ack({ error: 'no such channel' });
        if (!inChannel(cid).manage) return ack(noPerm('manage that channel'));
        if (state.channels.filter((c) => c.type === ch.type).length <= 1) return ack({ error: `There must be at least one ${ch.type} channel` });
        console.log(`[mod] ${whoIs(users.get(socket.id).profile)} deleted the ${ch.type} channel "${ch.name}"`);
        state.channels = state.channels.filter((c) => c.id !== cid);
        delete state.messages[cid];
        deleteFiles(state.files.filter((f) => f.channelId === cid).map((f) => f.id));
        for (const [sid, u] of users) {
          if (u.voice === cid) {
            const s = io.sockets.sockets.get(sid);
            if (s) leaveVoice(s);
            io.to(sid).emit('voice:kicked', { reason: 'deleted' });
          }
        }
        permsChanged({ roles: false });
        ack({ ok: true });
      });

      // --- files ---

      // Attached files of one channel, or of the whole server; newest first
      on('file:list', ({ channelId }, ack) => {
        const cid = str(channelId, 32);
        const may = permsOf(myId()).channels;
        const files = state.files.filter((f) => f.messageId && may[f.channelId]?.view && (!cid || f.channelId === cid));
        ack({ files: files.map(publicFile).sort((a, b) => b.ts - a.ts), storage: usage() });
      });

      // Your own files, or anyone's with manageFiles (and sight of the channel)
      on('file:delete', ({ ids }, ack) => {
        const g = permsOf(myId());
        const files = (Array.isArray(ids) ? ids : []).map((x) => fileById(str(x, 64))).filter(Boolean);
        if (files.some((f) => f.by !== myId() && !(g.manageFiles && g.channels[f.channelId]?.view))) return ack(noPerm('delete other people’s files'));
        const others = files.filter((f) => f.by !== myId());
        if (others.length) console.log(`[files] ${whoIs(users.get(socket.id).profile)} deleted ${others.length} file${others.length === 1 ? '' : 's'} uploaded by others (${others.reduce((n, f) => n + f.size, 0)} bytes)`);
        deleteFiles(files.map((f) => f.id));
        ack({ ok: true });
      });

      // --- custom emojis ---

      on('emoji:add', ({ name, url }, ack) => {
        if (!permsOf(myId()).manageEmojis) return ack(noPerm('add emojis'));
        name = str(name, 32).toLowerCase().replace(/[^a-z0-9_]/g, '');
        if (!name) return ack({ error: 'Name must be letters, numbers or _' });
        if (!isDataImage(url, MAX_EMOJI_BYTES)) return ack({ error: 'Image must be png/jpg/gif/webp under 256KB' });
        state.emojis = state.emojis.filter((e) => e.name !== name);
        state.emojis.push({ name, url, by: users.get(socket.id).profile.name });
        save();
        io.emit('emojis', state.emojis);
        ack({ ok: true });
      });

      on('emoji:remove', ({ name }, ack) => {
        if (!permsOf(myId()).manageEmojis) return ack(noPerm('remove emojis'));
        state.emojis = state.emojis.filter((e) => e.name !== name);
        save();
        io.emit('emojis', state.emojis);
        ack({ ok: true });
      });

      // --- GIFs (server-side key, used when the client has none) ---

      on('gif:search', async ({ q }, ack) => {
        const key = GIPHY_API_KEY;
        if (!key) return ack({ error: 'nokey' });
        try {
          const qs = new URLSearchParams({ api_key: key, limit: '30', rating: 'pg-13' });
          const endpoint = q ? 'search' : 'trending';
          if (q) qs.set('q', str(q, 100));
          const r = await fetch(`https://api.giphy.com/v1/gifs/${endpoint}?${qs}`);
          const j = await r.json();
          ack({ data: j.data || [] });
        } catch (e) {
          ack({ error: String(e.message || e) });
        }
      });

      // --- voice (WebRTC mesh signaling) ---

      on('voice:join', ({ channelId }, ack) => {
        const ch = channel(channelId);
        if (!ch || ch.type !== 'voice') return ack({ error: 'no such channel' });
        if (!inChannel(channelId).send) return ack(noPerm('join that voice channel'));
        leaveVoice(socket);
        const u = users.get(socket.id);
        const peers = [...users.entries()].filter(([, x]) => x.voice === channelId).map(([sid]) => sid);
        u.voice = channelId;
        console.debug(`[voice] ${whoIs(u.profile)} joined ${ch.name}`);
        socket.join('voice:' + channelId);
        ack({ ok: true, peers });
        broadcastUsers();
      });

      on('voice:leave', () => {
        const left = users.get(socket.id)?.voice;
        if (left) console.debug(`[voice] ${whoIs(users.get(socket.id).profile)} left ${channel(left)?.name ?? 'a deleted channel'}`);
        leaveVoice(socket);
        broadcastUsers();
      });

      // Take someone out of the voice channel they're in (they can rejoin)
      on('voice:kick', ({ profileId }, ack) => {
        const denied = need({ profileId: myId() }, 'voiceKick', 'remove people from voice');
        if (denied) return ack(denied);
        profileId = str(profileId, 64);
        if (profileId === myId()) return ack({ error: 'You can’t remove yourself from voice' });
        if (!touchable({ profileId: myId() }, profileId)) return ack(ADMIN_TARGET);
        const me = permsOf(myId());
        const [sid] = [...users].find(([, x]) => x.profile.id === profileId && x.voice && me.channels[x.voice]?.view) || [];
        const target = sid && io.sockets.sockets.get(sid);
        if (!target) return ack({ error: 'They aren’t in a voice channel' });
        console.log(`[mod] ${whoIs(users.get(socket.id).profile)} removed ${whoIs({ ...state.profiles[profileId], id: profileId })} from voice`);
        leaveVoice(target);
        target.emit('voice:kicked', { reason: 'kicked', by: users.get(socket.id).profile.name });
        broadcastUsers();
        ack({ ok: true });
      });

      // Force-mute someone (or lift it). Lifting only clears the flag: their own mute stays. A
      // force-muted person who may force-mute can lift it on themselves, nothing else on themselves.
      on('voice:forcemute', ({ profileId, muted }, ack) => {
        const denied = need({ profileId: myId() }, 'forceMute', 'force-mute people');
        if (denied) return ack(denied);
        profileId = str(profileId, 64);
        muted = !!muted;
        if (!profileId || !Object.hasOwn(state.profiles, profileId)) return ack({ error: 'Unknown user' });
        if (profileId === myId() && muted) return ack({ error: 'You can’t force-mute yourself' });
        if (!touchable({ profileId: myId() }, profileId)) return ack(ADMIN_TARGET);
        if (state.forceMuted.includes(profileId) !== muted) {
          state.forceMuted = muted ? [...state.forceMuted, profileId] : state.forceMuted.filter((x) => x !== profileId);
          save();
          const by = users.get(socket.id).profile.name;
          console.log(`[mod] ${whoIs(users.get(socket.id).profile)} ${muted ? 'force-muted' : 'lifted the force-mute of'} ${whoIs({ ...state.profiles[profileId], id: profileId })}`);
          for (const [sid, x] of users) if (x.profile.id === profileId) io.to(sid).emit('voice:forcemuted', { muted, by });
          broadcastUsers();
        }
        ack({ ok: true });
      });

      on('voice:state', ({ muted, deafened }) => {
        const u = users.get(socket.id);
        u.muted = !!muted;
        u.deafened = !!deafened;
        broadcastUsers();
      });

      // Screen share / camera on or off. Video itself flows peer to peer (see voice.js).
      on('voice:media', ({ screen, camera }) => {
        const u = users.get(socket.id);
        u.sharing = !!screen && !!u.voice;
        u.camera = !!camera && !!u.voice;
        broadcastUsers();
      });

      on('rtc:signal', ({ to, data }) => {
        const me = users.get(socket.id);
        const peer = users.get(to);
        if (!peer || !me.voice || peer.voice !== me.voice) return;
        io.to(to).emit('rtc:signal', { from: socket.id, data });
      });

      // --- penguin game (Yukon) ---

      // Every friendspeak profile gets a penguin automatically; this hands the
      // client a one-time-use-ish login token for it.
      on('game:login', async (_, ack) => {
        const game = gameRef.current;
        if (!game?.available) return ack({ error: game?.reason || 'The game is not available on this server' });
        if (state.gameEnabled === false) return ack({ error: 'The game is turned off on this server' });
        try {
          ack({ ok: true, ...(await game.login(users.get(socket.id).profile)) });
        } catch (err) {
          console.error('[game] login', err);
          ack({ error: 'Could not create your penguin: ' + err.message });
        }
      });

      on('game:state', ({ playing }) => {
        users.get(socket.id).playing = !!playing && gameInfo().enabled;
        broadcastUsers();
      });

      socket.on('disconnect', () => {
        const u = users.get(socket.id);
        if (!u) return;
        leaveVoice(socket);
        users.delete(socket.id);
        console.log(`[server] ${whoIs(u.profile)} disconnected`);
        const stored = Object.hasOwn(state.profiles, u.profile.id) && state.profiles[u.profile.id];
        if (stored) {
          stored.seen = Date.now();
          save();
          io.emit('profile', { id: u.profile.id, ...stored });
        }
        broadcastUsers();
      });
    });

    return { io, actions };
  }

  const server = await createServer();
  const { io, actions } = attach(server);
  ioRef.current = io;
  // opts.game === false (GAME=off): don't serve or start the game at all
  const game =
    opts.game === false
      ? { available: false, reason: 'The game is turned off by the server host.' }
      : await startGame({ app, httpServer: server, dataDir: DATA_DIR, express, assetsDir: opts.gameAssetsDir }).catch((err) => {
          console.error('[game] failed to start:', err);
          return { available: false, reason: 'The game server failed to start: ' + err.message };
        });
  gameRef.current = game;
  let unsubCrashes = null;
  const adminOn = opts.admin?.enabled !== false;
  const admin = adminOn
    ? (adminRef.current = createAdmin({
        app,
        express,
        dataDir: DATA_DIR,
        version: VERSION,
        https: USE_HTTPS,
        fingerprint: () => fingerprint,
        inDocker: !!opts.update?.inDocker,
        startedAt: Date.now(),
        state: () => state,
        game: () => gameRef.current, // for players() and maxUsers
        gameOff: opts.game === false, // GAME=off
        users,
        lastIp,
        actions,
        usage,
        gameInfo,
        audioQuality,
        updater,
        saveUpdateSettings: (o) => {
          state.updateSettings = o;
          save();
        },
        logs: logs || { lines: () => ({ lines: [], more: false }), query: async () => ({ lines: [], more: false }), info: () => ({ persisted: false, bytes: 0, files: 0, oldest: null, retentionDays: 0, maxBytes: 0 }), on: () => () => {}, scrub: (t) => String(t) },
        crashes,
        options: { local: opts.admin?.local, key: opts.admin?.key, mfa: opts.admin?.mfa, path: opts.admin?.path },
      }))
    : null;
  unsubCrashes = admin ? crashes.on(() => admin.notify('crashes')) : null;
  // Unexpected errors in a route (the admin API has its own handler): logged without the stack, answered without it too
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const where = req.path.startsWith('/files/') ? '/files/…' : req.path.slice(0, 100);
    if (err && err.status && err.status < 500) return res.status(err.status).json({ error: 'Invalid request' });
    console.error(`[http] ${req.method} ${where} failed: ${err && err.message}`);
    res.status(500).json({ error: 'Internal error' });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  });
  updater.start();
  const port = server.address().port;
  console.log(`[server] version ${VERSION} listening on port ${port}`);
  return {
    port,
    version: VERSION,
    update: updater.info(),
    https: USE_HTTPS,
    fingerprint,
    name: state.name,
    firstInvite, // the token of the invite made on a first start, else null: shown by the CLI
    get inviteOnly() {
      return state.inviteOnly;
    },
    admin: { enabled: adminOn, local: adminOn && opts.admin?.local !== false, path: admin ? admin.path : null, mfa: !!admin?.mfa },
    game,
    get gameEnabled() {
      return gameInfo().enabled;
    },
    get storage() {
      return usage();
    },
    close: () =>
      new Promise((resolve) => {
        // Flush a pending debounced save so nothing is lost on shutdown
        clearTimeout(saveTimer);
        clearInterval(sweepTimer);
        clearInterval(mailSweepTimer);
        try {
          if (mailTimer) writeMail();
        } catch (err) {
          saveFailed('the mailboxes', err);
        }
        updater.stop();
        admin?.close();
        unsubCrashes?.();
        try {
          writeState();
        } catch (err) {
          saveFailed('the server state', err);
        }
        console.log('[server] shutting down');
        logs?.flushSync();
        clearMarker();
        closing = true;
        io.close();
        server.close(() => resolve());
      }),
  };
}

// "2GB", "500 MB", "1.5g", "1048576" -> bytes (binary units). Invalid -> fallback.
function parseSize(v, fallback) {
  if (typeof v === 'number') return v >= 0 ? v : fallback;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?\s*$/i.exec(String(v ?? ''));
  return m ? Math.round(parseFloat(m[1]) * 1024 ** ' kmgt'.indexOf(m[2].toLowerCase() || ' ')) : fallback;
}

// "24h", "90m", "2d", "3600" (seconds) -> ms. Invalid -> fallback.
function parseDuration(v, fallback) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([smhd]?)\s*$/i.exec(String(v ?? ''));
  return m ? parseFloat(m[1]) * { '': 1e3, s: 1e3, m: 60e3, h: 3600e3, d: 864e5 }[m[2].toLowerCase()] : fallback;
}

function fmtBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) (n /= 1024), i++;
  return `${i ? n.toFixed(n < 10 ? 1 : 0) : n} ${units[i]}`;
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

// "https://chat.example.com/" → "https://chat.example.com"; anything that isn't an http(s) address → ''
function publicOrigin(v) {
  try {
    const u = new URL(String(v || '').trim());
    return /^https?:$/.test(u.protocol) ? u.origin : '';
  } catch {
    return '';
  }
}

module.exports = { startServer, lanAddresses };

if (require.main === module) {
  const env = process.env;
  startServer({
    port: Number(env.PORT) || 3000,
    https: env.HTTPS === '1' || env.HTTPS === 'true',
    dataDir: env.DATA_DIR,
    serverName: env.SERVER_NAME,
    giphyKey: env.GIPHY_API_KEY,
    maxStorage: env.MAX_STORAGE,
    logs: { retentionDays: /^\s*\d+\s*$/.test(env.LOG_RETENTION_DAYS || '') ? Number(env.LOG_RETENTION_DAYS) : 14, maxBytes: parseSize(env.LOG_MAX_SIZE, 50 * 1024 ** 2) },
    crashReports: true,
    dmGuests: !/^(off|0|false|no)$/i.test(env.DM_GUESTS || ''),
    game: !/^(off|0|false|no)$/i.test(env.GAME || ''),
    admin: { enabled: !/^(off|0|false|no)$/i.test(env.ADMIN || ''), local: !/^(off|0|false|no)$/i.test(env.ADMIN_LOCAL || ''), key: env.ADMIN_KEY, mfa: !/^(off|0|false|no)$/i.test(env.ADMIN_MFA || ''), path: /^(off|0|false|no)$/i.test(env.ADMIN_PATH || '') ? false : env.ADMIN_PATH },
    update: {
      mode: (env.AUTO_UPDATE || 'off').toLowerCase(),
      repo: env.UPDATE_REPO || 'nickolaiposs/friendspeak',
      token: env.GITHUB_TOKEN,
      cron: env.MAINTENANCE_CRON || '0 6 * * 0',
      warn: parseDuration(env.MAINTENANCE_WARN, 24 * 60 * 60e3),
      inDocker: env.FRIENDSPEAK_DOCKER === '1',
      watchtowerUrl: env.WATCHTOWER_URL || 'http://watchtower:8080',
      watchtowerToken: env.WATCHTOWER_TOKEN,
    },
  }).then((s) => {
    const scheme = s.https ? 'https' : 'http';
    // PUBLIC_URL: the address people use from outside, when it isn't this machine's own
    // (a domain on a reverse proxy, D53). Only printed: the server never needs to know it.
    const publicUrl = publicOrigin(env.PUBLIC_URL);
    if (env.PUBLIC_URL && !publicUrl) console.warn('  PUBLIC_URL ignored: it must look like https://chat.example.com');
    console.log(`\n  friendspeak server "${s.name}" is running\n`);
    console.log(`  Local address:     ${scheme}://localhost:${s.port}  (connect with the desktop app)`);
    // The app reads an address without a scheme as https, so a plain http server prints its scheme
    if (publicUrl) console.log(`  Friends connect:   ${publicUrl}`);
    else for (const ip of lanAddresses()) console.log(`  Friends connect:   ${s.https ? '' : 'http://'}${ip}:${s.port}`);
    if (s.fingerprint) console.log(`  Certificate:       ${s.fingerprint}`);
    console.log(`  Admin dashboard:   ${!s.admin.enabled ? 'off (ADMIN=off)' : `${publicUrl || `${scheme}://localhost:${s.port}`}${s.admin.path}  (${s.admin.local ? 'no key needed from this machine' : 'admin key' + (s.admin.mfa ? ' and authenticator code' : '') + ' required'})`}`);
    console.log(`  Joining:           ${s.inviteOnly ? 'needs an invite (make them in Server settings or the admin dashboard)' : 'open to anyone with the address (invites are off)'}`);
    if (env.PASSWORD) console.warn('  PASSWORD is no longer used: people join with invites, and everyone already on the server stays');
    if (env.GIPHY_API_KEY) console.log('  GIPHY: server key configured');
    console.log(`  Version:           ${s.version}` + (s.update.mode === 'off' ? '' : `  (updates: ${s.update.mode === 'on' ? 'automatic, cron "' + s.update.cron + '"' : 'notify only'})`));
    console.log(`  File storage:      ${fmtBytes(s.storage.used)} of ${fmtBytes(s.storage.max)} used`);
    console.log(`  Penguin game:      ${env.GAME && /^(off|0|false|no)$/i.test(env.GAME) ? 'off (GAME=off)' : !s.game.available ? s.game.reason : s.gameEnabled ? 'ready (' + s.game.worldName + ')' : 'turned off (Settings → Server)'}`);
    console.log('');
    // stdout, not console: the token must never enter the log the dashboard shows
    if (s.firstInvite) {
      process.stdout.write(
        `  Invite (never expires; made on the first start):\n\n    ${s.firstInvite}\n\n` +
          '  Friends paste it into the Invite field of "Connect to a server".\n' +
          '  See it again, revoke it or make more under Invites, in Server settings or the admin dashboard.\n\n'
      );
    }

    // `docker stop` sends SIGTERM: save state and exit cleanly. The game worlds'
    // sockets can keep the HTTP server open, so don't wait on them forever.
    const shutdown = (signal) => {
      console.log(`  ${signal} received, shutting down…`);
      setTimeout(() => process.exit(0), 5000).unref();
      s.close().then(() => process.exit(0));
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }, (err) => {
    console.error(err);
    crashState?.crashes.write('startup', err, { fatal: true });
    crashState?.clearMarker();
    crashState?.logs?.flushSync();
    process.exit(1);
  });
}
