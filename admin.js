// The admin dashboard (D34): a web page served by the friendspeak server
// itself, plus the JSON API and the event stream behind it. Its path is random,
// made on the first start (D52); ADMIN_PATH picks another or the plain /admin.
//
// Access: a request from this very machine (loopback peer, localhost Host, no
// proxy headers) needs no key. Everything else needs an admin key and TLS, and
// a code from the authenticator app set up at the key's first sign-in (D52).
// Keys are 32 random bytes, stored only as SHA-256 hashes in DATA_DIR/admin.json.
// Sessions are opaque tokens held in memory. There are no accounts (D3): this
// is the one place that is gated, because it shows IPs and logs.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COOKIE = 'fs_admin';
const SESSION_MAX = 12 * 3600e3; // absolute
const SESSION_IDLE = 3600e3; // sliding
const AUDIT_MAX = 5 * 1024 * 1024;
const MAX_KEYS = 50;
const MAX_TRACKED_IPS = 10000;
const FREE_FAILURES = 5;
const PLAIN_PATH = '/admin';
// Paths the server already answers on: ADMIN_PATH can't be one of them
const TAKEN_PATHS = /^\/(api|files|game|assets|world|socket\.io)$/i;
const ENROLL_TTL = 600e3; // how long a 2-step setup waits for its first code

const sha256 = (v) => crypto.createHash('sha256').update(v).digest();
const sha256hex = (v) => sha256(v).toString('hex');
const isLoopbackAddr = (a) => a === '::1' || a.startsWith('127.');
const peerOf = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
const hostnameOf = (host) => {
  host = String(host || '').toLowerCase();
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
};
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const cleanName = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) : '');
const clampInt = (v, def, max) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : def;
};

// ---------- TOTP (RFC 6238: SHA-1, 6 digits, 30 s) ----------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const isBase32 = (v) => typeof v === 'string' && /^[A-Z2-7]{16,64}$/.test(v);
function base32(buf) {
  let out = '';
  let v = 0;
  let bits = 0;
  for (const b of buf) {
    v = (v << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(v >>> (bits - 5)) & 31];
      bits -= 5;
    }
    v &= (1 << bits) - 1;
  }
  return bits ? out + B32[(v << (5 - bits)) & 31] : out;
}
function unbase32(text) {
  const out = [];
  let v = 0;
  let bits = 0;
  for (const ch of text) {
    v = (v << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((v >>> (bits - 8)) & 255);
      bits -= 8;
    }
    v &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}
function totpAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest();
  return String((mac.readUInt32BE(mac[19] & 15) & 0x7fffffff) % 1e6).padStart(6, '0');
}
// The time step a 6-digit code is good for: this one or a neighbor, and newer
// than `after` (a code works once). 0 = wrong code.
function totpStep(secret, code, after, now) {
  const cur = Math.floor(now / 30e3);
  let found = 0;
  for (const step of [cur - 1, cur, cur + 1]) {
    const ok = crypto.timingSafeEqual(Buffer.from(totpAt(secret, step)), Buffer.from(code));
    if (ok && step > after && !found) found = step;
  }
  return found;
}

const HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function createAdmin(ctx) {
  const { app, express, dataDir, logs, options = {} } = ctx;
  const crashes = ctx.crashes || { list: () => [], get: () => null, remove: () => false, clear: () => 0 };
  const KEYS_FILE = path.join(dataDir, 'admin.json');
  const AUDIT_FILE = path.join(dataDir, 'admin-audit.log');
  const UI_DIR = path.join(__dirname, 'admin-ui');
  const localAllowed = options.local !== false;
  const mfaOn = options.mfa !== false;

  // ---------- keys ----------

  const newSecret = () => 'fsa_' + crypto.randomBytes(32).toString('base64url');
  // What a key's authenticator app shares with the server: { secret (base32), last (the time step of the last code used) }
  const cleanTotp = (t) => (t && isBase32(t.secret) ? { secret: t.secret, last: Number(t.last) || 0 } : null);
  let stored = []; // { id, name, hash, created, lastUsed, bootstrap?, totp? }
  let storedPath = null; // the generated dashboard path
  let envTotp = null; // the ADMIN_KEY key's { secret, last, hash }: it has no entry in `stored`
  try {
    const j = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    stored = (Array.isArray(j.keys) ? j.keys : []).filter((k) => k && typeof k.id === 'string' && typeof k.hash === 'string' && /^[0-9a-f]{64}$/.test(k.hash)).map((k) => ({ id: k.id, name: cleanName(k.name) || 'key', hash: k.hash, created: Number(k.created) || Date.now(), lastUsed: Number(k.lastUsed) || null, bootstrap: !!k.bootstrap, totp: cleanTotp(k.totp) }));
    if (typeof j.path === 'string' && /^\/admin-[0-9a-f]{32}$/.test(j.path)) storedPath = j.path;
    if (cleanTotp(j.envTotp) && typeof j.envTotp.hash === 'string') envTotp = { ...cleanTotp(j.envTotp), hash: j.envTotp.hash };
  } catch {}
  function saveKeys() {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = KEYS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ path: storedPath || undefined, keys: stored.map((k) => ({ ...k, totp: k.totp || undefined })), envTotp: envTotp || undefined }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, KEYS_FILE);
  }

  // Where the dashboard is (D52): a random path made once and kept, unless
  // ADMIN_PATH names one (`false` = the plain /admin).
  const BASE = (() => {
    if (options.path === false) return PLAIN_PATH;
    if (typeof options.path === 'string' && options.path.trim()) {
      const p = '/' + options.path.trim().replace(/^\/+|\/+$/g, '');
      if (/^\/[A-Za-z0-9_~-][A-Za-z0-9._~-]{0,63}$/.test(p) && !TAKEN_PATHS.test(p)) return p;
      console.error('[admin] ADMIN_PATH must be one path segment of letters, digits, "-", "_", "." or "~" that the server doesn’t already use; it is ignored');
    }
    if (!storedPath) {
      storedPath = '/admin-' + crypto.randomBytes(16).toString('hex');
      saveKeys();
    }
    return storedPath;
  })();
  if (BASE !== PLAIN_PATH) logs.redact?.(BASE); // the stored log never holds it

  let envKey = null;
  if (options.key) {
    if (String(options.key).length >= 16) envKey = { id: 'env', name: 'ADMIN_KEY (env)', hash: sha256hex(String(options.key)), created: ctx.startedAt, lastUsed: null, env: true };
    else console.error('[admin] ADMIN_KEY is shorter than 16 characters and is ignored');
  }
  if (!envKey && !stored.length) {
    const secret = newSecret();
    stored.push({ id: crypto.randomBytes(8).toString('hex'), name: 'First-boot key', hash: sha256hex(secret), created: Date.now(), lastUsed: null, bootstrap: true });
    saveKeys();
    // stdout, not console: the key must never enter the log buffer the dashboard shows
    process.stdout.write(
      `\n  Admin key (generated on first boot):\n\n    ${secret}\n\n` +
        '  This is the only time it is shown. Use it to sign in to the admin dashboard\n' +
        '  (its address is printed at every start; set ADMIN_KEY to choose your own key instead).\n\n'
    );
  }

  const isActive = (k) => !(k.bootstrap && envKey);
  const allKeys = () => (envKey ? [envKey, ...stored] : stored);
  const findKey = (kid) => allKeys().find((k) => k.id === kid);
  // A changed ADMIN_KEY is a new key: it sets up 2-step again
  const totpOf = (k) => (k.env ? (envTotp && envTotp.hash === k.hash ? envTotp : null) : k.totp || null);
  const setTotp = (k, t) => {
    if (k.env) envTotp = t && { ...t, hash: k.hash };
    else k.totp = t;
  };
  const keyView = (k, current) => ({ id: k.id, name: k.name, created: k.created, lastUsed: k.lastUsed || null, env: !!k.env, bootstrap: !!k.bootstrap, active: isActive(k), current: k.id === current, mfa: !!totpOf(k) });

  // Compare the submitted key against every active key, without stopping at the first match
  function matchKey(secret) {
    const given = sha256(secret);
    let found = null;
    for (const k of allKeys()) {
      const ok = crypto.timingSafeEqual(given, Buffer.from(k.hash, 'hex')) && isActive(k);
      if (ok && !found) found = k;
    }
    return found;
  }

  // ---------- audit ----------

  function audit(actor, ip, action, detail = '') {
    try {
      try {
        if (fs.statSync(AUDIT_FILE).size > AUDIT_MAX) fs.renameSync(AUDIT_FILE, AUDIT_FILE + '.1');
      } catch {}
      fs.appendFileSync(AUDIT_FILE, JSON.stringify({ ts: Date.now(), actor, ip, action, detail: String(detail).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) }) + '\n', { mode: 0o600 });
    } catch (err) {
      console.error('[admin] could not write the audit log:', err.message);
    }
  }
  function readAudit(before, limit) {
    const out = [];
    for (const file of [AUDIT_FILE, AUDIT_FILE + '.1']) {
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const rows = text.split('\n');
      for (let i = rows.length - 1; i >= 0 && out.length <= limit; i--) {
        if (!rows[i]) continue;
        try {
          const e = JSON.parse(rows[i]);
          if (e.ts < before) out.push({ ts: e.ts, actor: str(e.actor, 80), ip: str(e.ip, 64), action: str(e.action, 40), detail: str(e.detail, 200) });
        } catch {}
      }
      if (out.length > limit) break;
    }
    return { entries: out.slice(0, limit), more: out.length > limit };
  }

  // ---------- request classification ----------

  const hasProxyHeaders = (req) => ['x-forwarded-for', 'forwarded', 'x-real-ip'].some((h) => req.headers[h] !== undefined);
  const hostIsLocal = (req) => ['localhost', '127.0.0.1', '[::1]'].includes(hostnameOf(req.headers.host));
  const isTls = (req) => req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
  function classify(req) {
    const ip = peerOf(req);
    const direct = isLoopbackAddr(ip) && hostIsLocal(req);
    const local = localAllowed && direct && !hasProxyHeaders(req);
    const tls = isTls(req);
    // A key over plain HTTP is only fine when it never leaves this machine
    return { ip, local, tls, canLogin: tls || (direct && !hasProxyHeaders(req)) };
  }

  // ---------- sessions ----------

  const sessions = new Map(); // sha256(token) hex -> { keyId, actor, created, seen }
  const parseCookies = (header) => {
    const out = {};
    for (const part of String(header || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  };
  const sessionExpired = (s, now) => now - s.created > SESSION_MAX || now - s.seen > SESSION_IDLE || !findKey(s.keyId) || !isActive(findKey(s.keyId));
  function sessionOf(req, touch) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const sk = sha256hex(token);
    const s = sessions.get(sk);
    if (!s) return null;
    if (sessionExpired(s, Date.now())) return sessions.delete(sk), null;
    if (touch) s.seen = Date.now();
    s.sk = sk;
    return s;
  }
  const pruneTimer = setInterval(() => {
    const now = Date.now();
    for (const [sk, s] of sessions) if (sessionExpired(s, now)) sessions.delete(sk);
    for (const [id, e] of enrolling) if (e.expires <= now) enrolling.delete(id);
    for (const [id, f] of codeFails) if (now - f.last > 24 * 3600e3) codeFails.delete(id);
    pruneLimits(now);
  }, 60e3);
  pruneTimer.unref();

  // The identity behind a request: { local, actor, keyId, sk } or null
  function who(req, touch = true) {
    if (classify(req).local) return { local: true, actor: 'local', keyId: null, sk: null };
    const s = sessionOf(req, touch);
    return s ? { local: false, actor: s.actor, keyId: s.keyId, sk: s.sk } : null;
  }

  // ---------- rate limit ----------

  const failures = new Map(); // ip -> { n, until, last }
  let recent = []; // timestamps of failed logins, any IP
  let globalUntil = 0;
  function pruneLimits(now) {
    for (const [ip, f] of failures) if (now - f.last > 24 * 3600e3) failures.delete(ip);
    recent = recent.filter((t) => now - t < 600e3);
  }
  function lockedFor(ip, now) {
    // The global lock only applies to an IP that has already failed. Otherwise
    // anyone could keep it on forever and block the real admin (a clean IP is
    // still held back by nothing but the per-IP rules).
    return Math.max(0, failures.has(ip) ? globalUntil - now : 0, (failures.get(ip)?.until || 0) - now);
  }
  function noteFailure(ip, now) {
    let f = failures.get(ip);
    if (!f) {
      if (failures.size >= MAX_TRACKED_IPS) {
        pruneLimits(now);
        if (failures.size >= MAX_TRACKED_IPS) failures.delete(failures.keys().next().value);
      }
      f = { n: 0, until: 0, last: now };
      failures.set(ip, f);
    }
    f.n++;
    f.last = now;
    // The 5th failure in a row starts the first lockout: 30 s, doubling up to 1 h
    if (f.n >= FREE_FAILURES) f.until = now + Math.min(30e3 * 2 ** (f.n - FREE_FAILURES), 3600e3);
    recent.push(now);
    recent = recent.filter((t) => now - t < 600e3);
    if (recent.length > 100) globalUntil = now + 60e3;
  }

  // ---------- 2-step sign-in (D52) ----------

  const enrolling = new Map(); // key id -> { secret, expires }: shown at a key's first sign-in, kept once a code proves the app has it
  const codeFails = new Map(); // key id -> { n, until, last }: wrong codes are also counted per key, whatever address they come from
  function enrollment(key, now) {
    let e = enrolling.get(key.id);
    if (!e || e.expires <= now) enrolling.set(key.id, (e = { secret: base32(crypto.randomBytes(20)), expires: now + ENROLL_TTL }));
    const account = `${ctx.state().name} (${key.name})`.slice(0, 60);
    return { secret: e.secret, uri: `otpauth://totp/friendspeak:${encodeURIComponent(account)}?secret=${e.secret}&issuer=friendspeak` };
  }
  function noteCodeFailure(keyId, now) {
    const f = codeFails.get(keyId) || { n: 0, until: 0, last: now };
    f.n++;
    f.last = now;
    if (f.n >= FREE_FAILURES) f.until = now + Math.min(30e3 * 2 ** (f.n - FREE_FAILURES), 3600e3);
    codeFails.set(keyId, f);
  }
  const forgetMfa = (keyId) => (enrolling.delete(keyId), codeFails.delete(keyId));

  // ---------- event stream ----------

  const streams = new Set(); // { res, sk }
  function send(st, event, data, eventId) {
    try {
      st.res.write((eventId ? `id: ${eventId}\n` : '') + `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {}
  }
  const endStream = (st, reason) => {
    send(st, 'bye', { reason });
    streams.delete(st);
    try {
      st.res.end();
    } catch {}
  };
  const unsubscribeLogs = logs.on((line) => {
    for (const st of streams) send(st, 'log', line, line.id);
  });
  const pending = new Map(); // topic -> timer, so a burst of changes is one event
  function notify(topic) {
    if (pending.has(topic) || !streams.size) return;
    const t = setTimeout(() => {
      pending.delete(topic);
      for (const st of streams) send(st, 'change', { topic });
    }, 250);
    t.unref();
    pending.set(topic, t);
  }
  const pingTimer = setInterval(() => {
    const now = Date.now();
    for (const st of [...streams]) {
      const s = st.sk ? sessions.get(st.sk) : null;
      if (st.sk && (!s || sessionExpired(s, now))) {
        if (s) sessions.delete(st.sk);
        endStream(st, 'expired');
      } else {
        if (s) s.seen = now; // an open stream counts as activity; the 12 h limit still applies
        send(st, 'ping', {});
      }
    }
  }, 25e3);
  pingTimer.unref();

  function revokeSessions(keyId) {
    const gone = new Set();
    for (const [sk, s] of sessions) if (s.keyId === keyId) sessions.delete(sk), gone.add(sk);
    for (const st of [...streams]) if (st.sk && gone.has(st.sk)) endStream(st, 'expired');
  }

  // ---------- routes ----------

  // This machine may still ask at /admin: it needs no key, so the path is no secret to it. Anyone else gets the 404 of any unknown path.
  if (BASE !== PLAIN_PATH) app.use(PLAIN_PATH, (req, res, next) => (classify(req).local ? res.set(HEADERS).redirect(302, BASE + '/') : next()));

  app.use(BASE, (req, res, next) => {
    res.set(HEADERS);
    // <path> → <path>/ (relative URLs in the page need the slash)
    if (req.path === '/' && !req.originalUrl.split('?')[0].endsWith('/')) return res.redirect(302, BASE + '/' + (req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : ''));
    next();
  });

  const api = express.Router();
  app.use(BASE + '/api', api);

  // State-changing requests: JSON only, same origin. Applies to local requests too,
  // so a web page open in the host's browser can't drive the dashboard.
  api.use((req, res, next) => {
    // A page on another origin (or another port of localhost) has no business here, even for GET
    const site = req.headers['sec-fetch-site'];
    if (site === 'cross-site' || site === 'same-site') return res.status(403).json({ error: 'Cross-site request refused' });
    next();
  });
  api.use((req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const fail = (error) => res.status(403).json({ error });
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) return fail('Content-Type must be application/json');
    let originHost = null;
    try {
      originHost = new URL(String(req.headers.origin || '')).host;
    } catch {}
    if (!originHost || originHost !== req.headers.host) return fail('Cross-origin request refused. Behind a reverse proxy, make sure it passes the original Host header.');
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') return fail('Cross-origin request refused');
    next();
  });
  api.use(express.json({ limit: '1mb' }));

  const cookieHeader = (value, maxAge, tls) => `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=${BASE}; Max-Age=${maxAge}` + (tls ? '; Secure' : '');

  api.get('/session', (req, res) => {
    const c = classify(req);
    const me = who(req);
    res.json({ authed: !!me, local: !!me?.local, actor: me ? me.actor : null, tls: c.tls, canLogin: c.canLogin, mfa: mfaOn, fingerprint: ctx.fingerprint(), name: ctx.state().name, version: ctx.version });
  });

  api.post('/login', (req, res) => {
    const c = classify(req);
    if (c.local) return res.json({ ok: true, actor: 'local' });
    if (!c.canLogin) return res.status(400).json({ error: 'Signing in needs HTTPS. Start the server with HTTPS=1 or put it behind a TLS reverse proxy.' });
    const now = Date.now();
    const wait = lockedFor(c.ip, now);
    if (wait > 0) {
      const retryAfter = Math.ceil(wait / 1000);
      return res.set('Retry-After', String(retryAfter)).status(429).json({ error: 'Too many attempts. Try again later.', retryAfter });
    }
    const secret = req.body && typeof req.body.key === 'string' ? req.body.key.slice(0, 200) : '';
    if (!secret) return res.status(400).json({ error: 'Key required' });
    const key = matchKey(secret);
    if (!key) {
      noteFailure(c.ip, now);
      audit('', c.ip, 'login.failed');
      console.log(`[admin] failed sign-in from ${c.ip}`);
      return res.status(401).json({ error: 'Wrong key' });
    }
    // The second step: a code from the authenticator app, which a key sets up the first time it signs in
    if (mfaOn) {
      const code = typeof req.body.code === 'string' ? req.body.code.replace(/\s/g, '').slice(0, 12) : '';
      const totp = totpOf(key);
      const pend = enrolling.get(key.id);
      const setup = !totp && (!code || !pend || pend.expires <= now);
      if (setup) return res.json({ mfa: 'setup', ...enrollment(key, now), expired: !!code });
      if (!code) return res.json({ mfa: 'code' });
      const keyWait = (codeFails.get(key.id)?.until || 0) - now;
      if (keyWait > 0) {
        const retryAfter = Math.ceil(keyWait / 1000);
        return res.set('Retry-After', String(retryAfter)).status(429).json({ error: 'Too many attempts. Try again later.', retryAfter });
      }
      const step = /^\d{6}$/.test(code) ? totpStep((totp || pend).secret, code, totp ? totp.last : 0, now) : 0;
      if (!step) {
        noteFailure(c.ip, now);
        noteCodeFailure(key.id, now);
        audit(key.name, c.ip, 'login.failed', 'wrong code');
        console.log(`[admin] failed sign-in from ${c.ip}: wrong code for the key "${key.name}"`);
        return res.status(401).json({ error: 'Wrong code' });
      }
      if (totp) totp.last = step;
      else {
        setTotp(key, { secret: pend.secret, last: step });
        audit(key.name, c.ip, 'mfa.setup');
        console.log(`[admin] 2-step sign-in set up for the key "${key.name}"`);
      }
      forgetMfa(key.id);
    }
    failures.delete(c.ip);
    key.lastUsed = now;
    saveKeys();
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(sha256hex(token), { keyId: key.id, actor: key.name, created: now, seen: now });
    res.set('Set-Cookie', cookieHeader(token, SESSION_MAX / 1000, c.tls));
    audit(key.name, c.ip, 'login');
    console.log(`[admin] ${key.name} signed in from ${c.ip}`);
    notify('keys');
    res.json({ ok: true, actor: key.name });
  });

  // Everything below needs a local request or a session
  api.use((req, res, next) => {
    const me = who(req);
    if (!me) return res.status(401).json({ error: 'Sign in required', login: true });
    req.admin = me;
    next();
  });

  api.post('/logout', (req, res) => {
    const c = classify(req);
    if (req.admin.sk) {
      sessions.delete(req.admin.sk);
      for (const st of [...streams]) if (st.sk === req.admin.sk) endStream(st, 'expired');
      audit(req.admin.actor, c.ip, 'logout');
      console.log(`[admin] ${req.admin.actor} signed out`);
    }
    res.set('Set-Cookie', cookieHeader('', 0, c.tls)).json({ ok: true });
  });

  api.get('/overview', (req, res) => {
    const st = ctx.state();
    const mem = process.memoryUsage();
    res.json({
      name: st.name,
      icon: st.icon,
      version: ctx.version,
      startedAt: ctx.startedAt,
      uptime: Math.round(process.uptime()),
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      memory: { rss: mem.rss, heapUsed: mem.heapUsed },
      docker: !!ctx.inDocker,
      https: !!ctx.https,
      fingerprint: ctx.fingerprint(),
      inviteOnly: st.inviteOnly !== false,
      invites: st.invites.filter((v) => !v.revoked && !(v.expires && v.expires <= Date.now()) && !(v.maxUses && v.uses >= v.maxUses)).length, // the ones that still work
      adminLocal: localAllowed,
      adminMfa: mfaOn,
      adminPathHidden: BASE !== PLAIN_PATH,
      counts: { online: ctx.users.size, profiles: Object.keys(st.profiles).length, bans: st.bans.length, channels: st.channels.length },
      storage: ctx.usage(),
      game: ctx.gameInfo(),
      update: ctx.updater.status(),
      crashes: crashesSummary(),
      logs: logs.info(),
    });
  });

  // ---------- logs and crash reports (#50, #51) ----------

  const crashesSummary = () => {
    const list = crashes.list();
    return { count: list.length, last: list.length ? list[0].ts : null };
  };
  // Express 5 forwards a rejected promise to the error handler; this answers it as JSON
  const guard = (fn) => (req, res) =>
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error(`[admin] ${req.method} ${req.path} failed:`, err && err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    });
  const msOrUndef = (v) => (typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
  // The filters of /logs and /logs/export, from the query string
  const logFilters = (q) => {
    const levels = typeof q.level === 'string' && q.level ? q.level.split(',').map((x) => x.trim()).filter((x) => ['debug', 'info', 'warn', 'error'].includes(x)) : undefined;
    return {
      before: msOrUndef(q.before),
      from: msOrUndef(q.from),
      to: msOrUndef(q.to),
      levels: levels && levels.length ? levels : undefined,
      source: typeof q.source === 'string' && q.source ? (q.source === '-' ? '' : q.source.slice(0, 32).toLowerCase()) : undefined,
      q: typeof q.q === 'string' ? q.q.slice(0, 200) : undefined,
    };
  };

  api.get('/logs', guard(async (req, res) => {
    res.json(await logs.query({ ...logFilters(req.query), limit: clampInt(req.query.limit, 500, 2000) }));
  }));

  api.get('/logs/info', (_req, res) => res.json(logs.info()));

  api.get('/logs/export', guard(async (req, res) => {
    const f = logFilters(req.query);
    const { lines } = await logs.query({ ...f, limit: clampInt(req.query.limit, 20000, 100000) });
    const now = new Date();
    const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const filters = [f.q && `text contains "${f.q.replace(/[\u0000-\u001f\u007f]/g, ' ')}"`, f.levels && `levels ${f.levels.join(',')}`, f.source !== undefined && `source ${f.source || '(none)'}`, f.from !== undefined && `from ${new Date(f.from).toISOString()}`, f.to !== undefined && `to ${new Date(f.to).toISOString()}`, f.before !== undefined && `before id ${f.before}`].filter(Boolean);
    const head = [`friendspeak server log: ${ctx.state().name.replace(/[\u0000-\u001f\u007f]/g, ' ')}`, `version ${ctx.version}`, `exported ${now.toISOString()}`, `filters: ${filters.join('; ') || 'none'}`, `${lines.length} lines`, ''];
    res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="friendspeak-log-${stamp}.txt"` });
    res.send(head.join('\n') + '\n' + lines.map((l) => `${new Date(l.ts).toISOString()} ${l.level.toUpperCase().padEnd(5)} ${l.text}`).join('\n') + (lines.length ? '\n' : ''));
  }));

  api.get('/crashes', (_req, res) => res.json({ crashes: crashes.list() }));
  api.get('/crashes/:id', (req, res) => {
    const r = crashes.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'No such crash report' });
    res.json(r);
  });
  api.delete('/crashes/:id', (req, res) => {
    if (!crashes.remove(req.params.id)) return res.status(404).json({ error: 'No such crash report' });
    audit(req.admin.actor, peerOf(req), 'crash.delete', req.params.id);
    notify('crashes');
    res.json({ ok: true });
  });
  api.delete('/crashes', (req, res) => {
    const removed = crashes.clear();
    audit(req.admin.actor, peerOf(req), 'crash.clear', `${removed} reports`);
    notify('crashes');
    res.json({ ok: true, removed });
  });

  api.get('/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 5000\n\n');
    const st = { res, sk: req.admin.sk };
    // A reconnecting EventSource says where it left off: replay what it missed
    const last = Number(req.headers['last-event-id']);
    if (Number.isInteger(last) && last > 0) for (const line of logs.lines({ limit: 2000 }).lines) if (line.id > last) send(st, 'log', line, line.id);
    streams.add(st);
    res.on('close', () => streams.delete(st));
  });

  api.get('/keys', (req, res) => res.json({ keys: allKeys().map((k) => keyView(k, req.admin.keyId)), mfa: mfaOn }));

  api.post('/keys', (req, res) => {
    const name = cleanName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Name required (1 to 40 characters)' });
    if (stored.length >= MAX_KEYS) return res.status(400).json({ error: `At most ${MAX_KEYS} keys` });
    const secret = newSecret();
    const key = { id: crypto.randomBytes(8).toString('hex'), name, hash: sha256hex(secret), created: Date.now(), lastUsed: null, bootstrap: false };
    stored.push(key);
    saveKeys();
    audit(req.admin.actor, peerOf(req), 'key.create', name);
    console.log(`[admin] ${req.admin.actor} created the key "${name}"`);
    notify('keys');
    res.json({ ok: true, key: keyView(key, req.admin.keyId), secret });
  });

  api.delete('/keys/:id', (req, res) => {
    const k = stored.find((x) => x.id === req.params.id);
    if (!k) return res.status(400).json({ error: req.params.id === 'env' ? 'The ADMIN_KEY key is set in the server environment; remove it there' : 'No such key' });
    stored = stored.filter((x) => x !== k);
    saveKeys();
    forgetMfa(k.id);
    revokeSessions(k.id);
    audit(req.admin.actor, peerOf(req), 'key.revoke', k.name);
    console.log(`[admin] ${req.admin.actor} revoked the key "${k.name}"`);
    notify('keys');
    res.json({ ok: true });
  });

  // A lost phone: the key sets 2-step up again at its next sign-in
  api.post('/keys/:id/mfa/reset', (req, res) => {
    const k = findKey(req.params.id);
    if (!k) return res.status(400).json({ error: 'No such key' });
    if (!totpOf(k)) return res.status(400).json({ error: '2-step sign-in isn’t set up for that key' });
    setTotp(k, null);
    saveKeys();
    forgetMfa(k.id);
    audit(req.admin.actor, peerOf(req), 'key.mfa.reset', k.name);
    console.log(`[admin] ${req.admin.actor} reset 2-step sign-in for the key "${k.name}"`);
    notify('keys');
    res.json({ ok: true });
  });

  api.get('/audit', (req, res) => {
    const before = Number.isFinite(Number(req.query.before)) && req.query.before !== undefined && req.query.before !== '' ? Number(req.query.before) : Infinity;
    res.json(readAudit(before, clampInt(req.query.limit, 200, 1000)));
  });

  // ---------- users, bans and roles (D34) ----------
  // The same actions the chat sockets use (server.js), credited to the dashboard.

  const BY = 'Admin dashboard';
  const actions = ctx.actions;
  // The actor of everything below: it may do anything that is valid (`label` is for the log)
  const dash = (req) => ({ dashboard: true, label: req.admin.actor });
  const rolesOf = (st, pid) => (Object.hasOwn(st.memberRoles, pid) ? st.memberRoles[pid] : []);
  const roleNames = (st, ids) => (ids.length ? ids.map((x) => st.roles.find((r) => r.id === x)?.name || '?').join(', ') : 'none');
  // A short fingerprint of the key a profile id is pinned to (D42), or null
  const keyOf = (st, pid) => (st.pins[pid] ? st.pins[pid].slice(0, 8) : null);
  const urlId = (v) => (typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : '');
  // 400 with the action's own message, or run `done` and answer ok
  const answer = (res, r, done) => {
    if (r.error) return res.status(400).json({ error: r.error });
    if (done) done(r);
    res.json(r);
  };
  const logAction = (req, action, detail) => {
    detail = String(detail).replace(/[\u0000-\u001f\u007f]/g, ' '); // names are user input
    audit(req.admin.actor, peerOf(req), action, detail);
    // What the shared actions do is logged by server.js ([mod], [server]), with this actor
    if (!/^(user|ban|role|perms|server|invite)\./.test(action)) console.log(`[admin] ${req.admin.actor}: ${action} ${detail}`.trim());
  };

  api.get('/users', (req, res) => {
    const st = ctx.state();
    const online = [];
    const onlineIds = new Set();
    for (const [sid, u] of ctx.users) {
      const p = u.profile;
      onlineIds.add(p.id);
      online.push({
        sid,
        id: p.id,
        name: p.name,
        color: p.color,
        avatar: p.avatar,
        status: p.status,
        ip: u.ip || '',
        since: u.since || null,
        voice: u.voice,
        voiceName: u.voice ? st.channels.find((c) => c.id === u.voice)?.name || null : null,
        muted: !!u.muted,
        deafened: !!u.deafened,
        sharing: !!u.sharing,
        camera: !!u.camera,
        playing: !!u.playing,
        roles: rolesOf(st, p.id),
        key: keyOf(st, p.id),
      });
    }
    const banned = new Set(st.bans.map((b) => b.profileId));
    const offline = Object.entries(st.profiles)
      .filter(([pid]) => !onlineIds.has(pid) && !banned.has(pid))
      .map(([pid, p]) => ({ id: pid, name: p.name, color: p.color, avatar: p.avatar, status: p.status, seen: p.seen || null, lastIp: ctx.lastIp.get(pid) || null, roles: rolesOf(st, pid), key: keyOf(st, pid) }));
    res.json({ online, offline, bans: st.bans.map((b) => ({ id: b.id, profileId: b.profileId, name: b.name, ip: b.ip || '', by: b.by, ts: b.ts })), roles: st.roles });
  });

  api.post('/users/:profileId/remove', (req, res) => {
    const pid = urlId(req.params.profileId);
    const name = Object.hasOwn(ctx.state().profiles, pid) ? ctx.state().profiles[pid].name : '';
    answer(res, actions.removeMember(dash(req), { profileId: pid }), () => logAction(req, 'user.remove', name));
  });

  api.post('/users/:profileId/reset-key', (req, res) => {
    const pid = urlId(req.params.profileId);
    const name = Object.hasOwn(ctx.state().profiles, pid) ? ctx.state().profiles[pid].name : pid;
    answer(res, actions.resetKey(pid, dash(req)), () => logAction(req, 'user.key.reset', name));
  });

  api.post('/bans', (req, res) => {
    const pid = urlId(req.body?.profileId);
    const name = Object.hasOwn(ctx.state().profiles, pid) ? ctx.state().profiles[pid].name : '';
    const ip = req.body?.ip === true;
    answer(res, actions.ban(dash(req), { profileId: pid, ip, by: BY, selfIp: peerOf(req) }), (r) => logAction(req, 'ban.add', name + (ip && !r.ipSkipped ? ' (and their IP)' : '')));
  });

  api.delete('/bans/:id', (req, res) => {
    const ban = ctx.state().bans.find((b) => b.id === req.params.id);
    answer(res, actions.unban(dash(req), req.params.id), () => ban && logAction(req, 'ban.remove', ban.name));
  });

  api.get('/roles', (req, res) => {
    const st = ctx.state();
    const profiles = Object.create(null);
    for (const [pid, p] of Object.entries(st.profiles)) profiles[pid] = { name: p.name, color: p.color, avatar: p.avatar };
    res.json({ roles: st.roles, memberRoles: st.memberRoles, profiles, defaultPerms: st.defaultPerms, defaultGrantable: st.defaultGrantable, permissionsOn: st.permissionsOn });
  });

  // Permissions: what everybody gets, and whether they apply yet (open mode until someone is an administrator)
  const permsView = () => {
    const st = ctx.state();
    return { defaultPerms: st.defaultPerms, defaultGrantable: st.defaultGrantable, permissionsOn: st.permissionsOn, roles: st.roles };
  };
  api.get('/permissions', (_req, res) => res.json(permsView()));

  api.put('/permissions', (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const patch = {};
    if (b.perms !== undefined) patch.perms = b.perms;
    if (b.grantable !== undefined) patch.grantable = b.grantable;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change' });
    const was = { ...ctx.state().defaultPerms };
    answer(res, actions.setDefaultPerms(dash(req), patch), () => {
      const now = ctx.state().defaultPerms;
      const what = Object.keys(now).filter((k) => now[k] !== was[k]).map((k) => `${k} ${now[k] ? 'on' : 'off'}`);
      if (patch.grantable !== undefined) what.push('grantable roles');
      logAction(req, 'perms.default', what.join(', ') || 'no change');
    });
  });

  api.post('/roles', (req, res) => {
    const b = req.body || {};
    const role = { name: b.name, color: b.color };
    if (b.perms !== undefined) role.perms = b.perms;
    if (b.grantable !== undefined) role.grantable = b.grantable;
    answer(res, actions.createRole(dash(req), role), (r) => logAction(req, 'role.create', r.role.name + (Object.keys(r.role.perms).length ? ' (with permissions)' : '')));
  });

  api.patch('/roles/:id', (req, res) => {
    const id = urlId(req.params.id);
    const old = ctx.state().roles.find((r) => r.id === id);
    const b = req.body || {};
    const patch = {};
    for (const k of ['name', 'color', 'position', 'perms', 'grantable']) if (b[k] !== undefined) patch[k] = b[k];
    answer(res, actions.updateRole(dash(req), id, patch), (r) => {
      const what = [...new Set(Object.keys(patch).map((k) => (k === 'name' ? `renamed to ${r.role.name}` : k === 'color' ? 'color' : k === 'position' ? `moved to ${patch.position + 1}` : 'permissions')))];
      logAction(req, 'role.update', `${old.name}${what.length ? ': ' + what.join(', ') : ''}`);
    });
  });

  api.delete('/roles/:id', (req, res) => {
    const id = urlId(req.params.id);
    const old = ctx.state().roles.find((r) => r.id === id);
    answer(res, actions.deleteRole(dash(req), id), () => logAction(req, 'role.delete', old.name));
  });

  api.put('/users/:profileId/roles', (req, res) => {
    const pid = urlId(req.params.profileId);
    answer(res, actions.setMemberRoles(dash(req), pid, req.body?.roles), (r) => {
      const st = ctx.state();
      logAction(req, 'role.assign', `${st.profiles[pid].name}: ${roleNames(st, r.roles)}`);
    });
  });

  // ---------- updates, storage, channels, game, server settings (D34) ----------

  const updater = ctx.updater;
  api.get('/updates', (_req, res) => res.json({ ...updater.status(), docker: !!ctx.inDocker }));

  api.get('/updates/preview', (req, res) => {
    // Checked on every keystroke: a schedule that doesn't parse is an answer, not a failed request
    const r = updater.preview(typeof req.query.cron === 'string' ? req.query.cron : undefined);
    res.json(r.error ? { ok: false, error: r.error } : r);
  });

  // mode: off | notify | on, cron: 5 fields; null removes the override (back to AUTO_UPDATE / MAINTENANCE_CRON)
  api.patch('/updates', async (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const patch = {};
    for (const k of ['mode', 'cron']) {
      if (b[k] === undefined) continue;
      if (b[k] !== null && typeof b[k] !== 'string') return res.status(400).json({ error: k === 'mode' ? 'Mode must be off, notify or on' : 'Invalid schedule: expected text' });
      patch[k] = b[k];
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change' });
    const r = await updater.configure(patch);
    answer(res, r.error ? r : { ok: true, update: { ...updater.status(), docker: !!ctx.inDocker } }, () => {
      ctx.saveUpdateSettings(updater.overrides());
      const what = [];
      if (patch.mode !== undefined) what.push(patch.mode === null ? 'mode reset' : `mode ${patch.mode}`);
      if (patch.cron !== undefined) what.push(patch.cron === null ? 'window reset' : `window "${updater.overrides().cron}"`);
      logAction(req, 'update.settings', what.join(', '));
    });
  });

  api.post('/update/check', async (req, res) => {
    const r = await updater.checkNow();
    answer(res, r.error ? r : { ok: true, update: r }, () => logAction(req, 'update.check', r.latest ? `${r.latest.version} available` : 'up to date'));
  });
  api.post('/update/now', async (req, res) => {
    const r = await updater.installSoon();
    answer(res, r.error ? r : { ok: true, update: updater.status() }, () => logAction(req, 'update.now', updater.status().latest?.version || ''));
  });
  api.post('/update/cancel', (req, res) => {
    const r = updater.cancelInstall();
    answer(res, r.error ? r : { ok: true, update: updater.status() }, () => logAction(req, 'update.cancel', ''));
  });

  const DELETED = '(deleted channel)';
  const DATA_FILES = ['state.json', 'mail.json', 'game.sqlite', 'admin-audit.log'];
  api.get('/storage', async (_req, res) => {
    const st = ctx.state();
    const files = st.files.filter((f) => f.messageId);
    const nameOf = (cid) => st.channels.find((c) => c.id === cid)?.name || DELETED;
    const byChannel = new Map(st.channels.filter((c) => c.type === 'text').map((c) => [c.id, { channelId: c.id, name: c.name, bytes: 0, count: 0 }]));
    for (const f of files) {
      let c = byChannel.get(f.channelId);
      if (!c) byChannel.set(f.channelId, (c = { channelId: f.channelId, name: DELETED, bytes: 0, count: 0 }));
      c.bytes += f.size;
      c.count++;
    }
    const dirBytes = (dir) => fs.promises.readdir(dir).then((names) => Promise.all(names.map((n) => fs.promises.stat(path.join(dir, n)).then((s) => (s.isFile() ? s.size : 0), () => 0))).then((a) => a.reduce((x, y) => x + y, 0)), () => 0);
    const data = await Promise.all(DATA_FILES.map((name) => fs.promises.stat(path.join(dataDir, name)).then((s) => ({ name, bytes: s.size }), () => ({ name, bytes: 0 }))));
    for (const name of ['logs', 'crashes']) data.push({ name: name + '/', bytes: await dirBytes(path.join(dataDir, name)) });
    res.json({
      ...ctx.usage(),
      count: files.length,
      largest: [...files].sort((a, b) => b.size - a.size).slice(0, 20).map((f) => ({ id: f.id, name: f.name, size: f.size, type: f.type, channelId: f.channelId, channelName: nameOf(f.channelId), byName: f.byName, ts: f.ts })),
      channels: [...byChannel.values()].sort((a, b) => b.bytes - a.bytes),
      data,
    });
  });

  api.get('/channels', (_req, res) => {
    const st = ctx.state();
    res.json({
      channels: st.channels.map((c) => {
        if (c.type !== 'text') {
          const occupants = [];
          for (const [sid, u] of ctx.users) if (u.voice === c.id) occupants.push({ sid, id: u.profile.id, name: u.profile.name, color: u.profile.color, avatar: u.profile.avatar, muted: !!u.muted, deafened: !!u.deafened, sharing: !!u.sharing, camera: !!u.camera });
          return { id: c.id, name: c.name, type: c.type, occupants };
        }
        const msgs = Object.hasOwn(st.messages, c.id) ? st.messages[c.id] : [];
        return { id: c.id, name: c.name, type: c.type, messages: msgs.length, lastMessage: msgs.length ? msgs[msgs.length - 1].ts : null, files: st.files.filter((f) => f.messageId && f.channelId === c.id).length };
      }),
    });
  });

  api.get('/game', (_req, res) => {
    const info = ctx.gameInfo();
    const g = ctx.game();
    res.json({ available: info.available, enabled: info.enabled, reason: info.available ? null : info.reason || null, world: info.world || null, players: g?.available && g.players ? g.players() : null, maxUsers: g?.maxUsers ?? null, off: !!ctx.gameOff });
  });

  const serverView = () => {
    const { name, icon, inviteOnly } = ctx.state();
    const { available, enabled, reason, world } = ctx.gameInfo();
    return { name, icon, inviteOnly, audioQuality: ctx.audioQuality(), game: { available, enabled, reason: available ? null : reason || null, world: world || null } };
  };
  api.get('/server', (_req, res) => res.json(serverView()));

  api.patch('/server', (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const patch = {};
    if (b.name !== undefined) patch.name = b.name;
    if (b.icon !== undefined) patch.icon = b.icon;
    if (b.game !== undefined) patch.game = b.game;
    if (b.audioQuality !== undefined) patch.audioQuality = b.audioQuality;
    if (b.inviteOnly !== undefined) patch.inviteOnly = b.inviteOnly;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change' });
    if (patch.name !== undefined && typeof patch.name !== 'string') return res.status(400).json({ error: 'Server name required' });
    if (patch.icon !== undefined && typeof patch.icon !== 'string') return res.status(400).json({ error: 'Icon must be an https image link, or png/jpg/gif/webp under 512KB' });
    if (patch.game !== undefined && typeof patch.game !== 'boolean') return res.status(400).json({ error: 'game must be true or false' });
    answer(res, actions.updateServer(dash(req), patch), () => {
      const what = [];
      if (patch.name !== undefined) what.push(`name "${ctx.state().name}"`);
      if (patch.icon !== undefined) what.push(patch.icon ? 'icon' : 'icon removed');
      if (patch.game !== undefined) what.push(patch.game ? 'game on' : 'game off');
      if (patch.audioQuality !== undefined) what.push(`voice quality ${patch.audioQuality}`);
      if (patch.inviteOnly !== undefined) what.push(patch.inviteOnly ? 'invites required' : 'invites not required');
      logAction(req, 'server.update', what.join(', '));
    });
  });

  // Invites (D51): the tokens people join with. The dashboard is sent the token of every working invite.
  api.get('/invites', (req, res) => answer(res, actions.listInvites(dash(req))));

  api.post('/invites', (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    answer(res, actions.createInvite(dash(req), { label: b.label, maxUses: b.maxUses ?? null, expiresIn: b.expiresIn ?? null }), (r) =>
      logAction(req, 'invite.create', `${r.invite.id.slice(0, 8)} ${r.invite.label}`.trim())
    );
  });

  api.delete('/invites/:id', (req, res) => {
    const inviteId = urlId(req.params.id);
    const label = ctx.state().invites.find((v) => v.id === inviteId)?.label || '';
    answer(res, actions.removeInvite(dash(req), inviteId), (r) => logAction(req, r.revoked ? 'invite.revoke' : 'invite.remove', `${inviteId.slice(0, 8)} ${label}`.trim()));
  });

  api.use((_req, res) => res.status(404).json({ error: 'No such admin API route' }));
  api.use((err, _req, res, _next) => {
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.type === 'entity.too.large' ? 'Request too large' : 'Invalid request' });
    console.error('[admin]', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
  });

  // The dashboard's files; util.js is shared with the desktop client
  app.get(BASE + '/js/util.js', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'js', 'util.js'), (err) => err && !res.headersSent && res.sendStatus(404)));
  app.use(BASE, express.static(UI_DIR, { index: 'index.html', redirect: false }));

  return {
    path: BASE,
    mfa: mfaOn,
    notify,
    close() {
      clearInterval(pruneTimer);
      clearInterval(pingTimer);
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
      unsubscribeLogs();
      for (const st of [...streams]) endStream(st, 'closed');
    },
  };
}

module.exports = { createAdmin };
