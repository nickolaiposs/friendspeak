// Logs and crash reports of the desktop app (issue #51). Everything stays on this
// computer: nothing is uploaded, and the user hands a report to whoever is
// helping them (Settings → About & updates).
//
//   <userData>/logs/app-YYYY-MM-DD.log   JSON lines { ts, level, source, text, stack? } (UTC days)
//   <userData>/crashes/<id>.json         one report per crash; crashes/seen.txt says when the user last looked
//
// Every string is scrubbed (secrets, data URIs, the home folder) before it is stored.
// createLogs() only builds the object; install() hooks the console, the process
// and the app, so the parts that don't need Electron can run on their own.
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const LEVELS = ['debug', 'info', 'warn', 'error'];
const CONSOLE_LEVELS = { log: 'info', info: 'info', warn: 'warn', error: 'error', debug: 'debug' };
const MAX_TEXT = 4096;
const MAX_STACK = 8000;
const KEEP_DAYS = 14;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_CRASHES = 50;
const DAY = 24 * 3600e3;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const NO_DIALOGS = process.env.FRIENDSPEAK_TEST_NO_DIALOGS === '1'; // tests: nothing modal

const pad = (n, w = 2) => String(n).padStart(w, '0');
const stamp = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);
const clean = (s, max) => String(s ?? '').replace(ANSI, '').slice(0, max);
const lvl = (l) => (LEVELS.includes(l) ? l : 'info');

// scheme://host only, never a path or query
function originOf(url) {
  try {
    const u = new URL(url);
    return u.host ? `${u.protocol}//${u.host}` : u.protocol;
  } catch {
    return 'unknown';
  }
}

function makeScrub(home) {
  const homes = [home, home && process.platform === 'win32' ? home.replace(/\\/g, '/') : null].filter((h) => h && h.length > 2);
  return (s) => {
    s = String(s)
      .replace(/fsa_[A-Za-z0-9_-]{16,}/g, 'fsa_[redacted]')
      .replace(/(data:[\w.+\/-]*;base64,)[A-Za-z0-9+\/=_-]{32,}/gi, '$1[redacted]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]+/gi, 'Bearer [redacted]')
      .replace(/\b(password|passwd|token|secret|api_?key|key)=[^\s&"']+/gi, '$1=[redacted]')
      .replace(/"(password|passwd|token|secret|api_?key|key)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"');
    for (const h of homes) s = s.split(h).join('~');
    return s;
  };
}

// At most `n` per `ms`; the first one over the limit returns 'drop-first', the rest 'drop'
function limiter(n, ms) {
  let start = 0;
  let count = 0;
  return () => {
    const now = Date.now();
    if (now - start > ms) ((start = now), (count = 0));
    count++;
    return count <= n ? 'ok' : count === n + 1 ? 'drop-first' : 'drop';
  };
}

function createLogs({ app, dir }) {
  const logDir = path.join(dir, 'logs');
  const crashDir = path.join(dir, 'crashes');
  const seenFile = path.join(crashDir, 'seen.txt');
  const scrub = makeScrub(os.homedir());
  const logFile = (ts) => path.join(logDir, `app-${dayOf(ts)}.log`);
  const logFiles = () => {
    try {
      return fs.readdirSync(logDir).filter((f) => /^app-\d{4}-\d\d-\d\d\.log$/.test(f)).sort();
    } catch {
      return [];
    }
  };

  let queue = []; // { file, s }
  let timer = null;
  let writing = false;
  let day = '';
  let dialogShown = false;
  const recent = new Map(); // crash dedupe: message+stack -> ts
  const rendererLimit = limiter(300, 10e3);

  // Keeps KEEP_DAYS days and MAX_BYTES, oldest first; today's file always stays
  function prune() {
    try {
      const files = logFiles();
      const cutoff = dayOf(Date.now() - KEEP_DAYS * DAY);
      const today = path.basename(logFile(Date.now()));
      let total = 0;
      const kept = [];
      for (const f of files) {
        if (f.slice(4, 14) < cutoff) fs.rmSync(path.join(logDir, f), { force: true });
        else kept.push(f);
      }
      const sizes = kept.map((f) => {
        try {
          return fs.statSync(path.join(logDir, f)).size;
        } catch {
          return 0;
        }
      });
      total = sizes.reduce((a, b) => a + b, 0);
      for (let i = 0; i < kept.length && total > MAX_BYTES && kept[i] !== today; i++) {
        fs.rmSync(path.join(logDir, kept[i]), { force: true });
        total -= sizes[i];
      }
    } catch {}
  }

  function flushSync() {
    clearTimeout(timer);
    timer = null;
    const q = queue;
    queue = [];
    if (!q.length) return;
    try {
      fs.mkdirSync(logDir, { recursive: true });
      const by = new Map();
      for (const { file, s } of q) by.set(file, (by.get(file) || '') + s);
      for (const [file, s] of by) fs.appendFileSync(file, s);
    } catch {}
  }

  function flush() {
    timer = null;
    if (writing || !queue.length) return;
    const q = queue;
    queue = [];
    writing = true;
    const by = new Map();
    for (const { file, s } of q) by.set(file, (by.get(file) || '') + s);
    fs.promises
      .mkdir(logDir, { recursive: true })
      .then(() => Promise.all([...by].map(([file, s]) => fs.promises.appendFile(file, s))))
      .catch(() => {})
      .finally(() => {
        writing = false;
        if (queue.length) schedule();
      });
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(flush, 1000);
    timer.unref?.();
  }

  // The one way in. Never throws.
  function add(level, source, text, stack) {
    try {
      const ts = Date.now();
      const d = dayOf(ts);
      if (d !== day) ((day = d), prune());
      const line = { ts, level: lvl(level), source: clean(source, 16) || 'main', text: scrub(clean(text, MAX_TEXT)) };
      if (stack) line.stack = scrub(clean(stack, MAX_STACK));
      queue.push({ file: logFile(ts), s: JSON.stringify(line) + '\n' });
      schedule();
    } catch {}
  }

  // ---- reading

  const parse = (f) => {
    try {
      return fs.readFileSync(path.join(logDir, f), 'utf8').split('\n');
    } catch {
      return [];
    }
  };

  // Oldest first: the newest `limit` lines older than `before` (a line's `id`, "<file>:<index>"; omit for the
  // newest). `more`: there are older lines. Lines come with their `id`, so the oldest one shown is the next cursor.
  function read({ limit = 500, before } = {}) {
    flushSync();
    limit = Math.max(1, Math.min(5000, Math.floor(Number(limit)) || 500));
    const files = logFiles();
    let fi = files.length - 1;
    let end = Infinity;
    if (typeof before === 'string') {
      const m = /^(app-\d{4}-\d\d-\d\d\.log):(\d+)$/.exec(before);
      if (m) ((fi = files.indexOf(m[1])), (end = Number(m[2])));
      if (fi < 0) return { lines: [], more: false };
    }
    const out = [];
    let more = false;
    for (; fi >= 0; fi--, end = Infinity) {
      const rows = parse(files[fi]);
      for (let i = Math.min(end, rows.length) - 1; i >= 0; i--) {
        if (!rows[i]) continue;
        if (out.length >= limit) {
          more = true;
          break;
        }
        try {
          out.push({ ...JSON.parse(rows[i]), id: `${files[fi]}:${i}` });
        } catch {}
      }
      if (more) break;
    }
    return { lines: out.reverse(), more };
  }

  const crashFiles = () => {
    try {
      return fs.readdirSync(crashDir).filter((f) => /^\d{8}-\d{6}-[0-9a-f]{4}\.json$/.test(f)).sort();
    } catch {
      return [];
    }
  };
  const crashes = () =>
    crashFiles()
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(crashDir, f), 'utf8'));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  const seenAt = () => {
    try {
      return Number(fs.readFileSync(seenFile, 'utf8')) || 0;
    } catch {
      return 0;
    }
  };

  function summary() {
    flushSync();
    const cutoff = Date.now() - 7 * DAY;
    let errors = 0;
    let bytes = 0;
    for (const f of logFiles()) {
      try {
        bytes += fs.statSync(path.join(logDir, f)).size;
      } catch {}
      if (f.slice(4, 14) < dayOf(cutoff)) continue;
      for (const row of parse(f)) {
        if (!row.includes('"level":"error"')) continue;
        try {
          const l = JSON.parse(row);
          if (l.level === 'error' && l.ts >= cutoff) errors++;
        } catch {}
      }
    }
    const all = crashes();
    const seen = seenAt();
    for (const c of all) bytes += JSON.stringify(c).length;
    return {
      errors,
      crashes: all.map(({ id, ts, kind, message }) => ({ id, ts, kind, message })).reverse(),
      unseen: all.filter((c) => c.ts > seen).length,
      bytes,
      dir: logDir,
    };
  }

  function seen() {
    try {
      fs.mkdirSync(crashDir, { recursive: true });
      fs.writeFileSync(seenFile, String(Date.now()));
    } catch {}
  }

  // ---- crash reports

  function crash(kind, message, stack, extra = {}) {
    try {
      message = scrub(clean(message, MAX_TEXT));
      stack = stack ? scrub(clean(stack, MAX_STACK)) : '';
      const key = kind + message + stack;
      const now = Date.now();
      for (const [k, t] of recent) if (now - t > 60e3) recent.delete(k);
      if (recent.has(key)) return null;
      recent.set(key, now);
      flushSync();
      const id = `${stamp(new Date(now))}-${pad(Math.floor(Math.random() * 0x10000).toString(16), 4)}`;
      const report = {
        id,
        ts: now,
        kind,
        message,
        stack,
        ...extra,
        version: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        osVersion: os.release(),
        lines: read({ limit: 200 }).lines.map(({ ts, level, source, text, stack }) => ({ ts, level, source, text, stack })),
      };
      fs.mkdirSync(crashDir, { recursive: true });
      fs.writeFileSync(path.join(crashDir, id + '.json'), JSON.stringify(report));
      for (const f of crashFiles().slice(0, -MAX_CRASHES)) fs.rmSync(path.join(crashDir, f), { force: true });
      return report;
    } catch {
      return null;
    }
  }

  // ---- the report to hand over

  const fmtLine = (l) => `${new Date(l.ts).toISOString()} ${l.level.toUpperCase()} [${l.source}] ${l.text}` + (l.stack ? '\n' + l.stack.replace(/^/gm, '    ') : '');

  function report() {
    const out = [];
    let gpu = '';
    try {
      gpu = JSON.stringify(app.getGPUFeatureStatus?.() || {});
    } catch {}
    out.push(
      `friendspeak report, ${new Date().toISOString()}`,
      `App ${app.getVersion()}  Electron ${process.versions.electron}  Chrome ${process.versions.chrome}  Node ${process.versions.node}`,
      `OS ${process.platform} ${os.release()} ${process.arch}`,
      gpu ? `GPU ${scrub(gpu)}` : undefined,
      ''
    );
    const cutoff = Date.now() - KEEP_DAYS * DAY;
    const cs = crashes().filter((c) => c.ts >= cutoff);
    out.push(`== Crash reports (${cs.length}) ==`);
    for (const c of cs) {
      out.push(`${new Date(c.ts).toISOString()} ${c.kind}${c.reason ? ` (${c.reason}${c.exitCode !== undefined ? `, exit ${c.exitCode}` : ''})` : ''} ${c.message}`);
      if (c.stack) out.push(c.stack.replace(/^/gm, '    '));
    }
    out.push('', '== Log (newest last) ==');
    for (const l of read({ limit: 2000 }).lines) out.push(fmtLine(l));
    return scrub(out.filter((x) => x !== undefined).join('\n')) + '\n';
  }

  function clear() {
    flushSync();
    for (const f of logFiles()) fs.rmSync(path.join(logDir, f), { force: true });
    for (const f of crashFiles()) fs.rmSync(path.join(crashDir, f), { force: true });
    fs.rmSync(seenFile, { force: true });
  }

  // Lines from the renderer (over IPC): validated and rate limited
  function fromRenderer(msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.text !== 'string') return;
    const r = rendererLimit();
    if (r === 'drop-first') return add('warn', 'ui', '(log lines dropped)');
    if (r === 'drop') return;
    add(lvl(msg.level), 'ui', msg.text, typeof msg.stack === 'string' ? msg.stack : '');
  }

  // Sidecar stderr: at most 200 lines per 10 s
  const stderrLimit = limiter(200, 10e3);
  function media(text) {
    const r = stderrLimit();
    if (r === 'drop-first') return add('warn', 'media', '(sidecar output dropped)');
    if (r === 'ok') add('warn', 'media', text);
  }

  // ---- hooks

  function install() {
    prune();
    day = dayOf(Date.now());

    for (const [method, level] of Object.entries(CONSOLE_LEVELS)) {
      const original = console[method].bind(console);
      console[method] = (...args) => {
        try {
          const text = util.format(...args);
          const tag = /^\s*\[([^\]\s]{1,32})\]\s?/.exec(text);
          const source = tag && ['media', 'update'].includes(tag[1].toLowerCase()) ? tag[1].toLowerCase() : 'main';
          add(level, source, tag && source !== 'main' ? text.slice(tag[0].length) : text);
        } catch {}
        original(...args);
      };
    }

    const { dialog } = require('electron');
    process.on('uncaughtException', (err) => {
      add('error', 'main', `Uncaught exception: ${err?.message || err}`, err?.stack);
      const r = crash('main', String(err?.message || err), err?.stack);
      flushSync();
      if (!dialogShown && !NO_DIALOGS) {
        dialogShown = true;
        try {
          dialog.showErrorBox('friendspeak ran into a problem', `Something went wrong, but friendspeak is still running.\n\nA report was saved${r ? '' : ' (if possible)'}. You can view and share it from Settings → About & updates.`);
        } catch {}
      }
    });
    process.on('unhandledRejection', (reason) => {
      const err = reason instanceof Error ? reason : null;
      const message = err ? err.message : String(reason);
      add('error', 'main', `Unhandled rejection: ${message}`, err?.stack);
      crash('main-rejection', message, err?.stack);
      flushSync();
    });

    app.on('render-process-gone', (_e, wc, d) => {
      if (d.reason === 'clean-exit') return;
      let where = 'unknown';
      try {
        where = originOf(wc.getURL());
      } catch {}
      add('error', 'main', `Renderer process gone (${where}): ${d.reason}, exit code ${d.exitCode}`);
      crash('renderer-gone', `Renderer process gone (${where})`, '', { reason: d.reason, exitCode: d.exitCode });
      flushSync();
    });
    app.on('child-process-gone', (_e, d) => {
      if (d.reason === 'clean-exit') return;
      add('error', 'main', `${d.type} process gone: ${d.reason}, exit code ${d.exitCode}`);
      crash('child-gone', `${d.type} process gone`, '', { reason: d.reason, exitCode: d.exitCode });
      flushSync();
    });

    // Every web contents: the app, the game's pop-out window, iframes
    app.on('web-contents-created', (_e, wc) => {
      wc.on('console-message', (details) => {
        const { level, message, lineNumber, frame } = details;
        if (level !== 'warning' && level !== 'error') return;
        let origin = 'unknown';
        try {
          origin = originOf(frame?.url || details.sourceId);
        } catch {}
        // The app's own page reports its errors and console.warn/error itself, with stacks (public/js/log.js);
        // only what the browser engine says on its own (failed loads, CSP) is taken from here
        if (origin === 'friendspeak://app' && !/^(Failed to load resource|Refused to)|Content Security Policy/.test(message)) return;
        add(level === 'error' ? 'error' : 'warn', 'console', `${message} (${origin}:${lineNumber})`);
      });
      wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
        if (isMainFrame && code !== -3) add('error', 'main', `Page failed to load (${originOf(url)}): ${desc} (${code})`);
      });
      wc.on('preload-error', (_e, file, err) => add('error', 'main', `Preload error in ${path.basename(file)}: ${err?.message}`, err?.stack));
      wc.on('unresponsive', () => add('warn', 'main', 'Window is not responding'));
      wc.on('responsive', () => add('info', 'main', 'Window is responding again'));
    });

    app.on('before-quit', flushSync);
    app.on('will-quit', flushSync);
    process.on('exit', flushSync);
  }

  async function save(win) {
    const { dialog } = require('electron');
    try {
      const r = await dialog.showSaveDialog(win, { defaultPath: `friendspeak-report-${stamp(new Date())}.txt`, filters: [{ name: 'Text', extensions: ['txt'] }] });
      if (r.canceled || !r.filePath) return { saved: false };
      await fs.promises.writeFile(r.filePath, report());
      return { saved: true };
    } catch (e) {
      return { error: String(e?.message || e) };
    }
  }

  async function reveal() {
    const { shell } = require('electron');
    fs.mkdirSync(logDir, { recursive: true });
    const err = await shell.openPath(logDir);
    return err ? { error: err } : { ok: true };
  }

  return { install, add, read, summary, seen, crash, report, clear, save, reveal, fromRenderer, media, flushSync, scrub, originOf, dir: logDir };
}

module.exports = { createLogs, originOf };
