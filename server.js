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

const VERSION = require('./package.json').version;

async function startServer(opts = {}) {
  const PORT = opts.port ?? 3000;
  const HOST = opts.host;
  const USE_HTTPS = !!opts.https;
  const PASSWORD = opts.password || '';
  const GIPHY_API_KEY = opts.giphyKey || '';
  let fingerprint = null; // SHA-256 of the self-signed certificate, when HTTPS
  const DATA_DIR = opts.dataDir || path.join(__dirname, 'data');
  const STATE_FILE = path.join(DATA_DIR, 'state.json');
  const MAX_HISTORY = 500;
  const MAX_MESSAGE_LEN = 4000;
  const MAX_EMOJI_BYTES = 256 * 1024;
  const MAX_AVATAR_BYTES = 384 * 1024;
  const MAX_BANNER_BYTES = 640 * 1024; // profile background
  const MAX_ICON_BYTES = 512 * 1024;
  const MAX_CHANNEL_NAME = 48; // room for emojis, incl. :custom: ones
  const MAX_STORAGE = parseSize(opts.maxStorage, 2 * 1024 ** 3); // all uploaded files together
  const MAX_FILES_PER_MESSAGE = 10;
  const FILES_DIR = path.join(DATA_DIR, 'files');

  fs.mkdirSync(FILES_DIR, { recursive: true });

  // Self-update from GitHub Releases (updater.js, D29). Clients learn about a
  // scheduled update from `server:update` and show a maintenance warning.
  const ioRef = { current: null };
  const updater = createUpdater({ ...opts.update, version: VERSION, onChange: (info) => ioRef.current?.emit('server:update', info) });

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
    };
  }

  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state = { ...defaultState(), ...state };
    delete state.dms; // DMs used to be stored here; they're peer to peer now (D28)
  } catch {
    state = defaultState();
  }

  let saveTimer = null;
  function writeState() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE);
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeState, 500);
  }
  save();

  // ---------- helpers ----------

  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const channel = (cid) => state.channels.find((c) => c.id === cid);
  const isDataImage = (v, max) =>
    typeof v === 'string' && /^data:image\/(png|jpe?g|gif|webp);base64,/.test(v) && v.length <= max * 1.4;
  // An uploaded image (data URL) or a linked one (https only, e.g. a GIPHY GIF)
  const isImageRef = (v, max) => isDataImage(v, max) || (typeof v === 'string' && v.length <= 1000 && /^https:\/\/[^\s"'<>]+$/.test(v));
  const isHexColor = (v) => /^#[0-9a-f]{6}$/i.test(v);

  function cleanProfile(p = {}) {
    return {
      id: str(p.id, 64) || id(),
      name: str(p.name, 32).trim() || 'anon',
      color: isHexColor(p.color) ? p.color : '#5865f2',
      avatar: isImageRef(p.avatar, MAX_AVATAR_BYTES) ? p.avatar : str(p.avatar, 16), // image or emoji
      banner: isImageRef(p.banner, MAX_BANNER_BYTES) || isHexColor(p.banner) ? p.banner : '', // profile background: image or color
      status: str(p.status, 64),
    };
  }
  // `seen`: when the profile was last online (the member list's "Offline" section)
  const storedProfile = (p, seen = Date.now()) => ({ name: p.name, color: p.color, avatar: p.avatar, banner: p.banner, status: p.status, seen });

  // The messages of a text channel; null if there's no such channel
  function thread(cid) {
    const ch = channel(cid);
    if (!ch || ch.type !== 'text') return null;
    return (state.messages[cid] ||= []);
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
  // The server hosts no UI: the client ships only in the desktop app (D26).
  app.get('/', (_req, res) => res.type('text/plain').send('This is a friendspeak server. Connect to it with the friendspeak desktop app.\n'));
  app.get('/api/info', (_req, res) => res.json({ name: state.name, icon: state.icon, password: !!PASSWORD, version: VERSION }));

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
    if (!ch || ch.type !== 'text') return res.status(400).json({ error: 'No such channel' });
    const size = Number(req.get('content-length'));
    if (!Number.isInteger(size) || size <= 0) return res.status(400).json({ error: 'Empty file' });
    const free = MAX_STORAGE - usedBytes() - reserved;
    if (size > free) return res.status(413).json({ error: `Not enough storage on this server (${fmtBytes(Math.max(0, free))} free)` });
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
      if (err) {
        fs.rm(tmp, { force: true }, () => {});
        if (!res.headersSent) res.status(err.status || 400).json({ error: err.message });
        return;
      }
      fs.renameSync(tmp, filePath(fid));
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

  // ---------- realtime ----------

  // socket.id -> { profile, voice: channelId|null, muted, deafened, sharing, camera }
  const users = new Map();

  function userList() {
    return [...users.entries()].map(([sid, { profile: { banner, ...profile }, ...u }]) => ({
      sid,
      ...profile, // minus the banner: this is re-sent on every mute toggle; clients get banners from `profiles`
      voice: u.voice,
      muted: u.muted,
      deafened: u.deafened,
      sharing: u.sharing,
      camera: u.camera,
      playing: u.playing,
    }));
  }

  function publicState() {
    return {
      name: state.name,
      icon: state.icon,
      channels: state.channels,
      emojis: state.emojis,
      profiles: state.profiles,
      bans: publicBans(),
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

    const broadcastUsers = () => io.emit('users', userList());

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

    // --- DM signaling (D28) ---
    // Direct messages are peer to peer. Clients keep a socket on this
    // namespace for every server they have bookmarked, so friends who share
    // any server can find each other. The server only says who is reachable
    // and relays WebRTC handshakes; it never sees or stores the messages.
    const dm = io.of('/dm');
    const dmOnline = () => [...new Set([...dm.sockets.values()].map((s) => s.data.profileId))];
    dm.use((socket, next) => {
      const { profileId, password } = socket.handshake.auth || {};
      const pid = str(profileId, 64);
      if (PASSWORD && password !== PASSWORD) return next(new Error('Wrong server password'));
      if (!pid) return next(new Error('No profile'));
      if (banFor(pid, clientIp(socket))) return next(new Error('banned'));
      socket.data.profileId = pid;
      next();
    });
    dm.on('connection', (socket) => {
      const pid = socket.data.profileId;
      // Newest wins, like chat sessions: a reconnect replaces the stale socket
      for (const s of dm.sockets.values()) if (s !== socket && s.data.profileId === pid) s.disconnect(true);
      socket.join('p:' + pid);
      socket.emit('online', dmOnline());
      socket.broadcast.emit('presence', { id: pid, online: true });
      socket.on('signal', ({ to, data } = {}) => {
        to = str(to, 64);
        if (to && to !== pid && data && typeof data === 'object') dm.to('p:' + to).emit('signal', { from: pid, data });
      });
      socket.on('disconnect', () => {
        if (!dmOnline().includes(pid)) dm.emit('presence', { id: pid, online: false });
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
          io.emit('msg:deleted', { channelId: f.channelId, messageId: m.id });
        } else io.emit('msg:update', { channelId: f.channelId, message: m });
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

    io.on('connection', (socket) => {
      const authed = () => users.has(socket.id);
      const on = (event, fn) =>
        socket.on(event, (payload, ack) => {
          if (!authed()) return typeof ack === 'function' && ack({ error: 'not authenticated' });
          try {
            fn(payload || {}, typeof ack === 'function' ? ack : () => {});
          } catch (err) {
            console.error(event, err);
          }
        });

      socket.on('hello', ({ profile, password } = {}, ack) => {
        if (typeof ack !== 'function') return;
        if (PASSWORD && password !== PASSWORD) return ack({ error: 'Wrong server password' });
        const p = cleanProfile(profile);
        if (banFor(p.id, clientIp(socket))) return ack({ error: 'You are banned from this server', banned: true });
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
        socket.data.profileId = p.id;
        users.set(socket.id, { profile: p, voice: null, muted: false, deafened: false, sharing: false, camera: false });
        state.profiles[p.id] = storedProfile(p);
        save();
        ack({ ok: true, sid: socket.id, server: publicState(), users: userList() });
        socket.broadcast.emit('profile', { id: p.id, ...storedProfile(p) });
        broadcastUsers();
      });

      on('profile:update', (profile) => {
        const u = users.get(socket.id);
        const p = cleanProfile({ ...profile, id: u.profile.id });
        u.profile = p;
        state.profiles[p.id] = storedProfile(p);
        save();
        io.emit('profile', { id: p.id, ...storedProfile(p) });
        broadcastUsers();
      });

      // --- text ---

      const myId = () => users.get(socket.id).profile.id;

      on('msg:history', ({ channelId, before }, ack) => {
        const list = thread(channelId);
        if (!list) return ack({ messages: [] });
        const end = before ? list.findIndex((m) => m.id === before) : list.length;
        ack({ messages: list.slice(Math.max(0, end - 50), end < 0 ? list.length : end) });
      });

      on('msg:send', ({ channelId, text, gif, replyTo, files }, ack) => {
        const list = thread(channelId);
        if (!list) return ack({ error: 'no such channel' });
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
        const msg = {
          id: id(),
          author: u.profile.id,
          name: u.profile.name,
          text,
          gif: g,
          files: attached.length ? attached.map((f) => ({ id: f.id, name: f.name, size: f.size, type: f.type })) : undefined,
          replyTo: str(replyTo, 32) || null,
          reactions: {}, // emoji -> [profileId]
          ts: Date.now(),
        };
        list.push(msg);
        if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
        for (const f of attached) f.messageId = msg.id;
        save();
        io.emit('msg:new', { channelId, message: msg });
        if (attached.length) io.emit('files:new', { files: attached.map(publicFile), storage: usage() });
        ack({ ok: true });
      });

      on('msg:edit', ({ channelId, messageId, text }) => {
        const m = thread(channelId)?.find((x) => x.id === messageId);
        const u = users.get(socket.id);
        text = str(text, MAX_MESSAGE_LEN).trim();
        if (!m || m.author !== u.profile.id || !text) return;
        m.text = text;
        m.edited = Date.now();
        save();
        io.emit('msg:update', { channelId, message: m });
      });

      on('msg:delete', ({ channelId, messageId }) => {
        const list = thread(channelId) || [];
        const i = list.findIndex((x) => x.id === messageId);
        if (i < 0 || list[i].author !== myId()) return;
        const [m] = list.splice(i, 1);
        save();
        io.emit('msg:deleted', { channelId, messageId });
        if (m.files?.length) deleteFiles(m.files.map((f) => f.id));
      });

      on('msg:react', ({ channelId, messageId, emoji }) => {
        const m = thread(channelId)?.find((x) => x.id === messageId);
        emoji = str(emoji, 64);
        if (!m || !emoji) return;
        const pid = users.get(socket.id).profile.id;
        const who = (m.reactions[emoji] ||= []);
        const i = who.indexOf(pid);
        if (i >= 0) who.splice(i, 1);
        else who.push(pid);
        if (!who.length) delete m.reactions[emoji];
        save();
        io.emit('msg:update', { channelId, message: m });
      });

      on('typing', ({ channelId }) => {
        if (!thread(channelId)) return;
        socket.broadcast.emit('typing', { channelId, sid: socket.id, name: users.get(socket.id).profile.name });
      });

      // --- bans (anyone can ban or unban, like channels: D3, D27) ---

      on('ban:add', ({ profileId, ip }, ack) => {
        profileId = str(profileId, 64);
        const pid = myId();
        if (!profileId || !Object.hasOwn(state.profiles, profileId)) return ack({ error: 'Unknown user' });
        if (profileId === pid) return ack({ error: 'You can’t ban yourself' });
        if (state.bans.some((b) => b.profileId === profileId)) return ack({ error: 'Already banned' });
        // Skip the IP if it's shared with the person banning (same network,
        // reverse proxy, or the host's own machine): it would ban them too.
        let banIp = ip ? lastIp.get(profileId) || '' : '';
        const ipSkipped = !!ip && (!banIp || banIp === clientIp(socket) || isLoopback(banIp));
        if (ipSkipped) banIp = '';
        const ban = { id: id(), profileId, name: state.profiles[profileId].name, ip: banIp, by: users.get(socket.id).profile.name, ts: Date.now() };
        state.bans.push(ban);
        save();
        kick((s) => s.data.profileId === profileId || (banIp && clientIp(s) === banIp), 'banned');
        io.emit('bans', publicBans());
        ack({ ok: true, ipSkipped });
      });

      // Remove someone from the server: disconnect them and drop them from the
      // member list. Unlike a ban they can come back (and reappear).
      on('member:remove', ({ profileId }, ack) => {
        profileId = str(profileId, 64);
        if (!profileId || !Object.hasOwn(state.profiles, profileId)) return ack({ error: 'Unknown user' });
        if (profileId === myId()) return ack({ error: 'You can’t remove yourself' });
        kick((s) => s.data.profileId === profileId, 'removed');
        delete state.profiles[profileId];
        save();
        io.emit('profile:removed', { id: profileId });
        ack({ ok: true });
      });

      on('ban:remove', ({ id: banId }, ack) => {
        state.bans = state.bans.filter((b) => b.id !== banId);
        save();
        io.emit('bans', publicBans());
        ack({ ok: true });
      });

      // --- server name / icon (anyone can change them, D3) ---

      on('server:update', ({ name, icon, game }, ack) => {
        if (name !== undefined) {
          name = str(name, 40).trim();
          if (!name) return ack({ error: 'Server name required' });
          state.name = name;
        }
        if (icon !== undefined) {
          if (icon && !isImageRef(icon, MAX_ICON_BYTES)) return ack({ error: 'Icon must be an https image link, or png/jpg/gif/webp under 512KB' });
          state.icon = icon || '';
        }
        if (game !== undefined) {
          if (game && !gameRef.current?.available) return ack({ error: gameInfo().reason || 'The game is not available on this server' });
          state.gameEnabled = !!game;
          if (!game) for (const u of users.values()) u.playing = false;
        }
        save();
        io.emit('server', { name: state.name, icon: state.icon, game: gameInfo() });
        if (game === false) broadcastUsers();
        ack({ ok: true });
      });

      // --- channels ---

      on('channel:create', ({ name, type }, ack) => {
        type = type === 'voice' ? 'voice' : 'text';
        name = str(name, MAX_CHANNEL_NAME).trim();
        if (type === 'text') name = name.toLowerCase().replace(/\s+/g, '-');
        if (!name) return ack({ error: 'name required' });
        const ch = { id: id(), name, type };
        state.channels.push(ch);
        save();
        io.emit('channels', state.channels);
        ack({ ok: true, channel: ch });
      });

      on('channel:rename', ({ id: cid, name }) => {
        const ch = channel(cid);
        name = str(name, MAX_CHANNEL_NAME).trim();
        if (!ch || !name) return;
        ch.name = ch.type === 'text' ? name.toLowerCase().replace(/\s+/g, '-') : name;
        save();
        io.emit('channels', state.channels);
      });

      on('channel:delete', ({ id: cid }) => {
        const ch = channel(cid);
        if (!ch || state.channels.filter((c) => c.type === ch.type).length <= 1) return;
        state.channels = state.channels.filter((c) => c.id !== cid);
        delete state.messages[cid];
        deleteFiles(state.files.filter((f) => f.channelId === cid).map((f) => f.id));
        for (const [sid, u] of users) {
          if (u.voice === cid) {
            const s = io.sockets.sockets.get(sid);
            if (s) leaveVoice(s);
            io.to(sid).emit('voice:kicked');
          }
        }
        save();
        io.emit('channels', state.channels);
        broadcastUsers();
      });

      // --- files ---

      // Attached files of one channel, or of the whole server; newest first
      on('file:list', ({ channelId }, ack) => {
        const cid = str(channelId, 32);
        const files = state.files.filter((f) => f.messageId && (!cid || f.channelId === cid));
        ack({ files: files.map(publicFile).sort((a, b) => b.ts - a.ts), storage: usage() });
      });

      // Anyone can delete any file (trust model: friends, D3)
      on('file:delete', ({ ids }, ack) => {
        deleteFiles((Array.isArray(ids) ? ids : []).map((x) => str(x, 64)));
        ack({ ok: true });
      });

      // --- custom emojis ---

      on('emoji:add', ({ name, url }, ack) => {
        name = str(name, 32).toLowerCase().replace(/[^a-z0-9_]/g, '');
        if (!name) return ack({ error: 'Name must be letters, numbers or _' });
        if (!isDataImage(url, MAX_EMOJI_BYTES)) return ack({ error: 'Image must be png/jpg/gif/webp under 256KB' });
        state.emojis = state.emojis.filter((e) => e.name !== name);
        state.emojis.push({ name, url, by: users.get(socket.id).profile.name });
        save();
        io.emit('emojis', state.emojis);
        ack({ ok: true });
      });

      on('emoji:remove', ({ name }) => {
        state.emojis = state.emojis.filter((e) => e.name !== name);
        save();
        io.emit('emojis', state.emojis);
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
        leaveVoice(socket);
        const u = users.get(socket.id);
        const peers = [...users.entries()].filter(([, x]) => x.voice === channelId).map(([sid]) => sid);
        u.voice = channelId;
        socket.join('voice:' + channelId);
        ack({ ok: true, peers });
        broadcastUsers();
      });

      on('voice:leave', () => {
        leaveVoice(socket);
        broadcastUsers();
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
        const stored = Object.hasOwn(state.profiles, u.profile.id) && state.profiles[u.profile.id];
        if (stored) {
          stored.seen = Date.now();
          save();
          io.emit('profile', { id: u.profile.id, ...stored });
        }
        broadcastUsers();
      });
    });

    return io;
  }

  const server = await createServer();
  const io = (ioRef.current = attach(server));
  // opts.game === false (GAME=off): don't serve or start the game at all
  const game =
    opts.game === false
      ? { available: false, reason: 'The game is turned off by the server host.' }
      : await startGame({ app, httpServer: server, dataDir: DATA_DIR, express, assetsDir: opts.gameAssetsDir }).catch((err) => {
          console.error('[game] failed to start:', err);
          return { available: false, reason: 'The game server failed to start: ' + err.message };
        });
  gameRef.current = game;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  });
  updater.start();
  const port = server.address().port;
  return {
    port,
    version: VERSION,
    update: updater.info(),
    https: USE_HTTPS,
    fingerprint,
    name: state.name,
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
        updater.stop();
        writeState();
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

module.exports = { startServer, lanAddresses };

if (require.main === module) {
  const env = process.env;
  startServer({
    port: Number(env.PORT) || 3000,
    https: env.HTTPS === '1' || env.HTTPS === 'true',
    dataDir: env.DATA_DIR,
    serverName: env.SERVER_NAME,
    password: env.PASSWORD,
    giphyKey: env.GIPHY_API_KEY,
    maxStorage: env.MAX_STORAGE,
    game: !/^(off|0|false|no)$/i.test(env.GAME || ''),
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
    console.log(`\n  friendspeak server "${s.name}" is running\n`);
    console.log(`  Local address:     ${scheme}://localhost:${s.port}  (connect with the desktop app)`);
    for (const ip of lanAddresses()) console.log(`  Friends connect:   ${ip}:${s.port}`);
    if (s.fingerprint) console.log(`  Certificate:       ${s.fingerprint}`);
    if (env.PASSWORD) console.log('  Password protected: yes');
    if (env.GIPHY_API_KEY) console.log('  GIPHY: server key configured');
    console.log(`  Version:           ${s.version}` + (s.update.mode === 'off' ? '' : `  (updates: ${s.update.mode === 'on' ? 'automatic, cron "' + s.update.cron + '"' : 'notify only'})`));
    console.log(`  File storage:      ${fmtBytes(s.storage.used)} of ${fmtBytes(s.storage.max)} used`);
    console.log(`  Penguin game:      ${env.GAME && /^(off|0|false|no)$/i.test(env.GAME) ? 'off (GAME=off)' : !s.game.available ? s.game.reason : s.gameEnabled ? 'ready (' + s.game.worldName + ')' : 'turned off (Settings → Server)'}`);
    console.log('');

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
    process.exit(1);
  });
}
