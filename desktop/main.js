// friendspeak desktop app (Electron).
//
// - Loads the same UI as the web client from a private friendspeak:// origin,
//   which counts as a secure context: the microphone always works, and profiles
//   and sounds stay put no matter which server you connect to.
// - It is a client only. To host, run the server separately (`npm start` or
//   Docker) and connect to it like any other server.
// - Registers soundboard hotkeys as global shortcuts that work in other apps.
// - Checks GitHub Releases for new versions and installs them where it can (D29).
const { app, BrowserWindow, protocol, ipcMain, globalShortcut, shell, session, systemPreferences, Menu, dialog, desktopCapturer, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');
const { spawn } = require('child_process');
const readline = require('readline');
const { createLogs, originOf } = require('./logs');

const APP = 'friendspeak://app'; // the origin of the app's own page
const isApp = (url) => typeof url === 'string' && (url === APP || url.startsWith(APP + '/'));
const GAME_WINDOW = 'friendspeak-game'; // the name the page gives the game's pop-out window (popOutGame in main.js)
const STREAM_WINDOW = 'friendspeak-stream-'; // and the start of the name of the video grid's window (popOutStage in main.js)
const STREAM_PAGE = APP + '/popout.html';
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const MODULES = path.join(ROOT, 'node_modules');
const ROUTES = [
  ['/vendor/emoji-picker-element/', path.join(MODULES, 'emoji-picker-element')],
  ['/vendor/emoji-data/', path.join(MODULES, 'emoji-picker-element-data')],
  ['/vendor/mediapipe/', path.join(MODULES, '@mediapipe/tasks-vision')], // camera backgrounds (D37)
  ['/socket.io/socket.io.js', path.join(MODULES, 'socket.io/client-dist/socket.io.js')],
  ['/', PUBLIC],
];
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.wasm': 'application/wasm', // must be exact for streaming compilation
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'friendspeak', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// Separate profile/data folder, e.g. to run two copies side by side
if (process.env.FRIENDSPEAK_USER_DATA) app.setPath('userData', path.resolve(process.env.FRIENDSPEAK_USER_DATA));

// Logs and crash reports (issue #51): on this computer only, never sent anywhere. See logs.js.
const logs = createLogs({ app, dir: app.getPath('userData') });
logs.install();
const NO_DIALOGS = process.env.FRIENDSPEAK_TEST_NO_DIALOGS === '1'; // tests: no modal dialogs, reload at once

// Settings the main process needs before there is a window to ask (the page's
// own settings live in its localStorage): { hardwareAcceleration }
const PREFS_FILE = () => path.join(app.getPath('userData'), 'desktop-prefs.json');
const PREF_DEFAULTS = { hardwareAcceleration: true };
function readPrefs() {
  try {
    return { ...PREF_DEFAULTS, ...JSON.parse(fs.readFileSync(PREFS_FILE(), 'utf8')) };
  } catch {
    return { ...PREF_DEFAULTS };
  }
}
let prefs = readPrefs();

// Hardware acceleration (D46), on unless turned off in Settings → Voice & Video:
// the GPU draws the app and decodes video, and the media sidecar encodes
// streams on it. Off, everything runs on the CPU. It has to be decided before
// the app is ready, so the switch takes effect at the next start.
const HW_AT_START = prefs.hardwareAcceleration;
if (!HW_AT_START) app.disableHardwareAcceleration();

// Soundboard hotkeys can fire while the window is in the background
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// System audio for screen sharing on macOS (13+). Windows supports it natively.
if (process.platform === 'darwin') app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');

// Screen capture on Windows: keep frames on the GPU instead of copying each one
// through memory. Chromium's capturer spends at most half its time capturing,
// so the copy capped a 1440p share at about 30 fps in motion (D36).
// FRIENDSPEAK_LEGACY_CAPTURE=1 turns this off if a share comes out black or frozen.
if (process.platform === 'win32' && process.env.FRIENDSPEAK_LEGACY_CAPTURE !== '1') app.commandLine.appendSwitch('enable-features', 'WebRtcAllowWgcUsingTexture,ZeroCopyDesktopCapture');

// Automatic gain (D44) levels the voice digitally. Without this, Chromium's
// gain control also turns the system's microphone volume up and down. Added to
// any --disable-features given on the command line, which this would replace.
app.commandLine.appendSwitch('disable-features', [app.commandLine.getSwitchValue('disable-features'), 'WebRtcAllowInputVolumeAdjustment'].filter(Boolean).join(','));

// Single instance: a second launch focuses the existing window
if (!app.requestSingleInstanceLock()) app.quit();

// ---------------------------------------------------------------- self-signed certificates

// Self-hosted servers often use a self-signed certificate. The first time you
// connect to one, the app shows its fingerprint and asks; the answer is pinned per host
// (trust on first use), so a different certificate later triggers a warning.
const TRUST_FILE = () => path.join(app.getPath('userData'), 'trusted-certs.json');

function readTrust() {
  try {
    return JSON.parse(fs.readFileSync(TRUST_FILE(), 'utf8'));
  } catch {
    return {};
  }
}

const isTrusted = (hostname, fp) => readTrust()[hostname.replace(/^\[|\]$/g, '')] === fp;

// Fetch the certificate a server presents, without validating it
function peekCertificate(host, port) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: require('net').isIP(host) ? undefined : host, rejectUnauthorized: false });
    socket.setTimeout(5000, () => socket.destroy(new Error('timeout')));
    socket.once('secureConnect', () => {
      resolve({ authorized: socket.authorized, fingerprint: socket.getPeerCertificate().fingerprint256 });
      socket.end();
    });
    socket.once('error', reject);
  });
}

async function trustServer(address) {
  let url;
  try {
    url = new URL(address);
  } catch {
    return true;
  }
  if (url.protocol !== 'https:') return true;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const cert = await peekCertificate(host, Number(url.port) || 443).catch(() => null);
  // Unreachable, or a properly signed certificate: let the normal connection handle it
  if (!cert || cert.authorized || !cert.fingerprint || isTrusted(host, cert.fingerprint)) return true;

  const previous = readTrust()[host];
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'friendspeak',
    message: previous ? `The certificate for ${host} has CHANGED` : `Trust the server at ${host}?`,
    detail:
      (previous
        ? 'This can mean the host reinstalled friendspeak or deleted its data folder, or that someone is intercepting your connection. Only continue if the host confirms the new fingerprint.\n\n'
        : 'This server uses a self-signed certificate. Ask the host to check that this fingerprint matches the one the server printed on startup.\n\n') +
      `SHA-256 fingerprint:\n${cert.fingerprint}`,
    buttons: ['Cancel', previous ? 'Trust new certificate' : 'Trust'],
    defaultId: 0,
    cancelId: 0,
  });
  if (response !== 1) return false;
  const trust = readTrust();
  trust[host] = cert.fingerprint;
  fs.writeFileSync(TRUST_FILE(), JSON.stringify(trust, null, 2));
  return true;
}

function acceptPinnedCertificates() {
  session.defaultSession.setCertificateVerifyProc(({ hostname, certificate, verificationResult }, callback) => {
    if (verificationResult === 'net::OK') return callback(-3); // use Chromium's verdict
    let fp = null;
    try {
      fp = new crypto.X509Certificate(certificate.data).fingerprint256;
    } catch {}
    callback(fp && isTrusted(hostname, fp) ? 0 : -3);
  });
}

// ---------------------------------------------------------------- window

let win = null;
const streamWindows = new Map(); // window name -> BrowserWindow, for the video grid in a window of its own

// Everything the bridge in preload.js can ask for is for the app's own page, in the main frame of its own
// window. The game's window and iframes don't get the bridge today; this holds if that ever changes.
const ownPage = (e) => !!e.senderFrame && !!win && e.sender === win.webContents && e.senderFrame === e.sender.mainFrame && isApp(e.senderFrame.url);
const handle = (channel, fn) => ipcMain.handle(channel, (e, ...a) => (ownPage(e) ? fn(e, ...a) : undefined));
const listen = (channel, fn) => ipcMain.on(channel, (e, ...a) => ownPage(e) && fn(e, ...a));

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 940,
    minHeight: 560,
    backgroundColor: '#181a1f',
    title: 'friendspeak',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // keep voice and soundboard smooth when hidden
    },
  });

  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    // The game's "Pop out" button opens it in its own window. Only that: the page names the
    // window when it opens it, and a link in a message can't (those open in the real browser).
    if (frameName === GAME_WINDOW && /^https?:\/\/[^/]+\/game\//.test(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1280,
          height: 840,
          title: 'Club Penguin',
          autoHideMenuBar: true,
          backgroundColor: '#0a1a33',
          webPreferences: { contextIsolation: true, nodeIntegration: false },
        },
      };
    }
    // The video grid in a window of its own: a page of the app's with no script, which the app's page fills
    if (frameName.startsWith(STREAM_WINDOW) && url === STREAM_PAGE) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { width: 1100, height: 680, minWidth: 480, minHeight: 300, title: 'friendspeak', autoHideMenuBar: true, backgroundColor: '#000000' },
      };
    }
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // The game's window stays on the server it was opened for, and what it opens goes to the real browser
  win.webContents.on('did-create-window', (child, { url, frameName }) => {
    if (frameName.startsWith(STREAM_WINDOW)) {
      // No menu: its reload and zoom items are for a page that can draw itself
      child.removeMenu();
      streamWindows.set(frameName, child);
      child.on('closed', () => streamWindows.delete(frameName));
    }
    const origin = originOf(url);
    child.webContents.setWindowOpenHandler(({ url: to }) => {
      if (/^https?:\/\//.test(to)) shell.openExternal(to);
      return { action: 'deny' };
    });
    child.webContents.on('will-navigate', (e, to) => {
      if (originOf(to) === origin) return;
      e.preventDefault();
      if (/^https?:\/\//.test(to)) shell.openExternal(to);
    });
  });

  // Links clicked inside chat open in the real browser
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('friendspeak://')) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });

  // The page's process died (crash, out of memory, killed): offer to reload, but not in a loop
  const goneAt = [];
  win.webContents.on('render-process-gone', async (_e, d) => {
    if (d.reason === 'clean-exit' || quitting || !win) return;
    const w = win;
    const now = Date.now();
    goneAt.push(now);
    const loop = goneAt.filter((t) => now - t < 60e3).length >= 3;
    let reload = NO_DIALOGS && !loop;
    if (!NO_DIALOGS) {
      const { response } = await dialog.showMessageBox(w.isDestroyed() ? undefined : w, {
        type: 'error',
        title: 'friendspeak',
        message: 'friendspeak stopped working',
        detail: 'A report was saved. You can view and share it from Settings → About & updates once it is running again.',
        buttons: loop ? ['Quit'] : ['Reload', 'Quit'],
        defaultId: 0,
        cancelId: loop ? 0 : 1,
      }).catch(() => ({ response: 1 }));
      reload = !loop && response === 0;
    }
    if (reload && !w.isDestroyed()) w.reload();
    else if (!reload && !NO_DIALOGS) app.quit();
  });

  win.loadURL('friendspeak://app/index.html');
  win.on('closed', () => {
    win = null;
    // The video grid's window is drawn by the app's page: without it there is nothing to show
    for (const w of streamWindows.values()) if (!w.isDestroyed()) w.destroy();
  });
}

// What the app's page may load and run. Messages are drawn from escaped text (formatText in
// util.js); this is the second line, for the day something gets past that: no inline or remote
// script, so injected markup can't reach the bridge in preload.js or the keys in localStorage.
// Servers, images, media and embeds can be anywhere, so those stay open.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'", // wasm: noise suppression and camera backgrounds
  "style-src 'self' 'unsafe-inline'", // role colors and sizes are style attributes
  "img-src 'self' data: blob: https: http:",
  "media-src 'self' data: blob: mediastream: https: http:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob: https: http: wss: ws:",
  "frame-src https: http:", // the game, and link embeds
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function serveApp() {
  protocol.handle('friendspeak', async (request) => {
    const { pathname } = new URL(request.url);
    const clean = decodeURIComponent(pathname);
    for (const [prefix, target] of ROUTES) {
      if (!clean.startsWith(prefix) && clean !== prefix.replace(/\/$/, '')) continue;
      const file = target.endsWith('.js') ? target : path.join(target, clean.slice(prefix.length) || 'index.html');
      const rel = path.relative(target, file);
      if (rel.startsWith('..') || path.isAbsolute(rel)) break; // path traversal
      try {
        const data = await fs.promises.readFile(file);
        const type = MIME[path.extname(file)] || 'application/octet-stream';
        return new Response(data, { headers: { 'content-type': type, 'x-content-type-options': 'nosniff', ...(type.startsWith('text/html') ? { 'content-security-policy': CSP } : {}) } });
      } catch {
        if (prefix !== '/') continue;
      }
    }
    return new Response('Not found', { status: 404 });
  });
}

// YouTube's embedded player refuses to play without a Referer (error 153), and
// Chromium sends none from the friendspeak:// origin. Supply YouTube's own.
function allowYouTubeEmbeds() {
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['https://www.youtube-nocookie.com/embed/*'] }, (details, cb) => {
    if (!details.requestHeaders.Referer) details.requestHeaders.Referer = 'https://www.youtube-nocookie.com/';
    cb({ requestHeaders: details.requestHeaders });
  });
}

// The microphone, camera, screen and notifications are for the app's own page. The game (an
// iframe or its own window) and link embeds are other sites: they get fullscreen and copying
// to the clipboard, nothing else.
const OPEN_PERMISSIONS = ['fullscreen', 'clipboard-sanitized-write'];

function allowMicrophone() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler(async (wc, permission, callback, details) => {
    if (OPEN_PERMISSIONS.includes(permission)) return callback(true);
    if (!win || wc !== win.webContents || !isApp(details.requestingUrl)) return callback(false);
    if (permission === 'media') {
      if (process.platform === 'darwin') {
        const types = details.mediaTypes || [];
        if (types.includes('audio') && !(await systemPreferences.askForMediaAccess('microphone'))) return callback(false);
        if (types.includes('video') && !(await systemPreferences.askForMediaAccess('camera'))) return callback(false);
      }
      return callback(true);
    }
    callback(['display-capture', 'notifications', 'speaker-selection'].includes(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => OPEN_PERMISSIONS.includes(permission) || (isApp(requestingOrigin) && ['media', 'display-capture', 'speaker-selection', 'notifications'].includes(permission)));
}

// ---------------------------------------------------------------- screen sharing

// Electron has no built-in getDisplayMedia picker. The UI lists sources over
// IPC, the user picks one in friendspeak's own dialog, then getDisplayMedia
// is answered with that choice. A request without a pick is denied.
let pickedSource = null; // { id, audio, at }

async function screenSources() {
  const status = process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted';
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true });
  return {
    status,
    // Loopback (system) audio: Windows always, macOS behind the feature flags above
    systemAudio: process.platform === 'win32' || process.platform === 'darwin',
    sources: sources.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
      icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    })),
  };
}

function allowScreenShare() {
  handle('desktop:screen-sources', () => screenSources());
  handle('desktop:screen-pick', (_e, pick) => {
    pickedSource = pick && typeof pick.id === 'string' ? { id: pick.id, audio: !!pick.audio, at: Date.now() } : null;
  });
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const pick = pickedSource;
    pickedSource = null;
    if (!pick || Date.now() - pick.at > 30_000) return callback({});
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
    const video = sources.find((s) => s.id === pick.id);
    if (!video) return callback({});
    callback({ video, ...(pick.audio && request.audioRequested ? { audio: 'loopback' } : {}) });
  });
}

// ---------------------------------------------------------------- native media sidecar (D45)

// friendspeak-media: a process of its own that captures a screen, window or
// camera, encodes it and sends it to each viewer over standard WebRTC. The app
// starts it on first use, talks to it in JSON lines (commands on stdin, events
// on stdout) and relays the events to the UI. If it is missing or keeps dying,
// shares go through the browser engine as before.
const MEDIA_EXE = 'friendspeak-media' + (process.platform === 'win32' ? '.exe' : '');
const MEDIA_CRASHES = 3; // after this many unexpected exits, no more native media until the app restarts
const media = { proc: null, caps: null, ready: null, crashes: 0 };

function mediaBinary() {
  if (process.env.FRIENDSPEAK_MEDIA === 'off') return null;
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'native', MEDIA_EXE)]
    : [process.env.FRIENDSPEAK_MEDIA_BIN, path.join(ROOT, 'native', 'target', 'release', MEDIA_EXE), path.join(ROOT, 'native', 'target', 'debug', MEDIA_EXE)];
  return candidates.find((f) => f && fs.existsSync(f)) || null;
}

// Starts the sidecar if needed. Resolves to what it can do ({ sources, hardware, audio }), or null.
function startMedia() {
  if (media.ready) return media.ready;
  const bin = media.crashes < MEDIA_CRASHES && mediaBinary();
  if (!bin) return Promise.resolve(null);
  media.ready = new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      console.warn('[media]', e.message);
      media.ready = null;
      return resolve(null);
    }
    media.proc = proc;
    proc.stdin.on('error', () => {}); // a dead sidecar is handled by 'exit'
    proc.stderr.on('data', (d) => {
      process.stderr.write(d);
      for (const line of String(d).split('\n')) if (line.trim()) logs.media(line);
    });
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.ev === 'ready') {
        media.caps = { version: ev.version, sources: ev.sources || [], hardware: ev.hardware || [], audio: !!ev.audio };
        return resolve(media.caps);
      }
      if (win && !win.isDestroyed()) win.webContents.send('desktop:media', ev);
    });
    const gone = (why) => {
      if (media.proc !== proc) return;
      media.proc = null;
      media.ready = null;
      media.caps = null;
      resolve(null);
      if (quitting) return;
      media.crashes++;
      console.warn('[media] sidecar stopped:', why);
      if (win && !win.isDestroyed()) win.webContents.send('desktop:media', { ev: 'exit', gone: media.crashes >= MEDIA_CRASHES });
    };
    proc.on('error', (e) => gone(e.message));
    proc.on('exit', (code, signal) => gone(signal || `exit code ${code}`));
  });
  return media.ready;
}

const MEDIA_OPS = ['start', 'quality', 'stop', 'viewer', 'unviewer', 'signal', 'view'];
const MEDIA_KINDS = ['screen', 'camera'];

async function sendMedia(cmd) {
  if (!cmd || !MEDIA_OPS.includes(cmd.op) || !MEDIA_KINDS.includes(cmd.kind)) return;
  if (!(await startMedia()) || !media.proc) {
    // Nothing to carry the share: tell the page as the sidecar would
    if (cmd.op === 'start' && win && !win.isDestroyed()) win.webContents.send('desktop:media', { ev: 'error', kind: cmd.kind, message: 'native media is not available' });
    return;
  }
  if (cmd.op === 'start') cmd = await describeSource(cmd);
  media.proc.stdin.write(JSON.stringify(cmd) + '\n');
}

// What only the main process knows about a share: where the screen is, whose
// sound to leave out of its audio, and whether encoders may use the GPU.
async function describeSource(cmd) {
  const source = { ...cmd.source, exclude_pid: process.pid };
  if (process.env.FRIENDSPEAK_FAKE_CAPTURE === '1') source.type = 'test'; // a test pattern, for automated runs
  if (source.type === 'screen') {
    const all = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).catch(() => []);
    const displayId = all.find((s) => s.id === source.id)?.display_id;
    const display = screen.getAllDisplays().find((d) => String(d.id) === String(displayId));
    if (display) {
      // In physical pixels, as the OS capture APIs count them
      const b = process.platform === 'win32' ? screen.dipToScreenRect(null, display.bounds) : display.bounds;
      Object.assign(source, { x: b.x, y: b.y, width: b.width, height: b.height });
    }
  }
  return { ...cmd, source, hw: prefs.hardwareAcceleration };
}

function stopMedia() {
  const proc = media.proc;
  if (!proc) return;
  try {
    proc.stdin.end(); // it exits when its stdin closes
  } catch {}
  setTimeout(() => proc.exitCode == null && proc.kill(), 1500).unref();
}

// In the app window, zoom is the UI size setting (theme.js): the page steps it
// (+1, -1, or 0 to reset) and applies it. Other windows (the game's pop-out) zoom
// like a browser.
function zoomItem(label, accelerator, step, extra = {}) {
  return {
    label,
    accelerator,
    ...extra,
    click: (_item, focused) => {
      if (!focused) return;
      if (focused === win) return win.webContents.send('desktop:zoom', step);
      const wc = focused.webContents;
      wc.setZoomLevel(step ? wc.getZoomLevel() + step * 0.5 : 0);
    },
  };
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' }] : []),
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          zoomItem('Actual Size', 'CommandOrControl+0', 0),
          zoomItem('Zoom In', 'CommandOrControl+Plus', 1),
          zoomItem('Zoom In', 'CommandOrControl+=', 1, { visible: false, acceleratorWorksWhenHidden: true }), // + without Shift
          zoomItem('Zoom Out', 'CommandOrControl+-', -1),
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ])
  );
}

// ---------------------------------------------------------------- global hotkeys

// Soundboard combos look like "Ctrl+Shift+1" (see comboFromEvent in util.js)
const KEY_NAMES = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';',
  Quote: "'", Comma: ',', Period: '.', Slash: '/', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
};
const MODS = { Ctrl: 'Control', Alt: 'Alt', Shift: 'Shift', Meta: 'Super' };

function toAccelerator(combo) {
  const parts = combo.split('+');
  const key = parts.pop();
  const mods = parts.map((m) => MODS[m]).filter(Boolean);
  // Only claim keys globally when they can't interfere with normal typing
  const safeAlone = /^F\d+$/.test(key) || /^Numpad/.test(key) || ['Pause', 'ScrollLock', 'Insert'].includes(key);
  if (!mods.filter((m) => m !== 'Shift').length && !safeAlone) return null;
  let name = KEY_NAMES[key] || key;
  if (/^Numpad\d$/.test(key)) name = 'num' + key.slice(6);
  return [...mods, name].join('+');
}

function setHotkeys(combos) {
  globalShortcut.unregisterAll();
  const registered = [];
  for (const combo of new Set(combos)) {
    const acc = toAccelerator(combo);
    if (!acc) continue;
    try {
      if (globalShortcut.register(acc, () => win?.webContents.send('desktop:hotkey', combo))) registered.push(combo);
    } catch {
      // unsupported key for this platform; it still works while focused
    }
  }
  return registered;
}

// ---------------------------------------------------------------- updates (D29)

// Releases are published by .github/workflows/release.yml on every push to
// `prod`. The installers carry the latest*.yml files electron-updater reads.
const REPO = { owner: 'nickolaiposs', repo: 'friendspeak' };
const RELEASES = `https://github.com/${REPO.owner}/${REPO.repo}/releases`;
// In-app install works for the Windows installer and the Linux AppImage.
// Squirrel.Mac refuses unsigned (ad-hoc) apps and the Windows portable exe has
// no installer, so those get a download link to the release page instead.
const CAN_INSTALL =
  process.platform === 'win32' ? !process.env.PORTABLE_EXECUTABLE_DIR : process.platform === 'linux' ? !!process.env.APPIMAGE : false;
// From source (`npm run desktop`) only with FRIENDSPEAK_UPDATE_DEV=1, for testing
const UPDATES_ON = app.isPackaged || process.env.FRIENDSPEAK_UPDATE_DEV === '1';

// status: idle | checking | none | available | downloading | ready | error
let update = { current: app.getVersion(), status: 'idle', version: null, url: RELEASES, canInstall: CAN_INSTALL, progress: 0, error: null };
let updater = null;

function setUpdate(patch) {
  update = { ...update, ...patch };
  win?.webContents.send('desktop:update', update);
}

function startUpdater() {
  if (!UPDATES_ON) return;
  ({ autoUpdater: updater } = require('electron-updater'));
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updater.logger = null;
  // A private repo needs a token to read releases. Never ship one: this is for
  // testing (`GH_TOKEN=… npm run desktop`) until the repo is public.
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token || !app.isPackaged) {
    updater.forceDevUpdateConfig = !app.isPackaged;
    updater.setFeedURL({ provider: 'github', ...REPO, ...(token ? { private: true, token } : {}) });
  }
  updater.on('checking-for-update', () => setUpdate({ status: 'checking', error: null }));
  updater.on('update-not-available', () => setUpdate({ status: 'none', version: null }));
  updater.on('update-available', (info) => setUpdate({ status: 'available', version: info.version, url: `${RELEASES}/tag/v${info.version}` }));
  updater.on('download-progress', (p) => setUpdate({ status: 'downloading', progress: Math.round(p.percent) }));
  updater.on('update-downloaded', () => setUpdate({ status: 'ready', progress: 100 }));
  updater.on('error', (err) => console.warn('[update]', String(err?.message || err).split('\n')[0]));
  updater.on('error', (err) => setUpdate({ status: update.version ? 'available' : 'error', error: String(err?.message || err).split('\n')[0] }));
  setTimeout(checkForUpdates, 10e3);
  setInterval(checkForUpdates, 4 * 60 * 60e3);
}

function checkForUpdates() {
  if (!updater || ['checking', 'downloading', 'ready'].includes(update.status)) return;
  updater.checkForUpdates().catch(() => {}); // reported through the 'error' event
}

handle('desktop:update-state', () => update);
handle('desktop:update-check', () => (updater ? checkForUpdates() : setUpdate({ status: 'error', error: 'Updates are only checked in the installed app' })));
handle('desktop:update-download', () => {
  if (update.status !== 'available') return;
  if (!CAN_INSTALL) return shell.openExternal(update.url);
  setUpdate({ status: 'downloading', progress: 0, error: null });
  updater.downloadUpdate().catch(() => {});
});
handle('desktop:update-install', () => update.status === 'ready' && updater.quitAndInstall());
handle('desktop:open-releases', (_e, version) => shell.openExternal(typeof version === 'string' && /^[\d.]+$/.test(version) ? `${RELEASES}/tag/v${version}` : RELEASES));

// ---------------------------------------------------------------- ipc

handle('desktop:trust-server', (_e, address) => trustServer(String(address)));
// Chat file downloads: Electron shows a save dialog, and pinned certificates apply
handle('desktop:download', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) win?.webContents.downloadURL(url);
});
// Notification clicks bring the window back
// The video grid's window can stay above other windows (its "Keep on top" button)
handle('desktop:stream-top', (_e, name, on) => {
  const w = streamWindows.get(name);
  if (w && !w.isDestroyed()) w.setAlwaysOnTop(!!on, 'floating');
});

handle('desktop:focus', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});
// Unread count on the dock/taskbar icon; Windows has no count, so flash the taskbar instead
handle('desktop:badge', (_e, n) => {
  n = Math.min(9999, Math.max(0, Math.trunc(Number(n)) || 0));
  if (process.platform === 'win32') {
    if (win && !win.isDestroyed()) win.flashFrame(n > 0 && !win.isFocused());
  } else app.setBadgeCount(n);
});
handle('desktop:media-caps', () => startMedia());
listen('desktop:media-send', (_e, cmd) => sendMedia(cmd).catch((e) => console.warn('[media]', e.message)));
// Hardware acceleration: what is set (applies to the sidecar's encoders at the next share, and to the app's
// own drawing at the next start), what this run started with, and what Chromium does with the GPU
handle('desktop:prefs', async (_e, patch) => {
  if (patch && typeof patch.hardwareAcceleration === 'boolean') {
    prefs = { ...prefs, hardwareAcceleration: patch.hardwareAcceleration };
    fs.writeFileSync(PREFS_FILE(), JSON.stringify(prefs, null, 2));
  }
  return { ...prefs, atStart: HW_AT_START, gpu: app.getGPUFeatureStatus() };
});
// Logs and crash reports
listen('desktop:log', (_e, msg) => logs.fromRenderer(msg));
handle('desktop:logs-read', (_e, o) => logs.read({ limit: o?.limit, before: o?.before }));
handle('desktop:logs-summary', () => logs.summary());
handle('desktop:logs-seen', () => logs.seen());
handle('desktop:logs-report', () => logs.report());
handle('desktop:logs-save', () => logs.save(win && !win.isDestroyed() ? win : undefined));
handle('desktop:logs-reveal', () => logs.reveal());
handle('desktop:logs-clear', () => logs.clear());
handle('desktop:set-hotkeys', (_e, combos) => setHotkeys(Array.isArray(combos) ? combos.filter((c) => typeof c === 'string') : []));

// ---------------------------------------------------------------- lifecycle

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  serveApp();
  allowMicrophone();
  allowYouTubeEmbeds();
  allowScreenShare();
  acceptPinnedCertificates();
  buildMenu();
  createWindow();
  startUpdater();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

let quitting = false;
app.on('before-quit', () => ((quitting = true), stopMedia()));
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
