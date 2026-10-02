// friendspeak desktop app (Electron).
//
// - Loads the same UI as the web client from a private friendspeak:// origin,
//   which counts as a secure context: the microphone always works, and profiles
//   and sounds stay put no matter which server you connect to.
// - It is a client only. To host, run the server separately (`npm start` or
//   Docker) and connect to it like any other server.
// - Registers soundboard hotkeys as global shortcuts that work in other apps.
// - Checks GitHub Releases for new versions and installs them where it can (D29).
const { app, BrowserWindow, protocol, ipcMain, globalShortcut, shell, session, systemPreferences, Menu, dialog, desktopCapturer } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const MODULES = path.join(ROOT, 'node_modules');
const ROUTES = [
  ['/vendor/emoji-picker-element/', path.join(MODULES, 'emoji-picker-element')],
  ['/vendor/emoji-data/', path.join(MODULES, 'emoji-picker-element-data')],
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
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'friendspeak', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// Separate profile/data folder, e.g. to run two copies side by side
if (process.env.FRIENDSPEAK_USER_DATA) app.setPath('userData', path.resolve(process.env.FRIENDSPEAK_USER_DATA));

// Soundboard hotkeys can fire while the window is in the background
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// System audio for screen sharing on macOS (13+). Windows supports it natively.
if (process.platform === 'darwin') app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');

// Screen capture on Windows: keep frames on the GPU instead of copying each one
// through memory. Chromium's capturer spends at most half its time capturing,
// so the copy capped a 1440p share at about 30 fps in motion (D34).
// FRIENDSPEAK_LEGACY_CAPTURE=1 turns this off if a share comes out black or frozen.
if (process.platform === 'win32' && process.env.FRIENDSPEAK_LEGACY_CAPTURE !== '1') app.commandLine.appendSwitch('enable-features', 'WebRtcAllowWgcUsingTexture,ZeroCopyDesktopCapture');

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

  win.webContents.setWindowOpenHandler(({ url }) => {
    // The game's "Pop out" button opens it in its own window
    if (/^https?:\/\/[^/]+\/game\//.test(url)) {
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
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Links clicked inside chat open in the real browser
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('friendspeak://')) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });

  win.loadURL('friendspeak://app/index.html');
  win.on('closed', () => (win = null));
}

function serveApp() {
  protocol.handle('friendspeak', async (request) => {
    const { pathname } = new URL(request.url);
    const clean = decodeURIComponent(pathname);
    for (const [prefix, target] of ROUTES) {
      if (!clean.startsWith(prefix) && clean !== prefix.replace(/\/$/, '')) continue;
      const file = target.endsWith('.js') ? target : path.join(target, clean.slice(prefix.length) || 'index.html');
      if (!file.startsWith(target)) break; // path traversal
      try {
        const data = await fs.promises.readFile(file);
        return new Response(data, { headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' } });
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

function allowMicrophone() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler(async (_wc, permission, callback, details) => {
    if (permission === 'media') {
      if (process.platform === 'darwin') {
        const types = details.mediaTypes || [];
        if (types.includes('audio') && !(await systemPreferences.askForMediaAccess('microphone'))) return callback(false);
        if (types.includes('video') && !(await systemPreferences.askForMediaAccess('camera'))) return callback(false);
      }
      return callback(true);
    }
    callback(['clipboard-sanitized-write', 'display-capture', 'fullscreen', 'notifications', 'speaker-selection'].includes(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) => ['media', 'display-capture', 'speaker-selection', 'clipboard-sanitized-write'].includes(permission));
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
  ipcMain.handle('desktop:screen-sources', () => screenSources());
  ipcMain.handle('desktop:screen-pick', (_e, pick) => {
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

function buildMenu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' }] : []),
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
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
  updater.on('error', (err) => setUpdate({ status: update.version ? 'available' : 'error', error: String(err?.message || err).split('\n')[0] }));
  setTimeout(checkForUpdates, 10e3);
  setInterval(checkForUpdates, 4 * 60 * 60e3);
}

function checkForUpdates() {
  if (!updater || ['checking', 'downloading', 'ready'].includes(update.status)) return;
  updater.checkForUpdates().catch(() => {}); // reported through the 'error' event
}

ipcMain.handle('desktop:update-state', () => update);
ipcMain.handle('desktop:update-check', () => (updater ? checkForUpdates() : setUpdate({ status: 'error', error: 'Updates are only checked in the installed app' })));
ipcMain.handle('desktop:update-download', () => {
  if (update.status !== 'available') return;
  if (!CAN_INSTALL) return shell.openExternal(update.url);
  setUpdate({ status: 'downloading', progress: 0, error: null });
  updater.downloadUpdate().catch(() => {});
});
ipcMain.handle('desktop:update-install', () => update.status === 'ready' && updater.quitAndInstall());
ipcMain.handle('desktop:open-releases', (_e, version) => shell.openExternal(typeof version === 'string' && /^[\d.]+$/.test(version) ? `${RELEASES}/tag/v${version}` : RELEASES));

// ---------------------------------------------------------------- ipc

ipcMain.handle('desktop:trust-server', (_e, address) => trustServer(String(address)));
// Chat file downloads: Electron shows a save dialog, and pinned certificates apply
ipcMain.handle('desktop:download', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) win?.webContents.downloadURL(url);
});
ipcMain.handle('desktop:set-hotkeys', (_e, combos) => setHotkeys(Array.isArray(combos) ? combos.filter((c) => typeof c === 'string') : []));

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

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
