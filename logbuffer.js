// The server's console output, for the admin dashboard (D34, #50, #51).
// install() wraps the console methods: output still goes where it did, and
// each call is also recorded as { id, ts, level, source, text }. The last few
// thousand lines stay in memory (live view); everything but `debug` is also
// appended to JSON-lines files in `dir`, kept for a number of days and a size
// cap, so history survives restarts and crashes. Every line is scrubbed of
// secrets before it goes anywhere.
const fs = require('fs');
const path = require('path');
const util = require('util');
const { EventEmitter } = require('events');

const MAX_TEXT = 4096;
const LEVELS = { log: 'info', info: 'info', warn: 'warn', error: 'error', debug: 'debug' };
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const PART_MAX = 5 * 1024 * 1024; // start a new file past this size
const FILE_RE = /^server-(\d{4}-\d\d-\d\d)-(\d\d)\.log$/;
const DAY = 864e5;
const REDACTED = '[redacted]';

// Patterns that are secrets wherever they show up
const PATTERNS = [
  [/\bfsa_[A-Za-z0-9_-]{16,}/g, 'fsa_' + REDACTED],
  [/\bdata:([\w.+-]+\/[\w.+-]+);base64,[A-Za-z0-9+/=_-]{32,}/g, `data:$1;base64,${REDACTED}`],
  [/\b[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3}\b/gi, 'invite ' + REDACTED], // an invite token (D51)
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ' + REDACTED],
  [/\b(password|passwd|token|secret|apikey|api_key|key)=[^&\s"']+/gi, `$1=${REDACTED}`],
];

let installed = null;

function install({ max = 2000, dir, retentionDays = 14, maxBytes = 50 * 1024 ** 2 } = {}) {
  if (installed) return installed;
  const buf = [];
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  const origError = console.error.bind(console); // for our own failures: never through the wrapper
  const persist = !!dir && retentionDays > 0;
  let lastId = 0;

  // ---------- scrubbing ----------

  const secrets = new Set();
  function redact(value) {
    if (typeof value === 'string' && value.length >= 6) secrets.add(value);
  }
  function scrub(text) {
    text = String(text);
    for (const s of secrets) if (text.includes(s)) text = text.split(s).join(REDACTED);
    for (const [re, to] of PATTERNS) text = text.replace(re, to);
    return text;
  }

  // ---------- files ----------

  let queue = []; // { file, data } waiting to be appended, in order
  let chain = Promise.resolve();
  let failed = false;
  let started = false; // a new file was started since retain() last ran
  let cur = { day: null, part: 0, size: 0, file: null };
  const fail = (err) => {
    if (failed) return;
    failed = true;
    try {
      origError('[logs] could not write the log history:', err && err.message);
    } catch {}
  };
  const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);
  const nameOf = (day, part) => `server-${day}-${String(part).padStart(2, '0')}.log`;
  const listFiles = () => {
    try {
      return fs.readdirSync(dir).filter((f) => FILE_RE.test(f)).sort();
    } catch {
      return [];
    }
  };

  // Delete what is past the retention, then the oldest while over the size cap
  function retain() {
    if (!persist) return;
    try {
      const files = listFiles().map((f) => {
        let size = 0;
        try {
          size = fs.statSync(path.join(dir, f)).size;
        } catch {}
        return { f, size, end: Date.parse(FILE_RE.exec(f)[1] + 'T00:00:00Z') + DAY };
      });
      const cutoff = Date.now() - retentionDays * DAY;
      const keep = [];
      for (const x of files) {
        if (x.end < cutoff && x.f !== cur.file) fs.rmSync(path.join(dir, x.f), { force: true });
        else keep.push(x);
      }
      let total = keep.reduce((n, x) => n + x.size, 0);
      for (const x of keep) {
        if (total <= maxBytes) break;
        if (x.f === cur.file) continue;
        fs.rmSync(path.join(dir, x.f), { force: true });
        total -= x.size;
      }
    } catch (err) {
      fail(err);
    }
  }

  if (persist) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const last = listFiles().pop();
      if (last) {
        const m = FILE_RE.exec(last);
        cur = { day: m[1], part: Number(m[2]), size: fs.statSync(path.join(dir, last)).size, file: last };
      }
    } catch (err) {
      fail(err);
    }
    retain();
    const t = setInterval(retain, 3600e3);
    t.unref();
  }

  // Which file the next line belongs in (starting a new one when due)
  function place(ts, bytes) {
    const day = dayOf(ts);
    if (cur.day === null || day > cur.day) cur = { day, part: 0, size: 0, file: nameOf(day, 0) };
    else if (cur.size >= PART_MAX && cur.part < 99) cur = { day: cur.day, part: cur.part + 1, size: 0, file: nameOf(cur.day, cur.part + 1) };
    else {
      cur.size += bytes;
      return cur.file;
    }
    cur.size = bytes;
    started = true; // retention runs once it is on disk (retain() reads sizes)
    return cur.file;
  }

  // Merge neighbours that go to the same file
  function batches(q) {
    const out = [];
    for (const e of q) {
      const last = out[out.length - 1];
      if (last && last.file === e.file) last.data += e.data;
      else out.push({ file: e.file, data: e.data });
    }
    return out;
  }
  function flush() {
    chain = chain.then(async () => {
      const q = queue;
      queue = [];
      for (const b of batches(q)) {
        try {
          await fs.promises.appendFile(path.join(dir, b.file), b.data, { mode: 0o600 });
        } catch (err) {
          fail(err);
        }
      }
      if (started) (started = false), retain();
    });
    return chain;
  }
  // For a dying process: blocks until the queue is on disk
  function flushSync() {
    if (!persist || !queue.length) return;
    const q = queue;
    queue = [];
    for (const b of batches(q)) {
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.appendFileSync(path.join(dir, b.file), b.data, { mode: 0o600 });
      } catch (err) {
        fail(err);
      }
    }
    if (started) (started = false), retain();
  }
  if (persist) {
    const t = setInterval(() => queue.length && flush(), 1000);
    t.unref();
    process.on('exit', flushSync);
  }

  // ---------- recording ----------

  function record(level, args) {
    try {
      const now = Date.now();
      const text = scrub(util.format(...args).replace(ANSI, '')).slice(0, MAX_TEXT);
      const tag = /^\s*\[([^\]\s]{1,32})\]/.exec(text);
      // Ids rise across restarts, and id >= ts * 1000 always holds (the history search skips files by it)
      lastId = Math.max(lastId + 1, now * 1000);
      const line = { id: lastId, ts: now, level, source: tag ? tag[1].toLowerCase() : '', text };
      buf.push(line);
      if (buf.length > max) buf.splice(0, buf.length - max);
      // debug lines stay in memory: the history has none
      if (persist && level !== 'debug') {
        const data = JSON.stringify(line) + '\n';
        queue.push({ file: place(now, Buffer.byteLength(data)), data });
      }
      bus.emit('line', line);
    } catch {}
  }

  for (const [method, level] of Object.entries(LEVELS)) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      record(level, args);
      original(...args);
    };
  }

  // ---------- reading ----------

  // Oldest first. Without `before`: the newest `limit` lines; with it: the
  // `limit` lines just older than that id. `more`: older lines exist.
  // Memory only (the live stream's replay); history is query().
  function lines({ before, limit = 500 } = {}) {
    limit = Math.max(1, Math.min(2000, Math.floor(Number(limit)) || 500));
    let end = buf.length;
    if (before !== undefined && before !== null) {
      const b = Number(before);
      end = buf.findIndex((l) => l.id >= b);
      if (end < 0) end = buf.length;
    }
    const start = Math.max(0, end - limit);
    return { lines: buf.slice(start, end), more: start > 0 };
  }

  // Lines that match the filters; history has no `debug` lines (they are never written)
  function matcher({ before, from, to, levels, source, q }) {
    const needle = typeof q === 'string' && q ? q.toLowerCase() : '';
    const lv = Array.isArray(levels) && levels.length ? new Set(levels) : null;
    const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
    const b = num(before);
    const f = num(from);
    const t = num(to);
    return (l) => (b === null || l.id < b) && (f === null || l.ts >= f) && (t === null || l.ts <= t) && (!lv || lv.has(l.level)) && (source === undefined || l.source === source) && (!needle || l.text.toLowerCase().includes(needle));
  }

  // Oldest first: the newest `limit` matching lines among those older than `before`.
  // `more`: an older match exists. Reads the files from the newest, and stops once it has enough.
  async function query(opts = {}) {
    const limit = Math.max(1, Math.min(100000, Math.floor(Number(opts.limit)) || 500));
    const ok = matcher(opts);
    const found = []; // newest first
    if (!persist) {
      for (let i = buf.length - 1; i >= 0 && found.length <= limit; i--) if (ok(buf[i])) found.push(buf[i]);
    } else {
      await flush();
      const before = opts.before === undefined || opts.before === null || opts.before === '' ? null : Number(opts.before);
      const from = Number.isFinite(Number(opts.from)) && opts.from !== undefined && opts.from !== null && opts.from !== '' ? Number(opts.from) : null;
      const to = Number.isFinite(Number(opts.to)) && opts.to !== undefined && opts.to !== null && opts.to !== '' ? Number(opts.to) : null;
      const files = listFiles().reverse();
      for (const f of files) {
        if (found.length > limit) break;
        const start = Date.parse(FILE_RE.exec(f)[1] + 'T00:00:00Z');
        if ((to !== null && start > to) || (from !== null && start + DAY - 1 < from) || (before !== null && Number.isFinite(before) && start * 1000 >= before)) continue;
        let text;
        try {
          text = await fs.promises.readFile(path.join(dir, f), 'utf8');
        } catch {
          continue;
        }
        const rows = text.split('\n');
        for (let i = rows.length - 1; i >= 0 && found.length <= limit; i--) {
          if (!rows[i]) continue;
          let l;
          try {
            l = JSON.parse(rows[i]);
          } catch {
            continue; // a torn line
          }
          if (l && typeof l.id === 'number' && typeof l.ts === 'number' && typeof l.level === 'string' && typeof l.text === 'string' && ok({ ...l, source: typeof l.source === 'string' ? l.source : '' })) found.push(l);
        }
      }
    }
    const more = found.length > limit;
    return { lines: found.slice(0, limit).reverse(), more };
  }

  // The last `limit` persisted lines, synchronously, oldest first (for a crash report at boot)
  function tail(limit = 200) {
    const out = [];
    if (!persist) return out;
    for (const f of listFiles().reverse()) {
      let rows;
      try {
        rows = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
      } catch {
        continue;
      }
      for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) {
        try {
          const l = JSON.parse(rows[i]);
          if (l && typeof l.id === 'number' && typeof l.text === 'string') out.push(l);
        } catch {}
      }
      if (out.length >= limit) break;
    }
    return out.reverse();
  }

  function info() {
    let bytes = 0;
    let count = 0;
    let oldest = null;
    if (persist) {
      const files = listFiles();
      for (const f of files) {
        try {
          bytes += fs.statSync(path.join(dir, f)).size;
          count++;
        } catch {}
      }
      if (files.length) {
        const first = files[0];
        oldest = Date.parse(FILE_RE.exec(first)[1] + 'T00:00:00Z');
        try {
          const fd = fs.openSync(path.join(dir, first), 'r');
          try {
            const b = Buffer.alloc(16384);
            const n = fs.readSync(fd, b, 0, b.length, 0);
            const row = b.toString('utf8', 0, n).split('\n')[0];
            const ts = JSON.parse(row).ts;
            if (Number.isFinite(ts)) oldest = ts;
          } finally {
            fs.closeSync(fd);
          }
        } catch {}
      }
    }
    return { persisted: persist, bytes, files: count, oldest, retentionDays, maxBytes };
  }

  function on(fn) {
    bus.on('line', fn);
    return () => bus.off('line', fn);
  }

  return (installed = { lines, query, tail, info, on, scrub, redact, flush, flushSync });
}

module.exports = { install };
