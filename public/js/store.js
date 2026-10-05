// Everything a user "owns" lives on their own device: profiles, their keys,
// server bookmarks, settings (localStorage), soundboard files, direct
// messages and camera background pictures (IndexedDB).
//
// A profile is its own account (D50): server bookmarks, the last server and
// unread mentions are kept per profile, as DMs already were. Settings, sounds
// and camera backgrounds belong to the device.
import { uid } from './util.js';

const read = (k, d) => {
  try {
    const v = JSON.parse(localStorage.getItem(k));
    return v ?? d;
  } catch {
    return d;
  }
};
const write = (k, v) => localStorage.setItem(k, JSON.stringify(v));
// The active profile's copy of a per-profile key: "fs.servers:<profile id>"
const PER_PROFILE = ['fs.servers', 'fs.lastServer', 'fs.mentionUnread'];
const mine = (k) => `${k}:${read('fs.activeProfile', '')}`;

const COLORS = ['#8b6cf6', '#e06fb8', '#2fb36d', '#d99a1c', '#e5484d', '#f0835a', '#4aa3f0', '#b866e0', '#22b8a6', '#e88a2a'];
export const randomColor = () => COLORS[Math.floor(Math.random() * COLORS.length)];

// ---------- profiles ----------

export const profiles = {
  all: () => read('fs.profiles', []),
  active() {
    const list = this.all();
    return list.find((p) => p.id === read('fs.activeProfile', null)) || list[0] || null;
  },
  setActive: (id) => write('fs.activeProfile', id),
  save(p) {
    const list = this.all();
    const i = list.findIndex((x) => x.id === p.id);
    if (i >= 0) list[i] = p;
    else list.push(p);
    write('fs.profiles', list);
    return p;
  },
  create(data) {
    const p = { id: uid(), name: 'friend', color: randomColor(), avatar: '', banner: '', status: '', ...data };
    this.save(p);
    this.setActive(p.id);
    return p;
  },
  // Its server list goes with it. Its DMs stay in IndexedDB, for a later import of the same profile.
  remove(id) {
    write('fs.profiles', this.all().filter((p) => p.id !== id));
    identities.remove(id);
    for (const k of PER_PROFILE) localStorage.removeItem(`${k}:${id}`);
  },
};

// Before D50 every profile shared one server list. Each profile that exists
// gets a copy (with the same bookmark ids, which settings refer to), so nobody
// loses a server they were using; the unread mentions go to the active one.
(function splitByProfile() {
  const list = profiles.all();
  if (localStorage.getItem('fs.servers') === null || !list.length) return;
  const active = profiles.active().id;
  write('fs.activeProfile', active);
  for (const p of list) {
    if (localStorage.getItem(`fs.servers:${p.id}`) !== null) continue;
    write(`fs.servers:${p.id}`, read('fs.servers', []));
    write(`fs.lastServer:${p.id}`, read('fs.lastServer', null));
  }
  if (localStorage.getItem(`fs.mentionUnread:${active}`) === null) write(`fs.mentionUnread:${active}`, read('fs.mentionUnread', {}));
  for (const k of PER_PROFILE) localStorage.removeItem(k);
})();

// The key pairs behind each profile (identity.js, D32). They live apart from
// the profile itself, because the whole profile object is sent to servers.
export const identities = {
  get: (profileId) => read('fs.keys', {})[profileId] || null,
  set: (profileId, keys) => write('fs.keys', { ...read('fs.keys', {}), [profileId]: keys }),
  remove(profileId) {
    const { [profileId]: _, ...rest } = read('fs.keys', {});
    write('fs.keys', rest);
  },
};

// ---------- server bookmarks (the active profile's) ----------

export const servers = {
  all: () => read(mine('fs.servers'), []),
  saveAll: (list) => write(mine('fs.servers'), list),
  upsert(entry) {
    const list = this.all();
    const i = list.findIndex((s) => s.id === entry.id);
    if (i >= 0) list[i] = { ...list[i], ...entry };
    else list.push({ id: uid(), ...entry });
    this.saveAll(list);
    return i >= 0 ? list[i] : list[list.length - 1];
  },
  remove(id) {
    this.saveAll(this.all().filter((s) => s.id !== id));
  },
  get: (id) => read(mine('fs.servers'), []).find((s) => s.id === id),
  last: () => read(mine('fs.lastServer'), null),
  setLast: (id) => write(mine('fs.lastServer'), id),
};

// ---------- settings ----------

const DEFAULT_SETTINGS = {
  giphyKey: '',
  inputDevice: '',
  outputDevice: '',
  videoDevice: '', // camera
  cameraBackground: 'none', // a key of BACKGROUNDS (background.js): 'none' | 'blur' | 'image'
  cameraBlur: 0.5, // blur strength, 0..1
  cameraImage: '', // the picture for 'image': a preset's id, or one of your own (backgroundStore)
  micVolume: 1,
  masterVolume: 1, // everything this app plays: voices, streams, soundboard, cues
  voiceVolume: 1, // other people's voices
  cueVolume: 1, // join/leave/mute/message sounds
  soundboardVolume: 0.8,
  soundboardMonitor: true, // hear your own soundboard
  ptt: false,
  pttKey: 'Backquote',
  noiseSuppression: true, // DeepFilterNet, in a worklet (D47)
  noiseSuppressionLimit: 100, // dB the noise is turned down by at most; 100 is no limit (DENOISE_LIMIT in audio.js)
  autoGain: true, // the browser's automatic gain: levels a quiet or loud mic (D44)
  echoCancellation: true, // the browser's echo canceller: keeps what the speakers play out of the mic (D48)
  micGate: -50, // dB the noise gate opens at; GATE.min (audio.js) and below is no gate (D48)
  userVolumes: {}, // profileId -> 0..3 (above 1 boosts, see audio.js)
  userMutes: {}, // profileId -> true: muted for us only
  muteHotkey: '', // combos like the soundboard's (comboFromEvent)
  deafenHotkey: '',
  lastChannel: {}, // serverId -> channelId
  showMembers: true,
  shareTier: 'auto', // screen share quality ceiling: a key of TIERS (voice.js)
  shareMode: 'smooth', // 'smooth' (games, video) | 'sharp' (text, code)
  nativeStreaming: true, // desktop app: shares go through the native media sidecar when it can carry them (D45)
  hideOffline: false, // collapse the member list's Offline section
  railDmsHidden: false, // collapsed groups in the left rail
  railServersHidden: false,
  cues: true, // master switch for the app's sounds
  sounds: {}, // cue kind -> false when that sound is off (missing = on), see CUES in audio.js
  notify: true, // master switch for notifications (DMs, mentions, calls)
  loadLinkMedia: false, // pictures, video and sound that a message links to load without a click (their host then sees your address)
  notifyMentions: true,
  notifyDms: true,
  notifyMutedUsers: {}, // profileId -> name: no notifications from them, anywhere. Not userMutes (voice).
  notifyMutedServers: {}, // serverId -> true: no notifications from this server
  dismissedBanners: {}, // update/maintenance banner key -> when it was closed
  // appearance (theme.js)
  theme: 'dark', // 'dark' | 'light' | 'contrast' | 'custom'
  themeColors: null, // the custom palette: { 'bg-0': '#rrggbb', … }
  font: 'system', // a key of FONTS, or 'custom' for fontCustom
  fontCustom: '', // name of a font installed on this device
  fontSize: 14.5, // px
  density: 'cozy', // 'compact' | 'cozy' | 'roomy'
  uiScale: 100, // percent: one of UI_SCALES, the desktop window's zoom
};

export const settings = {
  get() {
    const saved = read('fs.settings', {});
    const s = { ...DEFAULT_SETTINGS, ...saved };
    // Before D38 this was noiseReduction ('off' | 'standard' | 'high'): keep an
    // explicit off. The old key goes away with the next set().
    if (saved.noiseReduction) s.noiseSuppression = saved.noiseReduction !== 'off';
    delete s.noiseReduction;
    return s;
  },
  set(patch) {
    const s = { ...this.get(), ...patch };
    write('fs.settings', s);
    return s;
  },
};

// The active profile's unread mentions per server and channel, so the red badges survive a restart:
// { [serverId]: { [channelId]: count } }
export const mentionUnread = {
  all: () => read(mine('fs.mentionUnread'), {}),
  add(serverId, channelId) {
    const all = this.all();
    all[serverId] = { ...all[serverId], [channelId]: (all[serverId]?.[channelId] || 0) + 1 };
    write(mine('fs.mentionUnread'), all);
  },
  // One channel, or the whole server when no channel is given
  clear(serverId, channelId) {
    const all = this.all();
    if (!all[serverId]) return false;
    if (channelId) {
      if (!all[serverId][channelId]) return false;
      delete all[serverId][channelId];
      if (!Object.keys(all[serverId]).length) delete all[serverId];
    } else delete all[serverId];
    write(mine('fs.mentionUnread'), all);
    return true;
  },
  channel: (serverId, channelId) => read(mine('fs.mentionUnread'), {})[serverId]?.[channelId] || 0,
  server: (serverId) => Object.values(read(mine('fs.mentionUnread'), {})[serverId] || {}).reduce((n, c) => n + c, 0),
  total: () => Object.values(read(mine('fs.mentionUnread'), {})).reduce((n, ch) => n + Object.values(ch).reduce((a, c) => a + c, 0), 0),
};

// ---------- IndexedDB: soundboard and direct messages ----------

let dbp;
function db() {
  return (dbp ||= new Promise((resolve, reject) => {
    const req = indexedDB.open('friendspeak', 4);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('sounds')) d.createObjectStore('sounds', { keyPath: 'id' });
      // DMs are keyed by "<my profile id>|<their profile id>" so each local profile has its own
      if (!d.objectStoreNames.contains('dmContacts')) d.createObjectStore('dmContacts', { keyPath: 'key' }).createIndex('owner', 'owner');
      if (!d.objectStoreNames.contains('dmMessages')) d.createObjectStore('dmMessages', { keyPath: 'key' }).createIndex('thread', 'thread');
      // Images sent and received in DMs, keyed by "<thread>|<file id>"
      if (!d.objectStoreNames.contains('dmFiles')) d.createObjectStore('dmFiles', { keyPath: 'key' }).createIndex('thread', 'thread');
      // Your own camera background pictures (background.js)
      if (!d.objectStoreNames.contains('backgrounds')) d.createObjectStore('backgrounds', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

async function tx(mode, fn, store = 'sounds') {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  });
}

export const sounds = {
  async all() {
    const list = (await tx('readonly', (s) => s.getAll())) || [];
    return list.sort((a, b) => (a.order ?? a.created) - (b.order ?? b.created));
  },
  put: (sound) => tx('readwrite', (s) => s.put(sound)),
  remove: (id) => tx('readwrite', (s) => s.delete(id)),
  async add(file) {
    const sound = {
      id: uid(),
      name: file.name.replace(/\.[^.]+$/, '').slice(0, 40),
      emoji: '🔊',
      volume: 1,
      hotkey: '',
      blob: file,
      type: file.type,
      created: Date.now(),
    };
    await this.put(sound);
    return sound;
  },
};

// ---------- camera background pictures (IndexedDB, see background.js) ----------

export const backgroundStore = {
  async all() {
    const list = (await tx('readonly', (s) => s.getAll(), 'backgrounds')) || [];
    return list.sort((a, b) => a.created - b.created);
  },
  get: (id) => tx('readonly', (s) => s.get(id), 'backgrounds'),
  put: (pic) => tx('readwrite', (s) => s.put(pic), 'backgrounds'),
  remove: (id) => tx('readwrite', (s) => s.delete(id), 'backgrounds'),
};

// ---------- direct messages (IndexedDB, see dm.js) ----------

export const dmStore = {
  contacts: (owner) => tx('readonly', (s) => s.index('owner').getAll(owner), 'dmContacts'),
  putContact: (c) => tx('readwrite', (s) => s.put(c), 'dmContacts'),
  messages: (thread) => tx('readonly', (s) => s.index('thread').getAll(thread), 'dmMessages'),
  putMessage: (m) => tx('readwrite', (s) => s.put(m), 'dmMessages'),
  removeMessage: (key) => tx('readwrite', (s) => s.delete(key), 'dmMessages'),
  file: (key) => tx('readonly', (s) => s.get(key), 'dmFiles'),
  putFile: (f) => tx('readwrite', (s) => s.put(f), 'dmFiles'),
  removeFile: (key) => tx('readwrite', (s) => s.delete(key), 'dmFiles'),
  async removeThread(contactKey) {
    for (const store of ['dmMessages', 'dmFiles']) {
      const keys = await tx('readonly', (s) => s.index('thread').getAllKeys(contactKey), store);
      await tx('readwrite', (s) => keys.forEach((k) => s.delete(k)), store);
    }
    await tx('readwrite', (s) => s.delete(contactKey), 'dmContacts');
  },
};

// ---------- profile export / import ----------

// The file carries the profile's private keys, so the same identity works on
// another device. Whoever can read them can read and write DMs as that profile, so with a
// passphrase the keys are sealed: { friendspeakProfile: 2, …profile, sealed: { kdf, iter, salt, iv, data } },
// AES-256-GCM under a key from PBKDF2-SHA-256. Without one they are in the file as they are
// (friendspeakProfile: 1, which older apps also read).
const KDF_ITERATIONS = 600000;
const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function passKey(passphrase, salt, iter) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function exportProfile(p, passphrase = '') {
  const keys = identities.get(p.id) || undefined;
  let file = { friendspeakProfile: 1, ...p, keys };
  if (passphrase && keys) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await passKey(passphrase, salt, KDF_ITERATIONS), new TextEncoder().encode(JSON.stringify(keys)));
    file = { friendspeakProfile: 2, ...p, sealed: { kdf: 'PBKDF2-SHA-256', iter: KDF_ITERATIONS, salt: b64u(salt), iv: b64u(iv), data: b64u(data) } };
  }
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `friendspeak-${p.name}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// askPassphrase(): asked when the file's keys are sealed; resolves to the passphrase, or null to give up.
// A profile file can come from anyone: only the fields a profile has are taken, each checked.
export async function importProfile(file, askPassphrase) {
  if (file.size > 4 * 1024 * 1024) throw new Error('Not a friendspeak profile file');
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    data = null;
  }
  if (!data || typeof data !== 'object' || !data.friendspeakProfile) throw new Error('Not a friendspeak profile file');
  const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : '');
  const image = (v, max) => typeof v === 'string' && v.length <= max && /^(data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$|https:\/\/(?:media\d*|i)\.giphy\.com\/[^\s"'<>]+$)/.test(v);
  const color = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
  const id = typeof data.id === 'string' && /^[\w-]{1,64}$/.test(data.id) ? data.id : null;
  if (!id) throw new Error('This profile file has no usable id');
  const p = {
    id,
    name: text(data.name, 32).trim() || 'friend',
    color: color(data.color) ? data.color : randomColor(),
    avatar: image(data.avatar, 600 * 1024) ? data.avatar : /^(https?:|data:)/i.test(text(data.avatar, 16)) ? '' : [...text(data.avatar, 16)].slice(0, 2).join(''),
    banner: image(data.banner, 1024 * 1024) || color(data.banner) ? data.banner : '',
    status: text(data.status, 64),
  };
  let keys = data.keys;
  if (data.sealed && typeof data.sealed === 'object') {
    const { iter, salt, iv, data: sealed } = data.sealed;
    if (data.sealed.kdf !== 'PBKDF2-SHA-256' || !Number.isInteger(iter) || iter < 1 || iter > 5e6) throw new Error('This profile file is protected in a way this version can’t open');
    const passphrase = await askPassphrase?.();
    if (!passphrase) throw new Error('The profile wasn’t imported: it needs its passphrase');
    try {
      keys = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(iv) }, await passKey(passphrase, unb64u(salt), iter), unb64u(sealed))));
    } catch {
      throw new Error('Wrong passphrase');
    }
  }
  const key = (v, max) => typeof v === 'string' && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v);
  const pair = (k) => !!k && typeof k === 'object' && key(k.pub, 64) && key(k.priv, 256);
  profiles.save(p);
  if (keys && typeof keys === 'object' && pair(keys.sign) && pair(keys.dh)) identities.set(p.id, { sign: { pub: keys.sign.pub, priv: keys.sign.priv }, dh: { pub: keys.dh.pub, priv: keys.dh.priv } });
  // older exports have none: new keys are made on first use
  profiles.setActive(p.id);
  return p;
}
