// Everything a user "owns" lives on their own device: profiles, their keys,
// server bookmarks, settings (localStorage), soundboard files, direct
// messages and camera background pictures (IndexedDB).
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
  remove(id) {
    write('fs.profiles', this.all().filter((p) => p.id !== id));
    identities.remove(id);
  },
};

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

// ---------- server bookmarks ----------

export const servers = {
  all: () => read('fs.servers', []),
  saveAll: (list) => write('fs.servers', list),
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
  get: (id) => read('fs.servers', []).find((s) => s.id === id),
  last: () => read('fs.lastServer', null),
  setLast: (id) => write('fs.lastServer', id),
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

// Unread mentions per server and channel, so the red badges survive a restart:
// { [serverId]: { [channelId]: count } }
export const mentionUnread = {
  all: () => read('fs.mentionUnread', {}),
  add(serverId, channelId) {
    const all = this.all();
    all[serverId] = { ...all[serverId], [channelId]: (all[serverId]?.[channelId] || 0) + 1 };
    write('fs.mentionUnread', all);
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
    write('fs.mentionUnread', all);
    return true;
  },
  channel: (serverId, channelId) => read('fs.mentionUnread', {})[serverId]?.[channelId] || 0,
  server: (serverId) => Object.values(read('fs.mentionUnread', {})[serverId] || {}).reduce((n, c) => n + c, 0),
  total: () => Object.values(read('fs.mentionUnread', {})).reduce((n, ch) => n + Object.values(ch).reduce((a, c) => a + c, 0), 0),
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
// another device. Whoever has the file can read and write DMs as that profile.
export function exportProfile(p) {
  const blob = new Blob([JSON.stringify({ friendspeakProfile: 1, ...p, keys: identities.get(p.id) || undefined }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `friendspeak-${p.name}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function importProfile(file) {
  const data = JSON.parse(await file.text());
  if (!data.friendspeakProfile) throw new Error('Not a friendspeak profile file');
  const { friendspeakProfile, keys, ...p } = data;
  profiles.save(p);
  if (keys?.sign?.priv && keys?.dh?.priv) identities.set(p.id, keys); // older exports have none: new keys are made on first use
  profiles.setActive(p.id);
  return p;
}
