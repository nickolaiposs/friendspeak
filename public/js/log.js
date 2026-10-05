// Records the page's errors for the desktop app's log (issue #51): uncaught
// errors, unhandled rejections, console.warn/error, and the few explicit
// events main.js reports. The desktop app keeps them on this computer, scrubbed;
// nothing is sent anywhere. Without the desktop bridge everything here is a no-op.
// Never pass message text, passwords, keys, file names or profile data to it.
const sink = window.friendspeakDesktop?.logs;
const MAX_ARG = 600;

// An error's message, fit for the log: its first line, without network addresses. WebRTC errors quote
// the line of the other side's session description they tripped on, and those lines carry addresses.
const errText = (m) =>
  String(m ?? '')
    .split('\n')[0]
    .slice(0, 300)
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[address]')
    .replace(/\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/gi, '[address]');

function write(level, text, stack) {
  try {
    sink?.write({ level, text: String(text).slice(0, 4096), stack: stack ? String(stack).slice(0, 8000) : undefined });
  } catch {}
}

// One console argument as text: errors by name and message, objects as a short JSON, never a big dump
function fmt(a) {
  try {
    if (a instanceof Error || (typeof DOMException !== 'undefined' && a instanceof DOMException)) return `${a.name}: ${errText(a.message)}`;
    if (a === null || ['string', 'number', 'boolean', 'undefined', 'bigint'].includes(typeof a)) return String(a);
    if (typeof a === 'function') return `[function ${a.name || ''}]`;
    if (typeof a === 'symbol') return a.toString();
    const shallow = {};
    if (Array.isArray(a)) return JSON.stringify(a.slice(0, 8).map((v) => (v && typeof v === 'object' ? `[${v.constructor?.name || 'object'}]` : v))).slice(0, MAX_ARG);
    for (const k of Object.keys(a).slice(0, 8)) shallow[k] = a[k] && typeof a[k] === 'object' ? `[${a[k].constructor?.name || 'object'}]` : a[k];
    return JSON.stringify(shallow).slice(0, MAX_ARG);
  } catch {
    return '[unprintable]';
  }
}

const origin = (url) => {
  try {
    return new URL(url, location.href).origin;
  } catch {
    return 'unknown';
  }
};
// "friendspeak://app/js/main.js" → "/js/main.js"
const where = (file, line, col) => {
  let p = '';
  try {
    const u = new URL(file, location.href);
    p = u.origin === location.origin ? u.pathname : u.origin;
  } catch {}
  return p ? `${p}:${line || 0}:${col || 0}` : '';
};

if (sink && !window.__fsLog) {
  window.__fsLog = true;

  window.addEventListener(
    'error',
    (e) => {
      // Resource errors (img, script, … failing to load) bubble only in the capture phase and have no `error`
      if (e.target && e.target !== window && e.target.tagName) {
        const t = e.target;
        return write('warn', `Failed to load <${t.tagName.toLowerCase()}> from ${origin(t.currentSrc || t.src || t.href || '')}`);
      }
      write('error', `${errText(e.message) || 'Error'} (${where(e.filename, e.lineno, e.colno)})`, e.error?.stack);
    },
    true
  );

  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    write('error', `Unhandled rejection: ${r instanceof Error || (typeof DOMException !== 'undefined' && r instanceof DOMException) ? `${r.name}: ${errText(r.message)}` : fmt(r)}`, r?.stack);
  });

  for (const [method, level] of [['warn', 'warn'], ['error', 'error']]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      write(level, args.map(fmt).join(' '), args.find((a) => a instanceof Error)?.stack);
      original(...args);
    };
  }
}

export const log = {
  info: (text) => write('info', text),
  warn: (text) => write('warn', text),
  error: (text, err) => write('error', err ? `${text}: ${err.name || 'Error'}: ${errText(err.message)}` : text, err?.stack),
};
