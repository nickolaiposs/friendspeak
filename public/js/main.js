import '/vendor/emoji-picker-element/index.js';
import { $, $$, h, uid, formatText, fmtBytes, fmtTime, shortTime, fileToDataUrl, avatarEl, channelNameEl, isImage, comboFromEvent, normalizeAddress } from './util.js';
import { profiles, servers, settings, sounds, exportProfile, importProfile, randomColor } from './store.js';
import { audio, Level, MAX_USER_VOLUME } from './audio.js';
import { VoiceClient, SCREEN, MEDIA } from './voice.js';
import { DirectMessages, MAX_FILES } from './dm.js';
import { identityFor } from './identity.js';
import { DmCalls } from './call.js';
import { BACKGROUNDS, CAPTURE, PRESETS, presetCss, pictures, backgroundOf, loadBackground, activeBackground, setBackground, withBackground } from './background.js';
import { applyAppearance, paletteOf, samePalette, setColors, THEMES, SCHEMES, COLOR_GROUPS, FONTS, FONT_SIZE, DENSITIES } from './theme.js';

applyAppearance(); // before the first render

// ---------------------------------------------------------------- state

const S = {
  entry: null, // server bookmark in view
  conn: null, // its connection (see openSocket)
  call: null, // the connection the voice call is on: `conn`, or another server's kept open in the background
  channelId: null, // a text channel, or "dm:<profileId>" while the DM view is open
  messages: new Map(), // channelId -> []
  hasMore: new Map(),
  unread: new Set(),
  typing: new Map(), // channelId -> Map(sid -> { name, until })
  muted: false,
  deafened: false,
  replyTo: null,
  attachments: new Map(), // channelId -> [{ key, file, preview, progress, xhr }] waiting in the composer
  uploading: new Set(), // channelIds with a send in progress
  sounds: [],
  game: { open: false, visible: false, origin: null, frame: null },
  stage: null, // video view: { screen: sid|null, tiles: Map(key -> tile), ... } (see openStage)

  // The server in view
  get socket() {
    return this.conn?.socket || null;
  },
  get sid() {
    return this.conn?.sid || null;
  },
  get connected() {
    return !!this.conn?.connected;
  },
  // { name, icon, channels, emojis, profiles }
  get server() {
    return this.conn?.server || null;
  },
  get users() {
    return this.conn?.users || [];
  },
  // The call, whichever server it is on
  get voice() {
    return this.call?.voice || null;
  },
  get voiceChannel() {
    return this.call?.voiceChannel || null;
  },
};

// Present when running inside the desktop app (see desktop/preload.js)
const desktop = window.friendspeakDesktop || null;
// Name a bookmark by the server's own name (set in Settings → Server)
const serverLabel = (s) => s.serverName || s.address.replace(/^https?:\/\//, '');
const initials = (label) =>
  label
    .split(/[\s.:-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');

const me = () => profiles.active();
// What servers get: the profile plus its public card for DMs (never the keys)
const myProfile = async () => ({ ...me(), card: (await identityFor(me()).catch(() => null))?.card });
const channelById = (id) => S.server?.channels.find((c) => c.id === id);
const profileOf = (id, fallbackName) =>
  S.server?.profiles?.[id] || DM.contacts.get(id) || (id === me()?.id ? me() : null) || { name: fallbackName || 'unknown' };
const myUser = () => S.users.find((u) => u.sid === S.sid);
const isDm = (id) => typeof id === 'string' && id.startsWith('dm:');
const inDmView = () => isDm(S.channelId);
const peerOf = (cid) => cid.slice(3);
// What the chat view shows: a text channel, or a DM shaped like one
function chatById(id) {
  if (isDm(id)) {
    const c = DM.contacts.get(peerOf(id));
    return c ? { id, type: 'dm', with: c.id, name: c.name } : null;
  }
  const ch = channelById(id);
  return ch?.type === 'text' ? ch : null;
}
const isOnline = (pid) => S.users.some((u) => u.id === pid);
const isBanned = (pid) => !!S.server?.bans?.some((b) => b.profileId === pid);

// ---------------------------------------------------------------- icons

const I = {
  mic: '<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>',
  micOff: '<svg viewBox="0 0 24 24"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5a3 3 0 0 0-6 0v.18l5.98 5.99zM4.27 3 3 4.27l6.01 6.01V11a3 3 0 0 0 3 3c.22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52A5.2 5.2 0 0 1 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28a6.9 6.9 0 0 0 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg>',
  head: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 0 0-9 9v7a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2H5v-1a7 7 0 0 1 14 0v1h-2a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-7a9 9 0 0 0-9-9z"/></svg>',
  headOff: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 0 0-9 9v7a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2H5v-1a7 7 0 0 1 14 0v1h-2a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-7a9 9 0 0 0-9-9z"/><path d="M3 3l18 18" stroke="currentColor" stroke-width="2.4"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><path d="M19.14 12.94a7.07 7.07 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7 7 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2.4h-3.84a.5.5 0 0 0-.49.42l-.36 2.54c-.59.24-1.13.56-1.63.94l-2.39-.96a.5.5 0 0 0-.61.22L2.66 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.61.22l2.39-.96c.5.38 1.04.7 1.63.94l.36 2.54c.05.24.25.42.49.42h3.84c.24 0 .44-.18.49-.42l.36-2.54c.59-.24 1.13-.56 1.63-.94l2.39.96c.22.08.48 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/></svg>',
  hash: '<svg viewBox="0 0 24 24"><path d="M5.88 21 6.6 17H3l.35-2h3.6l1.06-6H4.4l.35-2h3.6l.72-4h2l-.72 4h6l.72-4h2l-.72 4H22l-.35 2h-3.6l-1.06 6h3.61l-.35 2h-3.6l-.72 4h-2l.72-4h-6l-.72 4h-2zm4.13-12-1.06 6h6l1.06-6h-6z"/></svg>',
  speakerOff: '<svg viewBox="0 0 24 24"><path d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12a9 9 0 0 0-7-8.77v2.06A7 7 0 0 1 19 12zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z"/></svg>',
  speaker: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05A4.47 4.47 0 0 0 16.5 12zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06A9 9 0 0 0 14 3.23z"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24c1.12.37 2.33.57 3.57.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1.02l-2.2 2.2z"/></svg>',
  hangup: '<svg viewBox="0 0 24 24"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85a1 1 0 0 1-1.41-.01L.29 13.08a1 1 0 0 1 0-1.41C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67a1 1 0 0 1 0 1.41l-2.48 2.48a1 1 0 0 1-1.41.01 11.3 11.3 0 0 0-2.67-1.85 1 1 0 0 1-.56-.9v-3.1A15.5 15.5 0 0 0 12 9z"/></svg>',
  people: '<svg viewBox="0 0 24 24"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5C15 14.17 10.33 13 8 13zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>',
  smile: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-3.5 6a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm7 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM12 17.5A5.5 5.5 0 0 1 6.9 14h10.2a5.5 5.5 0 0 1-5.1 3.5z"/></svg>',
  board: '<svg viewBox="0 0 24 24"><path d="M4 4h7v7H4zm9 0h7v7h-7zM4 13h7v7H4zm11.5 0a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7z"/></svg>',
  reply: '<svg viewBox="0 0 24 24"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>',
  addReact: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 10 10h-2a8 8 0 1 1-8-8V2zm-3.5 7a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM12 17.5a5.5 5.5 0 0 0 5.1-3.5H6.9a5.5 5.5 0 0 0 5.1 3.5zM19 1v3h3v2h-3v3h-2V6h-3V4h3V1h2z"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>',
  screen: '<svg viewBox="0 0 24 24"><path d="M20 3H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h5v2H7v1h10v-1h-2v-2h5a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 13H4V5h16v11zm-8-9.5L8.5 10H11v4h2v-4h2.5L12 6.5z"/></svg>',
  window: '<svg viewBox="0 0 24 24"><path d="M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 14H5V8h14v10z"/></svg>',
  cam: '<svg viewBox="0 0 24 24"><path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/></svg>',
  camOff: '<svg viewBox="0 0 24 24"><path d="M21 6.5l-4 4V7a1 1 0 0 0-1-1H9.82L21 17.18V6.5zM3.27 2 2 3.27 4.73 6H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z"/></svg>',
  clip: '<svg viewBox="0 0 24 24"><path d="M16.5 6v11.5a4 4 0 0 1-8 0V5a2.5 2.5 0 0 1 5 0v10.5a1 1 0 0 1-2 0V6H10v9.5a2.5 2.5 0 0 0 5 0V5a4 4 0 0 0-8 0v12.5a5.5 5.5 0 0 0 11 0V6h-1.5z"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>',
  jump: '<svg viewBox="0 0 24 24"><path d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>',
  expand: '<svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>',
};
const icon = (name, cls = '') => h('span', { class: 'icon ' + cls, html: I[name] });

// ---------------------------------------------------------------- direct messages (peer to peer, dm.js)

const DM = new DirectMessages({
  change() {
    renderRail();
    if (inDmView()) (renderChannels(), refreshChatTitle());
  },
  presence() {
    renderRail();
    if (inDmView()) (renderChannels(), refreshChatTitle());
    DMCALL.linkChanged();
  },
  message(peerId, m) {
    const cid = 'dm:' + peerId;
    const mine = m.author === me().id;
    S.typing.get(cid)?.delete(peerId);
    if (cid === S.channelId && S.messages.get(cid)) {
      appendMessage(m, mine);
      renderTyping();
      DM.opened(peerId);
    }
    if (!mine && (cid !== S.channelId || document.hidden || S.game.visible)) {
      audio.cue('message');
      if (document.hidden) document.title = `(•) friendspeak`;
    }
    renderRail();
    if (inDmView()) renderChannels();
  },
  update(peerId, m) {
    if ('dm:' + peerId !== S.channelId) return;
    const list = S.messages.get(S.channelId) || [];
    $(`.msg[data-id="${m.id}"]`)?.replaceWith(messageEl(m, list[list.indexOf(m) - 1]));
  },
  deleted(peerId) {
    if ('dm:' + peerId === S.channelId) renderMessages(true);
  },
  progress(peerId, fileId, fraction) {
    if ('dm:' + peerId !== S.channelId) return;
    const el = $(`.dm-file[data-file="${CSS.escape(fileId)}"] .dm-file-state`);
    if (el) el.textContent = Math.round(fraction * 100) + '%';
  },
  typing(peerId) {
    const cid = 'dm:' + peerId;
    if (!S.typing.has(cid)) S.typing.set(cid, new Map());
    S.typing.get(cid).set(peerId, { name: profileOf(peerId).name, until: Date.now() + 4000 });
    if (cid === S.channelId) renderTyping();
  },
  call: (peerId, d) => DMCALL.receive(peerId, d),
});

// Open the conversation with someone (from a server's member list or a message)
function openDm(profileId) {
  if (profileId === me().id) return;
  DM.addContact({ id: profileId, ...(S.server?.profiles?.[profileId] || {}) });
  selectChannel('dm:' + profileId);
}

// Back from the DM view to the connected server's last channel
function leaveDmView() {
  const target = S.connected && (chatById(settings.get().lastChannel[S.entry.id]) || S.server.channels.find((c) => c.type === 'text'));
  if (target) return selectChannel(target.id);
  S.channelId = null;
  renderAll();
}

// Friend codes: how to message someone you share no server with (D32)
function friendDialog() {
  if (!DM.identity) return toast('Still starting up, try again in a moment');
  const code = DM.myCode();
  const mine = h('textarea', { class: 'friend-code', readonly: true, rows: 4, onclick: () => mine.select() });
  mine.value = code;
  const theirs = h('textarea', { class: 'friend-code', rows: 4, placeholder: 'fs1.…' });
  const add = async (close) => {
    const res = await DM.addFriend(theirs.value);
    if (res.error) return toast(res.error, 'error');
    close();
    selectChannel('dm:' + res.id);
  };
  modal(
    'Add a friend',
    h(
      'div',
      {},
      h('p', { class: 'muted' }, 'A friend code lets someone message you without sharing a server. Send yours to a friend, and paste theirs below. It holds your public key and the addresses of your saved servers, which pass messages along without being able to read them.'),
      h('label', { class: 'field' }, h('span', {}, 'Their friend code'), theirs),
      h('label', { class: 'field' }, h('span', {}, 'Your friend code'), mine),
      h('div', { class: 'row tight' }, h('button', { class: 'btn small ghost', onclick: () => navigator.clipboard.writeText(code).then(() => toast('Friend code copied')) }, 'Copy your code')),
      DM.relays().length ? null : h('p', { class: 'muted small' }, 'You have no saved servers, so a friend can only reach you through one of theirs, and only while you’re both online.')
    ),
    { actions: [(c) => h('button', { class: 'btn', onclick: () => add(c) }, 'Add friend')] }
  );
}

async function trustKeyPrompt(peerId) {
  const name = profileOf(peerId).name;
  const text = `Someone using ${name}’s profile is showing a different key than the one saved on this device, so their messages are being refused. That happens when ${name} lost their profile and made it again, and also when someone is pretending to be them. Ask ${name} before you trust it.`;
  if (await confirmModal('Different key', text, 'Trust the new key')) DM.trustNewKey(peerId);
}

async function deleteConversation(peerId) {
  const name = profileOf(peerId).name;
  if (!(await confirmModal('Delete conversation', `Delete your conversation with ${name} from this device? Their copy isn't affected.`))) return;
  if (DMCALL.with(peerId)) DMCALL.hangup();
  if (S.channelId === 'dm:' + peerId) leaveDmView();
  await DM.removeContact(peerId);
}

// ---------------------------------------------------------------- calls in DMs (call.js, D33)

const DMCALL = new DmCalls(DM, {
  change: () => renderDmCall(),
  active(c) {
    audio.cue('join');
    const err = c.voice.micError;
    if (err) toast(`No microphone (${err.message}). You joined the call listen-only — soundboard still works.`, 'error', 7000);
    if (c.out && c.video) toggleCamera();
  },
  ended(c, why, mine) {
    const name = profileOf(c.peerId).name;
    const caller = c.out ? me().id : c.peerId;
    if (c.started) {
      audio.cue('leave');
      DM.note(c.peerId, caller, `📞 ${c.video ? 'Video call' : 'Call'} · ${clock(Date.now() - c.started)}`);
      if (why === 'lost') toast(`The call with ${name} lost its connection`, 'error', 6000);
    } else if (!c.out) {
      if (!mine) DM.note(c.peerId, caller, '📞 Missed call', true);
    } else if (why === 'unanswered') {
      DM.note(c.peerId, caller, '📞 No answer');
      toast(`${name} didn’t answer`);
    } else if (why === 'unreachable') toast(`Couldn’t reach ${name}`, 'error');
    else if (why === 'declined') toast(`${name} declined the call`);
    else if (why === 'busy') toast(`${name} is in another call`);
  },
});

// Whichever is live, the DM call or the voice channel's call (S.call): its VoiceClient takes the camera and the screen share
const liveVoice = () => DMCALL.voice || (S.voiceChannel ? S.voice : null);

// A watched stream's sound plays through its <video>, outside the audio graph
// (audio.js), so the master volume and the output device are set on each one.
const streamVolume = (v) => v * settings.get().masterVolume;
function applyOutputDevice(deviceId) {
  audio.setOutputDevice(deviceId);
  for (const t of [...(S.stage?.tiles.values() || []), ...dmCallUi.tiles.values()]) if (t.kind === 'screen') t.video?.setSinkId?.(deviceId || '').catch(() => {});
}

const clock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60) % 60);
  return (s >= 3600 ? Math.floor(s / 3600) + ':' + mm.padStart(2, '0') : mm) + ':' + String(s % 60).padStart(2, '0');
};

function startDmCall(peerId, video = false) {
  const name = profileOf(peerId).name;
  if (DMCALL.cur) return toast(DMCALL.with(peerId) ? `You’re already in a call with ${name}` : 'Hang up your current call first');
  if (!DM.online(peerId)) return toast(`${name} is offline`);
  if (!DM.canSendFiles(peerId)) return toast(`${name} needs to connect with a current friendspeak before you can call them`, 'error'); // calls are sealed (D33)
  if (S.call) leaveVoice(); // one microphone: a DM call or a voice channel, not both
  audio.ensure();
  DMCALL.sync(S.muted, S.deafened);
  DMCALL.start(peerId, video);
}

async function acceptDmCall() {
  const c = DMCALL.cur;
  if (c?.state !== 'ringing') return;
  if (S.call) leaveVoice();
  audio.ensure();
  DMCALL.sync(S.muted, S.deafened);
  selectChannel('dm:' + c.peerId);
  await DMCALL.accept();
}

function dmCallStatus(c) {
  if (c.state === 'calling') return 'Calling…';
  if (c.state === 'ringing') return c.video ? 'Incoming video call' : 'Incoming call';
  const state = c.voice?.peers.get(c.peerId)?.state;
  if (state === 'connected') return clock(Date.now() - c.started);
  return state === 'disconnected' || state === 'failed' ? 'Reconnecting…' : 'Connecting…';
}

// compact: the sidebar panel (mute lives in the user panel right below it)
function dmCallButtons(c, compact) {
  const hangup = (title) => h('button', { class: 'icon-btn danger hangup', title, onclick: () => DMCALL.hangup() }, icon('hangup'));
  if (c.state === 'ringing') return [h('button', { class: 'icon-btn accept', title: 'Accept', onclick: acceptDmCall }, icon('phone')), hangup('Decline')];
  if (c.state === 'calling') return [hangup('Cancel')];
  const v = c.voice;
  const off = S.muted || S.deafened;
  const all = [
    compact ? null : h('button', { class: 'icon-btn' + (off ? ' off' : ''), title: off ? 'Unmute' : 'Mute', onclick: toggleMute }, icon(off ? 'micOff' : 'mic')),
    h(
      'button',
      {
        class: 'icon-btn' + (v.local.camera ? ' sharing' : ''),
        title: (v.local.camera ? 'Turn off camera' : 'Turn on camera') + ' (right-click for cameras and backgrounds)',
        onclick: toggleCamera,
        oncontextmenu: (e) => (e.preventDefault(), cameraPopover(e.currentTarget)),
      },
      icon(v.local.camera ? 'cam' : 'camOff')
    ),
    h(
      'button',
      {
        class: 'icon-btn' + (v.local.screen ? ' sharing' : ''),
        title: v.local.screen ? 'Change source or stop sharing' : 'Share your screen',
        onclick: (e) => (v.local.screen ? sharePopover(e.currentTarget) : screenPicker()),
      },
      icon('screen')
    ),
    compact ? null : h('button', { class: 'icon-btn' + (dmCallUi.max ? ' on' : ''), title: dmCallUi.max ? 'Show the chat' : 'Hide the chat', onclick: () => ((dmCallUi.max = !dmCallUi.max), renderDmCall()) }, icon('expand')),
    hangup('Hang up'),
  ];
  return all.filter(Boolean);
}

// The call's view sits on top of the conversation with that person, so it only
// shows (and video is only received at full size) while that DM is open. The
// sidebar panel and the incoming-call card show wherever you are.
const dmCallUi = { call: null, el: null, tiles: new Map(), focus: null, max: false, volume: 1, ringing: null, ringTimer: null };

function renderDmCall() {
  const c = DMCALL.cur;
  const ui = dmCallUi;
  const p = c && profileOf(c.peerId);

  // Ring while it's ringing, on either end
  const ringing = c && c.state !== 'active' ? c.state : null;
  if (ringing !== ui.ringing) {
    clearInterval(ui.ringTimer);
    ui.ringing = ringing;
    if (ringing) {
      const cue = ringing === 'ringing' ? 'ring' : 'calling';
      audio.cue(cue);
      ui.ringTimer = setInterval(() => audio.cue(cue), ringing === 'ringing' ? 2000 : 3000);
      if (ringing === 'ringing' && document.hidden) document.title = `(•) friendspeak`;
    }
  }

  const card = $('#call-ring');
  card.hidden = c?.state !== 'ringing';
  card.replaceChildren(
    ...(card.hidden
      ? []
      : [
          avatarEl(p, 44),
          h('div', { class: 'cr-text' }, h('strong', {}, p.name), h('span', { class: 'muted small' }, dmCallStatus(c))),
          h('button', { class: 'btn small accept', onclick: acceptDmCall }, 'Accept'),
          h('button', { class: 'btn small danger', onclick: () => DMCALL.hangup() }, 'Decline'),
        ])
  );

  const panel = $('#call-panel');
  panel.hidden = !c;
  panel.replaceChildren(
    ...(c
      ? [
          h(
            'div',
            { class: 'vp-info', title: 'Open the conversation', onclick: () => selectChannel('dm:' + c.peerId) },
            h('div', { class: 'vp-status call-status' }, dmCallStatus(c)),
            h('div', { class: 'vp-channel' }, 'Call with ' + p.name)
          ),
          ...dmCallButtons(c, true),
        ]
      : [])
  );

  // Call buttons in the header of the open conversation
  const peerId = inDmView() ? peerOf(S.channelId) : null;
  $('#main .dm-call-btns')?.replaceChildren(
    ...(peerId && !DMCALL.with(peerId)
      ? [
          h('button', { class: 'icon-btn', title: 'Start a voice call', onclick: () => startDmCall(peerId) }, icon('phone')),
          h('button', { class: 'icon-btn', title: 'Start a video call', onclick: () => startDmCall(peerId, true) }, icon('cam')),
        ]
      : [])
  );

  // A new call (or none): start the view over
  if (ui.call !== c) {
    for (const key of [...ui.tiles.keys()]) dropDmCallTile(key);
    ui.ro?.disconnect();
    ui.el?.remove();
    Object.assign(ui, { call: c, el: null, focus: null, max: false, volume: 1 });
    if (c) {
      ui.main = h('div', { class: 'stage-main' });
      ui.grid = h('div', { class: 'stage-grid' });
      ui.body = h('div', { class: 'stage' }, ui.main, ui.grid);
      ui.bar = h('div', { class: 'call-bar' });
      ui.el = h('div', { class: 'call-stage' }, ui.body, ui.bar);
      ui.ro = new ResizeObserver(() => layoutStage(ui));
      ui.ro.observe(ui.grid);
    }
  }
  const head = c && S.channelId === 'dm:' + c.peerId ? $('#main > .chat-header') : null;
  $('#main').classList.toggle('call-max', !!head && ui.max);
  if (!c) return;
  // The view takes room from the messages: keep them at the newest one
  const box = $('#messages');
  const atBottom = box && atBottomOrNew(box);
  if (!head) ui.el.remove();
  else if (ui.el.previousElementSibling !== head) head.after(ui.el);

  // Screens first, then the two people (camera, or avatar while it's off)
  const v = DMCALL.voice;
  const mine = me().id;
  const want = [
    v && c.remote.screen && { who: c.peerId, kind: 'screen' },
    v?.local.screen && { who: mine, kind: 'screen' },
    { who: c.peerId, kind: v && c.remote.camera ? 'camera' : 'user' },
    { who: mine, kind: v?.local.camera ? 'camera' : 'user' },
  ].filter(Boolean);
  for (const w of want) w.key = w.kind + ':' + w.who;
  for (const key of [...ui.tiles.keys()]) if (!want.some((w) => w.key === key)) dropDmCallTile(key);
  for (const w of want) {
    if (ui.tiles.has(w.key)) continue;
    ui.tiles.set(w.key, dmCallTile(w.key, w.who, w.kind));
    if (w.kind === 'screen' && w.who !== mine) ui.focus = w.key; // they started sharing: show it large
  }
  if (!ui.tiles.has(ui.focus)) ui.focus = null;

  const focused = ui.tiles.get(ui.focus);
  if (focused && ui.main.firstChild !== focused.el) ui.main.replaceChildren(focused.el);
  if (!focused) ui.main.replaceChildren();
  const rest = want.filter((w) => w.key !== ui.focus).map((w) => ui.tiles.get(w.key).el);
  if (rest.length !== ui.grid.children.length || rest.some((el, i) => ui.grid.children[i] !== el)) ui.grid.replaceChildren(...rest);
  ui.body.classList.toggle('focused', !!focused);
  ui.el.classList.toggle('has-video', want.some((w) => w.kind !== 'user'));

  for (const t of ui.tiles.values()) {
    t.el.classList.toggle('focus', t === focused);
    const theirs = t.who !== mine;
    if (t.flag) {
      const { muted, deafened } = theirs ? c.remote : S;
      t.flag.replaceChildren(...(muted || deafened ? [icon(deafened ? 'headOff' : 'micOff')] : []));
    }
    if (!t.video) continue;
    const src = v?.mediaOf(t.who, t.kind) || null;
    if (t.video.srcObject !== src) t.video.srcObject = src;
    // Taken out of the page (another channel was open), a video pauses
    if (src && head && t.video.paused) t.video.play().catch(() => {});
    t.status.hidden = !!src;
    if (t.kind === 'screen') {
      t.video.muted = !theirs || S.deafened;
      t.video.volume = streamVolume(ui.volume);
    }
    t.report?.();
  }

  ui.bar.replaceChildren(h('span', { class: 'call-status' }, dmCallStatus(c)), ...dmCallButtons(c, false));
  layoutStage(ui);
  if (head && atBottom) box.scrollTop = box.scrollHeight;
}

// kind: 'screen', 'camera' or 'user' (avatar)
function dmCallTile(key, who, kind) {
  const ui = dmCallUi;
  const mine = who === me().id;
  const p = mine ? me() : profileOf(who);
  const tile = { key, who, kind, el: null, video: null, status: null, flag: null };
  // A single click focuses; wait a moment so a double click can go fullscreen instead
  let clickTimer;
  const attrs = {
    class: 'tile ' + kind + (mine && kind === 'camera' ? ' mirror' : ''),
    onclick: () => {
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => ((ui.focus = ui.focus === key ? null : key), renderDmCall()), 220);
    },
    ondblclick: () => {
      clearTimeout(clickTimer);
      if (tile.video) document.fullscreenElement ? document.exitFullscreen() : tile.el.requestFullscreen?.().catch(() => {});
    },
  };
  if (kind !== 'screen') {
    attrs['data-who'] = who; // speaking outline
    tile.flag = h('span', { class: 'tile-flag' });
  }
  const label = h('span', { class: 'tile-name' }, kind === 'screen' ? (mine ? 'Your screen' : p.name + '’s screen') : mine ? 'You' : p.name, tile.flag);
  if (kind === 'user') {
    tile.el = h('div', attrs, avatarEl(p, 64), label);
    return tile;
  }

  const video = h('video', { autoplay: true, playsinline: true, muted: true });
  video.muted = true;
  tile.video = video;
  tile.status = h('div', { class: 'stream-status' }, kind === 'screen' ? 'Connecting to stream…' : 'Connecting…');
  let controls = null;
  if (kind === 'screen' && !mine) {
    const out = settings.get().outputDevice;
    if (out && video.setSinkId) video.setSinkId(out).catch(() => {});
    const stop = (e) => e.stopPropagation();
    controls = h(
      'div',
      { class: 'tile-controls', onclick: stop, ondblclick: stop },
      h(
        'label',
        { class: 'stream-volume', title: 'Stream volume' },
        icon('speaker'),
        h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: ui.volume, oninput: (e) => ((ui.volume = +e.target.value), (video.volume = streamVolume(ui.volume))) })
      )
    );
  }
  tile.el = h('div', attrs, video, tile.status, label, controls);
  if (!mine) {
    // Tell them how many device pixels we show, so their encoder is no bigger
    // than that, and pauses while we can't see it (window hidden, or another
    // channel open).
    let timer;
    let last = '';
    tile.report = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const dpr = devicePixelRatio || 1;
        const view = { w: Math.round(video.clientWidth * dpr), h: Math.round(video.clientHeight * dpr), hidden: document.hidden || !video.isConnected };
        if (!view.hidden && !(view.w && view.h)) return;
        const sig = JSON.stringify(view);
        if (sig === last || ui.tiles.get(key) !== tile) return;
        last = sig;
        DMCALL.voice?.view(who, kind, view);
      }, 300);
    };
    tile.ro = new ResizeObserver(tile.report);
    tile.ro.observe(video);
  }
  return tile;
}

function dropDmCallTile(key) {
  const tile = dmCallUi.tiles.get(key);
  if (!tile) return;
  dmCallUi.tiles.delete(key);
  if (tile.video) tile.video.srcObject = null;
  tile.ro?.disconnect();
  tile.el.remove();
}

document.addEventListener('visibilitychange', () => {
  for (const t of dmCallUi.tiles.values()) t.report?.();
});

// The call clock, and who's speaking
setInterval(() => {
  const c = DMCALL.cur;
  if (c?.state === 'active') for (const el of $$('.call-status')) el.textContent = dmCallStatus(c);
}, 1000);
setInterval(() => {
  const v = DMCALL.voice;
  if (!v || !dmCallUi.el?.isConnected) return;
  const levels = v.levels();
  if (audio.selfAnalyser) levels.set(me().id, Level(audio.selfAnalyser));
  for (const el of $$('.tile[data-who]', dmCallUi.el)) el.classList.toggle('speaking', (levels.get(el.dataset.who) || 0) > 0.02);
}, 90);

// ---------------------------------------------------------------- toasts, modals, popovers

function toast(text, kind = 'info', ms = 3500) {
  const el = h('div', { class: 'toast ' + kind }, text);
  $('#toasts').append(el);
  setTimeout(() => el.classList.add('out'), ms);
  setTimeout(() => el.remove(), ms + 400);
}

function modal(title, body, { actions = [], wide = false, dismissable = true, onClose } = {}) {
  const close = () => {
    root.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => dismissable && e.key === 'Escape' && close();
  const root = h(
    'div',
    { class: 'modal-backdrop', onmousedown: (e) => dismissable && e.target === root && close() },
    h(
      'div',
      { class: 'modal' + (wide ? ' wide' : '') },
      h('div', { class: 'modal-head' }, h('h2', {}, title), dismissable && h('button', { class: 'x', onclick: close }, '×')),
      h('div', { class: 'modal-body' }, body),
      actions.length ? h('div', { class: 'modal-foot' }, actions.map((a) => (typeof a === 'function' ? a(close) : a))) : null
    )
  );
  document.addEventListener('keydown', onKey);
  $('#modal-root').append(root);
  setTimeout(() => root.querySelector('input,textarea,select')?.focus(), 30);
  return close;
}

function promptModal(title, label, value = '') {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { value, onkeydown: (e) => e.key === 'Enter' && ok() });
    const ok = () => {
      done = true;
      close();
      resolve(input.value.trim());
    };
    const close = modal(title, h('label', { class: 'field' }, h('span', {}, label), input), {
      actions: [h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'), h('button', { class: 'btn', onclick: ok }, 'Save')],
      onClose: () => !done && resolve(null),
    });
  });
}

function confirmModal(title, text, okLabel = 'Delete') {
  return new Promise((resolve) => {
    let done = false;
    const close = modal(title, h('p', {}, text), {
      actions: [
        h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'btn danger', onclick: () => ((done = true), close(), resolve(true)) }, okLabel),
      ],
      onClose: () => !done && resolve(false),
    });
  });
}

let activePopover = null;
function closePopover() {
  activePopover?.close();
}
function popover(anchor, content, { align = 'end', className = '', onClose } = {}) {
  closePopover();
  const el = h('div', { class: 'popover ' + className }, content);
  $('#popovers').append(el);
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const pw = el.offsetWidth;
    const ph = el.offsetHeight;
    let left = align === 'start' ? r.left : align === 'right' ? r.right + 8 : align === 'left' ? r.left - pw - 8 : r.right - pw;
    let top = align === 'right' || align === 'left' ? r.top : r.top - ph - 8;
    if (top < 8) top = Math.min(r.bottom + 8, innerHeight - ph - 8);
    left = Math.max(8, Math.min(left, innerWidth - pw - 8));
    top = Math.max(8, Math.min(top, innerHeight - ph - 8));
    Object.assign(el.style, { left: left + 'px', top: top + 'px' });
  };
  place();
  const onDown = (e) => !el.contains(e.target) && !anchor.contains(e.target) && !e.target.closest('.modal-backdrop') && close();
  const onKey = (e) => e.key === 'Escape' && close();
  const close = () => {
    el.remove();
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey);
    if (activePopover?.el === el) activePopover = null;
    onClose?.();
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
  });
  activePopover = { el, close, place };
  return activePopover;
}

function contextMenu(e, items) {
  e.preventDefault();
  const anchor = { getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }), contains: () => false };
  const p = popover(
    anchor,
    h(
      'div',
      { class: 'menu' },
      items.filter(Boolean).map((it) =>
        h('button', { class: 'menu-item' + (it.danger ? ' danger' : ''), onclick: () => (p.close(), it.run()) }, it.label)
      )
    ),
    { align: 'start' }
  );
}

// ---------------------------------------------------------------- images (avatars, backgrounds, icons)

// Size limits must match server.js (MAX_AVATAR_BYTES, MAX_BANNER_BYTES, MAX_ICON_BYTES)
const IMG = {
  avatar: { max: 256, maxBytes: 380 * 1024 },
  banner: { max: 960, maxBytes: 630 * 1024 },
  icon: { max: 256, maxBytes: 500 * 1024 },
};

// Resolves if `url` loads as an image (links are checked before anyone else sees them)
const loadsAsImage = (url) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.onload = resolve;
    img.onerror = () => reject(new Error('Couldn’t load an image from that link'));
    img.src = url;
  });

// Buttons to pick an image three ways: upload any image file, a GIPHY GIF, or
// an https link. `onPick(value)` gets a data URL or an https URL. `dropOn`
// elements also accept a dropped image file.
function imageChoices({ size, onPick, dropOn = [], uploadLabel = 'Upload' }) {
  const pick = async (get) => {
    try {
      await onPick(await get());
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  const fromFile = (f) => pick(() => fileToDataUrl(f, size));
  const file = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: () => (fromFile(file.files[0]), (file.value = '')) });
  for (const el of dropOn) {
    el.classList.add('image-drop');
    el.title = 'Drop an image here';
    el.ondragover = (e) => [...(e.dataTransfer?.types || [])].includes('Files') && (e.preventDefault(), el.classList.add('dropping'));
    el.ondragleave = () => el.classList.remove('dropping');
    el.ondrop = (e) => {
      el.classList.remove('dropping');
      const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/'));
      if (!f) return;
      e.preventDefault();
      fromFile(f);
    };
  }
  return [
    h('button', { class: 'btn small', onclick: () => file.click() }, uploadLabel),
    h('button', { class: 'btn small ghost', title: 'Pick a GIF from GIPHY', onclick: (e) => openGifPicker(e.currentTarget, (g) => pick(() => g.url)) }, 'GIF'),
    h(
      'button',
      {
        class: 'btn small ghost',
        title: 'Use an image from an https link',
        onclick: async () => {
          const url = await promptModal('Image link', 'https:// link to an image or GIF');
          if (!url) return;
          if (!/^https:\/\/[^\s"'<>]+$/.test(url) || url.length > 1000) return toast('Use an https:// image link', 'error');
          pick(() => loadsAsImage(url).then(() => url));
        },
      },
      'Link'
    ),
    file,
  ];
}

// Sets a profile background (image, GIF or color) as an element's background
function paintBanner(el, p) {
  const b = p.banner || '';
  el.style.backgroundColor = b.startsWith('#') ? b : p.color || 'var(--accent)';
  el.style.backgroundImage = isImage(b) ? `url("${b.replace(/["\\\n]/g, encodeURIComponent)}")` : '';
  el.classList.toggle('has-image', isImage(b));
}

// A user's full profile: live user entries don't carry the background, the server's profile list does
const fullProfile = (u) => (u.id === me()?.id ? { ...u, ...me() } : { ...profileOf(u.id, u.name), ...u, banner: profileOf(u.id).banner || '' });

// Banner, avatar, name and status: the top of profile popovers and the editor preview
function profileCardHead(p, extra) {
  const banner = h('div', { class: 'pc-banner' });
  paintBanner(banner, p);
  return h(
    'div',
    { class: 'pc-head' },
    banner,
    h('div', { class: 'pc-avatar' }, avatarEl(p, 72)),
    h('div', { class: 'pc-names' }, h('strong', { style: { color: p.color } }, p.name || ' '), h('div', { class: 'muted small' }, p.status || ''), extra)
  );
}

// Role labels (set by the host in the admin dashboard; they grant nothing). The server's order is the display order.
// Everything here is server-supplied, so shapes are checked and names only ever become text nodes.
// The text color is pulled toward the theme's text color, so a dark role stays readable on a dark theme.
const MAX_ROLES = 10;
function rolesOf(profileId) {
  const sv = S.server;
  if (!sv || !Array.isArray(sv.roles) || !sv.memberRoles || typeof sv.memberRoles !== 'object') return [];
  const ids = sv.memberRoles[profileId];
  if (!Array.isArray(ids) || !ids.length) return [];
  const have = new Set(ids);
  return sv.roles.filter((r) => r && typeof r.name === 'string' && r.name && have.has(r.id)).slice(0, MAX_ROLES);
}
function roleTag(r) {
  const color = typeof r.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : 'var(--muted)';
  return h('span', { class: 'role-tag', title: r.name, style: { color: `color-mix(in srgb, ${color} 72%, var(--text))`, background: `color-mix(in srgb, ${color} 16%, transparent)`, borderColor: `color-mix(in srgb, ${color} 55%, var(--muted))` } }, r.name);
}

function profilePopover(anchor, u, align = 'right') {
  const p = fullProfile(u);
  const live = S.users.find((x) => x.id === p.id);
  const doing = live
    ? [live.voice && '🔊 ' + (channelById(live.voice)?.name || ''), live.sharing && '🖥️ Live', live.playing && '🐧 Club Penguin'].filter(Boolean).join(' · ')
    : p.seen && p.id !== me()?.id
      ? 'Last seen ' + fmtTime(p.seen)
      : '';
  const other = S.connected && p.id && p.id !== me()?.id && S.server?.profiles?.[p.id];
  const roles = rolesOf(p.id);
  const pop = popover(
    anchor,
    h(
      'div',
      { class: 'profile-card' },
      profileCardHead(p, [doing ? h('div', { class: 'small pc-doing' }, doing) : null, roles.length ? h('div', { class: 'role-tags' }, roles.map(roleTag)) : null]),
      other
        ? h(
            'div',
            { class: 'pc-actions' },
            h('button', { class: 'btn small', onclick: () => (pop.close(), openDm(p.id)) }, 'Message'),
            h('button', { class: 'btn small ghost', onclick: () => (pop.close(), removePrompt(p.id)) }, 'Remove'),
            !isBanned(p.id) && h('button', { class: 'btn small ghost danger', onclick: () => (pop.close(), banPrompt(p.id)) }, 'Ban')
          )
        : null
    ),
    { align, className: 'pc-pop' }
  );
}

// ---------------------------------------------------------------- profiles UI

function profileEditor(p) {
  const draft = { banner: '', ...p };
  const preview = h('div', { class: 'avatar-preview' });
  const card = h('div', { class: 'profile-card preview' });
  const refresh = () => {
    preview.replaceChildren(avatarEl(draft, 80));
    card.replaceChildren(profileCardHead(draft));
    emojiIn.value = isImage(draft.avatar) ? '' : draft.avatar || '';
  };
  const emojiIn = h('input', {
    class: 'emoji-avatar',
    placeholder: 'or an emoji 🐸',
    oninput: (e) => ((draft.avatar = [...e.target.value.trim()].slice(0, 2).join('')), preview.replaceChildren(avatarEl(draft, 80)), card.replaceChildren(profileCardHead(draft))),
  });
  const bannerColor = h('input', {
    type: 'color',
    title: 'Plain color background',
    value: draft.banner?.startsWith('#') ? draft.banner : draft.color || '#8b6cf6',
    oninput: (e) => ((draft.banner = e.target.value), refresh()),
  });
  refresh();
  const el = h(
    'div',
    { class: 'profile-editor-wrap' },
    h(
      'div',
      { class: 'profile-editor' },
      h(
        'div',
        { class: 'avatar-col' },
        preview,
        h('div', { class: 'row tight' }, imageChoices({ size: IMG.avatar, dropOn: [preview], onPick: (v) => ((draft.avatar = v), refresh()) })),
        emojiIn
      ),
      h(
        'div',
        { class: 'fields' },
        h('label', { class: 'field' }, h('span', {}, 'Display name'), h('input', { value: draft.name, maxlength: 32, oninput: (e) => ((draft.name = e.target.value), refresh()) })),
        h('label', { class: 'field' }, h('span', {}, 'Status'), h('input', { value: draft.status || '', maxlength: 64, placeholder: 'Playing something…', oninput: (e) => ((draft.status = e.target.value), refresh()) })),
        h(
          'label',
          { class: 'field inline' },
          h('span', {}, 'Color'),
          h('input', { type: 'color', value: draft.color, oninput: (e) => ((draft.color = e.target.value), refresh()) })
        )
      )
    ),
    h(
      'div',
      { class: 'banner-edit' },
      h('div', { class: 'field' }, h('span', {}, 'Profile background'), card),
      h(
        'div',
        { class: 'row tight' },
        imageChoices({ size: IMG.banner, dropOn: [card], onPick: (v) => ((draft.banner = v), refresh()) }),
        bannerColor,
        h('button', { class: 'btn small ghost danger', onclick: () => ((draft.banner = ''), refresh()) }, 'Remove'),
        h('span', { class: 'muted small' }, 'Image, GIF or color. Shown when friends click your name.')
      )
    )
  );
  return { el, draft };
}

// Save a profile to this device; big GIFs can run the browser out of storage
function saveProfile(save) {
  try {
    return save();
  } catch (e) {
    toast(e.name === 'QuotaExceededError' ? 'Not enough browser storage for these images. Try smaller ones, or GIFs from GIPHY (links take no space).' : e.message, 'error');
    return null;
  }
}

function welcome() {
  const { el, draft } = profileEditor({ name: '', color: randomColor(), avatar: '', status: '' });
  const importInput = h('input', {
    type: 'file',
    accept: '.json,application/json',
    hidden: true,
    onchange: async () => {
      try {
        await importProfile(importInput.files[0]);
        close();
        boot();
      } catch (e) {
        toast(e.message, 'error');
      }
    },
  });
  const close = modal(
    'Welcome to friendspeak',
    h(
      'div',
      {},
      h('p', { class: 'muted' }, 'No sign-up, no accounts. Your profile is saved only on this device. You can keep several and switch any time.'),
      el,
      importInput
    ),
    {
      dismissable: false,
      actions: [
        h('button', { class: 'btn ghost', onclick: () => importInput.click() }, 'Import profile…'),
        h(
          'button',
          {
            class: 'btn',
            onclick: () => {
              if (!draft.name.trim()) return toast('Pick a name', 'error');
              if (!saveProfile(() => profiles.create({ ...draft, name: draft.name.trim() }))) return;
              close();
              boot();
            },
          },
          'Save profile'
        ),
      ],
    }
  );
}

function applyProfileChange() {
  renderUserPanel();
  DM.updateProfile(me());
  myProfile().then((p) => conns().forEach((c) => c.connected && c.socket.emit('profile:update', p)));
}

// ---------------------------------------------------------------- server rail

function renderRail() {
  const rail = $('#rail');
  const list = servers.all();
  const { railDmsHidden, railServersHidden } = settings.get();
  const contacts = [...DM.contacts.values()].sort((a, b) => b.last - a.last);
  // Collapsible group headers; a collapsed DMs group still shows the unread count
  const group = (key, label, hidden, hint, badge) =>
    h(
      'button',
      { class: 'rail-group', title: (hidden ? 'Show ' : 'Hide ') + hint, onclick: () => (settings.set({ [key]: !hidden }), renderRail()) },
      h('span', { class: 'caret' }, hidden ? '▸' : '▾'),
      label,
      hidden && badge ? h('span', { class: 'rail-badge' }, badge > 99 ? '99+' : badge) : null
    );
  rail.replaceChildren(
    h('div', { class: 'rail-logo', title: 'friendspeak' }, 'fs'),
    h('div', { class: 'rail-sep' }),
    group('railDmsHidden', 'DMs', railDmsHidden, 'direct messages. Start one from anyone’s name in a server’s member list, or with a friend code.', DM.unreadTotal()),
    ...(railDmsHidden
      ? []
      : [h('button', { class: 'rail-add rail-add-dm', title: 'Add a friend with a friend code', onclick: friendDialog }, icon('plus'))]),
    ...(railDmsHidden
      ? []
      : contacts.map((c) =>
          h(
            'button',
            {
              class: 'rail-server rail-dm' + (S.channelId === 'dm:' + c.id ? ' active' : ''),
              title: c.name + (DM.online(c.id) ? '' : ' (offline)'),
              onclick: () => selectChannel('dm:' + c.id),
              oncontextmenu: (e) => contextMenu(e, [{ label: 'Delete conversation', danger: true, run: () => deleteConversation(c.id) }]),
            },
            avatarEl(c, 44),
            h('span', { class: 'presence' + (DM.online(c.id) ? '' : ' off') }),
            c.unread ? h('span', { class: 'rail-badge' }, c.unread > 99 ? '99+' : c.unread) : null
          )
        )),
    h('div', { class: 'rail-sep' }),
    group('railServersHidden', 'Servers', railServersHidden, 'servers'),
    ...(railServersHidden ? [] : list).map((s) => {
      const label = serverLabel(s);
      const active = S.entry?.id === s.id;
      const calling = S.call?.entry.id === s.id; // the voice call is on this server, in view or not
      return h(
        'button',
        {
          class: 'rail-server' + (active && !inDmView() ? ' active' : '') + (active && inDmView() ? ' current' : '') + (active && !S.connected ? ' offline' : ''),
          title: `${label}\n${s.address}` + (calling ? '\nYou’re in voice here' : ''),
          onclick: () => connectTo(s),
          oncontextmenu: (e) =>
            contextMenu(e, [
              { label: 'Edit', run: () => serverDialog(s) },
              active && S.connected && { label: 'Server name & icon…', run: () => openSettings('server') },
              calling && { label: 'Leave voice', run: leaveVoice },
              active && S.connected && { label: 'Disconnect', run: () => disconnect(true) },
              { label: 'Remove', danger: true, run: () => (active && disconnect(true), S.call?.entry.id === s.id && leaveVoice(), servers.remove(s.id), DM.setServers(servers.all()), renderRail()) },
            ]),
        },
        s.serverIcon ? h('img', { class: 'rail-icon', src: s.serverIcon, alt: '', referrerpolicy: 'no-referrer' }) : initials(label),
        calling ? h('span', { class: 'rail-call', html: I.speaker }) : null
      );
    }),
    h('button', { class: 'rail-add', title: 'Connect to a server', onclick: () => serverDialog() }, icon('plus'))
  );
}

function serverDialog(existing) {
  const addr = h('input', { placeholder: '192.168.1.20:3000', value: existing?.address?.replace(/^http:\/\//, '') || '' });
  const pass = h('input', { type: 'password', placeholder: 'optional', value: existing?.password || '' });
  const save = (close) => {
    const address = normalizeAddress(addr.value);
    if (!address) return toast('Enter an IP or hostname', 'error');
    const entry = servers.upsert({ ...(existing || {}), address, password: pass.value });
    close();
    DM.setServers(servers.all()); // every bookmarked server is also a place to meet for DMs
    renderRail();
    connectTo(entry);
  };
  const close = modal(
    existing ? 'Edit server' : 'Connect to a server',
    h(
      'div',
      { onkeydown: (e) => e.key === 'Enter' && save(close) },
      h('label', { class: 'field' }, h('span', {}, 'Server IP / address'), addr),
      h('label', { class: 'field' }, h('span', {}, 'Password'), pass),
      h('p', { class: 'muted small' }, 'Port defaults to 3000.')
    ),
    { actions: [(c) => h('button', { class: 'btn', onclick: () => save(c) }, existing ? 'Save & connect' : 'Connect')] }
  );
}

// ---------------------------------------------------------------- connection

// One connection per server: { entry, socket, voice, sid, connected, server,
// users, voiceChannel, rejoinVoice }. `S.conn` is the server in view. A call
// keeps its connection (`S.call`) open after you switch to another server, so
// at most two are open: the one in view and the one the call is on.
const conns = () => [...new Set([S.conn, S.call])].filter(Boolean);

// Close a connection for good, hanging up if the call is on it
function dropConn(c) {
  if (S.call === c) {
    closeStage();
    S.call = null;
  }
  c.voice.destroy();
  c.socket.removeAllListeners();
  c.socket.disconnect();
}

// Leave the server in view. With `keepCall`, a call on it carries on in the background.
function disconnect(manual = false, keepCall = false) {
  closePopover();
  closeGame();
  closeStage();
  const c = S.conn;
  S.conn = null;
  if (c && !(keepCall && S.call === c)) dropConn(c);
  // DMs don't depend on the server: stay in the DM view if it's open
  if (!inDmView()) S.channelId = null;
  S.messages.clear();
  S.unread.clear();
  S.typing.clear();
  if (manual) {
    S.entry = null;
    servers.setLast(null);
  }
  renderAll();
}

function connectTo(entry, { rejoinVoice = null } = {}) {
  if (S.entry?.id === entry.id && S.connected) return inDmView() && leaveDmView();
  // Switching servers keeps the call going; clicking the same server again is a fresh start
  disconnect(false, S.entry?.id !== entry.id);
  S.channelId = null; // clicking a server leaves the DM view
  S.entry = entry;
  servers.setLast(entry.id);
  // Back to the server the call is on: its connection is still open
  if (S.call?.entry.id === entry.id) return viewConn(S.call);
  renderAll();

  // Desktop: self-signed https servers need the user's OK (pinned after the first time)
  if (!desktop?.trustServer) return openSocket(entry, rejoinVoice);
  desktop.trustServer(entry.address).then((ok) => {
    if (S.entry !== entry || S.conn) return; // switched servers meanwhile
    if (ok) openSocket(entry, rejoinVoice);
    else renderMain(`Not connected: you didn't trust the certificate of ${entry.address}. Click the server to try again.`);
  });
}

// Bring the call's connection back into view
function viewConn(c) {
  S.conn = c;
  S.entry = c.entry;
  if (c.connected) showServer(c);
  else renderAll();
}

// Draw the server in view from scratch. Messages aren't tracked in the background, so they load again.
function showServer(c) {
  S.messages.clear();
  const last = settings.get().lastChannel[c.entry.id];
  const target = chatById(S.channelId) || chatById(last) || c.server.channels.find((ch) => ch.type === 'text');
  S.channelId = null;
  renderAll();
  if (target) selectChannel(target.id);
  checkAppAgainstServer();
}

function openSocket(entry, rejoinVoice = null) {
  const socket = io(entry.address, { transports: ['websocket', 'polling'], reconnectionDelayMax: 5000 });
  const c = (S.conn = { entry, socket, voice: null, sid: null, connected: false, server: null, users: [], voiceChannel: null, rejoinVoice });
  // Every handler keeps `c` up to date; only the server in view is drawn
  const viewed = () => S.conn === c;
  const calling = () => S.call === c;
  c.voice = new VoiceClient(socket, {
    onPeersChange: renderChannels,
    onMediaChange: () => {
      renderChannels();
      renderVoicePanel();
      syncStage();
    },
  });
  c.voice.profileIdFor = (sid) => c.users.find((u) => u.sid === sid)?.id;

  socket.on('connect', async () => {
    const res = await socket.emitWithAck('hello', { profile: await myProfile(), password: entry.password || '' });
    if (res.error) {
      toast(res.error, 'error');
      if (calling()) (endCall(), renderVoicePanel(), renderRail()); // also closes a background connection
      if (!viewed()) return;
      socket.disconnect();
      renderMain(res.error);
      if (/password/i.test(res.error)) serverDialog(entry);
      return;
    }
    Object.assign(c, { sid: res.sid, server: res.server, users: res.users, connected: true });
    rememberServerLook(c);
    if (viewed()) showServer(c);
    else renderRail();
    if (c.rejoinVoice && c.server.channels.some((ch) => ch.id === c.rejoinVoice)) return joinVoice(c.rejoinVoice, true, c);
    c.rejoinVoice = null;
    if (calling()) {
      endCall();
      renderVoicePanel();
      renderRail();
      toast('Your voice channel is gone');
    }
  });

  socket.on('connect_error', (err) => {
    if (viewed() && !c.connected) renderMain(`Can't reach ${entry.address} (${err.message}). Retrying…`);
  });

  // The server keeps one session per profile; a newer one (another window or
  // device with this profile) took over, so don't fight it by reconnecting.
  let replaced = false;
  socket.on('session:replaced', () => (replaced = true));
  let banned = false;
  socket.on('banned', () => (banned = true));
  let removed = false;
  socket.on('removed', () => (removed = true));

  socket.on('disconnect', (reason) => {
    if (calling()) closeStage();
    const here = viewed();
    if (replaced || banned || removed || reason === 'io server disconnect') {
      // socket.io won't retry a server-side disconnect
      if (here) disconnect(); // keep the bookmark selected
      else (dropConn(c), renderVoicePanel(), renderRail());
      if (!here || inDmView()) {
        const where = here ? 'this server' : serverLabel(entry);
        return toast(banned ? `You were banned from ${where}` : removed ? `You were removed from ${where}` : `Disconnected from ${here ? 'the server' : where}`, 'error');
      }
      renderMain(
        banned
          ? 'You were banned from this server.'
          : removed
            ? 'Someone removed you from this server. Click the server to rejoin.'
            : replaced
            ? 'You connected to this server from another window or device with this profile. Click the server to reconnect here.'
            : 'The server closed the connection. Click the server to reconnect.'
      );
      return;
    }
    if (c.voiceChannel) {
      c.rejoinVoice = c.voiceChannel;
      c.voice.leave(true);
      c.voiceChannel = null;
    }
    c.connected = false;
    if (here) renderAll();
    else renderVoicePanel();
    toast(here ? 'Disconnected — reconnecting…' : `Lost ${serverLabel(entry)}, where your call is — reconnecting…`, 'error');
  });

  socket.on('users', (users) => {
    const prev = c.users;
    c.users = users;
    // voice join/leave cues for our channel
    if (c.voiceChannel) {
      const was = new Set(prev.filter((u) => u.voice === c.voiceChannel).map((u) => u.sid));
      const now = new Set(users.filter((u) => u.voice === c.voiceChannel).map((u) => u.sid));
      for (const sid of now) if (!was.has(sid) && sid !== c.sid) c.voice.applyVolume(sid);
    }
    if (calling()) syncStage();
    if (!viewed()) return calling() && renderVoicePanel(); // its video button follows who is sharing
    renderChannels();
    renderMembers();
  });

  socket.on('profile', (p) => {
    if (!c.server) return;
    c.server.profiles[p.id] = p;
    if (!viewed()) return;
    if (S.channelId) renderMessages(true);
    renderMembers();
  });

  socket.on('profile:removed', ({ id }) => {
    if (!c.server) return;
    delete c.server.profiles[id];
    if (!viewed()) return;
    if (S.channelId && !inDmView()) renderMessages(true);
    renderMembers();
  });

  socket.on('bans', (bans) => {
    c.server.bans = bans;
    if (viewed()) renderMembers();
  });

  socket.on('roles', (msg) => {
    if (!c.server) return;
    const { roles, memberRoles } = msg && typeof msg === 'object' ? msg : {};
    c.server.roles = Array.isArray(roles) ? roles : [];
    c.server.memberRoles = memberRoles && typeof memberRoles === 'object' && !Array.isArray(memberRoles) ? memberRoles : {};
    if (viewed()) renderMembers();
  });

  socket.on('server', ({ name, icon, game }) => {
    Object.assign(c.server, { name, icon });
    if (game) {
      const wasOn = c.server.game?.enabled;
      c.server.game = game;
      if (viewed() && wasOn && !game.enabled && (S.game.open || S.game.popout)) {
        closeGame();
        toast('Club Penguin was turned off on this server');
      }
      if (viewed() && !inDmView()) renderChannels();
    }
    rememberServerLook(c);
    renderRail();
    if (viewed()) renderHeader();
    if (calling()) renderVoicePanel();
  });

  socket.on('server:update', (update) => {
    c.server.update = update;
    if (update.installing) toast(`${c.server.name} is updating to friendspeak ${update.latest?.version}. Hang tight…`, 'info', 8000);
    if (viewed()) renderBanners();
  });

  socket.on('channels', (channels) => {
    c.server.channels = channels;
    if (calling()) renderVoicePanel();
    if (!viewed()) return;
    if (!chatById(S.channelId)) {
      const first = channels.find((ch) => ch.type === 'text');
      if (first) selectChannel(first.id);
    }
    renderChannels();
    renderHeader();
    refreshChatTitle();
  });

  socket.on('emojis', (emojis) => {
    c.server.emojis = emojis;
    if (!viewed()) return;
    updatePickerEmojis();
    renderChannels();
    refreshChatTitle();
    if (S.channelId) renderMessages(true);
  });

  socket.on('msg:new', ({ channelId, message }) => {
    if (!viewed()) return;
    const list = S.messages.get(channelId);
    if (list) list.push(message);
    S.typing.get(channelId)?.forEach((t, sid) => t.name === message.name && S.typing.get(channelId).delete(sid));
    const mine = message.author === me().id;
    const mentioned = !mine && new RegExp(`@${me().name.replace(/[^\w-]/g, '')}\\b`, 'i').test(message.text);
    if (mentioned) audio.cue('message');
    if (channelId === S.channelId) {
      appendMessage(message, mine);
      renderTyping();
    } else if (!mine) {
      S.unread.add(channelId);
      renderChannels();
    }
    if (document.hidden && !mine) document.title = `(•) friendspeak`;
  });

  socket.on('msg:update', ({ channelId, message }) => {
    if (!viewed()) return;
    const list = S.messages.get(channelId);
    const i = list?.findIndex((m) => m.id === message.id) ?? -1;
    if (i >= 0) list[i] = message;
    if (channelId === S.channelId) {
      const el = $(`.msg[data-id="${message.id}"]`);
      if (el) el.replaceWith(messageEl(message, list[i - 1]));
    }
  });

  socket.on('msg:deleted', ({ channelId, messageId }) => {
    if (!viewed()) return;
    const list = S.messages.get(channelId);
    if (list) S.messages.set(channelId, list.filter((m) => m.id !== messageId));
    if (channelId === S.channelId) renderMessages(true);
  });

  socket.on('files:new', ({ storage }) => {
    c.server.storage = storage;
    if (viewed()) fileBrowser?.reload();
  });

  socket.on('files:deleted', ({ storage }) => {
    c.server.storage = storage;
    if (viewed()) fileBrowser?.reload();
  });

  socket.on('typing', ({ channelId, sid, name }) => {
    if (!viewed()) return;
    if (!S.typing.has(channelId)) S.typing.set(channelId, new Map());
    S.typing.get(channelId).set(sid, { name, until: Date.now() + 4000 });
    if (channelId === S.channelId) renderTyping();
  });

  socket.on('voice:kicked', () => {
    c.voice.leave(true);
    c.voiceChannel = null;
    if (calling()) endCall(true);
    renderRail();
    renderChannels();
    renderVoicePanel();
    toast('Voice channel was deleted');
  });
}

// Cache the server's name and icon on its bookmark, so the rail shows them offline too
function rememberServerLook(c) {
  const look = { serverName: c.server.name, serverIcon: c.server.icon || '' };
  Object.assign(c.entry, look);
  servers.upsert({ id: c.entry.id, ...look });
}

// ---------------------------------------------------------------- voice

// Is the call in this voice channel of the server in view?
const inCall = (channelId) => !!S.call && S.call === S.conn && S.call.voiceChannel === channelId;
// The call's channel (the one it returns to while its server reconnects)
const callChannel = () => S.call?.server?.channels.find((ch) => ch.id === (S.call.voiceChannel || S.call.rejoinVoice));

// `c` is the server in view, or the call's own connection when it rejoins after a reconnect
async function joinVoice(channelId, silent = false, c = S.conn) {
  if (!c?.connected) return;
  if (S.call === c && c.voiceChannel === channelId) return;
  if (S.call !== c) endCall(); // one call at a time: hang up the one on another server
  if (DMCALL.cur && DMCALL.cur.state !== 'ringing') DMCALL.hangup(); // one microphone: a DM call or a voice channel, not both
  audio.ensure();
  try {
    await c.voice.join(channelId);
  } catch (e) {
    c.rejoinVoice = null;
    if (S.call === c && !c.voiceChannel) (endCall(), renderVoicePanel());
    renderRail();
    return toast('Could not join voice: ' + e.message, 'error');
  }
  c.voiceChannel = channelId;
  c.rejoinVoice = null;
  S.call = c;
  if (c.voice.micError) {
    toast(
      window.isSecureContext
        ? `No microphone (${c.voice.micError.message}). You joined listen-only — soundboard still works.`
        : 'Mic needs a secure page. Open friendspeak from localhost or run the server with HTTPS=1. Joined listen-only.',
      'error',
      7000
    );
  }
  audio.setMuted(S.muted || S.deafened);
  c.voice.setDeafened(S.deafened);
  c.socket.emit('voice:state', { muted: S.muted, deafened: S.deafened });
  if (!silent) audio.cue('join');
  renderRail();
  renderChannels();
  renderVoicePanel();
}

// Hang up. A connection that was only open for the call closes with it.
function endCall(silent = false) {
  const c = S.call;
  if (!c) return;
  closeStage();
  c.voice.leave(silent);
  c.voiceChannel = c.rejoinVoice = null;
  S.call = null;
  if (c !== S.conn) dropConn(c);
}

function leaveVoice() {
  if (!S.call) return;
  endCall();
  audio.cue('leave');
  renderRail();
  renderChannels();
  renderVoicePanel();
}

function toggleMute() {
  if (S.deafened) {
    S.deafened = false;
    S.muted = false;
  } else S.muted = !S.muted;
  syncVoiceState();
  audio.cue(S.muted ? 'mute' : 'unmute');
}

function toggleDeafen() {
  S.deafened = !S.deafened;
  syncVoiceState();
  audio.cue(S.deafened ? 'mute' : 'unmute');
}

function syncVoiceState() {
  audio.setMuted(S.muted || S.deafened);
  audio.setMonitor(!S.deafened && settings.get().soundboardMonitor);
  S.voice?.setDeafened(S.deafened);
  DMCALL.sync(S.muted, S.deafened);
  for (const c of conns()) if (c.connected) c.socket.emit('voice:state', { muted: S.muted, deafened: S.deafened });
  renderUserPanel();
  syncStage();
  renderDmCall();
}

// Speaking indicators, polled from analysers.
setInterval(() => {
  if (!S.voiceChannel) return;
  const levels = S.voice.levels();
  if (audio.selfAnalyser) levels.set(S.call.sid, Level(audio.selfAnalyser));
  for (const el of $$('.voice-user, .tile[data-sid]')) el.classList.toggle('speaking', (levels.get(el.dataset.sid) || 0) > 0.02);
}, 90);

// ---------------------------------------------------------------- sidebar

function renderHeader() {
  const hd = $('#server-header');
  if (inDmView()) return hd.replaceChildren(h('span', { class: 'server-title' }, h('span', {}, 'Direct messages')));
  if (!S.entry) return hd.replaceChildren(h('span', {}, 'friendspeak'));
  hd.replaceChildren(
    h(
      'button',
      {
        class: 'server-title',
        title: S.connected ? 'Server settings: name, icon, emojis' : '',
        disabled: !S.connected,
        onclick: () => openSettings('server'),
      },
      S.server?.icon ? h('img', { class: 'header-icon', src: S.server.icon, alt: '', referrerpolicy: 'no-referrer' }) : null,
      h('span', {}, S.server?.name || S.entry.serverName || S.entry.address)
    ),
    S.connected && S.server?.storage ? h('button', { class: 'icon-btn tiny', title: 'Server files', onclick: () => openFileBrowser() }, icon('folder')) : null,
    h('span', { class: 'conn-dot ' + (S.connected ? 'on' : 'off'), title: S.connected ? 'Connected' : 'Offline' })
  );
}

function renderChannels() {
  const box = $('#channel-list');
  if (inDmView()) return box.replaceChildren(dmSidebar());
  if (!S.server) return box.replaceChildren();
  const text = S.server.channels.filter((c) => c.type === 'text');
  const voice = S.server.channels.filter((c) => c.type === 'voice');
  const chMenu = (ch) => (e) =>
    contextMenu(e, [
      ch.type === 'text' && S.server.storage && { label: 'Browse files', run: () => openFileBrowser(ch.id) },
      {
        label: 'Rename',
        run: async () => {
          const n = await channelDialog('Rename channel', ch.name);
          if (n) S.socket.emit('channel:rename', { id: ch.id, name: n });
        },
      },
      {
        label: 'Delete',
        danger: true,
        run: async () => (await confirmModal('Delete channel', `Delete "${ch.name}" and its history?`)) && S.socket.emit('channel:delete', { id: ch.id }),
      },
    ]);
  const cat = (label, type) =>
    h(
      'div',
      { class: 'cat' },
      h('span', {}, label),
      h(
        'button',
        {
          class: 'icon-btn tiny',
          title: 'Create channel',
          onclick: async () => {
            const name = await channelDialog(`New ${type} channel`);
            if (!name) return;
            const r = await S.socket.emitWithAck('channel:create', { name, type });
            if (r.ok && type === 'text') selectChannel(r.channel.id);
          },
        },
        icon('plus')
      )
    );
  box.replaceChildren(
    cat('Text channels', 'text'),
    ...text.map((ch) =>
      h(
        'div',
        {
          class: 'channel' + (ch.id === S.channelId ? ' active' : '') + (S.unread.has(ch.id) ? ' unread' : ''),
          onclick: () => selectChannel(ch.id),
          oncontextmenu: chMenu(ch),
        },
        icon('hash'),
        channelNameEl(ch.name, S.server.emojis)
      )
    ),
    cat('Voice channels', 'voice'),
    ...voice.flatMap((ch) => {
      const inside = S.users.filter((u) => u.voice === ch.id);
      const video = inside.some((u) => u.camera || u.sharing);
      return [
        h(
          'div',
          {
            class: 'channel voice' + (inCall(ch.id) ? ' connected' : '') + (video ? ' has-video' : ''),
            onclick: () => joinVoice(ch.id),
            oncontextmenu: chMenu(ch),
          },
          icon('speaker'),
          channelNameEl(ch.name, S.server.emojis),
          video
            ? h(
                'button',
                {
                  class: 'video-badge',
                  title: inCall(ch.id) ? 'Open video grid' : 'Join and open video grid',
                  onclick: (e) => (e.stopPropagation(), openVideoGrid(ch.id)),
                },
                icon('cam')
              )
            : null,
          inside.length ? h('span', { class: 'count' }, inside.length) : null
        ),
        h('div', { class: 'voice-users' + (video ? ' has-video' : '') }, inside.map(voiceUserEl)),
      ];
    }),
    gamesSection() || '' // replaceChildren(null) would print "null"
  );
}

// The sidebar while the DM view is open: every conversation on this device
function dmSidebar() {
  const list = [...DM.contacts.values()].sort((a, b) => b.last - a.last);
  return h(
    'div',
    {},
    h('div', { class: 'cat' }, h('span', {}, 'Direct messages'), h('button', { class: 'cat-add', title: 'Add a friend with a friend code', onclick: friendDialog }, icon('plus'))),
    list.map((c) =>
      h(
        'div',
        {
          class: 'channel dm' + ('dm:' + c.id === S.channelId ? ' active' : '') + (c.unread ? ' unread' : ''),
          title: c.name,
          onclick: () => selectChannel('dm:' + c.id),
          oncontextmenu: (e) => contextMenu(e, [{ label: 'Delete conversation', danger: true, run: () => deleteConversation(c.id) }]),
        },
        h('div', { class: 'member-av' }, avatarEl(c, 20), h('span', { class: 'presence' + (DM.online(c.id) ? '' : ' off') })),
        h('span', { class: 'name' }, c.name),
        c.unread ? h('span', { class: 'count' }, c.unread) : null
      )
    ),
    h('p', { class: 'muted small dm-hint' }, 'Messages are encrypted between your two devices. No server can read them. Start one from anyone’s name in a server’s member list, or add a friend with a friend code.')
  );
}

async function removePrompt(profileId) {
  const name = profileOf(profileId).name;
  if (!(await confirmModal(`Remove ${name}`, `Disconnect ${name} and take them off the member list? They can come back unless you ban them.`, 'Remove'))) return;
  const r = await S.socket.emitWithAck('member:remove', { profileId });
  if (r.error) toast(r.error, 'error');
}

async function banPrompt(profileId) {
  const name = profileOf(profileId).name;
  const withIp = h('input', { type: 'checkbox', checked: true });
  const ok = await new Promise((resolve) => {
    let done = false;
    const close = modal(
      `Ban ${name}`,
      h(
        'div',
        {},
        h('p', {}, `${name} will be disconnected and can't come back with this profile. Anyone on the server can lift the ban in Settings → Server.`),
        h('label', { class: 'field inline' }, withIp, h('span', {}, 'Also ban their IP address')),
        h('p', { class: 'muted small' }, 'There are no accounts, so a new profile gets around a profile ban. The IP ban is skipped when they share your network.')
      ),
      {
        actions: [
          h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'),
          h('button', { class: 'btn danger', onclick: () => ((done = true), close(), resolve(true)) }, 'Ban'),
        ],
        onClose: () => !done && resolve(false),
      }
    );
  });
  if (!ok) return;
  const r = await S.socket.emitWithAck('ban:add', { profileId, ip: withIp.checked });
  if (r.error) return toast(r.error, 'error');
  toast(r.ipSkipped ? `${name} is banned (profile only: their IP is shared with yours or unknown)` : `${name} is banned`);
}

// Name a channel; the emoji button inserts unicode or :custom: server emojis
function channelDialog(title, value = '') {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { value, maxlength: 48, placeholder: 'e.g. 🎮-gaming', onkeydown: (e) => e.key === 'Enter' && ok() });
    const ok = () => {
      if (!input.value.trim()) return toast('Enter a channel name', 'error');
      done = true;
      close();
      resolve(input.value.trim());
    };
    const close = modal(
      title,
      h(
        'label',
        { class: 'field' },
        h('span', {}, 'Channel name'),
        h(
          'div',
          { class: 'input-with-btn' },
          input,
          h('button', { class: 'icon-btn', title: 'Add an emoji', onclick: (e) => (e.preventDefault(), openEmojiPicker(e.currentTarget, { mode: 'insert', target: input })) }, icon('smile'))
        )
      ),
      {
        actions: [h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'), h('button', { class: 'btn', onclick: ok }, 'Save')],
        onClose: () => (closePopover(), !done && resolve(null)),
      }
    );
  });
}

// Hidden entirely unless the server has the game (assets included) and it's switched on
function gamesSection() {
  const g = S.server.game || {};
  if (!g.available || !g.enabled) return null;
  const players = S.users.filter((u) => u.playing);
  return h(
    'div',
    {},
    h('div', { class: 'cat' }, h('span', {}, 'Games')),
    h(
      'div',
      {
        class: 'channel game' + (S.game.visible ? ' active' : '') + (S.game.open ? ' connected' : ''),
        title: `Play Club Penguin on ${g.world} with everyone on this server`,
        onclick: () => openGame(),
      },
      h('span', { class: 'game-icon' }, '🐧'),
      h('span', { class: 'name' }, 'Club Penguin'),
      players.length ? h('span', { class: 'count' }, players.length) : null
    ),
    h(
      'div',
      { class: 'voice-users' },
      players.map((u) => h('div', { class: 'voice-user' }, avatarEl(u, 24), h('span', { class: 'name' }, u.name)))
    )
  );
}

function voiceUserEl(u) {
  const peer = S.voice?.peers.get(u.sid);
  const isMe = u.sid === S.sid;
  const together = inCall(u.voice); // we're in this channel too
  return h(
    'div',
    {
      class: 'voice-user' + (peer && peer.state !== 'connected' && !isMe ? ' pending' : ''),
      'data-sid': u.sid,
      title: peer && !isMe ? `connection: ${peer.state}` : '',
      onclick: (e) => (!isMe && together ? userVolumePopover(e.currentTarget, u) : profilePopover(e.currentTarget, u)),
      oncontextmenu: (e) => {
        e.preventDefault();
        if (!isMe && together) userVolumePopover(e.currentTarget, u);
      },
    },
    avatarEl(u, 24),
    h('span', { class: 'name' }, u.name),
    u.sharing
      ? h(
          'button',
          {
            class: 'live-badge' + (S.stage?.tiles.get('screen:' + u.sid)?.live ? ' watching' : ''),
            title: together ? (isMe ? 'Preview your stream' : `Watch ${u.name}'s screen`) : 'Join the channel to watch',
            onclick: (e) => {
              e.stopPropagation();
              if (together) openStage({ screen: u.sid });
              else toast('Join the voice channel to watch');
            },
          },
          'LIVE'
        )
      : null,
    u.camera
      ? h(
          'button',
          {
            class: 'cam-badge' + (S.stage && together ? ' watching' : ''),
            title: together ? 'Show cameras' : 'Join the channel to see cameras',
            onclick: (e) => {
              e.stopPropagation();
              if (together) openStage();
              else toast('Join the voice channel to see cameras');
            },
          },
          icon('cam')
        )
      : null,
    u.muted || u.deafened ? icon(u.deafened ? 'headOff' : 'micOff', 'state') : null,
    isMe ? null : userVolumeBadge(u)
  );
}

// What we did to someone's volume, next to their name: muted for us, or a
// percentage when it isn't 100%
function userVolumeBadge(u) {
  const st = settings.get();
  if (st.userMutes[u.id]) return h('span', { class: 'icon state', title: 'Muted for you', html: I.speakerOff });
  const v = st.userVolumes[u.id] ?? 1;
  if (v === 1) return null;
  return h('span', { class: 'vol-badge' + (v > 1 ? ' boost' : ''), title: v > 1 ? 'Boosted for you' : 'Turned down for you' }, Math.round(v * 100) + '%');
}

// Volume and mute for one person, for us only (stored by profile id). Above
// 100% boosts them.
function userVolumePopover(anchor, u, align = 'right') {
  const val = h('span', {});
  const slider = h('input', {
    type: 'range',
    min: 0,
    max: MAX_USER_VOLUME,
    step: 0.01,
    title: 'Double-click to reset',
    oninput: (e) => apply({ userVolumes: { ...settings.get().userVolumes, [u.id]: +e.target.value } }),
    onchange: renderChannels, // the badge next to their name
    ondblclick: () => reset(),
  });
  const muteBtn = h('button', { class: 'btn small ghost', onclick: () => (apply({ userMutes: { ...settings.get().userMutes, [u.id]: !settings.get().userMutes[u.id] } }), renderChannels()) });
  const resetBtn = h('button', { class: 'btn small ghost', onclick: () => reset() }, 'Reset');
  const draw = () => {
    const st = settings.get();
    const v = st.userVolumes[u.id] ?? 1;
    const muted = !!st.userMutes[u.id];
    slider.value = v;
    slider.classList.toggle('boost', v > 1);
    val.textContent = Math.round(v * 100) + '%' + (muted ? ' (muted)' : v > 1 ? ' (boosted)' : '');
    muteBtn.textContent = muted ? 'Unmute' : 'Mute';
    resetBtn.disabled = v === 1;
  };
  const apply = (patch) => {
    settings.set(patch);
    S.voice?.applyVolume(u.sid);
    draw();
  };
  const reset = () => (apply({ userVolumes: { ...settings.get().userVolumes, [u.id]: 1 } }), renderChannels());
  draw();
  popover(
    anchor,
    h(
      'div',
      { class: 'user-pop' },
      h('div', { class: 'profile-card' }, profileCardHead(fullProfile(u))),
      h('label', { class: 'field' }, h('span', {}, 'User volume ', val), slider),
      h('div', { class: 'row' }, muteBtn, resetBtn),
      h('p', { class: 'muted small' }, 'Only changes what you hear.')
    ),
    { align }
  );
}

function renderVoicePanel() {
  const p = $('#voice-panel');
  const c = S.call;
  const ch = callChannel();
  p.hidden = !ch;
  if (!ch) return p.replaceChildren();
  const live = !!c.voiceChannel; // false while the call's server reconnects
  const away = c !== S.conn; // the call is on another server than the one in view
  const serverName = c.server.name || serverLabel(c.entry);
  const where = ch.name + ' / ' + serverName;
  const video = live && c.users.some((u) => u.voice === c.voiceChannel && (u.camera || u.sharing));
  const buttons = [
    // On its own row: the way back to the server the call is on
    away ? h('button', { class: 'vp-channel vp-jump', title: `Go to ${serverName}`, onclick: () => connectTo(c.entry) }, icon('jump'), h('span', {}, where)) : null,
    h(
      'div',
      { class: 'vp-info' },
      h(
        'div',
        { class: 'vp-status' + (live ? '' : ' pending') },
        !live ? 'Reconnecting…' : c.voice.micError ? 'Listen-only' : 'Voice Connected',
        c.voice.local.screen ? h('span', { class: 'live-badge' }, 'LIVE') : null
      ),
      away ? null : h('div', { class: 'vp-channel' }, where)
    ),
    // The channel list has this button too, but that list now shows another server
    away && video ? h('button', { class: 'icon-btn' + (S.stage ? ' sharing' : ''), title: 'Open video grid', onclick: () => openStage() }, icon('expand')) : null,
    live
      ? h(
          'button',
          {
            class: 'icon-btn' + (c.voice.local.screen ? ' sharing' : ''),
            title: c.voice.local.screen ? 'Change source or stop sharing' : 'Share your screen',
            onclick: (e) => (S.voice?.local.screen ? sharePopover(e.currentTarget) : screenPicker()),
          },
          icon('screen')
        )
      : null,
    live
      ? h(
          'button',
          {
            class: 'icon-btn' + (c.voice.local.camera ? ' sharing' : ''),
            title: (c.voice.local.camera ? 'Turn off camera' : 'Turn on camera') + ' (right-click for cameras and backgrounds)',
            onclick: toggleCamera,
            oncontextmenu: (e) => (e.preventDefault(), cameraPopover(e.currentTarget)),
          },
          icon(c.voice.local.camera ? 'cam' : 'camOff')
        )
      : null,
    h('button', { class: 'icon-btn', title: 'Soundboard', onclick: (e) => openSoundboard(e.currentTarget) }, icon('board')),
    h('button', { class: 'icon-btn danger', title: 'Disconnect', onclick: leaveVoice }, icon('hangup')),
  ];
  p.replaceChildren(...buttons.filter(Boolean)); // replaceChildren(null) would print "null"
}

function renderUserPanel() {
  const p = me();
  if (!p) return;
  $('#user-panel').replaceChildren(
    h(
      'div',
      { class: 'up-me', title: 'Switch profile', onclick: (e) => profileSwitcher(e.currentTarget) },
      h('div', { class: 'voice-user self', 'data-sid': S.call?.sid || S.sid || '' }, avatarEl(p, 32)),
      h('div', { class: 'up-names' }, h('div', { class: 'up-name' }, p.name), h('div', { class: 'up-status' }, p.status || (S.connected ? 'Online' : 'Offline')))
    ),
    h('button', { class: 'icon-btn' + (S.muted || S.deafened ? ' off' : ''), title: 'Mute', onclick: toggleMute }, icon(S.muted || S.deafened ? 'micOff' : 'mic')),
    h('button', { class: 'icon-btn' + (S.deafened ? ' off' : ''), title: 'Deafen', onclick: toggleDeafen }, icon(S.deafened ? 'headOff' : 'head')),
    h('button', { class: 'icon-btn', title: 'Soundboard', onclick: (e) => openSoundboard(e.currentTarget) }, icon('board')),
    h('button', { class: 'icon-btn', title: 'Settings', onclick: () => openSettings() }, icon('gear'))
  );
}

function profileSwitcher(anchor) {
  const cur = me();
  const pop = popover(
    anchor,
    h(
      'div',
      { class: 'menu profiles-menu' },
      h('div', { class: 'menu-label' }, 'Profiles on this device'),
      profiles.all().map((p) =>
        h(
          'button',
          { class: 'menu-item profile-item' + (p.id === cur.id ? ' current' : ''), onclick: () => (pop.close(), switchProfile(p.id)) },
          avatarEl(p, 24),
          h('span', {}, p.name),
          p.id === cur.id ? h('span', { class: 'check' }, '✓') : null
        )
      ),
      h('div', { class: 'menu-sep' }),
      h('button', { class: 'menu-item', onclick: () => (pop.close(), openSettings('profile')) }, 'Edit profile…'),
      h(
        'button',
        {
          class: 'menu-item',
          onclick: () => {
            pop.close();
            const p = profiles.create({ name: 'new friend' });
            switchProfile(p.id);
            openSettings('profile');
          },
        },
        'New profile'
      )
    ),
    { align: 'start' }
  );
}

function switchProfile(id) {
  profiles.setActive(id);
  if (inDmView()) S.channelId = null; // those DMs belong to the previous profile
  DMCALL.stop();
  DM.start(me(), servers.all());
  renderUserPanel();
  // Servers identify you by profile id, so reconnect as the new one. A call on
  // the server in view is rejoined; one on another server ends.
  const rejoinVoice = S.call === S.conn ? S.voiceChannel : null;
  endCall();
  if (S.entry) {
    const entry = S.entry;
    disconnect();
    connectTo(entry, { rejoinVoice });
  } else renderAll();
}

// ---------------------------------------------------------------- members

function renderMembers() {
  const box = $('#members');
  const show = settings.get().showMembers && S.connected && !inDmView();
  document.body.classList.toggle('no-members', !show);
  if (!show) return box.replaceChildren();
  const byName = (a, b) => a.name.localeCompare(b.name);
  const inVoice = S.users.filter((u) => u.voice).sort(byName);
  const rest = S.users.filter((u) => !u.voice).sort(byName);
  // Everyone who has been here before and isn't now (banned people are listed in Settings → Server)
  const offline = Object.entries(S.server.profiles || {})
    .filter(([pid]) => !isOnline(pid) && !isBanned(pid))
    .map(([pid, p]) => ({ ...p, id: pid, offline: true }))
    .sort(byName);
  const hideOffline = settings.get().hideOffline;
  const menu = (u) => (e) => {
    const el = e.currentTarget;
    if (u.id === me().id) return;
    contextMenu(e, [
      inCall(u.voice) && { label: 'Volume…', run: () => userVolumePopover(el, u, 'left') },
      { label: 'Message', run: () => openDm(u.id) },
      { label: 'Remove from server…', danger: true, run: () => removePrompt(u.id) },
      !isBanned(u.id) && { label: 'Ban…', danger: true, run: () => banPrompt(u.id) },
    ]);
  };
  const row = (u) => {
    const roles = rolesOf(u.id);
    return h(
      'div',
      { class: 'member' + (u.offline ? ' offline' : ''), onclick: (e) => profilePopover(e.currentTarget, u, 'left'), oncontextmenu: menu(u) },
      h('div', { class: 'member-av' }, avatarEl(u, 32), h('span', { class: 'presence' + (u.offline ? ' off' : '') })),
      h(
        'div',
        { class: 'member-names' },
        h('div', { class: 'member-name', style: { color: u.color } }, u.name),
        h(
          'div',
          { class: 'member-status' },
          [u.voice && '🔊 ' + (channelById(u.voice)?.name || ''), u.sharing && '🖥️ Live', u.camera && '📷 Camera', u.playing && '🐧 Club Penguin'].filter(Boolean).join(' · ') || u.status || ''
        ),
        roles.length
          ? h(
              'div',
              { class: 'member-roles', title: roles.length > 3 ? roles.map((r) => r.name).join(', ') : null },
              roles.slice(0, 3).map(roleTag),
              roles.length > 3 ? h('span', { class: 'role-more' }, `+${roles.length - 3}`) : null
            )
          : null
      )
    );
  };
  box.replaceChildren(
    ...[
      inVoice.length ? h('div', { class: 'cat' }, `In voice — ${inVoice.length}`) : null,
      ...inVoice.map(row),
      rest.length ? h('div', { class: 'cat' }, `Online — ${rest.length}`) : null,
      ...rest.map(row),
      offline.length
        ? h(
            'button',
            { class: 'cat cat-toggle', title: hideOffline ? 'Show' : 'Hide', onclick: () => (settings.set({ hideOffline: !hideOffline }), renderMembers()) },
            `${hideOffline ? '▸' : '▾'} Offline — ${offline.length}`
          )
        : null,
      ...(hideOffline ? [] : offline.map(row)),
    ].filter(Boolean)
  );
}

// ---------------------------------------------------------------- main / chat

function renderMain(error) {
  const main = $('#main');
  if (!inDmView() && (!S.entry || (!S.connected && !S.server))) {
    const list = servers.all();
    main.replaceChildren(
      h(
        'div',
        { class: 'home' },
        h('div', { class: 'home-logo' }, 'friendspeak'),
        S.entry
          ? h('p', { class: error ? 'error-text' : 'muted' }, error || `Connecting to ${S.entry.address}…`)
          : h('p', { class: 'muted' }, 'Text, voice, GIFs and soundboards with your friends. Connect to a server by IP.'),
        h('div', { class: 'home-actions' }, h('button', { class: 'btn big', onclick: () => serverDialog() }, 'Connect to a server')),
        list.length
          ? h(
              'div',
              { class: 'home-servers' },
              h('div', { class: 'cat' }, 'Saved servers'),
              list.map((s) =>
                h(
                  'button',
                  { class: 'home-server', onclick: () => connectTo(s) },
                  h('strong', {}, s.serverName || 'Server'),
                  h('span', { class: 'muted' }, s.address)
                )
              )
            )
          : null,
        h('p', { class: 'muted small hosting' }, 'Hosting? Run the friendspeak server (npm start or Docker) and connect to it here. It prints its LAN addresses on startup.')
      )
    );
    return;
  }
  const ch = chatById(S.channelId);
  if (!ch) return main.replaceChildren(h('div', { class: 'home' }, h('p', { class: 'muted' }, 'No channel selected')));
  const dm = ch.type === 'dm';
  // Files live in channels (D24). DMs carry images, sent straight to the friend's device.
  const canUpload = dm || !!S.server?.storage;

  const ta = h('textarea', {
    id: 'composer-input',
    rows: 1,
    placeholder: dm ? `Message @${ch.name}` : `Message #${ch.name}`,
    onkeydown: onComposerKey,
    oninput: onComposerInput,
    onpaste: (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length && canUpload) (e.preventDefault(), addAttachments(files));
    },
  });
  const fileIn = h('input', { type: 'file', multiple: true, hidden: true, accept: dm ? 'image/png,image/jpeg,image/gif,image/webp' : null, onchange: () => (addAttachments([...fileIn.files]), (fileIn.value = '')) });
  // Drop files anywhere on the chat
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  main.ondragover = (e) => {
    if (!hasFiles(e) || !canUpload || !chatById(S.channelId)) return;
    e.preventDefault();
    main.classList.add('dropping');
  };
  main.ondragleave = (e) => !main.contains(e.relatedTarget) && main.classList.remove('dropping');
  main.ondrop = (e) => {
    main.classList.remove('dropping');
    if (!hasFiles(e) || !canUpload || !chatById(S.channelId)) return;
    e.preventDefault();
    addAttachments([...e.dataTransfer.files]);
  };
  main.replaceChildren(
    h(
      'header',
      { class: 'chat-header' },
      ...chatTitle(ch),
      !S.connected && !dm ? h('span', { class: 'badge warn' }, 'reconnecting…') : null,
      dm ? h('span', { class: 'muted small dm-status' }, dmStatus(ch.with)) : null,
      dm ? h('button', { class: 'badge warn dm-conflict', hidden: !DM.contacts.get(ch.with)?.conflict, title: 'Messages from a different key are being refused', onclick: () => trustKeyPrompt(ch.with) }, 'different key') : null,
      h('div', { class: 'spacer' }),
      dm ? h('div', { class: 'dm-call-btns' }) : null,
      canUpload && !dm ? h('button', { class: 'icon-btn', title: 'Files in this channel', onclick: () => openFileBrowser(ch.id) }, icon('folder')) : null,
      h(
        'button',
        {
          hidden: dm,
          class: 'icon-btn' + (settings.get().showMembers ? ' on' : ''),
          title: 'Member list',
          onclick: (e) => {
            settings.set({ showMembers: !settings.get().showMembers });
            e.currentTarget.classList.toggle('on');
            renderMembers();
          },
        },
        icon('people')
      )
    ),
    h('div', { id: 'messages', class: 'messages', onscroll: onMessagesScroll }),
    h(
      'div',
      { class: 'composer-wrap' },
      h('div', { id: 'reply-bar', class: 'reply-bar', hidden: true }),
      h('div', { id: 'attach-tray', class: 'attach-tray', hidden: true }),
      h(
        'div',
        { class: 'composer', ondragover: (e) => e.preventDefault() },
        canUpload ? h('button', { class: 'icon-btn attach-btn', title: dm ? 'Send images' : 'Upload files', onclick: () => fileIn.click() }, icon('clip')) : null,
        fileIn,
        ta,
        h('button', { class: 'icon-btn gif-btn', title: 'GIFs', onclick: (e) => openGifPicker(e.currentTarget) }, 'GIF'),
        h('button', { class: 'icon-btn', title: 'Emoji', onclick: (e) => openEmojiPicker(e.currentTarget, { mode: 'insert' }) }, icon('smile'))
      ),
      h('div', { id: 'typing', class: 'typing' })
    )
  );
  renderMessages();
  renderReplyBar();
  renderAttachTray();
  renderDmCall();
  ta.focus();
}

// Whether a DM can be delivered right now
const dmStatus = (peerId) =>
  DM.connected(peerId)
    ? 'connected'
    : DM.online(peerId)
      ? 'connecting…'
      : DM.canMail(peerId)
        ? 'offline · messages wait for them in their mailbox'
        : 'offline · messages are delivered when you’re both online';

// Header icon + title: # and the channel name, or the other person in a DM
function chatTitle(ch) {
  if (ch.type !== 'dm') return [icon('hash'), channelNameEl(ch.name, S.server?.emojis, 'chat-title')];
  const p = profileOf(ch.with);
  return [
    h('div', { class: 'member-av dm-av' }, avatarEl(p, 24), h('span', { class: 'presence' + (DM.online(ch.with) ? '' : ' off') })),
    h('span', { class: 'chat-title dm-title', title: p.name, onclick: (e) => profilePopover(e.currentTarget, { ...p, id: ch.with }, 'start') }, p.name),
  ];
}

// Channel renamed, emojis or a DM partner changed: update the chat header without rebuilding the composer
function refreshChatTitle() {
  const ch = chatById(S.channelId);
  const head = $('#main .chat-header');
  if (!ch || !head) return;
  head.querySelectorAll(':scope > .icon:first-child, :scope > .dm-av, :scope > .chat-title').forEach((el) => el.remove());
  head.prepend(...chatTitle(ch));
  const status = head.querySelector('.dm-status');
  if (status && ch.type === 'dm') status.textContent = dmStatus(ch.with);
  const conflict = head.querySelector('.dm-conflict');
  if (conflict && ch.type === 'dm') conflict.hidden = !DM.contacts.get(ch.with)?.conflict;
  const ta = $('#composer-input');
  if (ta) ta.placeholder = ch.type === 'dm' ? `Message @${ch.name}` : `Message #${ch.name}`;
}

async function selectChannel(id) {
  const ch = chatById(id);
  if (!ch) return;
  S.channelId = id;
  S.unread.delete(id);
  showGame(false);
  closeStage();
  S.replyTo = null;
  if (isDm(id)) {
    // The thread lives in dm.js; share its array so new messages show up here too
    S.messages.set(id, await DM.history(peerOf(id)));
    S.hasMore.set(id, false);
    if (S.channelId !== id) return;
    DM.opened(peerOf(id));
    return renderAll();
  }
  settings.set({ lastChannel: { ...settings.get().lastChannel, [S.entry.id]: id } });
  if (!S.messages.has(id) && S.connected) {
    const res = await S.socket.emitWithAck('msg:history', { channelId: id });
    S.messages.set(id, res.messages || []);
    S.hasMore.set(id, (res.messages || []).length >= 50);
  }
  if (S.channelId !== id) return;
  renderRail();
  renderHeader();
  renderChannels();
  renderMembers();
  renderMain();
}

function isGrouped(m, prev) {
  return prev && prev.author === m.author && m.ts - prev.ts < 5 * 60e3 && !m.replyTo && new Date(m.ts).getDate() === new Date(prev.ts).getDate();
}

function messageEl(m, prev) {
  const grouped = isGrouped(m, prev);
  const author = profileOf(m.author, m.name);
  const mine = m.author === me().id;
  const { html, jumbo, embeds } = formatText(m.text || '', { emojis: S.server?.emojis || [], myName: me().name });
  const mentioned = !mine && /class="mention me"/.test(html);
  const replied = m.replyTo && S.messages.get(S.channelId)?.find((x) => x.id === m.replyTo);

  const reactions = Object.entries(m.reactions || {});
  return h(
    'div',
    {
      class: 'msg' + (grouped ? ' grouped' : '') + (mentioned ? ' mentioned' : '') + (m.pending ? ' pending' : '') + (m.mailed ? ' mailed' : '') + (m.note ? ' note' : ''),
      'data-id': m.id,
      title: m.mailed ? 'Waiting in their mailbox' : m.pending ? 'Not delivered yet' : null,
    },
    m.replyTo
      ? h(
          'div',
          { class: 'msg-reply', onclick: () => $(`.msg[data-id="${m.replyTo}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }) },
          icon('reply'),
          replied
            ? [h('strong', {}, profileOf(replied.author, replied.name).name), ' ', (replied.text || (replied.gif ? 'GIF' : replied.files?.length ? '📎 ' + replied.files[0].name : '')).slice(0, 100)]
            : h('em', {}, 'original message unavailable')
        )
      : null,
    h(
      'div',
      { class: 'msg-row' },
      grouped
        ? h('span', { class: 'msg-hover-time' }, shortTime(m.ts))
        : h('button', { class: 'msg-avatar', onclick: (e) => profilePopover(e.currentTarget, { ...author, id: m.author }) }, avatarEl(author, 40)),
      h(
        'div',
        { class: 'msg-body' },
        grouped
          ? null
          : h(
              'div',
              { class: 'msg-head' },
              h('span', { class: 'msg-author', style: { color: author.color }, onclick: (e) => profilePopover(e.currentTarget, { ...author, id: m.author }) }, author.name),
              h('span', { class: 'msg-time' }, fmtTime(m.ts))
            ),
        m.text ? h('div', { class: 'msg-text' + (jumbo ? ' jumbo' : ''), html: m.edited ? html.replace(/(<\/p>)?$/, (end) => ' <span class="edited">(edited)</span>' + end) : html }) : null,
        m.files?.length ? h('div', { class: 'attachments' }, m.files.map(m.thread ? (f) => dmAttachmentEl(m, f) : attachmentEl)) : null,
        embeds.length ? h('div', { class: 'embeds' }, embeds.map(embedEl)) : null,
        m.gif
          ? h(
              'div',
              { class: 'msg-gif' },
              h('img', { src: m.gif.url, alt: m.gif.title || 'GIF', loading: 'lazy', style: { aspectRatio: `${m.gif.w} / ${m.gif.h}` } })
            )
          : null,
        reactions.length
          ? h(
              'div',
              { class: 'reactions' },
              reactions.map(([emoji, who]) => {
                const custom = /^:([a-z0-9_]+):$/.exec(emoji);
                const url = custom && S.server?.emojis.find((e) => e.name === custom[1])?.url;
                return h(
                  'button',
                  {
                    class: 'reaction' + (who.includes(me().id) ? ' mine' : ''),
                    title: who.map((id) => profileOf(id).name).join(', '),
                    onclick: () => react(m.id, emoji),
                  },
                  url ? h('img', { class: 'cemoji', src: url, alt: emoji }) : emoji,
                  h('span', {}, who.length)
                );
              }),
              h('button', { class: 'reaction add', title: 'Add reaction', onclick: (e) => openEmojiPicker(e.currentTarget, { mode: 'react', messageId: m.id }) }, icon('addReact'))
            )
          : null
      )
    ),
    h(
      'div',
      { class: 'msg-actions' },
      // A note (e.g. "Missed call") exists only on this device: nothing to react to, reply to or edit
      m.note ? null : h('button', { title: 'Add reaction', onclick: (e) => openEmojiPicker(e.currentTarget, { mode: 'react', messageId: m.id }) }, icon('addReact')),
      m.note ? null : h('button', { title: 'Reply', onclick: () => setReply(m) }, icon('reply')),
      mine && m.text && !m.note ? h('button', { title: 'Edit', onclick: () => editMessage(m) }, icon('edit')) : null,
      mine || m.note
        ? h(
            'button',
            {
              title: 'Delete',
              class: 'danger',
              onclick: async (e) =>
                (e.shiftKey || (await confirmModal('Delete message', 'Delete this message? (Tip: shift-click to skip this)'))) &&
                (inDmView() ? DM.deleteMessage(peerOf(S.channelId), m.id) : S.socket.emit('msg:delete', { channelId: S.channelId, messageId: m.id })),
            },
            icon('trash')
          )
        : null
    )
  );
}

function renderMessages(keepScroll = false) {
  const box = $('#messages');
  if (!box) return;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const prevTop = box.scrollTop;
  const list = S.messages.get(S.channelId) || [];
  const ch = chatById(S.channelId);
  const frag = document.createDocumentFragment();
  if (!S.hasMore.get(S.channelId) && ch?.type === 'dm') {
    const p = profileOf(ch.with);
    frag.append(
      h(
        'div',
        { class: 'channel-intro' },
        avatarEl(p, 64),
        h('h1', {}, p.name),
        h(
          'p',
          { class: 'muted' },
          `This is the beginning of your direct messages with ${p.name}. They are encrypted so that only your two devices can read them, and stored only there. Servers you both use help you find each other and hold messages, still encrypted, while one of you is away. ` +
            (DM.contacts.get(ch.with)?.card
              ? `This device remembers ${p.name}’s key, so someone else using their profile is refused.`
              : `${p.name}’s key isn’t known yet. Until they connect with a current friendspeak, anyone who copied their profile could pretend to be them, and images can’t be sent.`)
        )
      )
    );
  } else if (!S.hasMore.get(S.channelId))
    frag.append(
      h(
        'div',
        { class: 'channel-intro' },
        h('div', { class: 'intro-icon' }, icon('hash')),
        h('h1', {}, 'Welcome to #', channelNameEl(ch?.name || '', S.server?.emojis, ''), '!'),
        h('p', { class: 'muted' }, `This is the start of the #${ch?.name} channel.`)
      )
    );
  list.forEach((m, i) => frag.append(messageEl(m, list[i - 1])));
  box.replaceChildren(frag);
  if (!keepScroll || atBottom) box.scrollTop = box.scrollHeight;
  else box.scrollTop = prevTop;
  // re-stick once images load
  for (const img of $$('img', box)) img.addEventListener('load', () => atBottomOrNew(box) && (box.scrollTop = box.scrollHeight), { once: true });
}

const atBottomOrNew = (box) => box.scrollHeight - box.scrollTop - box.clientHeight < 400;

function appendMessage(m, force) {
  const box = $('#messages');
  if (!box) return;
  const list = S.messages.get(S.channelId);
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const el = messageEl(m, list[list.length - 2]);
  box.append(el);
  if (atBottom || force) {
    box.scrollTop = box.scrollHeight;
    for (const img of $$('img', el)) img.addEventListener('load', () => (box.scrollTop = box.scrollHeight), { once: true });
  }
}

let loadingOlder = false;
async function onMessagesScroll(e) {
  const box = e.currentTarget;
  if (box.scrollTop > 60 || loadingOlder || !S.hasMore.get(S.channelId)) return;
  const list = S.messages.get(S.channelId);
  if (!list?.length) return;
  loadingOlder = true;
  const cid = S.channelId;
  const res = await S.socket.emitWithAck('msg:history', { channelId: cid, before: list[0].id });
  loadingOlder = false;
  if (cid !== S.channelId) return;
  const older = res.messages || [];
  S.hasMore.set(cid, older.length >= 50);
  S.messages.set(cid, [...older, ...list]);
  const fromBottom = box.scrollHeight - box.scrollTop;
  renderMessages(true);
  box.scrollTop = box.scrollHeight - fromBottom;
}

function react(messageId, emoji) {
  if (inDmView()) return DM.react(peerOf(S.channelId), messageId, emoji);
  S.socket.emit('msg:react', { channelId: S.channelId, messageId, emoji });
}

function setReply(m) {
  S.replyTo = m;
  renderReplyBar();
  $('#composer-input')?.focus();
}

function renderReplyBar() {
  const bar = $('#reply-bar');
  if (!bar) return;
  bar.hidden = !S.replyTo;
  if (!S.replyTo) return;
  bar.replaceChildren(
    h('span', {}, 'Replying to ', h('strong', {}, profileOf(S.replyTo.author, S.replyTo.name).name)),
    h('button', { class: 'x', onclick: () => ((S.replyTo = null), renderReplyBar()) }, '×')
  );
}

function editMessage(m) {
  const el = $(`.msg[data-id="${m.id}"] .msg-text`);
  if (!el) return;
  const ta = h('textarea', { class: 'edit-box', rows: 1 });
  ta.value = m.text;
  const done = (save) => {
    if (save && ta.value.trim() && ta.value !== m.text) {
      if (inDmView()) DM.editMessage(peerOf(S.channelId), m.id, ta.value.trim());
      else S.socket.emit('msg:edit', { channelId: S.channelId, messageId: m.id, text: ta.value });
    }
    const list = S.messages.get(S.channelId);
    const i = list.findIndex((x) => x.id === m.id);
    $(`.msg[data-id="${m.id}"]`)?.replaceWith(messageEl(list[i], list[i - 1]));
  };
  ta.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) (e.preventDefault(), done(true));
    if (e.key === 'Escape') done(false);
  };
  el.replaceWith(h('div', { class: 'edit-wrap' }, ta, h('div', { class: 'muted small' }, 'escape to cancel • enter to save')));
  autosize(ta);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 300) + 'px';
}

let lastTyping = 0;
function onComposerInput(e) {
  autosize(e.target);
  if (Date.now() - lastTyping > 2500 && e.target.value) {
    lastTyping = Date.now();
    if (inDmView()) DM.typing(peerOf(S.channelId));
    else S.socket?.emit('typing', { channelId: S.channelId });
  }
}

function onComposerKey(e) {
  const ta = e.target;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const text = ta.value;
    ta.value = '';
    autosize(ta);
    // A failed upload puts the text back so nothing is lost
    sendMessage(text).then((ok) => ok === false && !ta.value && ((ta.value = text), autosize(ta)));
  } else if (e.key === 'Escape' && S.replyTo) {
    S.replyTo = null;
    renderReplyBar();
  } else if (e.key === 'ArrowUp' && !ta.value) {
    const mine = [...(S.messages.get(S.channelId) || [])].reverse().find((m) => m.author === me().id && m.text);
    if (mine) (e.preventDefault(), editMessage(mine));
  }
}

async function sendMessage(text, gif) {
  text = (text || '').trim();
  const cid = S.channelId;
  if (isDm(cid)) {
    const images = gif ? [] : S.attachments.get(cid) || [];
    if (!text && !gif && !images.length) return;
    S.attachments.delete(cid);
    renderAttachTray();
    try {
      await DM.sendMessage(peerOf(cid), { text, gif, replyTo: S.replyTo?.id, files: images.map((a) => a.file) });
    } catch (err) {
      S.attachments.set(cid, images); // an image that can't be read: give everything back
      renderAttachTray();
      toast('Couldn’t read one of the images', 'error');
      return false;
    }
    for (const a of images) a.preview && URL.revokeObjectURL(a.preview);
    S.replyTo = null;
    lastTyping = 0;
    return renderReplyBar();
  }
  const pending = gif ? [] : [...(S.attachments.get(cid) || [])];
  if ((!text && !gif && !pending.length) || !S.connected) return;
  let files;
  if (pending.length) {
    if (S.uploading.has(cid)) return toast('Still uploading…'), false;
    const st = S.server.storage;
    const total = pending.reduce((n, a) => n + a.file.size, 0);
    if (st && total > st.max - st.used) return toast(`Not enough storage on this server (${fmtBytes(Math.max(0, st.max - st.used))} free)`, 'error'), false;
    S.uploading.add(cid);
    for (const a of pending) a.progress = 0;
    renderAttachTray();
    try {
      files = [];
      for (const a of pending) files.push((await uploadFile(a, cid)).id);
    } catch (err) {
      for (const a of pending) (a.progress = null), (a.xhr = null);
      renderAttachTray();
      if (err.message !== 'aborted') toast(err.message, 'error');
      return false;
    } finally {
      S.uploading.delete(cid);
    }
    for (const a of pending) a.preview && URL.revokeObjectURL(a.preview);
    S.attachments.set(cid, (S.attachments.get(cid) || []).filter((a) => !pending.includes(a)));
    renderAttachTray();
  }
  const res = await S.socket.emitWithAck('msg:send', { channelId: cid, text, gif, replyTo: S.replyTo?.id, files });
  if (res.error) toast(res.error, 'error');
  S.replyTo = null;
  lastTyping = 0;
  renderReplyBar();
}

function renderTyping() {
  const el = $('#typing');
  if (!el) return;
  const now = Date.now();
  const map = S.typing.get(S.channelId);
  const names = map ? [...map.values()].filter((t) => t.until > now).map((t) => t.name) : [];
  el.textContent = !names.length
    ? ''
    : names.length === 1
      ? `${names[0]} is typing…`
      : names.length < 4
        ? `${names.join(', ')} are typing…`
        : 'Several people are typing…';
}
setInterval(renderTyping, 1000);

// ---------------------------------------------------------------- files

const fileUrl = (f, download) => `${S.entry.address}/files/${f.id}/${encodeURIComponent(f.name)}${download ? '?download' : ''}`;
// Matches what the server serves inline (INLINE_TYPES in server.js)
const fileKind = (type = '') =>
  /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(type)
    ? 'image'
    : /^video\/(mp4|webm|ogg|quicktime)$/.test(type)
      ? 'video'
      : /^audio\/(mpeg|mp3|ogg|wav|x-wav|wave|webm|mp4|aac|flac|x-flac|x-m4a)$/.test(type)
        ? 'audio'
        : 'file';
const fileEmoji = (type = '') =>
  /^image\//.test(type) ? '🖼️' : /^video\//.test(type) ? '🎬' : /^audio\//.test(type) ? '🎵' : /zip|compressed|tar|rar|7z/.test(type) ? '🗜️' : /pdf/.test(type) ? '📕' : /^text\//.test(type) ? '📝' : '📄';

function downloadFile(f) {
  if (f.blobUrl) return h('a', { href: f.blobUrl, download: f.name }).click(); // a DM image, already on this device
  const url = fileUrl(f, true);
  if (desktop?.download) return desktop.download(url);
  h('a', { href: url, download: f.name }).click(); // the server answers with Content-Disposition: attachment
}

async function deleteFilesPrompt(files, skipConfirm) {
  if (!files.length) return;
  const what = files.length === 1 ? `"${files[0].name}"` : `${files.length} files`;
  if (!skipConfirm && !(await confirmModal('Delete file' + (files.length > 1 ? 's' : ''), `Permanently delete ${what} for everyone? This can't be undone.`))) return;
  await S.socket.emitWithAck('file:delete', { ids: files.map((f) => f.id) });
}

function addAttachments(files) {
  const cid = S.channelId;
  if (isDm(cid)) return addDmImages(files);
  if (!S.connected || !channelById(cid) || !files.length) return;
  if (S.uploading.has(cid)) return toast('Wait for the current upload to finish', 'error');
  if (!S.attachments.has(cid)) S.attachments.set(cid, []);
  const list = S.attachments.get(cid);
  for (const file of files) {
    if (list.length >= 10) {
      toast('Up to 10 files per message', 'error');
      break;
    }
    if (!file.size) {
      toast(`"${file.name}" is empty`, 'error');
      continue;
    }
    list.push({ key: uid(), file, preview: fileKind(file.type) === 'image' ? URL.createObjectURL(file) : null, progress: null, xhr: null });
  }
  renderAttachTray();
  $('#composer-input')?.focus();
}

// DMs carry images only, a few per message (D32)
function addDmImages(files) {
  const cid = S.channelId;
  if (!DM.canSendFiles(peerOf(cid))) return toast(`${profileOf(peerOf(cid)).name} needs to connect with a current friendspeak before you can send them images`, 'error');
  if (!S.attachments.has(cid)) S.attachments.set(cid, []);
  const list = S.attachments.get(cid);
  for (const file of files) {
    const error = list.length >= MAX_FILES ? `Up to ${MAX_FILES} images per message` : DM.fileError(file);
    if (error) {
      toast(error, 'error');
      if (list.length >= MAX_FILES) break;
      continue;
    }
    list.push({ key: uid(), file, preview: URL.createObjectURL(file), progress: null, xhr: null });
  }
  renderAttachTray();
  $('#composer-input')?.focus();
}

function renderAttachTray() {
  const tray = $('#attach-tray');
  if (!tray) return;
  const cid = S.channelId;
  const list = S.attachments.get(cid) || [];
  tray.hidden = !list.length;
  const st = isDm(cid) ? null : S.server?.storage;
  const total = list.reduce((n, a) => n + a.file.size, 0);
  tray.replaceChildren(
    ...list.map((a) => {
      a.bar = a.progress != null ? h('div', { style: { width: a.progress * 100 + '%' } }) : null;
      return h(
        'div',
        { class: 'attach-chip' + (a.progress != null ? ' uploading' : '') },
        a.preview ? h('img', { src: a.preview, alt: '' }) : h('span', { class: 'attach-icon' }, fileEmoji(a.file.type)),
        h('div', { class: 'attach-meta' }, h('span', { class: 'attach-name', title: a.file.name }, a.file.name), h('span', { class: 'muted small' }, fmtBytes(a.file.size))),
        a.bar ? h('div', { class: 'attach-progress' }, a.bar) : null,
        h(
          'button',
          {
            class: 'x',
            title: a.progress != null ? 'Cancel upload' : 'Remove',
            onclick: () => {
              a.xhr?.abort();
              if (a.preview) URL.revokeObjectURL(a.preview);
              S.attachments.set(cid, (S.attachments.get(cid) || []).filter((x) => x !== a));
              renderAttachTray();
            },
          },
          '×'
        )
      );
    }),
    ...(st && total > st.max - st.used ? [h('div', { class: 'attach-warn error-text small' }, `Too big: ${fmtBytes(Math.max(0, st.max - st.used))} of server storage left`)] : [])
  );
}

// Raw-body POST with progress. The socket id proves we passed `hello` (and the password).
function uploadFile(a, channelId) {
  return new Promise((resolve, reject) => {
    const xhr = (a.xhr = new XMLHttpRequest());
    xhr.open('POST', `${S.entry.address}/api/files?channelId=${encodeURIComponent(channelId)}`);
    xhr.setRequestHeader('x-friendspeak-sid', S.sid);
    xhr.setRequestHeader('x-file-name', encodeURIComponent(a.file.name));
    xhr.setRequestHeader('content-type', a.file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      a.progress = e.loaded / (e.total || a.file.size || 1);
      if (a.bar) a.bar.style.width = a.progress * 100 + '%';
    };
    xhr.onload = () => {
      let r;
      try {
        r = JSON.parse(xhr.responseText);
      } catch {
        r = { error: `Upload failed (HTTP ${xhr.status})` };
      }
      if (r.ok) resolve(r.file);
      else reject(new Error(r.error || `Upload failed (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error(`Upload of "${a.file.name}" failed (network error)`));
    xhr.onabort = () => reject(new Error('aborted'));
    xhr.send(a.file);
  });
}

function attachmentEl(f) {
  const url = fileUrl(f);
  const kind = fileKind(f.type);
  const del = h('button', { class: 'attach-del', title: 'Delete file (shift-click skips the prompt)', onclick: (e) => (e.stopPropagation(), deleteFilesPrompt([f], e.shiftKey)) }, icon('trash'));
  const card = () =>
    h(
      'div',
      { class: 'file-card' },
      h('span', { class: 'file-icon' }, fileEmoji(f.type)),
      h('div', { class: 'file-meta' }, h('a', { href: '#', class: 'file-name', title: f.name, onclick: (e) => (e.preventDefault(), downloadFile(f)) }, f.name), h('span', { class: 'muted small' }, fmtBytes(f.size))),
      h('button', { class: 'icon-btn', title: 'Download', onclick: () => downloadFile(f) }, icon('download'))
    );
  if (kind === 'image') return h('div', { class: 'attachment media' }, h('img', { src: url, alt: f.name, loading: 'lazy', onclick: () => lightbox(url, f) }), del);
  if (kind === 'video') return h('div', { class: 'attachment media' }, h('video', { src: url, controls: true, preload: 'metadata' }), del);
  if (kind === 'audio') return h('div', { class: 'attachment file' }, card(), h('audio', { src: url, controls: true, preload: 'metadata' }), del);
  return h('div', { class: 'attachment file' }, card(), del);
}

// An image in a DM: its thumbnail came with the message, and the image itself
// is fetched from the friend's device when you're both online
function dmAttachmentEl(m, f) {
  const peerId = peerOf(S.channelId);
  const scale = Math.min(1, 520 / f.w, 350 / f.h);
  const img = h('img', { src: f.thumb || null, alt: f.name, style: { aspectRatio: `${f.w} / ${f.h}`, width: Math.max(24, Math.round(f.w * scale)) + 'px', height: 'auto' } });
  const state = h('span', { class: 'dm-file-state' }, f.gone ? 'no longer available' : '');
  const el = h('div', { class: 'attachment media dm-file loading', 'data-file': f.id }, img, state);
  DM.fileUrl(peerId, f.id).then((url) => {
    if (!url) return;
    img.src = url;
    img.onclick = () => lightbox(url, { ...f, blobUrl: url });
    el.classList.remove('loading');
    state.remove();
  });
  return el;
}

function embedEl(e) {
  if (e.kind === 'image') return h('div', { class: 'embed' }, h('img', { src: e.url, loading: 'lazy', alt: '', onclick: () => lightbox(e.url) }));
  if (e.kind === 'video') return h('div', { class: 'embed' }, h('video', { src: e.url, controls: true, preload: 'metadata' }));
  if (e.kind === 'audio') return h('div', { class: 'embed' }, h('audio', { src: e.url, controls: true, preload: 'metadata' }));
  const frame = (src, style) =>
    h('iframe', {
      src,
      style,
      loading: 'lazy',
      allow: 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture',
      allowfullscreen: true,
      referrerpolicy: 'strict-origin-when-cross-origin',
    });
  if (e.kind === 'youtube') {
    // Click-to-play: YouTube's player is heavy, and this keeps it off until wanted
    const box = h(
      'div',
      {
        class: 'embed-video yt',
        title: 'Play',
        onclick: () => box.replaceChildren(frame(`https://www.youtube-nocookie.com/embed/${e.id}?autoplay=1${e.start ? '&start=' + e.start : ''}`)),
      },
      h('img', { src: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`, alt: '', loading: 'lazy' }),
      h('span', { class: 'play' }, '▶')
    );
    return h('div', { class: 'embed rich' }, h('div', { class: 'embed-provider' }, 'YouTube'), box);
  }
  return h(
    'div',
    { class: 'embed rich' },
    h('div', { class: 'embed-provider' }, e.provider),
    e.height ? frame(e.src, { height: e.height + 'px' }) : h('div', { class: 'embed-video', style: { aspectRatio: e.ratio } }, frame(e.src))
  );
}

function lightbox(url, f) {
  const close = () => (root.remove(), document.removeEventListener('keydown', onKey, true));
  // Capture phase, so Escape closes only the lightbox and not a modal under it
  const onKey = (e) => e.key === 'Escape' && (e.stopPropagation(), close());
  const root = h(
    'div',
    { class: 'lightbox', onclick: (e) => e.target === root && close() },
    h('img', { src: url, alt: f?.name || '' }),
    h(
      'div',
      { class: 'lightbox-bar' },
      f ? h('span', {}, f.name, ' · ', fmtBytes(f.size)) : null,
      f ? h('button', { class: 'btn small ghost', onclick: () => downloadFile(f) }, 'Download') : h('a', { class: 'btn small ghost', href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Open original'),
      h('button', { class: 'btn small ghost', onclick: close }, 'Close')
    )
  );
  document.addEventListener('keydown', onKey, true);
  $('#modal-root').append(root);
}

async function jumpToMessage(channelId, messageId) {
  await selectChannel(channelId);
  const find = () => $(`.msg[data-id="${messageId}"]`);
  // Page back through history until the message is loaded (≤500 are kept)
  for (let i = 0; i < 12 && !find() && S.hasMore.get(channelId) && S.channelId === channelId; i++) {
    const list = S.messages.get(channelId);
    const res = await S.socket.emitWithAck('msg:history', { channelId, before: list[0]?.id });
    const older = res.messages || [];
    S.hasMore.set(channelId, older.length >= 50);
    S.messages.set(channelId, [...older, ...list]);
    renderMessages(true);
  }
  const el = find();
  if (!el) return toast('That message is no longer in the chat history');
  el.scrollIntoView({ block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1600);
}

// TeamSpeak-style file browser: one channel or the whole server
let fileBrowser = null; // { reload } while open
function openFileBrowser(channelId = '') {
  const view = { scope: channelId, q: '', kind: '', sort: 'ts', desc: true, files: [], selected: new Set() };
  const textChannels = () => S.server.channels.filter((c) => c.type === 'text');
  const scopeSel = h(
    'select',
    { onchange: () => ((view.scope = scopeSel.value), view.selected.clear(), load()) },
    h('option', { value: '' }, 'All channels'),
    textChannels().map((c) => h('option', { value: c.id, selected: c.id === channelId }, '#' + c.name))
  );
  const kindSel = h(
    'select',
    { onchange: () => ((view.kind = kindSel.value), draw()) },
    [['', 'All types'], ['image', 'Images'], ['video', 'Videos'], ['audio', 'Audio'], ['file', 'Other files']].map(([v, l]) => h('option', { value: v }, l))
  );
  const search = h('input', { type: 'search', placeholder: 'Search by name or uploader', oninput: () => ((view.q = search.value.trim().toLowerCase()), draw()) });
  const usageBox = h('div', { class: 'storage' });
  const table = h('div', { class: 'file-table' });
  const bulk = h('div', { class: 'file-bulk' });

  const shown = () => {
    const list = view.files.filter(
      (f) => (!view.kind || fileKind(f.type) === view.kind) && (!view.q || f.name.toLowerCase().includes(view.q) || (profileOf(f.by, f.byName).name || '').toLowerCase().includes(view.q))
    );
    const key = { name: (f) => f.name.toLowerCase(), size: (f) => f.size, ts: (f) => f.ts, by: (f) => (profileOf(f.by, f.byName).name || '').toLowerCase() }[view.sort];
    return list.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * (view.desc ? -1 : 1));
  };
  const col = (label, sortKey, cls) =>
    h(
      'button',
      {
        class: 'file-col ' + cls + (view.sort === sortKey ? ' sorted' : ''),
        onclick: () => {
          view.desc = view.sort === sortKey ? !view.desc : sortKey !== 'name' && sortKey !== 'by';
          view.sort = sortKey;
          draw();
        },
      },
      label,
      view.sort === sortKey ? (view.desc ? ' ▾' : ' ▴') : ''
    );

  function draw() {
    const st = S.server.storage || { used: 0, max: 0 };
    const pct = st.max ? Math.min(100, (st.used / st.max) * 100) : 0;
    usageBox.replaceChildren(
      h('div', { class: 'storage-bar' + (pct > 90 ? ' full' : '') }, h('div', { style: { width: pct + '%' } })),
      h('span', { class: 'muted small' }, `${fmtBytes(st.used)} of ${fmtBytes(st.max)} used on this server`)
    );
    const list = shown();
    for (const fid of view.selected) if (!view.files.some((f) => f.id === fid)) view.selected.delete(fid);
    const sel = view.files.filter((f) => view.selected.has(f.id));
    const all = h('input', {
      type: 'checkbox',
      title: 'Select all',
      checked: list.length > 0 && list.every((f) => view.selected.has(f.id)),
      onchange: (e) => (list.forEach((f) => (e.target.checked ? view.selected.add(f.id) : view.selected.delete(f.id))), draw()),
    });
    bulk.replaceChildren(
      h('span', { class: 'muted small' }, `${list.length} file${list.length === 1 ? '' : 's'} · ${fmtBytes(list.reduce((n, f) => n + f.size, 0))}`),
      h('span', {}, sel.length ? h('button', { class: 'btn small danger', onclick: () => deleteFilesPrompt(sel) }, `Delete selected (${sel.length})`) : null)
    );
    const showChannel = !view.scope;
    table.classList.toggle('with-channel', showChannel);
    table.replaceChildren(
      h(
        'div',
        { class: 'file-row head' },
        h('span', { class: 'file-check' }, all),
        col('Name', 'name', 'c-name'),
        col('Size', 'size', 'c-size'),
        col('Uploaded by', 'by', 'c-by'),
        showChannel ? h('span', { class: 'file-col c-chan' }, 'Channel') : null,
        col('Date', 'ts', 'c-date'),
        h('span', { class: 'file-col c-act' })
      ),
      ...(list.length
        ? list.map((f) => {
            const kind = fileKind(f.type);
            const open = () => (kind === 'image' ? lightbox(fileUrl(f), f) : downloadFile(f));
            return h(
              'div',
              { class: 'file-row' + (view.selected.has(f.id) ? ' selected' : '') },
              h(
                'span',
                { class: 'file-check' },
                h('input', { type: 'checkbox', checked: view.selected.has(f.id), onchange: (e) => (e.target.checked ? view.selected.add(f.id) : view.selected.delete(f.id), draw()) })
              ),
              h(
                'span',
                { class: 'c-name', title: f.name },
                kind === 'image' ? h('img', { class: 'file-thumb', src: fileUrl(f), alt: '', loading: 'lazy' }) : h('span', { class: 'file-thumb' }, fileEmoji(f.type)),
                h('a', { href: '#', onclick: (e) => (e.preventDefault(), open()) }, f.name)
              ),
              h('span', { class: 'c-size muted' }, fmtBytes(f.size)),
              h('span', { class: 'c-by' }, profileOf(f.by, f.byName).name),
              showChannel ? h('span', { class: 'c-chan muted' }, '#' + (channelById(f.channelId)?.name || '?')) : null,
              h('span', { class: 'c-date muted', title: new Date(f.ts).toLocaleString() }, fmtTime(f.ts)),
              h(
                'span',
                { class: 'c-act' },
                h('button', { class: 'icon-btn', title: 'Show in chat', onclick: () => (close(), jumpToMessage(f.channelId, f.messageId)) }, icon('jump')),
                h('button', { class: 'icon-btn', title: 'Download', onclick: () => downloadFile(f) }, icon('download')),
                h('button', { class: 'icon-btn danger', title: 'Delete (shift-click skips the prompt)', onclick: (e) => deleteFilesPrompt([f], e.shiftKey) }, icon('trash'))
              )
            );
          })
        : [h('p', { class: 'muted small file-empty' }, view.files.length ? 'No files match.' : view.scope ? 'No files in this channel yet. Drop some into the chat!' : 'No files on this server yet.')])
    );
  }

  let seq = 0;
  async function load() {
    const n = ++seq;
    const r = await S.socket.emitWithAck('file:list', { channelId: view.scope });
    if (n !== seq || fileBrowser !== api) return;
    view.files = r.files || [];
    if (r.storage) S.server.storage = r.storage;
    draw();
  }

  const api = { reload: load };
  fileBrowser?.close?.();
  const close = modal(
    'Files',
    h('div', { class: 'file-browser' }, h('div', { class: 'file-toolbar' }, scopeSel, kindSel, search), usageBox, table, bulk),
    { wide: true, onClose: () => fileBrowser === api && (fileBrowser = null) }
  );
  api.close = close;
  fileBrowser = api;
  draw();
  load();
}

// ---------------------------------------------------------------- emoji picker

let picker;
function getPicker() {
  if (!picker) {
    picker = document.createElement('emoji-picker');
    picker.dataSource = '/vendor/emoji-data/en/emojibase/data.json';
  }
  const scheme = document.documentElement.dataset.scheme;
  picker.classList.toggle('dark', scheme !== 'light');
  picker.classList.toggle('light', scheme === 'light');
  updatePickerEmojis();
  return picker;
}

function updatePickerEmojis() {
  if (!picker) return;
  picker.customEmoji = (S.server?.emojis || []).map((e) => ({ name: e.name, shortcodes: [e.name], url: e.url, category: S.server.name }));
}

// mode 'react' reacts to messageId; 'insert' types into `target` (default: the composer)
function openEmojiPicker(anchor, { mode, messageId, target }) {
  const p = getPicker();
  const onPick = (e) => {
    const d = e.detail;
    const value = d.unicode || `:${d.name}:`;
    if (mode === 'react') {
      react(messageId, value);
      pop.close();
    } else {
      const ta = target || $('#composer-input');
      const s = ta.selectionStart ?? ta.value.length;
      const insert = d.unicode || target ? value : ` ${value} `;
      ta.value = ta.value.slice(0, s) + insert + ta.value.slice(ta.selectionEnd ?? s);
      ta.focus();
      ta.selectionStart = ta.selectionEnd = s + insert.length;
      ta.dispatchEvent(new Event('input'));
      if (!e.detail.shift) pop.close?.();
    }
  };
  p.addEventListener('emoji-click', onPick);
  const pop = popover(anchor, p, { className: 'emoji-pop', onClose: () => p.removeEventListener('emoji-click', onPick) });
  requestAnimationFrame(() => pop.place());
}

// ---------------------------------------------------------------- GIFs

async function searchGifs(q) {
  const key = settings.get().giphyKey;
  if (key) {
    const qs = new URLSearchParams({ api_key: key, limit: '30', rating: 'pg-13' });
    if (q) qs.set('q', q);
    const r = await fetch(`https://api.giphy.com/v1/gifs/${q ? 'search' : 'trending'}?${qs}`);
    const j = await r.json();
    if (!r.ok) throw new Error(j.message || j.meta?.msg || 'GIPHY error');
    return j.data;
  }
  if (!S.connected) throw new Error('nokey'); // the server's key is only reachable while connected
  const res = await S.socket.emitWithAck('gif:search', { q });
  if (res.error === 'nokey') throw new Error('nokey');
  if (res.error) throw new Error(res.error);
  return res.data;
}

// Pick a GIPHY GIF: sends it to the channel, or hands it to onPick (avatars, backgrounds, icons)
function openGifPicker(anchor, onPick) {
  const grid = h('div', { class: 'gif-grid' });
  // CSS columns overflow sideways when height-constrained, so the grid grows freely inside a vertical scroller
  const scroller = h('div', { class: 'gif-scroll' }, grid);
  let seq = 0;
  const run = async (q) => {
    const my = ++seq;
    grid.replaceChildren(h('div', { class: 'muted center' }, 'Loading…'));
    scroller.scrollTop = 0;
    try {
      const data = await searchGifs(q);
      if (my !== seq) return;
      if (!data.length) return grid.replaceChildren(h('div', { class: 'muted center' }, 'No GIFs found'));
      grid.replaceChildren(
        ...data.map((g) => {
          const full = g.images.fixed_height;
          const small = g.images.fixed_width_small || g.images.fixed_height_small || full;
          return h(
            'button',
            {
              class: 'gif-item',
              title: g.title,
              onclick: () => {
                const gif = { url: full.url, w: +full.width, h: +full.height, title: g.title };
                pop.close();
                if (onPick) onPick(gif);
                else sendMessage('', gif);
              },
            },
            h('img', { src: small.url, loading: 'lazy', alt: g.title })
          );
        })
      );
    } catch (e) {
      if (my !== seq) return;
      grid.replaceChildren(
        e.message === 'nokey'
          ? h(
              'div',
              { class: 'gif-nokey' },
              h('p', {}, 'GIFs need a free GIPHY API key.'),
              h('p', { class: 'muted small' }, 'Get one at developers.giphy.com, then paste it in Settings → Integrations (or the server host can set GIPHY_API_KEY).'),
              onPick ? null : h('button', { class: 'btn small', onclick: () => (pop.close(), openSettings('integrations')) }, 'Open settings')
            )
          : h('div', { class: 'error-text center' }, e.message)
      );
    }
  };
  let t;
  const input = h('input', { class: 'gif-search', placeholder: 'Search GIPHY', oninput: (e) => (clearTimeout(t), (t = setTimeout(() => run(e.target.value.trim()), 300))) });
  const pop = popover(anchor, h('div', { class: 'gif-picker' }, input, scroller, h('div', { class: 'giphy-attr' }, 'Powered by GIPHY')), { className: 'gif-pop' });
  input.focus();
  run('');
}

// ---------------------------------------------------------------- soundboard

async function loadSounds() {
  S.sounds = await sounds.all();
  syncHotkeys();
}

// Desktop app: soundboard, mute and deafen hotkeys registered as global shortcuts
function syncHotkeys() {
  const st = settings.get();
  desktop?.setHotkeys([st.muteHotkey, st.deafenHotkey, ...S.sounds.map((s) => s.hotkey)].filter(Boolean));
}

// The same toggles as the buttons in the user panel
function voiceHotkey(combo) {
  const st = settings.get();
  if (combo === st.muteHotkey) toggleMute();
  else if (combo === st.deafenHotkey) toggleDeafen();
  else return false;
  return true;
}

desktop?.onHotkey((combo) => {
  if (voiceHotkey(combo)) return;
  const s = S.sounds.find((x) => x.hotkey === combo);
  if (!s) return;
  audio.ensure();
  playSound(s);
});

audio.onPlayingChange = () => {
  for (const el of $$('.sound-tile')) el.classList.toggle('playing', audio.isPlaying(el.dataset.id));
};

async function playSound(sound) {
  try {
    await audio.play(sound);
  } catch (e) {
    toast(`Can't play "${sound.name}": ${e.message}`, 'error');
  }
}

async function addSoundFiles(files) {
  let added = 0;
  for (const f of files) {
    if (!f.type.startsWith('audio/') && !/\.(mp3|wav|ogg|m4a|aac|flac|webm|opus)$/i.test(f.name)) continue;
    if (f.size > 10 * 1024 * 1024) {
      toast(`${f.name} is over 10MB`, 'error');
      continue;
    }
    await sounds.add(f);
    added++;
  }
  await loadSounds();
  if (added) toast(`Added ${added} sound${added > 1 ? 's' : ''}`);
}

function openSoundboard(anchor) {
  const grid = h('div', { class: 'sound-grid' });
  const fileInput = h('input', {
    type: 'file',
    accept: 'audio/*',
    multiple: true,
    hidden: true,
    onchange: async () => {
      await addSoundFiles([...fileInput.files]);
      fileInput.value = '';
      draw();
    },
  });
  const draw = () => {
    grid.replaceChildren(
      ...S.sounds.map((s) =>
        h(
          'div',
          {
            class: 'sound-tile' + (audio.isPlaying(s.id) ? ' playing' : ''),
            'data-id': s.id,
            onclick: () => playSound(s),
            oncontextmenu: (e) => (e.preventDefault(), editSound(s, draw)),
            title: `${s.name}${s.hotkey ? ` (${s.hotkey})` : ''}\nRight-click to edit`,
          },
          h('div', { class: 'sound-emoji' }, s.emoji || '🔊'),
          h('div', { class: 'sound-name' }, s.name),
          s.hotkey ? h('div', { class: 'sound-key' }, s.hotkey) : null,
          h('button', { class: 'sound-edit', title: 'Edit', onclick: (e) => (e.stopPropagation(), editSound(s, draw)) }, icon('edit'))
        )
      ),
      h('button', { class: 'sound-tile add', onclick: () => fileInput.click() }, h('div', { class: 'sound-emoji' }, '＋'), h('div', { class: 'sound-name' }, 'Add sounds'))
    );
  };
  draw();
  const vol = h('input', {
    type: 'range',
    min: 0,
    max: 1,
    step: 0.01,
    value: settings.get().soundboardVolume,
    oninput: (e) => {
      settings.set({ soundboardVolume: +e.target.value });
      audio.setSoundboardVolume(+e.target.value);
    },
  });
  const panel = h(
    'div',
    {
      class: 'soundboard',
      ondragover: (e) => (e.preventDefault(), panel.classList.add('drop')),
      ondragleave: () => panel.classList.remove('drop'),
      ondrop: async (e) => {
        e.preventDefault();
        panel.classList.remove('drop');
        await addSoundFiles([...e.dataTransfer.files]);
        draw();
      },
    },
    h(
      'div',
      { class: 'sb-head' },
      h('strong', {}, 'Soundboard'),
      h('div', { class: 'spacer' }),
      h('label', { class: 'sb-vol', title: 'Soundboard volume' }, icon('speaker'), vol),
      h('button', { class: 'icon-btn', title: 'Stop all sounds', onclick: () => audio.stopAll() }, icon('stop'))
    ),
    grid,
    h(
      'div',
      { class: 'muted small sb-hint' },
      DMCALL.voice ? 'Your friend in the call hears these.' : S.voiceChannel ? 'Everyone in your voice channel hears these.' : 'Join a voice channel so friends hear these. ',
      ' Drop audio files here • right-click a sound to edit or set a hotkey.'
    ),
    fileInput
  );
  audio.ensure();
  popover(anchor, panel, { className: 'sb-pop', align: 'start' });
}

function editSound(s, redraw) {
  const draft = { ...s };
  const keyBtn = h('button', { class: 'btn ghost small hotkey-btn' }, draft.hotkey || 'Click to set');
  keyBtn.onclick = () => {
    keyBtn.textContent = 'Press a key… (Esc clears)';
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') draft.hotkey = '';
      else {
        const c = comboFromEvent(e);
        if (!c) return;
        draft.hotkey = c;
      }
      keyBtn.textContent = draft.hotkey || 'Click to set';
      window.removeEventListener('keydown', onKey, true);
    };
    window.addEventListener('keydown', onKey, true);
  };
  const volLabel = h('span', {}, Math.round(draft.volume * 100) + '%');
  const close = modal(
    'Edit sound',
    h(
      'div',
      {},
      h(
        'div',
        { class: 'row' },
        h('label', { class: 'field', style: { width: '80px' } }, h('span', {}, 'Emoji'), h('input', { value: draft.emoji, oninput: (e) => (draft.emoji = [...e.target.value.trim()].slice(0, 2).join('')) })),
        h('label', { class: 'field grow' }, h('span', {}, 'Name'), h('input', { value: draft.name, maxlength: 40, oninput: (e) => (draft.name = e.target.value) }))
      ),
      h(
        'label',
        { class: 'field' },
        h('span', {}, 'Volume ', volLabel),
        h('input', { type: 'range', min: 0, max: 2, step: 0.05, value: draft.volume, oninput: (e) => ((draft.volume = +e.target.value), (volLabel.textContent = Math.round(draft.volume * 100) + '%')) })
      ),
      h('div', { class: 'field' }, h('span', {}, 'Hotkey'), keyBtn),
      h(
        'p',
        { class: 'muted small' },
        desktop
          ? 'Hotkeys with Ctrl/Alt/Cmd, F-keys or the numpad work even while other apps are focused.'
          : 'Hotkeys work while friendspeak is the focused window (or the desktop app, from anywhere).'
      )
    ),
    {
      actions: [
        h(
          'button',
          {
            class: 'btn danger ghost',
            onclick: async () => {
              await sounds.remove(s.id);
              audio.forget(s.id);
              await loadSounds();
              close();
              redraw?.();
            },
          },
          'Delete'
        ),
        h('button', { class: 'btn ghost', onclick: () => playSound(draft) }, 'Preview'),
        h(
          'button',
          {
            class: 'btn',
            onclick: async () => {
              await sounds.put({ ...draft, name: draft.name.trim() || s.name });
              await loadSounds();
              close();
              redraw?.();
            },
          },
          'Save'
        ),
      ],
    }
  );
}

// ---------------------------------------------------------------- screen sharing

// Pick what to share. Browsers show their own picker after this (we hint which
// tab it opens on); the desktop app has none, so we list sources ourselves.
function sharePopover(anchor) {
  popover(
    anchor,
    h(
      'div',
      { class: 'menu' },
      h('button', { class: 'menu-item', onclick: () => (closePopover(), screenPicker({ switching: true })) }, 'Change source'),
      h('button', { class: 'menu-item danger', onclick: () => (closePopover(), liveVoice()?.stopMedia('screen')) }, 'Stop sharing')
    ),
    { align: 'right' }
  );
}

// `switching`: pick a new source for the share that's already live, without
// ending it (viewers keep watching; see VoiceClient.replaceMedia).
async function screenPicker({ switching = false } = {}) {
  if (!liveVoice()) return;
  if (switching && !liveVoice().local.screen) return;
  const share = (opts) => (switching ? switchShare(opts) : startShare(opts));
  const heading = switching ? 'Change what you share' : 'Share your screen';
  if (!navigator.mediaDevices?.getDisplayMedia) return toast('Screen sharing needs a secure page (localhost, HTTPS or the desktop app).', 'error', 6000);
  let withAudio = true;
  const audioBox = (label) =>
    h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => (withAudio = e.target.checked) }), label);
  const quality = h('p', { class: 'muted small' }, `Streams up to ${SCREEN.height >= 2160 ? '4K' : SCREEN.height + 'p'} at ${SCREEN.fps} fps.` + (DMCALL.voice ? '' : ' Only people who click LIVE receive it.'));

  if (!desktop) {
    const choice = (surface, ic, label, sub) =>
      h('button', { class: 'share-choice', onclick: () => (close(), share({ surface, withAudio })) }, icon(ic), h('strong', {}, label), h('span', { class: 'muted small' }, sub));
    const close = modal(
      heading,
      h(
        'div',
        {},
        h('div', { class: 'share-choices' }, choice('monitor', 'screen', 'Entire screen', 'A whole display'), choice('window', 'window', 'Window', 'One app window')),
        audioBox('Share audio'),
        h('p', { class: 'muted small' }, 'Your browser asks which screen or window next. Chrome and Edge can share system audio on Windows and window audio on recent macOS; other browsers may send video only.'),
        quality
      )
    );
    return;
  }

  let info;
  try {
    info = await desktop.screenSources();
  } catch (e) {
    return toast('Could not list screens: ' + e.message, 'error');
  }
  let tab = 'screen';
  let selected = null;
  const grid = h('div', { class: 'share-grid' });
  const tabs = h('div', { class: 'share-tabs' });
  const go = h('button', { class: 'btn', disabled: true, onclick: () => (close(), share({ sourceId: selected, withAudio: withAudio && info.systemAudio })) }, switching ? 'Switch' : 'Go Live');
  const draw = () => {
    tabs.replaceChildren(
      ...[
        ['screen', 'Screens'],
        ['window', 'Windows'],
      ].map(([k, label]) => h('button', { class: k === tab ? 'active' : '', onclick: () => ((tab = k), draw()) }, label))
    );
    const list = info.sources.filter((s) => s.type === tab);
    grid.replaceChildren(
      ...(list.length
        ? list.map((s) =>
            h(
              'button',
              {
                class: 'share-source' + (s.id === selected ? ' selected' : ''),
                title: s.name,
                onclick: () => ((selected = s.id), (go.disabled = false), draw()),
                ondblclick: () => ((selected = s.id), go.click()),
              },
              s.thumbnail ? h('img', { src: s.thumbnail, alt: '' }) : h('div', { class: 'share-thumb-empty' }, icon(tab === 'screen' ? 'screen' : 'window')),
              h('span', { class: 'share-name' }, s.icon ? h('img', { src: s.icon, alt: '' }) : null, s.name)
            )
          )
        : [h('p', { class: 'muted' }, tab === 'window' ? 'No windows found.' : 'No screens found.')])
    );
  };
  draw();
  const close = modal(
    heading,
    h(
      'div',
      {},
      info.status !== 'granted'
        ? h('p', { class: 'error-text small' }, 'friendspeak needs Screen Recording permission: System Settings → Privacy & Security → Screen & System Audio Recording. Restart the app after allowing it.')
        : null,
      tabs,
      grid,
      info.systemAudio ? audioBox('Share system audio') : h('p', { class: 'muted small' }, 'System audio sharing isn’t supported on this OS; video only.'),
      quality
    ),
    { wide: true, actions: [h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'), go] }
  );
}

// Ask for the screen or window; null when cancelled or failed (after a toast).
async function captureScreen({ surface, sourceId, withAudio }) {
  const video = {
    width: { ideal: SCREEN.width, max: SCREEN.width },
    height: { ideal: SCREEN.height, max: SCREEN.height },
    frameRate: { ideal: SCREEN.fps, max: SCREEN.fps },
    ...(surface ? { displaySurface: surface } : {}),
  };
  // Raw audio: voice processing would mangle music and game sound.
  // restrictOwnAudio keeps friends' voices (played by this page) out of the share.
  const shareAudio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false, restrictOwnAudio: true };
  const capture = async (audioOn) => {
    await desktop?.pickScreenSource({ id: sourceId, audio: audioOn });
    return navigator.mediaDevices.getDisplayMedia({
      video,
      audio: audioOn ? shareAudio : false,
      systemAudio: 'include',
      windowAudio: 'window',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      monitorTypeSurfaces: 'include',
    });
  };
  let stream;
  const fail = (e) => (toast('Could not share screen: ' + e.message, 'error'), null);
  try {
    stream = await capture(withAudio);
  } catch (e) {
    // In a browser this is almost always "cancelled in the picker"
    if (!desktop) return e.name === 'NotAllowedError' ? null : fail(e);
    if (!withAudio) return fail(e);
    try {
      stream = await capture(false); // system audio capture unsupported here; try video only
      toast('Couldn’t capture system audio here, so you’re sharing video only.', 'error', 6000);
    } catch (e2) {
      return fail(e2);
    }
  }
  if (!liveVoice()) return stream.getTracks().forEach((t) => t.stop()), null; // left voice meanwhile
  if (withAudio && !stream.getAudioTracks().length) toast('This source has no shareable audio, so you’re sharing video only.', 'info', 5000);
  return stream;
}

async function startShare(opts) {
  const stream = await captureScreen(opts);
  if (!stream) return;
  liveVoice().setMedia('screen', stream);
  audio.cue('join');
  renderVoicePanel();
}

async function switchShare(opts) {
  const stream = await captureScreen(opts);
  if (!stream) return;
  const v = liveVoice();
  await v.replaceMedia('screen', stream); // starts a new share if it ended while the picker was open
  reattachOwn(v, 'screen');
  renderVoicePanel();
  toast('Switched what you’re sharing', 'info', 3000);
}

// After replaceMedia our own preview keeps the same MediaStream object; reattach so it shows the new tracks
function reattachOwn(v, kind) {
  const own = v === DMCALL.voice ? dmCallUi.tiles.get(kind + ':' + me().id) : S.stage?.tiles.get(kind + ':' + S.call?.sid);
  if (!own?.video) return;
  own.video.srcObject = null;
  own.video.srcObject = v.local[kind];
  own.video.play().catch(() => {});
}

// ---------------------------------------------------------------- camera

// The camera with the chosen background (D35), or null after telling the user why not
async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) return toast('The camera needs a secure page (localhost, HTTPS or the desktop app).', 'error', 6000), null;
  const dev = settings.get().videoDevice;
  const cam = MEDIA.camera;
  const capture = (effect) => {
    const ideal = effect ? CAPTURE : cam.ideal;
    return navigator.mediaDevices.getUserMedia({
      audio: false, // your voice already carries the audio
      video: {
        deviceId: dev ? { ideal: dev } : undefined,
        width: { ideal: ideal.width, max: cam.width },
        height: { ideal: ideal.height, max: cam.height },
        frameRate: { ideal: ideal.fps, max: effect ? ideal.fps : cam.fps },
      },
    });
  };
  const bg = await loadBackground();
  setBackground(bg);
  try {
    const raw = await capture(!!BACKGROUNDS[bg.type]);
    try {
      return await withBackground(raw);
    } catch (e) {
      // Better a plain camera than none
      console.warn('camera background', e);
      toast('The camera background isn’t available: ' + e.message, 'error', 6000);
      raw.getTracks().forEach((t) => t.stop());
      setBackground({ ...bg, type: 'none' });
      return await capture(false);
    }
  } catch (e) {
    return toast(e.name === 'NotFoundError' ? 'No camera found.' : 'Could not start camera: ' + e.message, 'error', 6000), null;
  }
}

// Put the camera on the call: `stream` from the preview, or a new capture
async function startCamera(stream) {
  stream ||= liveVoice() && (await openCamera());
  if (!stream) return;
  if (!liveVoice()) return stream.getTracks().forEach((t) => t.stop());
  liveVoice().setMedia('camera', stream);
  renderVoicePanel();
}

// Off → on always goes through the preview (cameraDialog)
function toggleCamera() {
  if (!liveVoice()) return;
  if (liveVoice().local.camera) return liveVoice().stopMedia('camera');
  cameraDialog();
}

// Change the camera background (settings keys), also mid-call. Strength, the
// picture, and blur ↔ picture apply to a running camera at once. Going to or
// from no background needs a new capture (a plain camera has no pipeline, and
// is captured larger): the live camera's is swapped in without ending it for
// viewers. Resolves to true when the capture had to change, so a preview can
// reopen its own.
let cameraSwap = Promise.resolve();
function setCameraBackground(patch) {
  settings.set(patch);
  return (cameraSwap = cameraSwap
    .then(async () => {
      const was = !!BACKGROUNDS[activeBackground().type];
      const bg = await loadBackground();
      setBackground(bg);
      if (was === !!BACKGROUNDS[bg.type]) return false;
      const v = liveVoice();
      if (!v?.local.camera) return true;
      const stream = await openCamera();
      if (!stream) return true;
      if (liveVoice() !== v || !v.local.camera) return stream.getTracks().forEach((t) => t.stop()), true;
      await v.replaceMedia('camera', stream);
      reattachOwn(v, 'camera');
      return true;
    })
    .catch((e) => (console.warn('camera background', e), true)));
}

// A mirrored view of your camera as friends will get it: the live camera
// while it's on, otherwise a capture of its own.
function cameraPreview() {
  const video = h('video', { muted: true, playsinline: true });
  const status = h('div', { class: 'cam-status' });
  const el = h('div', { class: 'cam-preview' }, video, status);
  let own = null;
  let run = 0;
  const release = () => {
    own?.getTracks().forEach((t) => t.stop());
    own = null;
  };
  return {
    el,
    // (Re)open; call again after anything that changes the capture
    async show() {
      const mine = ++run;
      release();
      status.textContent = 'Starting camera…';
      status.hidden = false;
      const live = liveVoice()?.local.camera;
      const stream = live || (await openCamera());
      if (mine !== run) return void (!live && stream?.getTracks().forEach((t) => t.stop()));
      if (!live) own = stream;
      video.srcObject = null;
      video.srcObject = stream;
      if (!stream) return void (status.textContent = 'No camera');
      video.play().catch(() => {});
      status.hidden = true;
    },
    stop() {
      run++;
      release();
      video.srcObject = null;
    },
    // Hand over the preview's own capture (null if it has none, e.g. still starting)
    take() {
      run++;
      const stream = own;
      own = null;
      return stream;
    },
  };
}

// Tiles to choose what is behind you: nothing, a blur (with its strength), a
// picture that comes with the app, or one of your own. `onRecapture` runs
// when the choice changed the capture (see setCameraBackground).
function backgroundPicker(onRecapture) {
  const grid = h('div', { class: 'bg-grid' });
  const pct = h('span', {});
  const range = h('input', { type: 'range', min: 0, max: 1, step: 0.01, oninput: (e) => (setCameraBackground({ cameraBlur: +e.target.value }), (pct.textContent = Math.round(e.target.value * 100) + '%')) });
  const blurField = h('label', { class: 'field' }, h('span', {}, 'Blur strength ', pct), range);
  const file = h('input', {
    type: 'file',
    accept: 'image/*',
    hidden: true,
    onchange: async () => {
      const f = file.files[0];
      file.value = '';
      if (!f) return;
      try {
        const pic = await pictures.add(f);
        choose({ cameraBackground: 'image', cameraImage: pic.id });
      } catch (e) {
        toast(e.message, 'error', 5000);
      }
    },
  });
  let urls = [];
  let disposed = false;
  const choose = async (patch) => {
    const swap = setCameraBackground(patch);
    render();
    if (await swap) onRecapture?.();
  };
  const tile = (name, selected, onclick, { cls = '', image = '', children = [] } = {}) =>
    h(
      'div',
      { class: 'bg-tile ' + cls + (selected ? ' selected' : ''), role: 'button', tabindex: 0, title: name, style: image ? { backgroundImage: image } : null, onclick, onkeydown: (e) => e.key === 'Enter' && onclick() },
      children,
      h('span', { class: 'bg-name' }, name)
    );
  const render = async () => {
    const pics = await pictures.all().catch(() => []);
    if (disposed) return;
    const bg = backgroundOf();
    const on = (id) => bg.type === 'image' && bg.imageId === id;
    for (const u of urls) URL.revokeObjectURL(u);
    urls = pics.map((p) => URL.createObjectURL(p.blob));
    grid.replaceChildren(
      tile('None', bg.type === 'none', () => choose({ cameraBackground: 'none' }), { cls: 'plain', children: icon('camOff') }),
      tile('Blur', bg.type === 'blur', () => choose({ cameraBackground: 'blur' }), { cls: 'blur' }),
      ...PRESETS.map((p) => tile(p.name, on(p.id), () => choose({ cameraBackground: 'image', cameraImage: p.id }), { image: presetCss(p) })),
      ...pics.map((p, i) =>
        tile(p.name || 'Picture', on(p.id), () => choose({ cameraBackground: 'image', cameraImage: p.id }), {
          image: `url("${urls[i]}")`,
          children: h(
            'button',
            {
              class: 'bg-remove',
              title: 'Remove this picture',
              onclick: async (e) => {
                e.stopPropagation();
                await pictures.remove(p.id);
                if (on(p.id)) choose({ cameraBackground: 'none', cameraImage: '' });
                else render();
              },
            },
            '×'
          ),
        })
      ),
      tile('Add a picture', false, () => file.click(), { cls: 'plain add', children: icon('plus') })
    );
    blurField.hidden = bg.type !== 'blur';
    range.value = bg.blur;
    pct.textContent = Math.round(bg.blur * 100) + '%';
  };
  render();
  return {
    el: h('div', { class: 'bg-picker' }, grid, blurField, file),
    dispose() {
      disposed = true;
      for (const u of urls) URL.revokeObjectURL(u);
    },
  };
}

// See yourself and choose what is behind you. Opens every time before the
// camera goes on. Opened while it is on, it shows and changes the live camera.
function cameraDialog() {
  const live = !!liveVoice()?.local.camera;
  const preview = cameraPreview();
  const picker = backgroundPicker(() => preview.show());
  modal(
    live ? 'Camera' : 'Camera preview',
    h(
      'div',
      { class: 'cam-dialog' },
      preview.el,
      h('div', { class: 'field' }, h('span', {}, 'Background'), picker.el),
      h('p', { class: 'muted small' }, 'Your background is replaced on this device, before the camera reaches anyone.')
    ),
    {
      actions: live
        ? [(close) => h('button', { class: 'btn', onclick: close }, 'Done')]
        : [
            (close) => h('button', { class: 'btn ghost', onclick: close }, 'Cancel'),
            (close) =>
              h(
                'button',
                {
                  class: 'btn',
                  onclick: () => {
                    const stream = preview.take();
                    close();
                    startCamera(stream);
                  },
                },
                'Turn on camera'
              ),
          ],
      onClose: () => {
        preview.stop();
        picker.dispose();
      },
    }
  );
  preview.show();
}

async function cameraPopover(anchor) {
  const devs = (await navigator.mediaDevices?.enumerateDevices().catch(() => [])) || [];
  const cams = devs.filter((d) => d.kind === 'videoinput');
  const cur = settings.get().videoDevice;
  const pick = async (id) => {
    closePopover();
    settings.set({ videoDevice: id });
    if (liveVoice()?.local.camera) {
      liveVoice().stopMedia('camera', true);
      await startCamera();
    }
  };
  popover(
    anchor,
    h(
      'div',
      { class: 'menu' },
      cams.length
        ? [{ deviceId: '', label: 'Default camera' }, ...cams].map((d, i) =>
            h('button', { class: 'menu-item' + (d.deviceId === cur ? ' active' : ''), onclick: () => pick(d.deviceId) }, (d.deviceId === cur ? '✓ ' : '') + (d.label || `Camera ${i}`))
          )
        : h('div', { class: 'muted small', style: { padding: '8px' } }, 'No cameras found'),
      h('div', { class: 'menu-sep' }),
      h('button', { class: 'menu-item', onclick: () => (closePopover(), cameraDialog()) }, 'Preview and background…')
    ),
    { align: 'right' }
  );
}

// ---------------------------------------------------------------- video stage

// Discord-style view of your voice channel. In grid mode everyone in the
// channel gets a tile (their camera, or their avatar while it's off) and every
// screen share gets one too. Click a tile to focus it (large, the rest in a
// strip below); click it again for the grid. Cameras are watched while the
// stage is open. Screen shares stay opt-in per viewer (D22): one you haven't
// opened is a "Watch stream" card, and you can watch several at once.
function openStage({ screen } = {}) {
  if (!S.voiceChannel) return;
  if (!S.stage) {
    showGame(false);
    const title = h('span', { class: 'chat-title' });
    const stats = h('span', { class: 'muted small stream-stats' });
    const controls = h('div', { class: 'stage-controls' });
    const main = h('div', { class: 'stage-main' });
    const grid = h('div', { class: 'stage-grid' });
    const body = h('div', { class: 'stage' }, main, grid);
    const toggleFullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : body.requestFullscreen?.().catch(() => {}));
    // tiles: key ("screen:<sid>", "camera:<sid>", "user:<sid>") -> tile; watching: sids of screens we receive
    S.stage = { tiles: new Map(), watching: new Set(), volumes: new Map(), focus: null, title, stats, controls, main, grid, body };
    S.stage.ro = new ResizeObserver(() => layoutStage());
    S.stage.ro.observe(grid);
    // Resolution, real frame rate and codec of the focused (or first) screen
    // share, so people can see what they are getting (and the sharer sees what
    // each viewer gets)
    let frames = 0;
    let last = null;
    S.stage.timer = setInterval(async () => {
      const tile = statsTile();
      const v = tile?.video;
      const total = v?.getVideoPlaybackQuality?.().totalVideoFrames || 0;
      const fps = tile === last ? Math.max(0, total - frames) : 0;
      frames = total;
      last = tile;
      const base = v?.videoWidth ? `${v.videoWidth}×${v.videoHeight} · ${fps} fps` : '';
      const info = tile && (await S.voice?.videoStats(tile.sid, 'screen').catch(() => null));
      if (statsTile() !== tile) return;
      const full = base && [base, formatVideoStats(info)].filter(Boolean).join(' · ');
      stats.textContent = full;
      stats.title = full;
    }, 1000);
    $('#stream-view').replaceChildren(
      h(
        'header',
        { class: 'chat-header' },
        icon('cam'),
        title,
        stats,
        h('div', { class: 'spacer' }),
        controls,
        h('button', { class: 'icon-btn', title: 'Fullscreen', onclick: toggleFullscreen }, icon('expand')),
        h('button', { class: 'btn small ghost', onclick: () => closeStage() }, 'Close')
      ),
      body
    );
    document.body.classList.add('stream-visible');
  }
  if (screen) {
    watchScreen(screen, true, false);
    S.stage.focus = 'screen:' + screen;
  }
  syncStage();
  renderChannels();
}

// The channel list's video icon: join the channel if needed, then show the
// stage in grid mode (nothing focused)
async function openVideoGrid(channelId) {
  if (!inCall(channelId)) await joinVoice(channelId);
  if (!inCall(channelId)) return;
  openStage();
  if (S.stage?.focus) setStageFocus(S.stage.focus);
}

function statsTile() {
  const st = S.stage;
  if (!st) return null;
  const focused = st.tiles.get(st.focus);
  if (focused?.kind === 'screen') return focused.live ? focused : null;
  return [...st.tiles.values()].find((t) => t.kind === 'screen' && t.live) || null;
}

// Start or stop receiving someone's screen share (our own is always shown).
function watchScreen(sid, on = true, sync = true) {
  const st = S.stage;
  if (!st || sid === S.call?.sid || on === st.watching.has(sid)) return;
  if (on) st.watching.add(sid);
  else st.watching.delete(sid);
  S.voice?.watch(sid, 'screen', on);
  if (!on && st.focus === 'screen:' + sid) st.focus = null;
  if (sync) {
    syncStage();
    renderChannels();
  }
}

function setStageFocus(key) {
  const st = S.stage;
  if (!st) return;
  st.focus = st.focus === key ? null : key;
  syncStage();
}

// kind: 'screen' (live video, or a "Watch stream" card), 'camera' or 'user' (avatar)
function stageTile(key, sid, kind, live) {
  const u = S.call.users.find((x) => x.sid === sid);
  const mine = sid === S.call.sid;
  const name = u?.name || 'someone';
  const tile = { key, sid, kind, live, el: null, video: null, status: null };
  // A single click focuses; wait a moment so a double click can go fullscreen instead
  let clickTimer;
  const attrs = {
    class: 'tile ' + kind + (mine && kind === 'camera' ? ' mirror' : '') + (kind === 'screen' && !live ? ' card' : ''),
    onclick: () => {
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => setStageFocus(key), 220);
    },
    ondblclick: () => {
      clearTimeout(clickTimer);
      if (tile.video) document.fullscreenElement ? document.exitFullscreen() : tile.el.requestFullscreen?.().catch(() => {});
    },
  };
  if (kind !== 'screen') attrs['data-sid'] = sid; // speaking outline
  const label = h('span', { class: 'tile-name' }, name + (kind === 'screen' ? '’s screen' : ''), kind === 'screen' ? h('span', { class: 'live-badge' }, 'LIVE') : null);

  if (kind === 'user') {
    tile.el = h('div', attrs, avatarEl(u, 80), label);
    return tile;
  }
  if (kind === 'screen' && !live) {
    const watch = h('button', { class: 'btn small', onclick: (e) => (e.stopPropagation(), watchScreen(sid, true)) }, 'Watch stream');
    tile.el = h('div', attrs, avatarEl(u, 56), h('div', { class: 'tile-card-text' }, `${name} is streaming`), watch, label);
    return tile;
  }

  const video = h('video', { autoplay: true, playsinline: true, muted: true });
  video.muted = true;
  tile.video = video;
  tile.status = h('div', { class: 'stream-status' }, kind === 'screen' ? 'Connecting to stream…' : 'Connecting…');
  const extras = [];
  if (kind === 'screen' && !mine) {
    const out = settings.get().outputDevice;
    if (out && video.setSinkId) video.setSinkId(out).catch(() => {});
    const stop = (e) => e.stopPropagation();
    extras.push(
      h(
        'div',
        { class: 'tile-controls', onclick: stop, ondblclick: stop },
        h(
          'label',
          { class: 'stream-volume', title: 'Stream volume' },
          icon('speaker'),
          h('input', {
            type: 'range',
            min: 0,
            max: 1,
            step: 0.01,
            value: S.stage.volumes.get(sid) ?? 1,
            oninput: (e) => (S.stage.volumes.set(sid, +e.target.value), (video.volume = streamVolume(+e.target.value))),
          })
        ),
        h('button', { class: 'btn small ghost', onclick: () => watchScreen(sid, false) }, 'Stop watching')
      )
    );
  }
  tile.el = h('div', attrs, video, tile.status, label, ...extras);
  if (!mine) {
    // Tell the sender how many device pixels we show, so their encoder for us
    // is no bigger than that (and pauses while this window is hidden).
    let timer;
    tile.report = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!video.isConnected) return;
        const dpr = devicePixelRatio || 1;
        const w = video.clientWidth * dpr;
        const h = video.clientHeight * dpr;
        if (w && h) S.voice?.view(sid, kind, { w, h, hidden: document.hidden });
        else if (document.hidden) S.voice?.view(sid, kind, { hidden: true });
      }, 300);
    };
    tile.ro = new ResizeObserver(tile.report);
    tile.ro.observe(video);
  }
  if (kind === 'camera' && !mine) S.voice?.watch(sid, 'camera', true);
  return tile;
}

function dropTile(key) {
  const st = S.stage;
  const tile = st?.tiles.get(key);
  if (!tile) return;
  st.tiles.delete(key);
  if (tile.kind === 'camera' && tile.sid !== S.call?.sid && S.call?.connected) S.voice.watch(tile.sid, 'camera', false);
  if (tile.video) tile.video.srcObject = null;
  tile.ro?.disconnect();
  tile.el.remove();
}

document.addEventListener('visibilitychange', () => {
  if (!S.stage) return;
  for (const t of S.stage.tiles.values()) t.report?.();
});

// "H264 (hardware)" for a stream we receive; one entry per viewer for our own
function formatVideoStats(info) {
  if (!info) return '';
  const hw = (x) => (x === true ? ' (hardware)' : x === false ? ' (software)' : '');
  if (!Array.isArray(info)) return info.codec + hw(info.hw);
  if (!info.length) return 'no viewers yet';
  return info
    .map((v) =>
      v.paused
        ? 'viewer away (paused)'
        : `${v.codec}${hw(v.hw)} ${v.w || 0}×${v.h || 0}@${v.fps || 0} ${(v.mbps || 0).toFixed(1)} Mbps` + (v.limit && v.limit !== 'none' ? ` (limited by ${v.limit})` : '')
    )
    .join(' | ');
}

// Reconcile the stage with who is in the channel, sharing, or on camera.
function syncStage() {
  const st = S.stage;
  if (!st) return;
  const c = S.call; // the stage shows the call's channel, whichever server is in view
  if (!c?.voiceChannel) return closeStage();
  const inChannel = c.users.filter((u) => u.voice === c.voiceChannel);
  const byId = new Map(inChannel.map((u) => [u.sid, u]));

  for (const sid of [...st.watching]) {
    if (byId.get(sid)?.sharing) continue;
    st.watching.delete(sid);
    S.voice.watch(sid, 'screen', false);
    const name = c.users.find((u) => u.sid === sid)?.name;
    toast(name ? `${name}'s stream ended` : 'The stream ended');
  }
  if (!inChannel.some((u) => u.sharing || u.camera)) return closeStage();

  // Screens first, then everyone in the channel (camera or avatar)
  const want = [
    ...inChannel.filter((u) => u.sharing).map((u) => ({ key: 'screen:' + u.sid, sid: u.sid, kind: 'screen', live: u.sid === c.sid || st.watching.has(u.sid) })),
    ...inChannel.map((u) => ({ key: (u.camera ? 'camera:' : 'user:') + u.sid, sid: u.sid, kind: u.camera ? 'camera' : 'user', live: true })),
  ];
  const wanted = new Map(want.map((w) => [w.key, w]));
  for (const [key, tile] of st.tiles) if (wanted.get(key)?.live !== tile.live) dropTile(key);
  for (const w of want) if (!st.tiles.has(w.key)) st.tiles.set(w.key, stageTile(w.key, w.sid, w.kind, w.live));
  if (!st.tiles.has(st.focus)) st.focus = null;

  // Place tiles: the focused one large, the rest in the grid (a strip while focused)
  const focused = st.tiles.get(st.focus);
  if (focused && st.main.firstChild !== focused.el) st.main.replaceChildren(focused.el);
  if (!focused) st.main.replaceChildren();
  const rest = want.filter((w) => w.key !== st.focus).map((w) => st.tiles.get(w.key).el);
  if (rest.length !== st.grid.children.length || rest.some((el, i) => st.grid.children[i] !== el)) st.grid.replaceChildren(...rest);
  st.body.classList.toggle('focused', !!focused);
  for (const t of st.tiles.values()) t.el.classList.toggle('focus', t === focused);

  for (const t of st.tiles.values()) {
    if (!t.video) continue;
    const src = S.voice.mediaOf(t.sid, t.kind === 'screen' ? 'screen' : 'camera');
    if (t.video.srcObject !== src) {
      t.video.srcObject = src;
      if (src) t.video.play().catch(() => {});
    }
    t.status.hidden = !!src;
    if (t.kind === 'screen') {
      t.video.muted = t.sid === c.sid || S.deafened;
      t.video.volume = streamVolume(st.volumes.get(t.sid) ?? 1);
    }
  }

  // Header: what's focused, plus controls for your own share
  const fu = focused && byId.get(focused.sid);
  const mineFocused = focused?.sid === c.sid;
  st.title.replaceChildren(
    !focused
      ? callChannel()?.name || 'Voice'
      : focused.kind === 'screen'
        ? mineFocused
          ? 'Your stream'
          : `${fu?.name || 'someone'}'s screen`
        : mineFocused
          ? 'You'
          : fu?.name || 'someone'
  );
  const sharing = !!S.voice.local.screen;
  st.controls.replaceChildren(
    ...[
      focused ? h('button', { class: 'btn small ghost', title: 'Show everyone', onclick: () => setStageFocus(st.focus) }, 'Grid') : null,
      sharing ? h('button', { class: 'btn small ghost', onclick: () => screenPicker({ switching: true }) }, 'Change source') : null,
      sharing ? h('button', { class: 'btn small danger', onclick: () => S.voice.stopMedia('screen') }, 'Stop sharing') : null,
    ].filter(Boolean)
  );
  layoutStage();
}

// Grid mode: pick the column count that makes 16:9 tiles as big as possible
// in the space available, like Discord's call grid.
function layoutStage(st = S.stage) {
  if (!st) return;
  const g = st.grid;
  if (st.body.classList.contains('focused')) {
    g.style.gridTemplateColumns = g.style.gridAutoRows = '';
    return;
  }
  const n = g.children.length;
  const gap = 8;
  const W = g.clientWidth;
  const H = g.clientHeight;
  if (!n || !W || !H) return;
  let best = { w: 0, cols: 1 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const w = Math.min((W - gap * (cols - 1)) / cols, ((H - gap * (rows - 1)) / rows) * (16 / 9));
    if (w > best.w) best = { w, cols };
  }
  const w = Math.floor(best.w);
  g.style.gridTemplateColumns = `repeat(${best.cols}, ${w}px)`;
  g.style.gridAutoRows = `${Math.floor((w * 9) / 16)}px`;
}

function closeStage() {
  const st = S.stage;
  if (!st) return;
  clearInterval(st.timer);
  st.ro.disconnect();
  for (const key of [...st.tiles.keys()]) dropTile(key);
  if (S.call?.connected) for (const sid of st.watching) S.voice.watch(sid, 'screen', false);
  S.stage = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $('#stream-view').replaceChildren();
  document.body.classList.remove('stream-visible');
  if (S.server) renderChannels();
}

// ---------------------------------------------------------------- penguin game (Yukon)

// The game runs in an iframe served by the friendspeak server we're connected
// to. It stays alive while you switch to text channels, and voice keeps going.
async function openGame() {
  const g = S.server?.game;
  if (!g?.available) return toast(g?.reason || 'Club Penguin is not available on this server', 'error', 6000);
  if (!g.enabled) return toast('Club Penguin is turned off on this server', 'error', 6000);
  if (S.game.open) return showGame(true);
  const res = await S.socket.emitWithAck('game:login', {});
  if (res.error) return toast(res.error, 'error', 6000);
  const url = new URL(res.path, S.entry.address);
  url.hash = new URLSearchParams({ u: res.username, t: res.token }).toString();
  const frame = h('iframe', { src: url.href, allow: 'autoplay; fullscreen; clipboard-write', title: 'Club Penguin' });
  S.game = { open: true, visible: false, origin: url.origin, frame, popout: null };
  $('#game-view').replaceChildren(
    h(
      'header',
      { class: 'chat-header' },
      h('span', { class: 'game-icon' }, '🐧'),
      h('span', { class: 'chat-title' }, 'Club Penguin'),
      h('span', { class: 'muted small' }, `${g.world} · playing as ${res.username}`),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn small ghost', title: 'Open the game in its own window', onclick: popOutGame }, 'Pop out'),
      h('button', { class: 'btn small ghost danger', onclick: closeGame }, 'Quit game')
    ),
    h('div', { class: 'game-frame' }, frame)
  );
  S.socket.emit('game:state', { playing: true });
  showGame(true);
}

function showGame(visible) {
  if (visible && !S.game.open) return;
  if (visible) closeStage();
  S.game.visible = visible;
  document.body.classList.toggle('game-visible', visible);
  if (visible) {
    S.game.frame?.focus();
    renderChannels();
  } else if (S.server) renderChannels();
}

function closeGame() {
  if (!S.game.open && !S.game.popout) return;
  S.game.popout?.close?.();
  $('#game-view')?.replaceChildren();
  S.game = { open: false, visible: false, origin: null, frame: null };
  document.body.classList.remove('game-visible');
  if (S.connected) S.socket.emit('game:state', { playing: false });
  if (S.server) renderChannels();
}

function popOutGame() {
  const src = S.game.frame?.src;
  if (!src) return;
  // The login token was consumed by the embedded copy, so log in afresh
  closeGame();
  S.socket.emitWithAck('game:login', {}).then((res) => {
    if (res.error) return toast(res.error, 'error');
    const url = new URL(res.path, S.entry.address);
    url.hash = new URLSearchParams({ u: res.username, t: res.token }).toString();
    const win = window.open(url.href, 'friendspeak-game', 'width=1280,height=840');
    if (!win) return toast('Pop-up blocked', 'error');
    S.game.popout = win;
    S.socket.emit('game:state', { playing: true });
    const timer = setInterval(() => {
      if (!win.closed) return;
      clearInterval(timer);
      if (S.game.popout === win) {
        S.game.popout = null;
        if (S.connected && !S.game.open) S.socket.emit('game:state', { playing: false });
      }
    }, 1000);
  });
}

// The game forwards key presses so push-to-talk and soundboard hotkeys keep
// working while it has focus.
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.source !== 'friendspeak-game' || e.origin !== S.game.origin) return;
  if (d.event === 'keydown') handleKeyDown(d, d.typing);
  else if (d.event === 'keyup') handleKeyUp(d);
});

// ---------------------------------------------------------------- hotkeys & push-to-talk

const typingInField = (e) => !!e.target?.closest?.('input, textarea, [contenteditable], emoji-picker');

// `e` is a KeyboardEvent, or a plain object forwarded from the game iframe.
// Returns true if the key was used.
function handleKeyDown(e, typing) {
  const st = settings.get();
  if (st.ptt && e.code === st.pttKey && !e.repeat && !typing) {
    audio.setPttHeld(true);
    return true;
  }
  if (e.repeat) return false;
  const combo = comboFromEvent(e);
  if (!combo) return false;
  const hasMod = e.ctrlKey || e.altKey || e.metaKey || /^F\d+$/.test(e.code);
  if (typing && !hasMod) return false;
  // The desktop app registers these as global shortcuts; don't play twice
  if (desktop?.hasGlobalHotkey?.(combo)) return false;
  if (voiceHotkey(combo)) return true;
  const s = S.sounds.find((x) => x.hotkey === combo);
  if (!s) return false;
  audio.ensure();
  playSound(s);
  return true;
}

function handleKeyUp(e) {
  const st = settings.get();
  if (st.ptt && e.code === st.pttKey) audio.setPttHeld(false);
}

window.addEventListener('keydown', (e) => handleKeyDown(e, typingInField(e)) && e.preventDefault());
window.addEventListener('keyup', handleKeyUp);
window.addEventListener('blur', () => !S.game.open && audio.setPttHeld(false));
document.addEventListener('visibilitychange', () => !document.hidden && (document.title = 'friendspeak'));

// ---------------------------------------------------------------- app updates and server maintenance (D29)

// The desktop app checks GitHub Releases itself (desktop/main.js). Servers with
// AUTO_UPDATE on tell us about a scheduled update in `server.update`
// (updater.js) and we warn ahead of the maintenance window.
let appUpdate = null; // desktop.updateState(): { current, status, version, url, canInstall, progress, error }
let aboutRefresh = null; // redraws Settings → About while it's open
let bannerTimer = null;

const dismissed = (key) => !!settings.get().dismissedBanners[key];
const dismiss = (key) => settings.set({ dismissedBanners: { ...settings.get().dismissedBanners, [key]: Date.now() } });
// Links come from the server, so only follow ones that point at GitHub
const githubLink = (url) => (typeof url === 'string' && /^https:\/\/github\.com\/[^\s"'<>]+$/.test(url) ? url : null);

function newerVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

function countdown(ms) {
  const m = Math.max(1, Math.round(ms / 60e3));
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) return `${Math.floor(m / 60)} h ${m % 60 ? (m % 60) + ' min' : ''}`.trim();
  return `${Math.round(m / 1440)} days`;
}

const windowTime = (at) =>
  new Date(at).toLocaleString([], { weekday: 'short', ...(at - Date.now() > 6 * 864e5 ? { month: 'short', day: 'numeric' } : {}), hour: 'numeric', minute: '2-digit' });

function banner(kind, text, { link, action, onClose } = {}) {
  return h(
    'div',
    { class: 'banner ' + kind },
    h('span', { class: 'banner-dot' }),
    h('span', { class: 'grow' }, text),
    link && h('a', { href: link, target: '_blank', rel: 'noreferrer' }, 'What’s new'),
    action,
    onClose && h('button', { class: 'x', title: 'Dismiss', onclick: () => (onClose(), renderBanners()) }, '×')
  );
}

function maintenanceBanner() {
  const u = S.connected && S.server?.update;
  if (!u?.latest) return null;
  const v = u.latest.version;
  const link = githubLink(u.latest.url);
  const name = S.server.name;
  if (u.installing) return banner('warn', `${name} is updating to friendspeak ${v}. You’ll be reconnected automatically in a minute or two.`, { link });
  const key = `maint:${S.entry.id}:${v}`;
  if (!u.at) {
    // AUTO_UPDATE=notify: the host updates by hand
    if (dismissed(key)) return null;
    return banner('info', `friendspeak ${v} is available for ${name} (it runs ${u.version}). The host can update it.`, { link, onClose: () => dismiss(key) });
  }
  const now = Date.now();
  if (now < u.warnFrom) return null;
  // Closing the early warning hides it until the final minutes; closing that one hides it for good
  const final = now >= u.finalFrom;
  const k = `${key}:${u.at}${final ? ':final' : ''}`;
  if (dismissed(k)) return null;
  return banner(
    'warn',
    `Server maintenance ${windowTime(u.at)} (in ${countdown(u.at - now)}): ${name} updates to friendspeak ${v} and will be offline for a minute or two.`,
    { link, onClose: () => dismiss(k) }
  );
}

function appUpdateBanner() {
  const u = appUpdate;
  if (!u || !['available', 'downloading', 'ready'].includes(u.status) || dismissed('app:' + u.version)) return null;
  const text = {
    available: `friendspeak ${u.version} is available (you have ${u.current}).` + (u.canInstall ? '' : ' Download it from the release page and install it over this one.'),
    downloading: `Downloading friendspeak ${u.version}… ${u.progress}%`,
    ready: `friendspeak ${u.version} is downloaded. It installs when you restart the app.`,
  }[u.status];
  const action =
    u.status === 'available'
      ? h('button', { class: 'btn small', onclick: () => desktop.downloadUpdate() }, u.canInstall ? 'Update' : 'Download')
      : u.status === 'ready'
        ? h('button', { class: 'btn small', onclick: () => desktop.installUpdate() }, 'Restart now')
        : null;
  return banner('info', text, { link: githubLink(u.url), action, onClose: () => dismiss('app:' + u.version) });
}

function renderBanners() {
  clearTimeout(bannerTimer);
  $('#banners').replaceChildren(...[maintenanceBanner(), appUpdateBanner()].filter(Boolean));
  // Keep the countdown fresh, and show the warning when its time comes
  if (S.server?.update?.at) bannerTimer = setTimeout(renderBanners, 30e3);
}

// A server newer than this app may speak a newer protocol: look for an app update now
function checkAppAgainstServer() {
  const v = S.server?.update?.version;
  if (v && appUpdate && newerVersion(v, appUpdate.current) && appUpdate.status !== 'available') desktop.checkForUpdates();
}

async function startAppUpdates() {
  if (!desktop?.updateState) return;
  appUpdate = await desktop.updateState();
  desktop.onUpdate((u) => {
    appUpdate = u;
    renderBanners();
    aboutRefresh?.();
  });
  renderBanners();
}

// ---------------------------------------------------------------- settings

function openSettings(tab = 'profile') {
  const body = h('div', { class: 'settings-body' });
  const tabs = {
    profile: ['My profile', settingsProfile],
    appearance: ['Appearance', settingsAppearance],
    voice: ['Voice & video', settingsVoice],
    integrations: ['Integrations', settingsIntegrations],
    server: ['Server', settingsServer],
    about: ['About & updates', settingsAbout],
  };
  let cleanup = null;
  const nav = h('div', { class: 'settings-nav' });
  const show = (key) => {
    cleanup?.();
    cleanup = null;
    for (const b of nav.children) b.classList.toggle('active', b.dataset.tab === key);
    body.replaceChildren();
    cleanup = tabs[key][1](body) || null;
  };
  nav.append(...Object.entries(tabs).map(([k, [label]]) => h('button', { 'data-tab': k, onclick: () => show(k) }, label)));
  modal('Settings', h('div', { class: 'settings' }, nav, body), { wide: true, onClose: () => cleanup?.() });
  show(tab);
}

function settingsProfile(body) {
  const p = me();
  const { el, draft } = profileEditor(p);
  const importInput = h('input', {
    type: 'file',
    accept: '.json',
    hidden: true,
    onchange: async () => {
      try {
        const np = await importProfile(importInput.files[0]);
        toast(`Imported ${np.name}`);
        switchProfile(np.id);
        settingsProfile(body.replaceChildren() || body);
      } catch (e) {
        toast(e.message, 'error');
      }
    },
  });
  body.append(
    el,
    h(
      'div',
      { class: 'row end' },
      h('button', {
        class: 'btn',
        onclick: () => {
          if (!draft.name.trim()) return toast('Name required', 'error');
          if (!saveProfile(() => profiles.save({ ...draft, name: draft.name.trim() }))) return;
          applyProfileChange();
          toast('Profile saved');
        },
      }, 'Save profile')
    ),
    h('h3', {}, 'Saved profiles'),
    h('p', { class: 'muted small' }, 'Profiles live only in this browser. Export one to use it on another computer.'),
    h(
      'div',
      { class: 'profile-list' },
      profiles.all().map((x) =>
        h(
          'div',
          { class: 'profile-row' + (x.id === p.id ? ' current' : '') },
          avatarEl(x, 32),
          h('span', { class: 'grow' }, x.name, x.id === p.id ? h('span', { class: 'badge' }, 'active') : null),
          x.id !== p.id ? h('button', { class: 'btn small ghost', onclick: () => (switchProfile(x.id), settingsProfile(body.replaceChildren() || body)) }, 'Use') : null,
          h('button', { class: 'btn small ghost', onclick: () => exportProfile(x) }, 'Export'),
          profiles.all().length > 1
            ? h(
                'button',
                {
                  class: 'btn small ghost danger',
                  onclick: async () => {
                    if (!(await confirmModal('Delete profile', `Delete profile "${x.name}" from this device?`))) return;
                    profiles.remove(x.id);
                    if (x.id === p.id) switchProfile(profiles.all()[0].id);
                    settingsProfile(body.replaceChildren() || body);
                  },
                },
                'Delete'
              )
            : null
        )
      )
    ),
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'btn small', onclick: () => (switchProfile(profiles.create({ name: 'new friend' }).id), settingsProfile(body.replaceChildren() || body)) }, 'New profile'),
      h('button', { class: 'btn small ghost', onclick: () => importInput.click() }, 'Import…'),
      importInput
    ),
    h('p', { class: 'muted small' }, 'An exported profile includes its private keys for direct messages. Keep the file to yourself: whoever has it can read and send DMs as you.')
  );
}

function settingsAppearance(body) {
  const st = settings.get();
  const tiles = [];
  const pickers = [];
  const update = (patch) => {
    applyAppearance(settings.set(patch));
    sync();
  };
  // Tiles and pickers are updated in place: rebuilding them would close an open color picker
  const sync = () => {
    const now = settings.get();
    const colors = paletteOf(now);
    for (const t of tiles) t.el.classList.toggle('selected', t.theme ? now.theme === t.theme : now.theme === 'custom' && samePalette(colors, t.colors));
    for (const p of pickers) {
      p.input.value = colors[p.key];
      p.hex.textContent = colors[p.key];
    }
    customBadge.hidden = now.theme !== 'custom';
  };

  // A small mock of the app, drawn with the palette's own colors
  const tile = (name, colors, theme) => {
    const bar = (cls) => h('i', { class: cls });
    const el = h(
      'button',
      { class: 'theme-tile theme-scope', title: name, onclick: () => update(theme ? { theme } : { theme: 'custom', themeColors: colors }) },
      h(
        'div',
        { class: 'tt-preview' },
        h('div', { class: 'tt-rail' }, bar('on'), bar(), bar()),
        h('div', { class: 'tt-side' }, bar(), bar('on'), bar(), bar('voice')),
        h('div', { class: 'tt-main' }, bar('strong'), bar(), bar('link'), h('div', { class: 'tt-dots' }, bar('green'), bar('yellow'), bar('red')), h('div', { class: 'tt-composer' }, bar()))
      ),
      h('span', { class: 'tt-name' }, name)
    );
    setColors(el, colors);
    tiles.push({ el, colors, theme });
    return el;
  };
  const picker = ([key, label]) => {
    const input = h('input', { type: 'color', oninput: (e) => update({ theme: 'custom', themeColors: { ...paletteOf(), [key]: e.target.value } }) });
    const hex = h('span', { class: 'hex' });
    pickers.push({ key, input, hex });
    return h('label', { class: 'color-field' }, input, h('span', {}, label, hex));
  };

  const customBadge = h('span', { class: 'badge' }, 'custom');
  const select = (key, options) => {
    const el = h('select', { onchange: (e) => update({ [key]: e.target.value }) }, Object.entries(options).map(([k, [label]]) => h('option', { value: k }, label)));
    el.value = options[st[key]] ? st[key] : Object.keys(options)[0];
    return el;
  };
  const fontCustom = h(
    'label',
    { class: 'field', hidden: st.font !== 'custom' },
    h('span', {}, 'Font name'),
    h('input', { value: st.fontCustom, placeholder: 'A font installed on this computer, e.g. Fira Sans', oninput: (e) => update({ fontCustom: e.target.value }) })
  );
  const fontSel = select('font', FONTS);
  fontSel.addEventListener('change', () => (fontCustom.hidden = fontSel.value !== 'custom'));
  const sizeVal = h('span', {}, st.fontSize + 'px');
  const sizeIn = h('input', { type: 'range', min: FONT_SIZE.min, max: FONT_SIZE.max, step: FONT_SIZE.step, value: st.fontSize, oninput: (e) => (update({ fontSize: +e.target.value }), (sizeVal.textContent = e.target.value + 'px')) });

  body.append(
    h('h3', {}, 'Theme'),
    h('div', { class: 'theme-grid' }, Object.entries(THEMES).map(([id, t]) => tile(t.name, t.colors, id))),
    h('h3', {}, 'Color schemes'),
    h('p', { class: 'muted small' }, 'Popular terminal color schemes from the Gogh collection. Click one to load its colors, then adjust them below.'),
    h('div', { class: 'theme-grid scroll' }, SCHEMES.map((s) => tile(s.name, s.colors))),
    h('h3', {}, 'Colors', customBadge),
    h('p', { class: 'muted small' }, 'Changing a color makes a custom theme from the one in use.'),
    ...COLOR_GROUPS.flatMap(([title, colors]) => [h('div', { class: 'color-group' }, title), h('div', { class: 'color-grid' }, colors.map(picker))]),
    h('h3', {}, 'Font and spacing'),
    h('div', { class: 'row' }, h('label', { class: 'field grow' }, h('span', {}, 'Font'), fontSel), h('label', { class: 'field grow' }, h('span', {}, 'Density'), select('density', DENSITIES))),
    fontCustom,
    h(
      'div',
      { class: 'field' },
      h('span', {}, 'Text size ', sizeVal),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, sizeIn), h('button', { class: 'btn small ghost', onclick: () => (update({ fontSize: FONT_SIZE.base }), (sizeIn.value = FONT_SIZE.base), (sizeVal.textContent = FONT_SIZE.base + 'px')) }, 'Reset'))
    )
  );
  sync();
}

function settingsVoice(body) {
  const st = settings.get();
  const inSel = h('select', { onchange: (e) => (settings.set({ inputDevice: e.target.value }), restartMic()) }, h('option', { value: '' }, 'Default'));
  const outSel = h('select', { onchange: (e) => (settings.set({ outputDevice: e.target.value }), applyOutputDevice(e.target.value)) }, h('option', { value: '' }, 'Default'));
  const camSel = h(
    'select',
    {
      onchange: async (e) => {
        settings.set({ videoDevice: e.target.value });
        if (liveVoice()?.local.camera) (liveVoice().stopMedia('camera', true), await startCamera());
        if (previewing) preview.show();
      },
    },
    h('option', { value: '' }, 'Default')
  );
  const preview = cameraPreview();
  preview.el.hidden = true;
  let previewing = false;
  const previewBtn = h(
    'button',
    {
      class: 'btn small ghost',
      onclick: () => {
        previewing = !previewing;
        previewBtn.textContent = previewing ? 'Stop preview' : 'Preview';
        preview.el.hidden = !previewing;
        previewing ? preview.show() : preview.stop();
      },
    },
    'Preview'
  );
  const picker = backgroundPicker(() => previewing && preview.show());
  navigator.mediaDevices?.enumerateDevices().then((devs) => {
    for (const d of devs) {
      const opt = h('option', { value: d.deviceId }, d.label || `${d.kind} ${d.deviceId.slice(0, 6)}`);
      if (d.kind === 'audioinput') inSel.append(opt);
      if (d.kind === 'audiooutput') outSel.append(opt);
      if (d.kind === 'videoinput') camSel.append(opt);
    }
    inSel.value = st.inputDevice;
    outSel.value = st.outputDevice;
    camSel.value = st.videoDevice;
  });
  const restartMic = async () => {
    if (!liveVoice()) return;
    try {
      await audio.startMic();
      liveVoice().micError = null;
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  const meter = h('div', { class: 'meter' }, h('div', { class: 'meter-fill' }));
  let testing = false;
  const testBtn = h('button', { class: 'btn small ghost' }, liveVoice() ? 'Mic active' : 'Test mic');
  testBtn.onclick = async () => {
    if (liveVoice()) return;
    if (testing) {
      audio.stopMic();
      testing = false;
      testBtn.textContent = 'Test mic';
      return;
    }
    try {
      await audio.startMic();
      testing = true;
      testBtn.textContent = 'Stop test';
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  const iv = setInterval(() => {
    const lvl = audio.selfAnalyser ? Level(audio.selfAnalyser) : 0;
    meter.firstChild.style.width = Math.min(100, lvl * 400) + '%';
  }, 60);

  const pttBtn = h('button', { class: 'btn ghost small hotkey-btn' }, st.pttKey.replace(/^Key|^Digit/, ''));
  pttBtn.onclick = () => {
    pttBtn.textContent = 'Press a key…';
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      settings.set({ pttKey: e.code });
      pttBtn.textContent = e.code.replace(/^Key|^Digit/, '');
      window.removeEventListener('keydown', onKey, true);
    };
    window.addEventListener('keydown', onKey, true);
  };
  const hotkeyBtn = (key) => {
    const btn = h('button', { class: 'btn ghost small hotkey-btn' }, st[key] || 'Click to set');
    btn.onclick = () => {
      btn.textContent = 'Press a key… (Esc clears)';
      const onKey = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const c = e.key === 'Escape' ? '' : comboFromEvent(e);
        if (c === null) return; // a modifier on its own
        settings.set({ [key]: c });
        syncHotkeys();
        btn.textContent = c || 'Click to set';
        window.removeEventListener('keydown', onKey, true);
      };
      window.addEventListener('keydown', onKey, true);
    };
    return btn;
  };
  const check = (key, label, after) =>
    h(
      'label',
      { class: 'check-row' },
      h('input', { type: 'checkbox', checked: st[key], onchange: (e) => (settings.set({ [key]: e.target.checked }), after?.(e.target.checked)) }),
      h('span', {}, label)
    );
  const slider = (key, label, max, after) => {
    const val = h('span', {}, Math.round(st[key] * 100) + '%');
    return h(
      'label',
      { class: 'field' },
      h('span', {}, label, ' ', val),
      h('input', { type: 'range', min: 0, max, step: 0.01, value: st[key], oninput: (e) => (settings.set({ [key]: +e.target.value }), (val.textContent = Math.round(e.target.value * 100) + '%'), after(+e.target.value)) })
    );
  };

  body.append(
    h('div', { class: 'row' }, h('label', { class: 'field grow' }, h('span', {}, 'Input device'), inSel), h('label', { class: 'field grow' }, h('span', {}, 'Output device'), outSel)),
    h('div', { class: 'field' }, h('span', {}, 'Mic level'), h('div', { class: 'row' }, meter, testBtn)),
    h('h3', {}, 'Camera'),
    h('label', { class: 'field' }, h('span', {}, 'Camera'), camSel),
    h('div', { class: 'field' }, h('span', {}, 'Background'), picker.el),
    h('div', { class: 'field' }, h('div', { class: 'row' }, previewBtn, h('span', { class: 'muted small' }, 'Your background is replaced on this device, before the camera reaches anyone.')), preview.el),
    h('h3', {}, 'Volume'),
    slider('masterVolume', 'Master volume', 1, (v) => (audio.setMasterVolume(v), syncStage(), renderDmCall())),
    slider('voiceVolume', 'Voices', 1, (v) => audio.setVoiceVolume(v)),
    slider('cueVolume', 'Notification sounds', 1, (v) => audio.setCueVolume(v)),
    h('p', { class: 'muted small' }, 'Master volume covers everything friendspeak plays except the game. To turn one person up or down, click them in a voice channel: up to 300%, for you only.'),
    h('h3', {}, 'Microphone'),
    slider('micVolume', 'Mic volume', 2, (v) => audio.setMicVolume(v)),
    check('echoCancellation', 'Echo cancellation', restartMic),
    check('noiseSuppression', 'Noise suppression', restartMic),
    h('h3', {}, 'Push to talk'),
    check('ptt', 'Use push-to-talk instead of an open mic', () => audio.updateGate()),
    h('div', { class: 'field' }, h('span', {}, 'Push-to-talk key'), pttBtn),
    h('p', { class: 'muted small' }, 'Browsers only see keys while the friendspeak window is focused.'),
    h('h3', {}, 'Shortcuts'),
    h('div', { class: 'row' }, h('div', { class: 'field grow' }, h('span', {}, 'Mute'), hotkeyBtn('muteHotkey')), h('div', { class: 'field grow' }, h('span', {}, 'Deafen'), hotkeyBtn('deafenHotkey'))),
    h(
      'p',
      { class: 'muted small' },
      desktop ? 'Shortcuts with Ctrl/Alt/Cmd, F-keys or the numpad work even while other apps are focused.' : 'Shortcuts work while friendspeak is the focused window.'
    ),
    h('h3', {}, 'Soundboard'),
    slider('soundboardVolume', 'Soundboard volume', 1, (v) => audio.setSoundboardVolume(v)),
    check('soundboardMonitor', 'Hear my own soundboard', (on) => audio.setMonitor(on && !S.deafened)),
    h('h3', {}, 'Notifications'),
    check('cues', 'Play join/leave/mute sounds')
  );
  return () => {
    clearInterval(iv);
    preview.stop();
    picker.dispose();
    if (testing && !liveVoice()) audio.stopMic();
  };
}

function settingsIntegrations(body) {
  const st = settings.get();
  body.append(
    h('h3', {}, 'GIPHY'),
    h(
      'p',
      { class: 'muted small' },
      'GIF search uses GIPHY. Create a free API key at developers.giphy.com and paste it here. It is stored only on this device. If you leave it empty, the server host’s key (GIPHY_API_KEY) is used if they set one.'
    ),
    h('label', { class: 'field' }, h('span', {}, 'GIPHY API key'), h('input', { value: st.giphyKey, placeholder: 'paste key', oninput: (e) => settings.set({ giphyKey: e.target.value.trim() }) }))
  );
}

function settingsAbout(body) {
  const draw = () => {
    const u = appUpdate;
    const status = !u
      ? 'Updates are checked by the desktop app.'
      : {
          idle: 'Not checked yet.',
          checking: 'Checking for updates…',
          none: 'You’re on the latest version.',
          available: `Version ${u.version} is available.` + (u.canInstall ? '' : ' This build can’t install updates itself: download it and install it over this one.'),
          downloading: `Downloading ${u.version}… ${u.progress}%`,
          ready: `Version ${u.version} is downloaded and installs when you restart.`,
          error: /\b404\b/.test(u.error) ? 'No releases found yet (or the repository is private).' : `Couldn’t check for updates: ${u.error}`,
        }[u.status];
    const action =
      u?.status === 'available'
        ? h('button', { class: 'btn small', onclick: () => desktop.downloadUpdate() }, u.canInstall ? 'Update' : 'Download')
        : u?.status === 'ready'
          ? h('button', { class: 'btn small', onclick: () => desktop.installUpdate() }, 'Restart now')
          : u && h('button', { class: 'btn small ghost', disabled: ['checking', 'downloading'].includes(u.status), onclick: () => desktop.checkForUpdates() }, 'Check for updates');

    const su = S.connected && S.server?.update;
    const serverStatus =
      su &&
      (su.mode === 'off'
        ? 'Automatic updates are off on this server (AUTO_UPDATE).'
        : !su.latest
          ? su.mode === 'on'
            ? `It updates itself in its maintenance window (cron “${su.cron}”) when a new version is released.`
            : 'It checks for new versions; the host installs them by hand.'
          : su.installing
            ? `Updating to ${su.latest.version} now…`
            : su.at
              ? `Version ${su.latest.version} installs ${windowTime(su.at)} (in ${countdown(su.at - Date.now())}). The server is offline for a minute or two.`
              : `Version ${su.latest.version} is available. The host can update it.`);

    body.replaceChildren(
      h('h3', {}, 'friendspeak app'),
      h('div', { class: 'about-row' }, h('strong', {}, u ? `Version ${u.current}` : 'Version unknown'), action),
      h('p', { class: 'muted small' }, status),
      desktop?.openReleases && h('p', {}, h('a', { href: '#', onclick: (e) => (e.preventDefault(), desktop.openReleases()) }, 'Release notes and downloads')),
      S.connected && h('h3', {}, 'This server'),
      S.connected && h('div', { class: 'about-row' }, h('strong', {}, `${S.server.name}: version ${su?.version || 'unknown (older than 1.1)'}`)),
      serverStatus && h('p', { class: 'muted small' }, serverStatus)
    );
  };
  draw();
  aboutRefresh = draw;
  S.socket?.on('server:update', draw);
  return () => ((aboutRefresh = null), S.socket?.off('server:update', draw));
}

function settingsServer(body) {
  if (!S.connected) return body.append(h('p', { class: 'muted' }, 'Connect to a server to manage it.'));
  const nameIn = h('input', { placeholder: 'party_parrot', maxlength: 32 });
  const fileIn = h('input', { type: 'file', accept: 'image/*' });
  const list = h('div', { class: 'emoji-list' });
  const draw = () =>
    list.replaceChildren(
      ...(S.server.emojis.length
        ? S.server.emojis.map((e) =>
            h(
              'div',
              { class: 'emoji-row' },
              h('img', { src: e.url, alt: e.name }),
              h('code', {}, `:${e.name}:`),
              h('span', { class: 'muted small grow' }, e.by ? `by ${e.by}` : ''),
              h('button', { class: 'btn small ghost danger', onclick: () => S.socket.emit('emoji:remove', { name: e.name }) }, 'Remove')
            )
          )
        : [h('p', { class: 'muted small' }, 'No custom emojis yet.')])
    );
  draw();
  const onEmojis = () => draw();
  S.socket.on('emojis', onEmojis);

  // Name and icon are shared: everyone on the server sees them
  const serverName = h('input', { maxlength: 40, value: S.server.name });
  const preview = h('div', { class: 'server-icon-preview' });
  const drawIcon = () => preview.replaceChildren(S.server.icon ? h('img', { src: S.server.icon, alt: '', referrerpolicy: 'no-referrer' }) : initials(S.server.name));
  drawIcon();
  const update = async (patch) => {
    const r = await S.socket.emitWithAck('server:update', patch);
    if (r.error) toast(r.error, 'error');
    return !r.error;
  };
  const saveName = async () => {
    const name = serverName.value.trim();
    if (!name) return toast('Enter a server name', 'error');
    if (name !== S.server.name && (await update({ name }))) toast('Server renamed');
  };
  serverName.addEventListener('keydown', (e) => e.key === 'Enter' && saveName());
  // Game on/off: can only be switched on when the server has the game assets
  const gameToggle = h('input', { type: 'checkbox' });
  const gameNote = h('p', { class: 'muted small' });
  const drawGame = () => {
    const g = S.server.game || {};
    gameToggle.checked = !!g.enabled;
    gameToggle.disabled = !g.available;
    gameNote.textContent = g.available
      ? 'Shows Club Penguin under Games for everyone on this server. Anyone connected can turn it on or off.'
      : g.reason || 'Club Penguin is not available on this server.';
  };
  gameToggle.onchange = async () => {
    if (!(await update({ game: gameToggle.checked }))) drawGame();
  };
  drawGame();
  const onServer = () => {
    if (document.activeElement !== serverName) serverName.value = S.server.name;
    drawIcon();
    drawGame();
  };
  S.socket.on('server', onServer);

  const banList = h('div', { class: 'emoji-list' });
  const drawBans = () =>
    banList.replaceChildren(
      ...(S.server.bans?.length
        ? S.server.bans.map((b) =>
            h(
              'div',
              { class: 'emoji-row' },
              avatarEl({ ...profileOf(b.profileId, b.name) }, 28),
              h('strong', {}, profileOf(b.profileId, b.name).name),
              h('span', { class: 'muted small grow' }, `by ${b.by} · ${fmtTime(b.ts)}${b.ip ? ' · profile and IP' : ''}`),
              h('button', { class: 'btn small ghost', onclick: () => S.socket.emit('ban:remove', { id: b.id }) }, 'Unban')
            )
          )
        : [h('p', { class: 'muted small' }, 'Nobody is banned.')])
    );
  drawBans();
  S.socket.on('bans', drawBans);

  body.append(
    h('h3', {}, 'Overview'),
    h(
      'p',
      { class: 'muted small' },
      'The server’s name and icon are shown to everyone on it. Anyone connected can change them. The icon can be any image (it’s resized for you), an animated GIF, or a link. ',
      h('span', {}, S.entry.address)
    ),
    h(
      'div',
      { class: 'row server-overview' },
      h(
        'div',
        { class: 'server-icon-edit' },
        preview,
        h(
          'div',
          { class: 'row tight center' },
          imageChoices({ size: IMG.icon, dropOn: [preview], uploadLabel: 'Upload icon', onPick: (icon) => update({ icon }) }),
          h('button', { class: 'btn small ghost danger', onclick: () => S.server.icon && update({ icon: '' }) }, 'Remove')
        )
      ),
      h('label', { class: 'field grow' }, h('span', {}, 'Server name'), serverName),
      h('button', { class: 'btn', style: { alignSelf: 'flex-end' }, onclick: saveName }, 'Save')
    ),
    h('h3', {}, 'Games'),
    h('label', { class: 'check-row' + (gameToggle.disabled ? ' disabled' : '') }, gameToggle, h('span', {}, 'Club Penguin')),
    gameNote,
    ...(S.server.storage
      ? [
          h('h3', {}, 'Files'),
          h(
            'div',
            { class: 'row' },
            h('p', { class: 'muted small grow' }, `${fmtBytes(S.server.storage.used)} of ${fmtBytes(S.server.storage.max)} used. Anyone on the server can delete any file. The host sets the limit with MAX_STORAGE.`),
            h('button', { class: 'btn small', onclick: () => openFileBrowser() }, 'Browse files')
          ),
        ]
      : []),
    h('h3', {}, 'Banned'),
    h('p', { class: 'muted small' }, 'Ban someone from their name in the member list. Anyone connected can ban or unban (there are no admins).'),
    banList,
    h('h3', {}, 'Custom emojis'),
    h('p', { class: 'muted small' }, 'Everyone on this server can use them as :name:, from the emoji picker, or in channel names. Any image works (it’s resized); GIFs must be under 256KB.'),
    h(
      'div',
      { class: 'row' },
      h('label', { class: 'field grow' }, h('span', {}, 'Name'), nameIn),
      h('label', { class: 'field grow' }, h('span', {}, 'Image'), fileIn),
      h(
        'button',
        {
          class: 'btn',
          style: { alignSelf: 'flex-end' },
          onclick: async () => {
            const f = fileIn.files[0];
            if (!f) return toast('Choose an image', 'error');
            try {
              const url = await fileToDataUrl(f, { max: 96, maxBytes: 256 * 1024 });
              const name = nameIn.value.trim() || f.name.replace(/\.[^.]+$/, '');
              const r = await S.socket.emitWithAck('emoji:add', { name, url });
              if (r.error) return toast(r.error, 'error');
              nameIn.value = '';
              fileIn.value = '';
            } catch (e) {
              toast(e.message, 'error');
            }
          },
        },
        'Upload'
      )
    ),
    list
  );
  return () => (S.socket?.off('emojis', onEmojis), S.socket?.off('server', onServer), S.socket?.off('bans', drawBans));
}

// ---------------------------------------------------------------- boot

function renderAll() {
  renderRail();
  renderHeader();
  renderChannels();
  renderVoicePanel();
  renderUserPanel();
  renderMembers();
  renderMain();
  renderBanners();
}

let booted = false;
async function boot() {
  if (!profiles.active()) return welcome();
  profiles.setActive(profiles.active().id);
  DM.start(me(), servers.all());
  if (!booted) {
    booted = true;
    await loadSounds();
    startAppUpdates();
  }
  renderAll();
  const last = servers.get(servers.last());
  if (last) connectTo(last);
}

// Browsers block audio until a user gesture; unlock on first interaction.
window.addEventListener('pointerdown', () => audio.ensure(), { once: true });

boot();
