// Crash reports (#50, #51): one JSON file per crash in DATA_DIR/crashes, with the
// error, the version and system, and the last log lines. write() is fully
// synchronous because it runs while the process is dying, and never throws.
// Text is scrubbed like the log (logbuffer.js).
const fs = require('fs');
const path = require('path');
const util = require('util');

const MAX_REPORTS = 100;
const ID_RE = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/;

function createCrashLog({ dir, logs, version, context }) {
  const scrub = logs ? logs.scrub : (t) => String(t);
  const listeners = new Set();

  const ids = () => {
    try {
      return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && ID_RE.test(f.slice(0, -5))).map((f) => f.slice(0, -5)).sort();
    } catch {
      return [];
    }
  };
  const read = (id) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8'));
    } catch {
      return null;
    }
  };

  function write(kind, err, { fatal = false, extra = {} } = {}) {
    try {
      const isErr = err instanceof Error;
      const now = new Date();
      const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      const id = `${stamp}-${Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')}`;
      const message = scrub(isErr ? `${err.name}: ${err.message}` : typeof err === 'string' ? err : util.inspect(err)).slice(0, 2000);
      const stack = isErr ? scrub(String(err.stack || '')).slice(0, 16000) : '';
      let extraCtx = {};
      try {
        extraCtx = (context && context()) || {};
      } catch {}
      const mem = process.memoryUsage();
      const { lines: given, ...rest } = extra;
      const report = {
        id,
        ts: now.getTime(),
        kind,
        fatal: !!fatal,
        message,
        stack,
        version,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        uptime: Math.round(process.uptime()),
        memory: { rss: mem.rss, heapUsed: mem.heapUsed },
        ...extraCtx,
        ...rest,
        lines: given || (logs ? logs.lines({ limit: 200 }).lines : []),
      };
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(report), { mode: 0o600 });
      for (const old of ids().slice(0, -MAX_REPORTS)) fs.rmSync(path.join(dir, old + '.json'), { force: true });
      for (const fn of listeners) {
        try {
          fn(report);
        } catch {}
      }
      return report;
    } catch {
      return null;
    }
  }

  return {
    write,
    list() {
      return ids()
        .reverse()
        .map((id) => read(id))
        .filter(Boolean)
        .map((r) => ({ id: r.id, ts: r.ts, kind: r.kind, fatal: !!r.fatal, message: String(r.message || ''), version: r.version }));
    },
    get(id) {
      return typeof id === 'string' && ID_RE.test(id) ? read(id) : null;
    },
    remove(id) {
      if (typeof id !== 'string' || !ID_RE.test(id)) return false;
      try {
        fs.rmSync(path.join(dir, id + '.json'));
        return true;
      } catch {
        return false;
      }
    },
    clear() {
      let n = 0;
      for (const id of ids()) {
        try {
          fs.rmSync(path.join(dir, id + '.json'));
          n++;
        } catch {}
      }
      return n;
    },
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

module.exports = { createCrashLog };
