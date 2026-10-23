// The Steam game that is running on this computer, for the "playing" line next
// to a name (D59). Worked out from what Steam leaves on disk and from the
// process list: no Steam account, no web API, nothing leaves this computer here.
//
//   Windows  Steam keeps the running app's id in the registry (RunningAppID)
//   Linux    Steam starts every game through `reaper SteamLaunch AppId=<id>`
//   macOS    a process whose program is inside a library's steamapps/common/<game>/
//
// The name comes from the game's appmanifest_<id>.acf in a Steam library. A
// shortcut to a program that isn't from Steam has no manifest, so it is never shown.
// The icon is the small picture Steam keeps for its library, in appcache/librarycache.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const LIBRARY_TTL = 60e3; // how long the list of installed games is kept
const MAX_NAME = 64;
const MAX_ICON = 16 * 1024; // Steam's icons are 32×32 and about 1 KB; anything much bigger isn't one

// stdout of a program, '' when it fails or isn't there
const run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 5000, maxBuffer: 8 << 20 }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
const read = (file) => fs.readFile(file, 'utf8').catch(() => '');

// A value of Valve's text format: "key"  "value", with \\ and \" escaped
function vdfValue(text, key) {
  const m = new RegExp(`"${key}"\\s+"((?:[^"\\\\]|\\\\.)*)"`, 'i').exec(text);
  return m ? m[1].replace(/\\(.)/g, '$1') : '';
}
const vdfValues = (text, key) => [...text.matchAll(new RegExp(`"${key}"\\s+"((?:[^"\\\\]|\\\\.)*)"`, 'gi'))].map((m) => m[1].replace(/\\(.)/g, '$1'));

// Where Steam may be installed. `winPath` is SteamPath from the registry.
function steamRoots(winPath) {
  const home = os.homedir();
  if (process.platform === 'win32') return [winPath, 'C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam'].filter(Boolean);
  if (process.platform === 'darwin') return [path.join(home, 'Library/Application Support/Steam')];
  return [
    path.join(home, '.local/share/Steam'),
    path.join(home, '.steam/steam'),
    path.join(home, '.var/app/com.valvesoftware.Steam/.local/share/Steam'), // Flatpak
    path.join(home, 'snap/steam/common/.local/share/Steam'),
  ];
}

// Every installed game: [{ id, name, dir }], `dir` being its folder under steamapps/common
let library = { at: 0, key: '', games: [] };
async function installed(roots) {
  const key = roots.join('|');
  if (library.key === key && Date.now() - library.at < LIBRARY_TTL) return library.games;
  const libs = new Set();
  for (const root of roots) {
    const folders = await read(path.join(root, 'steamapps', 'libraryfolders.vdf'));
    if (!folders) continue;
    libs.add(path.normalize(root));
    for (const p of vdfValues(folders, 'path')) libs.add(path.normalize(p));
  }
  const games = [];
  for (const lib of libs) {
    const apps = path.join(lib, 'steamapps');
    const files = await fs.readdir(apps).catch(() => []);
    for (const f of files) {
      const id = /^appmanifest_(\d+)\.acf$/.exec(f)?.[1];
      if (!id) continue;
      const text = await read(path.join(apps, f));
      const name = vdfValue(text, 'name');
      const installdir = vdfValue(text, 'installdir');
      if (name && installdir) games.push({ id, name, dir: path.join(apps, 'common', installdir) + path.sep });
    }
  }
  library = { at: Date.now(), key, games };
  return games;
}

// The game's icon as a data URL, '' when Steam has none on disk. Steam keeps it in
// librarycache/<id>/<sha1>.jpg, or (before 2024) librarycache/<id>_icon.jpg.
const icons = new Map(); // id -> data URL ('' too: looked for and not there)
async function iconOf(id, roots) {
  if (icons.has(id)) return icons.get(id);
  let icon = '';
  for (const root of roots) {
    const dir = path.join(root, 'appcache', 'librarycache');
    const names = await fs.readdir(path.join(dir, id)).catch(() => []);
    const file = names.find((n) => /^[0-9a-f]{40}\.jpg$/i.test(n));
    for (const f of [file && path.join(dir, id, file), path.join(dir, id + '_icon.jpg')].filter(Boolean)) {
      const buf = await fs.readFile(f).catch(() => null);
      // A JPEG starts FF D8 FF
      if (buf && buf.length <= MAX_ICON && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) icon = 'data:image/jpeg;base64,' + buf.toString('base64');
      if (icon) break;
    }
    if (icon) break;
  }
  icons.set(id, icon);
  return icon;
}

// Windows: { id, root } from HKCU\Software\Valve\Steam
async function fromRegistry() {
  const out = await run('reg', ['query', 'HKCU\\Software\\Valve\\Steam']);
  const id = /^\s*RunningAppID\s+REG_DWORD\s+0x([0-9a-f]+)/im.exec(out);
  const root = /^\s*SteamPath\s+REG_SZ\s+(.+?)\s*$/im.exec(out);
  return { id: id ? String(parseInt(id[1], 16)) : '', root: root ? path.normalize(root[1]) : '' };
}

// For tests: FRIENDSPEAK_FAKE_STEAM_APP=<id> of an installed game makes it the one running
const FAKE_APP = /^\d+$/.test(process.env.FRIENDSPEAK_FAKE_STEAM_APP || '') ? process.env.FRIENDSPEAK_FAKE_STEAM_APP : '';

// What is running: { id, name, icon } or null
async function steamGame() {
  try {
    let id = '';
    let games;
    let roots = steamRoots();
    if (process.platform === 'win32') {
      const reg = await fromRegistry();
      if (!+reg.id && !FAKE_APP) return null;
      id = FAKE_APP || reg.id;
      roots = steamRoots(reg.root);
      games = await installed(roots);
    } else {
      const ps = await run('ps', ['-A', '-ww', '-o', 'args=']);
      if (!ps) return null;
      games = await installed(roots);
      id = FAKE_APP || /\bSteamLaunch AppId=(\d+)/.exec(ps)?.[1] || '';
      if (!id) {
        const lines = ps.split('\n');
        id = games.find((g) => lines.some((l) => l.trimStart().startsWith(g.dir)))?.id || '';
      }
    }
    const game = id && games.find((g) => g.id === id);
    return game ? { id: game.id, name: game.name.slice(0, MAX_NAME), icon: await iconOf(game.id, roots) } : null;
  } catch {
    return null;
  }
}

module.exports = { steamGame };
