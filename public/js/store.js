// Everything a user "owns" lives on their own device: profiles, their keys,
// server bookmarks, settings (localStorage), soundboard files and direct
// messages (IndexedDB).
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

const COLORS = ['#5865f2', '#eb459e', '#57f287', '#fee75c', '#ed4245', '#f47b67', '#3ba55c', '#9b59b6', '#1abc9c', '#e67e22'];
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

// The key pairs behind each profile (identity.js, D30). They live apart from
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
  micVolume: 1,
  soundboardVolume: 0.8,
  soundboardMonitor: true, // hear your own soundboard
  ptt: false,
  pttKey: 'Backquote',
  echoCancellation: true,
  noiseSuppression: true,
  userVolumes: {}, // profileId -> 0..2
  lastChannel: {}, // serverId -> channelId
  showMembers: true,
  hideOffline: false, // collapse the member list's Offline section
  railDmsHidden: false, // collapsed groups in the left rail
  railServersHidden: false,
  cues: true,
  dismissedBanners: {}, // update/maintenance banner key -> when it was closed
};

export const settings = {
  get: () => ({ ...DEFAULT_SETTINGS, ...read('fs.settings', {}) }),
  set(patch) {
    const s = { ...this.get(), ...patch };
    write('fs.settings', s);
    return s;
  },
};

// ---------- IndexedDB: soundboard and direct messages ----------

let dbp;
function db() {
  return (dbp ||= new Promise((resolve, reject) => {
    const req = indexedDB.open('friendspeak', 3);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('sounds')) d.createObjectStore('sounds', { keyPath: 'id' });
      // DMs are keyed by "<my profile id>|<their profile id>" so each local profile has its own
      if (!d.objectStoreNames.contains('dmContacts')) d.createObjectStore('dmContacts', { keyPath: 'key' }).createIndex('owner', 'owner');
      if (!d.objectStoreNames.contains('dmMessages')) d.createObjectStore('dmMessages', { keyPath: 'key' }).createIndex('thread', 'thread');
      // Images sent and received in DMs, keyed by "<thread>|<file id>"
      if (!d.objectStoreNames.contains('dmFiles')) d.createObjectStore('dmFiles', { keyPath: 'key' }).createIndex('thread', 'thread');
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
