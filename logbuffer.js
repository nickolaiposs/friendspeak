// Keeps the last few thousand console lines in memory for the admin dashboard
// (D34). install() wraps the console methods: output still goes where it did,
// and each call is also recorded as { id, ts, level, source, text }.
const util = require('util');
const { EventEmitter } = require('events');

const MAX_TEXT = 4096;
const LEVELS = { log: 'info', info: 'info', warn: 'warn', error: 'error', debug: 'debug' };
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

let installed = null;

function install({ max = 2000 } = {}) {
  if (installed) return installed;
  const buf = [];
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  // Ids keep rising across restarts, so a dashboard that reconnects to a
  // restarted server (Last-Event-ID) never mistakes new lines for old ones
  let nextId = Date.now() * 1000;

  function record(level, args) {
    try {
      const text = util.format(...args).replace(ANSI, '').slice(0, MAX_TEXT);
      const tag = /^\s*\[([^\]\s]{1,32})\]/.exec(text);
      const line = { id: nextId++, ts: Date.now(), level, source: tag ? tag[1].toLowerCase() : '', text };
      buf.push(line);
      if (buf.length > max) buf.splice(0, buf.length - max);
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

  // Oldest first. Without `before`: the newest `limit` lines; with it: the
  // `limit` lines just older than that id. `more`: older lines exist.
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

  function on(fn) {
    bus.on('line', fn);
    return () => bus.off('line', fn);
  }

  return (installed = { lines, on });
}

module.exports = { install };
