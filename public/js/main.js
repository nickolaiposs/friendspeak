import { log } from './log.js'; // first, so errors while the rest loads are caught
import '/vendor/emoji-picker-element/index.js';
import { $, $$, h, uid, formatText, fmtBytes, fmtTime, shortTime, fileToDataUrl, avatarEl, channelNameEl, isImage, mediaResolver, comboFromEvent, normalizeAddress, isUnencrypted, findMentions, mentionTag, messageLink, snippetAround, parseSearch, SEARCH_FILTERS, SEARCH_HAS, debounce, inviteInfo, inviteStatus, INVITE_TYPES, INVITE_DURATIONS } from './util.js';
import { profiles, servers, settings, sounds, identities, mentionUnread, exportProfile, importProfile, randomColor } from './store.js';
import { audio, Level, MAX_USER_VOLUME, MAX_MIC_VOLUME, MAX_VOICES_VOLUME, DENOISE_LIMIT, GATE, CUES } from './audio.js';
import { VoiceClient, MEDIA, TIERS, MODES, AUDIO_QUALITY } from './voice.js';
import { nativeMedia } from './native.js';
import { DirectMessages, MAX_FILES } from './dm.js';
import { identityFor } from './identity.js';
import { DmCalls } from './call.js';
import { BACKGROUNDS, CAPTURE, PRESETS, presetCss, pictures, backgroundOf, loadBackground, activeBackground, setBackground, withBackground } from './background.js';
import { applyAppearance, paletteOf, samePalette, setColors, THEMES, SCHEMES, COLOR_GROUPS, FONTS, FONT_SIZE, DENSITIES, UI_SCALES, uiScaleOf, stepUiScale } from './theme.js';

applyAppearance(); // before the first render

// ---------------------------------------------------------------- state

const S = {
  entry: null, // server bookmark in view
  conn: null, // its connection (see openSocket)
  callRtt: null, // the call's longest round trip to anyone in it, ms (signalOf)
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
  // The secret that goes with our uploads; null on a server from before it had one
  get uploadKey() {
    return this.conn?.uploadKey || null;
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
  // What we may do there (see "permissions"); null on a server from before permissions
  get perms() {
    return this.conn?.perms || null;
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

// The desktop app's own title bar (desktop/main.js draws the window without the system's)
if (desktop?.titleBar) {
  const root = document.documentElement;
  root.classList.add('has-titlebar', 'os-' + desktop.platform);
  root.style.setProperty('--titlebar-h', desktop.titleBar.height + 'px');
  document.getElementById('titlebar').hidden = false;
  desktop.titleBar.onFullscreen((on) => root.classList.toggle('fullscreen', on));
  // Dimmed while the window is in the background, as the system's own title bars are. The game's
  // iframe taking the focus blurs this window but not the app, so ask the document rather than the event.
  const focused = () => root.classList.toggle('window-blurred', !document.hasFocus());
  addEventListener('blur', () => setTimeout(focused));
  addEventListener('focus', focused);
}

// Where you are, in the title bar and the window's title (the taskbar, Alt-Tab): the server and channel,
// the DM's name, or the app's name on the home screen
let windowTitle = 'friendspeak';
function updateTitle() {
  const ch = S.channelId && chatById(S.channelId);
  windowTitle = !ch ? 'friendspeak' : ch.type === 'dm' ? profileOf(ch.with).name : S.server?.name ? `${S.server.name} · #${ch.name}` : 'friendspeak';
  const name = document.querySelector('#titlebar .titlebar-name');
  if (name) (name.textContent = windowTitle), (name.title = windowTitle);
  if (!document.title.startsWith('(•)')) document.title = windowTitle;
}
// What a plain http server means, where the address is typed and on the mark in the server's header
const UNENCRYPTED = 'Not encrypted: this server uses plain http, so anyone on the network between you and it can read and change what you send, your invite included. Fine on a network you trust; over the internet, ask the host to turn on HTTPS.';
// Name a bookmark by the server's own name (set in Server settings)
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
// An export from before D32 has no keys: this device makes new ones, which servers that know the profile refuse (D42)
const warnIfKeyless = (p) =>
  !identities.get(p.id) && toast(`${p.name}'s file has no keys, so servers that already know this profile won't accept it. Export it again from the device it's on.`, 'error');
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
// What of a `users` entry a member row shows, and a row in the channel list (voice, game)
const MEMBER_ROW = ['sid', 'id', 'name', 'color', 'avatar', 'status', 'voice', 'sharing', 'camera', 'playing', 'game'];
// The Steam game someone is playing (D59), as tooltips word it
const playingText = (game) => (game && typeof game === 'string' ? 'Playing ' + game : '');
// One part of a "what they are doing" line: an icon and its text
const actPart = (iconEl, text, cls = '') => h('span', { class: 'act' + (cls ? ' ' + cls : '') }, iconEl, text);
// The same for the game, with its icon from Steam in place of the controller when there is one (D59)
const playingEl = (game, src) =>
  game && typeof game === 'string'
    ? actPart(isImage(src) ? h('img', { class: 'steam-icon', src, alt: '', referrerpolicy: 'no-referrer' }) : icon('gamepad', 'act-icon'), game, 'act-game')
    : '';
// What someone is doing, as the member list and profile cards show it: voice, sharing, camera, games
const activityParts = (u) =>
  [
    u.voice && actPart(icon('speaker', 'act-icon'), channelById(u.voice)?.name || '', 'act-voice'),
    u.sharing && h('span', { class: 'live-badge act-live' }, 'LIVE'),
    u.camera && h('span', { class: 'act', role: 'img', 'aria-label': 'Camera on', title: 'Camera on' }, icon('cam', 'act-icon')),
    u.playing && actPart(icon('penguin', 'act-icon'), 'Club Penguin'),
    playingEl(u.game, u.gameIcon),
  ].filter(Boolean);
// Parts of a "what they are doing" line (text or elements), with dots between
const dotted = (parts) => parts.filter(Boolean).flatMap((p, i) => (i ? [' · ', p] : [p]));
const VOICE_ROW = [...MEMBER_ROW, 'muted', 'deafened', 'forceMuted'];
const sameUsers = (a, b, fields) => a.length === b.length && a.every((u, i) => fields.every((f) => u[f] === b[i][f]));
const isBanned = (pid) => !!S.server?.bans?.some((b) => b.profileId === pid);

// ---------------------------------------------------------------- permissions

// What we may do on a server comes from the server (hello, then a `perms` event) and is only used to hide what would be
// refused anyway: the server checks everything again. A server from before permissions sends none, so everything shows.
const hasPerms = (c = S.conn) => !!c?.perms;
const can = (key, c = S.conn) => !c?.perms || !!c.perms[key];
// A channel's own settings beat the server-wide ones
const canCh = (channelId, key, c = S.conn) => {
  const p = c?.perms;
  if (!p) return true;
  const ch = p.channels?.[channelId];
  return ch ? !!ch[key] : !!p[key === 'manage' ? 'manageChannels' : key];
};
// Server name, icon, voice quality, the game: administrators only (everyone while permissions are off)
const canServerSettings = (c = S.conn) => !c?.perms || c.perms.admin || c.perms.open;
// The Server settings window: administrators and moderators (anyone a role or the defaults let moderate or
// manage something) only. Everyone while permissions are off, since then everyone can do those things.
const SETTINGS_PERMS = ['kick', 'voiceKick', 'ban', 'forceMute', 'manageRoles', 'manageChannels', 'manageEmojis', 'manageFiles', 'manageMessages', 'createInvites'];
const canSeeServerSettings = (c = S.conn) => !c?.perms || !!c.perms.open || !!c.perms.admin || SETTINGS_PERMS.some((k) => c.perms[k]);
// Roles without permissions of their own are only labels: people who manage roles may hand those out
const isAesthetic = (r) => !Object.keys(r.perms || {}).length && !r.grantable?.length;
function isAdminPid(pid, sv = S.server) {
  if (!sv?.permissionsOn) return false;
  if (sv.defaultPerms?.admin) return true;
  const have = sv.memberRoles?.[pid];
  return Array.isArray(have) && !!sv.roles?.some((r) => have.includes(r.id) && r.perms?.admin);
}
// Nobody but an administrator can act on one
const canActOn = (pid) => pid !== me().id && (can('admin') || !isAdminPid(pid));
// The roles we may add to or take off someone
function grantableRoles(pid) {
  const p = S.conn?.perms;
  const roles = Array.isArray(S.server?.roles) ? S.server.roles : [];
  if (!p || p.open) return [];
  if (p.admin) return roles;
  if (!p.manageRoles || (pid !== me().id && isAdminPid(pid))) return [];
  return roles.filter((r) => p.grantable?.includes(r.id) && isAesthetic(r));
}
const NOPE = 'You don’t have permission to send messages here';
// Did the server mute us (and we can't lift it)? Then the mic stays shut whatever the mute button says.
const forcedMute = (c = S.call) => !!c?.perms && !c.perms.forceMute && !!c.users.find((u) => u.sid === c.sid)?.forceMuted;
// Force-mute changed (or the right to lift it): the mic gate and what friends are told follow
function syncForced(c) {
  const f = forcedMute(c);
  if (f === !!c.forced) return;
  c.forced = f;
  if (S.call === c) syncVoiceState();
}
const doAct = async (event, payload) => {
  const r = await S.socket.emitWithAck(event, payload);
  if (r?.error) toast(r.error, 'error');
  return r;
};

// ---------------------------------------------------------------- icons

const I = {
  mic: '<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>',
  micOff: '<svg viewBox="0 0 24 24"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5a3 3 0 0 0-6 0v.18l5.98 5.99zM4.27 3 3 4.27l6.01 6.01V11a3 3 0 0 0 3 3c.22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52A5.2 5.2 0 0 1 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28a6.9 6.9 0 0 0 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg>',
  head: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 0 0-9 9v7a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2H5v-1a7 7 0 0 1 14 0v1h-2a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-7a9 9 0 0 0-9-9z"/></svg>',
  headOff: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 0 0-9 9v7a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2H5v-1a7 7 0 0 1 14 0v1h-2a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-7a9 9 0 0 0-9-9z"/><path d="M3 3l18 18" stroke="currentColor" stroke-width="2.4"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><path d="M19.14 12.94a7.07 7.07 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7 7 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2.4h-3.84a.5.5 0 0 0-.49.42l-.36 2.54c-.59.24-1.13.56-1.63.94l-2.39-.96a.5.5 0 0 0-.61.22L2.66 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.61.22l2.39-.96c.5.38 1.04.7 1.63.94l.36 2.54c.05.24.25.42.49.42h3.84c.24 0 .44-.18.49-.42l.36-2.54c.59-.24 1.13-.56 1.63-.94l2.39.96c.22.08.48 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/></svg>',
  hash: '<svg viewBox="0 0 24 24"><path d="M5.88 21 6.6 17H3l.35-2h3.6l1.06-6H4.4l.35-2h3.6l.72-4h2l-.72 4h6l.72-4h2l-.72 4H22l-.35 2h-3.6l-1.06 6h3.61l-.35 2h-3.6l-.72 4h-2l.72-4h-6l-.72 4h-2zm4.13-12-1.06 6h6l1.06-6h-6z"/></svg>',
  unlock: '<svg viewBox="0 0 24 24"><path d="M12 17a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm6-9h-1V6a5 5 0 0 0-9.9-1h2.06A3.1 3.1 0 0 1 15.1 6v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zm0 12H6V10h12v10z"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><path d="M18 8h-1V6a5 5 0 0 0-10 0v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zm-6 9a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm3.1-9H8.9V6a3.1 3.1 0 0 1 6.2 0v2z"/></svg>',
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
  bellOff: '<svg viewBox="0 0 24 24"><path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68c-.6.14-1.14.37-1.63.66L18 12.2V16zM4.27 3 3 4.27l3.07 3.07A5.9 5.9 0 0 0 6 11v5l-2 2v1h14.73l1 1L21 18.73 4.27 3z"/></svg>',
  search: '<svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>',
  gamepad: '<svg viewBox="0 0 24 24"><path d="M21 6H3a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm-10 7H8v3H6v-3H3v-2h3V8h2v3h3v2zm4.5 2a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm4-3a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>',
  penguin: '<svg viewBox="0 0 24 24"><path fill-rule="evenodd" d="M12 2C8.7 2 6.5 4.6 6.5 8v3.2C5 12.6 4 14.8 4 17c0 2.8 3.6 5 8 5s8-2.2 8-5c0-2.2-1-4.4-2.5-5.8V8c0-3.4-2.2-6-5.5-6zm0 8c-2.2 0-4 2.4-4 5.3 0 2.3 1.8 4.2 4 4.2s4-1.9 4-4.2c0-2.9-1.8-5.3-4-5.3zM10 5.6a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2zm4 0a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2zM12 8l-1.4 1.2h2.8z"/></svg>',
  // the call's connection: bars beyond its quality are dimmed (.vp-signal)
  signal: '<svg viewBox="0 0 24 24"><rect class="bar1" x="3" y="15" width="4" height="6" rx="1"/><rect class="bar2" x="10" y="10" width="4" height="11" rx="1"/><rect class="bar3" x="17" y="4" width="4" height="17" rx="1"/></svg>',
  expand: '<svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
  more: '<svg viewBox="0 0 24 24"><path d="M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>',
  info: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>',
  okCircle: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>',
  errorCircle: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>',
  chevronLeft: '<svg viewBox="0 0 24 24"><path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>',
  chevronRight: '<svg viewBox="0 0 24 24"><path d="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>',
  upload: '<svg viewBox="0 0 24 24"><path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5z"/></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/></svg>',
  image: '<svg viewBox="0 0 24 24"><path d="M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>',
  key: '<svg viewBox="0 0 24 24"><path d="M12.65 10A6 6 0 1 0 7 18a6 6 0 0 0 5.65-4H17v4h4v-4h2v-4H12.65zM7 14a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 7V3.5L18.5 9H13z"/></svg>',
};
const icon = (name, cls = '') => h('span', { class: 'icon ' + cls, html: I[name] });

// ---------------------------------------------------------------- notifications and mentions

// Is this notification switched off? (master, its type, a muted person, a muted server)
function suppressed(kind, from, serverId) {
  const st = settings.get();
  return !st.notify || (kind === 'mention' ? !st.notifyMentions : !st.notifyDms) || !!st.notifyMutedUsers[from] || (kind === 'mention' && !!st.notifyMutedServers[serverId]);
}

// The one gate for DMs, mentions and incoming calls. Badges don't go through it.
// `inView`: the conversation is open in the focused window, so no ping.
function notify({ kind, from, serverId, title, body, icon: img, inView, open }) {
  if (suppressed(kind, from, serverId)) return false;
  if (kind !== 'call' && !inView) audio.cue(kind);
  if (document.hasFocus()) return true;
  try {
    const n = new Notification(title, { body, silent: true, icon: typeof img === 'string' && /^(data:image\/|https?:)/.test(img) ? img : undefined });
    n.onclick = () => {
      n.close();
      desktop?.focus?.() || window.focus();
      open?.();
    };
  } catch {} // not allowed here
  return true;
}

// Notification text is plain: one line, no markup
const plainText = (t, m) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 200) || (m?.gif ? 'Sent a GIF' : m?.files?.length ? 'Sent a file' : '');
const mentionTitle = (name, channelName, serverName) => `${name} in #${channelName}` + (serverName ? ` · ${serverName}` : '');

// Dock/taskbar badge: unread DMs plus unread mentions
let lastBadge = -1;
function syncBadge() {
  const n = DM.unreadTotal() + mentionUnread.total();
  if (n !== lastBadge) desktop?.setBadge?.((lastBadge = n));
}

// Mute notifications from a person (anywhere) or from a whole server
const userMuted = (id) => !!settings.get().notifyMutedUsers[id];
function toggleUserMute(id, name) {
  const cur = { ...settings.get().notifyMutedUsers };
  if (cur[id]) delete cur[id];
  else cur[id] = name || 'unknown';
  settings.set({ notifyMutedUsers: cur });
  renderRail();
  renderChannels();
}
const userMuteItem = (id, name) => id !== me()?.id && { label: 'Mute notifications', checked: userMuted(id), run: () => toggleUserMute(id, name) };
const serverMuted = (id) => !!settings.get().notifyMutedServers[id];
function toggleServerMute(id) {
  const cur = { ...settings.get().notifyMutedServers };
  if (cur[id]) delete cur[id];
  else cur[id] = true;
  settings.set({ notifyMutedServers: cur });
  renderRail();
}

// Everything mentionable on a server: @everyone, its roles, the people it knows
function mentionCandidates(server = S.server) {
  const roles = (Array.isArray(server?.roles) ? server.roles : []).filter((r) => r && typeof r.id === 'string' && typeof r.name === 'string' && r.name);
  const people = Object.entries(server?.profiles || {}).filter(([, p]) => p && typeof p.name === 'string' && p.name);
  return [{ kind: 'everyone', id: '', name: 'everyone' }, ...roles.map((r) => ({ kind: 'role', id: r.id, name: r.name, color: r.color })), ...people.flatMap(([id, p]) => [
      { kind: 'user', id, name: p.name },
      { kind: 'user', id, name: `${p.name}#${mentionTag(id)}`, tagged: true }, // tells apart people with the same name
    ]),
  ];
}
// Names more than one person here has (lowercased): those show their #tag
function sharedNames(server = S.server) {
  const seen = new Set();
  const dup = new Set();
  for (const p of Object.values(server?.profiles || {})) {
    const n = typeof p?.name === 'string' && p.name.toLowerCase();
    if (n) (seen.has(n) ? dup : seen).add(n);
  }
  return dup;
}
const nameTag = (id, name, dup = sharedNames()) => (typeof name === 'string' && dup.has(name.toLowerCase()) ? mentionTag(id) : '');
// How a mention of someone or a role reads today: what autocomplete inserts and edits start from
function mentionText(kind, id, server = S.server, dup = sharedNames(server)) {
  if (kind === 'everyone') return '@everyone';
  if (kind === 'role') {
    const r = server?.roles?.find((r) => r.id === id);
    return r ? '@' + r.name : null;
  }
  const n = server?.profiles?.[id]?.name;
  return n ? '@' + n + (nameTag(id, n, dup) ? '#' + mentionTag(id) : '') : null;
}
// The server's mention positions in m.text ([at, length, kind, id]), grouped by position:
// a group of several is an untagged name more than one person has
function spanGroups(m) {
  const spans = Array.isArray(m?.mentions?.spans) ? m.mentions.spans : null;
  if (!spans) return null;
  const byAt = new Map();
  for (const sp of spans) if (Array.isArray(sp) && Number.isInteger(sp[0]) && Number.isInteger(sp[1]) && sp[1] > 0) byAt.set(sp[0], [...(byAt.get(sp[0]) || []), sp]);
  return [...byAt.values()].sort((a, b) => a[0][0] - b[0][0]);
}
// formatText's `mentions`: drawn with today's names, so a rename carries over to old messages
function mentionMarks(m, server = S.server) {
  const groups = spanGroups(m);
  if (!groups) return null;
  const dup = sharedNames(server);
  const mine = new Set(myRoleIds(server));
  const my = me().id;
  return groups.map((group) => {
    const [at, len, kind, id] = group[0];
    const written = String(m.text || '').slice(at + 1, at + len);
    const isMe = group.some(([, , k, i]) => k === 'everyone' || (k === 'user' && i === my) || (k === 'role' && mine.has(i)));
    if (group.length > 1) return { at, len, kind: 'user', id: '', name: written, me: isMe };
    if (kind === 'everyone') return { at, len, kind, id: '', name: 'everyone', me: isMe };
    if (kind === 'role') {
      const r = server?.roles?.find((r) => r.id === id);
      return { at, len, kind, id, name: r?.name || written, color: r?.color, me: isMe };
    }
    const n = server?.profiles?.[id]?.name;
    return { at, len, kind: 'user', id, name: n || written, tag: n ? nameTag(id, n, dup) : '', me: isMe };
  });
}
// A message's text for editing, with its mentions written the way they read today
function editableText(m, server = S.server) {
  let t = String(m.text || '');
  const dup = sharedNames(server);
  const edits = (spanGroups(m) || []).map((group) => {
    const [at, len, kind, id] = group[0];
    return { at, len, now: group.length === 1 && t[at] === '@' && mentionText(kind, id, server, dup) };
  });
  for (const c of channelMarks(m, server) || []) edits.push({ at: c.at, len: c.len, now: !c.gone && t[c.at] === '#' && '#' + c.name });
  for (const { at, len, now } of edits.sort((a, b) => b.at - a.at)) if (now) t = t.slice(0, at) + now + t.slice(at + len);
  return t;
}
// The text channels we can read on the server in view: what #name links to
const textChannels = (server = S.server) => (server?.channels || []).filter((c) => c.type === 'text' && typeof c.name === 'string' && c.name);
// formatText's `channelMarks`, from the server's positions ([at, length, channelId]): drawn with
// today's name. A channel we can't find was deleted or isn't ours to see, and keeps the name as written.
function channelMarks(m, server = S.server) {
  if (!Array.isArray(m?.channels)) return null;
  return m.channels
    .filter((sp) => Array.isArray(sp) && Number.isInteger(sp[0]) && Number.isInteger(sp[1]) && sp[1] > 1)
    .map(([at, len, id]) => {
      const ch = textChannels(server).find((c) => c.id === id);
      return { at, len, id, name: ch ? ch.name : String(m.text || '').slice(at + 1, at + len), gone: !ch };
    });
}
const myRoleIds = (server = S.server) => (Array.isArray(server?.memberRoles?.[me().id]) ? server.memberRoles[me().id] : []);
// For formatText: the same list, flagged with the ones that concern us
function mentionables(server = S.server) {
  const mine = new Set(myRoleIds(server));
  return mentionCandidates(server).map((c) => ({ ...c, me: c.kind === 'everyone' || (c.kind === 'user' && c.id === me().id) || (c.kind === 'role' && mine.has(c.id)) }));
}
// Does this message mention us (or reply to us)? Uses what the server worked out, else works it out (older servers).
function mentionsMe(m, server = S.server, channelId = S.channelId) {
  const my = me().id;
  if (!m || m.author === my) return false;
  const mm = m.mentions;
  if (mm && typeof mm === 'object') {
    const mine = myRoleIds(server);
    return !!(mm.everyone || (Array.isArray(mm.users) && mm.users.includes(my)) || (Array.isArray(mm.roles) && mm.roles.some((r) => mine.includes(r))));
  }
  if (m.replyTo && S.messages.get(channelId)?.find((x) => x.id === m.replyTo)?.author === my) return true;
  if (!m.text || !m.text.includes('@')) return false;
  const mine = new Set(myRoleIds(server));
  return findMentions(m.text, mentionCandidates(server)).some((c) => c.kind === 'everyone' || (c.kind === 'user' && c.id === my) || (c.kind === 'role' && mine.has(c.id)));
}
// Is this channel of the server in view, in the focused window?
const watching = (channelId) => channelId === S.channelId && document.hasFocus() && !S.game.visible;

// Open a channel of a bookmarked server, connecting first if needed
function openChannel(entry, channelId) {
  if (S.entry?.id === entry.id && S.connected) return selectChannel(channelId);
  settings.set({ lastChannel: { ...settings.get().lastChannel, [entry.id]: channelId } });
  connectTo(entry);
}

function pruneMentions(c) {
  const ids = new Set(c.server.channels.map((ch) => ch.id));
  for (const id of Object.keys(mentionUnread.all()[c.entry.id] || {})) if (!ids.has(id)) mentionUnread.clear(c.entry.id, id);
}

// ---------------------------------------------------------------- Steam: the game that is running shows next to our name (D59)

// The desktop app reads it from Steam on this computer. Servers get it as `activity`, DM peers in `hello`.
const STEAM_POLL = 15e3;
let steamName = '';
let steamIcon = ''; // its icon from Steam on this computer: a small data URL, or ''
const sendActivity = (c) => c.connected && c.socket.emit('activity', { game: steamName, icon: steamIcon || undefined });
async function pollSteam() {
  if (!desktop?.steamGame) return;
  const game = settings.get().steamPlaying ? await desktop.steamGame().catch(() => null) : null;
  let name = game?.name || '';
  let icon = name && typeof game.icon === 'string' && game.icon.startsWith('data:image/') ? game.icon : '';
  if (!settings.get().steamPlaying) name = icon = ''; // turned off while we asked
  if (name === steamName && icon === steamIcon) return;
  steamName = name;
  steamIcon = icon;
  for (const c of conns()) sendActivity(c);
  DM.setGame(name, icon);
}
if (desktop?.steamGame) (setInterval(pollSteam, STEAM_POLL), pollSteam());

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
    if (!mine && !m.note) {
      const p = profileOf(peerId);
      notify({ kind: 'dm', from: peerId, title: p.name, body: plainText(m.text, m), icon: p.avatar, inView: watching(cid), open: () => selectChannel(cid) });
    }
    if (!mine && document.hidden) document.title = `(•) ${windowTitle}`;
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
  // Someone mentioned us on a bookmarked server (pushed over its /dm socket). The server in view
  // tells us itself, so this is for the others.
  mention(address, p) {
    const entry = servers.all().find((s) => s.address === address);
    const m = p?.message;
    if (!entry || !m || typeof m !== 'object' || typeof p.channelId !== 'string' || m.author === me().id) return;
    if (S.entry?.id === entry.id && S.connected) return;
    const mm = m.mentions;
    if (!mm || typeof mm !== 'object') return;
    // Role mentions: we can't see our roles here, the server only sent it to the people who hold one
    if (!(mm.everyone || (Array.isArray(mm.users) && mm.users.includes(me().id)) || (Array.isArray(mm.roles) && mm.roles.length))) return;
    mentionUnread.add(entry.id, p.channelId);
    renderRail();
    const name = String(m.name || 'someone').slice(0, 60);
    notify({
      kind: 'mention',
      from: m.author,
      serverId: entry.id,
      title: mentionTitle(name, String(p.channelName || '').slice(0, 60), String(p.serverName || '').slice(0, 60)),
      body: plainText(typeof m.text === 'string' ? m.text : '', m),
      open: () => openChannel(entry, p.channelId),
    });
  },
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

// Friend codes: someone's key, handed over directly, so it is known before the first message (D32, D55)
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
      h('p', { class: 'muted' }, 'A friend code adds someone to your direct messages with their key, so you know it’s really them from the first message. You reach each other through a server you both use. Send yours to a friend, and paste theirs below.'),
      h('label', { class: 'field' }, h('span', {}, 'Their friend code'), theirs),
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'field-head' }, 'Your friend code', h('button', { class: 'btn small ghost link-btn', onclick: () => navigator.clipboard.writeText(code).then(() => toast('Friend code copied', 'success')) }, 'Copy')),
        mine
      ),
      servers.all().length ? null : h('p', { class: 'muted small' }, 'You have no saved servers yet. Direct messages travel through a server you and your friend both use.')
    ),
    { actions: [(c) => h('button', { class: 'btn ghost', onclick: () => c() }, 'Cancel'), (c) => h('button', { class: 'btn', onclick: () => add(c) }, 'Add friend')] }
  );
}

async function trustKeyPrompt(peerId) {
  const name = profileOf(peerId).name;
  const text = `Someone using ${name}’s profile is showing a different key than the one saved on this device, so their messages are being refused. That happens when ${name} lost their profile and made it again, and also when someone is pretending to be them. Ask ${name} before you trust it.`;
  if (await confirmModal('Different key', text, 'Trust the new key', { cancel: 'Not now', titleIcon: 'warn' })) DM.trustNewKey(peerId);
}

async function deleteConversation(peerId) {
  const name = profileOf(peerId).name;
  if (!(await confirmModal('Delete conversation', `Delete your conversation with ${name} from this device? Their copy isn't affected.`, 'Delete conversation'))) return;
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
// What friends are told about our mic. The mic test (Settings) keeps it from them, so it counts as muted.
const micOff = () => S.muted || audio.micTest || forcedMute();

// A watched stream's sound plays through its <video>, outside the audio graph
// (audio.js), so the master volume and the output device are set on each one.
const streamVolume = (v) => v * settings.get().masterVolume;

// A stream's sound, on its tile: the speaker mutes and unmutes it, the slider
// sets its volume. The slider keeps its place while muted, so unmuting brings
// back the volume from before; moving it unmutes. get() answers
// { volume, muted }, set() stores what changed and syncs the tiles.
function streamSound(video, get, set) {
  const btn = h('button', { onclick: () => (set({ muted: !get().muted }), show()) });
  const el = h(
    'div',
    { class: 'stream-volume' },
    btn,
    h('input', {
      type: 'range',
      min: 0,
      max: 1,
      step: 0.01,
      value: get().volume,
      title: 'Stream volume',
      oninput: (e) => {
        const volume = +e.target.value;
        video.volume = streamVolume(volume);
        set(get().muted ? { volume, muted: false } : { volume });
        show();
      },
    })
  );
  const show = () => {
    const { muted } = get();
    btn.title = muted ? 'Unmute stream' : 'Mute stream';
    btn.replaceChildren(icon(muted ? 'speakerOff' : 'speaker'));
    el.classList.toggle('muted', muted);
  };
  show();
  return el;
}
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
  DMCALL.sync(micOff(), S.deafened);
  DMCALL.start(peerId, video);
}

// `camera`: answer a video call with ours on too
async function acceptDmCall(camera = false) {
  const c = DMCALL.cur;
  if (c?.state !== 'ringing') return;
  if (S.call) leaveVoice();
  audio.ensure();
  DMCALL.sync(micOff(), S.deafened);
  selectChannel('dm:' + c.peerId);
  await DMCALL.accept();
  if (camera === true && DMCALL.voice && !DMCALL.voice.local.camera) toggleCamera();
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
  const off = S.muted || S.deafened || forcedMute();
  const all = [
    compact ? null : h('button', { class: 'icon-btn' + (off ? ' off' : ''), title: (forcedMute() ? 'Muted by a moderator' : off ? 'Unmute' : 'Mute') + MIC_HINT, onclick: toggleMute, oncontextmenu: micMenu }, icon(off ? 'micOff' : 'mic')),
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
    compact || dmCallUi.pop ? null : h('button', { class: 'icon-btn' + (dmCallUi.max ? ' on' : ''), title: dmCallUi.max ? 'Show the chat' : 'Hide the chat', onclick: () => ((dmCallUi.max = !dmCallUi.max), renderDmCall()) }, icon('expand')),
    hangup('Hang up'),
  ];
  return all.filter(Boolean);
}

// The call's view sits on top of the conversation with that person, so it only
// shows (and video is only received at full size) while that DM is open. The
// sidebar panel and the incoming-call card show wherever you are. The video
// (ui.view: the stats line, its buttons and the tiles) can be in a window of
// its own instead (popOutDmCall), where it shows whatever is open in the app.
// pop: that window ({ win, name, ready, onTop }); timer, history, statsPanel: see startStats
const dmCallUi = { call: null, el: null, view: null, tiles: new Map(), focus: null, max: false, volume: 1, muted: false, ringing: null, ringTimer: null, pop: null, timer: null, statsPanel: null };

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
      // A caller you muted still shows the card, but doesn't ring or notify
      if (ringing !== 'ringing' || !suppressed('call', c.peerId)) {
        audio.cue(cue);
        ui.ringTimer = setInterval(() => audio.cue(cue), ringing === 'ringing' ? 2000 : 3000);
      }
      if (ringing === 'ringing') {
        notify({ kind: 'call', from: c.peerId, title: p.name, body: c.video ? 'Incoming video call' : 'Incoming call', icon: p.avatar, open: () => selectChannel('dm:' + c.peerId) });
        if (document.hidden) document.title = `(•) ${windowTitle}`;
      }
    }
  }

  const card = $('#call-ring');
  card.hidden = c?.state !== 'ringing';
  // A stacked card that can't be missed (D72): role="alertdialog", so it's announced
  card.setAttribute('role', 'alertdialog');
  card.setAttribute('aria-label', card.hidden ? '' : `${dmCallStatus(c)} from ${p.name}`);
  card.replaceChildren(
    ...(card.hidden
      ? []
      : [
          h('div', { class: 'cr-who' }, h('div', { class: 'cr-av' }, avatarEl(p, 48)), h('div', { class: 'cr-text' }, h('strong', {}, p.name), h('span', { class: 'muted small' }, dmCallStatus(c) + '…'))),
          h(
            'div',
            { class: 'cr-btns' },
            h('button', { class: 'btn danger', onclick: () => DMCALL.hangup() }, icon('hangup'), 'Decline'),
            h('button', { class: 'btn accept', onclick: () => acceptDmCall() }, icon('phone'), 'Accept')
          ),
          c.video ? h('button', { class: 'btn small ghost', onclick: () => acceptDmCall(true) }, 'Accept with camera') : null,
        ].filter(Boolean))
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
    clearInterval(ui.timer);
    ui.statsPanel?.close();
    const old = ui.pop;
    ui.pop = null; // first: its window closing would move the view back
    if (old && !old.win.closed) old.win.close();
    ui.ro?.disconnect();
    ui.view?.remove();
    ui.el?.remove();
    Object.assign(ui, { call: c, el: null, view: null, focus: null, max: false, volume: 1, muted: false, timer: null });
    if (c) {
      ui.main = h('div', { class: 'stage-main' });
      ui.grid = h('div', { class: 'stage-grid' });
      ui.body = h('div', { class: 'stage' }, ui.main, ui.grid);
      ui.stats = h('span', { class: 'muted small stream-stats' });
      ui.topBtns = h('div', { class: 'stage-controls' });
      ui.top = h('div', { class: 'call-top' }, ui.stats, h('div', { class: 'spacer' }), ui.topBtns);
      ui.view = h('div', { class: 'call-view' }, ui.top, ui.body);
      ui.bar = h('div', { class: 'call-bar' });
      ui.el = h('div', { class: 'call-stage' }, ui.view, ui.bar);
      ui.ro = new ResizeObserver(() => layoutStage(ui));
      ui.ro.observe(ui.grid);
      // The "socket ids" of a call's VoiceClient are profile ids
      startStats(ui, { tile: dmStatsTile, voice: () => DMCALL.voice, name: (sid) => profileOf(sid).name });
    }
  }
  const head = c && S.channelId === 'dm:' + c.peerId ? $('#main > .chat-header') : null;
  const pop = ui.pop?.ready ? ui.pop : null;
  $('#main').classList.toggle('call-max', !!head && ui.max && !ui.pop);
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
  const video = want.some((w) => w.kind !== 'user');
  ui.el.classList.toggle('has-video', video);
  ui.el.classList.toggle('popped', !!pop);
  ui.top.hidden = !video && !pop;
  if (pop) pop.win.document.title = 'Call with ' + p.name;
  const fullscreen = () => (ui.body.ownerDocument.fullscreenElement ? ui.body.ownerDocument.exitFullscreen() : ui.body.requestFullscreen?.().catch(() => {}));
  ui.topBtns.replaceChildren(
    ...[
      focused ? h('button', { class: 'btn small ghost', title: 'Show everything', onclick: () => ((ui.focus = null), renderDmCall()) }, 'Grid') : null,
      pop && desktop?.streamOnTop
        ? h(
            'button',
            { class: 'btn small ghost', title: 'Keep this window above other windows', onclick: () => ((pop.onTop = !pop.onTop), desktop.streamOnTop(pop.name, pop.onTop), renderDmCall()) },
            pop.onTop ? 'On top ✓' : 'Keep on top'
          )
        : null,
      pop
        ? h('button', { class: 'btn small ghost', title: 'Show the call’s video in the conversation again', onclick: () => (dockDmCall(), desktop?.focus?.()) }, 'Back to app')
        : h('button', { class: 'btn small ghost', title: 'Open the call’s video in a window of its own', disabled: !!ui.pop, onclick: () => popOutDmCall() }, 'Pop out'),
      h('button', { class: 'icon-btn', title: 'Fullscreen', onclick: fullscreen }, icon('expand')),
    ].filter(Boolean)
  );

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
    if (src && (head || pop) && t.video.paused) t.video.play().catch(() => {});
    t.status.hidden = !!src;
    if (t.kind === 'screen') {
      t.video.muted = !theirs || S.deafened || audio.micTest || ui.muted;
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
  const tile = { key, who, sid: who, kind, el: null, video: null, status: null, flag: null }; // sid: for startStats
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
      const doc = tile.el.ownerDocument; // the app's page, or the video's own window
      if (tile.video) doc.fullscreenElement ? doc.exitFullscreen() : tile.el.requestFullscreen?.().catch(() => {});
    },
  };
  if (kind !== 'screen') {
    attrs['data-who'] = who; // speaking outline
    tile.flag = h('span', { class: 'tile-flag' });
  }
  const label = h('span', { class: 'tile-name' }, kind === 'screen' ? (mine ? 'Your screen' : p.name + '’s screen') : mine ? 'You' : p.name, kind === 'screen' ? h('span', { class: 'live-badge' }, 'LIVE') : tile.flag);
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
      streamSound(video, () => ui, (o) => (Object.assign(ui, o), renderDmCall()))
    );
  }
  tile.el = h('div', attrs, video, tile.status, label, controls);
  if (!mine) {
    // Tell them how many device pixels we show, so their encoder is no bigger
    // than that, and pauses while we can't see it (window hidden, or another
    // channel open). The window is the one the video is in.
    let timer;
    let last = '';
    tile.report = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const doc = video.ownerDocument;
        const dpr = doc.defaultView?.devicePixelRatio || 1;
        const view = { w: Math.round(video.clientWidth * dpr), h: Math.round(video.clientHeight * dpr), hidden: doc.hidden || !video.isConnected };
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

// The stream the call's stats are about: the focused one, else a screen share, else a camera
function dmStatsTile() {
  const ui = dmCallUi;
  if (!ui.view?.isConnected) return null; // another channel is open: nothing is shown
  const live = [...ui.tiles.values()].filter((t) => t.video?.srcObject);
  return live.find((t) => t.key === ui.focus) || live.find((t) => t.kind === 'screen') || live.find((t) => t.who !== me().id) || live[0] || null;
}

// "Pop out": the call's video moves to a window of its own, like the stage's
// (popOutStage). The call's buttons stay with the conversation, since their
// menus are drawn in the app's page. Closing the window brings the video back.
function popOutDmCall() {
  const ui = dmCallUi;
  if (!ui.call) return;
  if (ui.pop) return ui.pop.win.focus();
  const view = ui.view;
  ui.pop = popWindow({
    alive: (pop) => ui.pop === pop && ui.view === view,
    ready(host) {
      ui.statsPanel?.close();
      host.replaceChildren(view);
      dmCallMoved();
    },
    // This page's observers don't see sizes change in another window
    changed() {
      layoutStage(ui);
      for (const t of ui.tiles.values()) t.report?.();
    },
    closed: () => dockDmCall(),
  });
  renderDmCall();
}

function dockDmCall() {
  const ui = dmCallUi;
  const pop = ui.pop;
  if (!pop) return;
  ui.pop = null;
  if (pop.ready) ui.el.prepend(ui.view);
  if (!pop.win.closed) pop.win.close();
  dmCallMoved();
}

// A video stops when its element moves to another page
function dmCallMoved() {
  for (const t of dmCallUi.tiles.values()) if (t.video?.srcObject) t.video.play().catch(() => {});
  renderDmCall();
}

// The call clock, and who's speaking
setInterval(() => {
  const c = DMCALL.cur;
  if (c?.state === 'active') for (const el of $$('.call-status')) el.textContent = dmCallStatus(c);
}, 1000);
setInterval(() => {
  const v = DMCALL.voice;
  if (!v || !dmCallUi.view?.isConnected) return;
  const levels = v.levels();
  if (audio.selfAnalyser) levels.set(me().id, Level(audio.selfAnalyser));
  // The tiles may be in a window of their own
  for (const { el } of dmCallUi.tiles.values()) if (el.dataset.who) el.classList.toggle('speaking', (levels.get(el.dataset.who) || 0) > 0.02);
}, 90);

// ---------------------------------------------------------------- toasts, modals, popovers

// kind: info, success or error. `action` ({ label, run }) adds a button, such as Undo. The timer
// waits while the pointer is on it.
const TOAST_ICONS = { info: 'info', success: 'okCircle', error: 'errorCircle' };
function toast(text, kind = 'info', ms = 3500, { action } = {}) {
  let t1, t2;
  const out = (after) => {
    clearTimeout(t1);
    clearTimeout(t2);
    t1 = setTimeout(() => el.classList.add('out'), after);
    t2 = setTimeout(() => el.remove(), after + 400);
  };
  const el = h(
    'div',
    {
      class: 'toast ' + kind,
      role: kind === 'error' ? 'alert' : 'status',
      onmouseenter: () => (clearTimeout(t1), clearTimeout(t2), el.classList.remove('out')),
      onmouseleave: () => out(1500),
    },
    icon(TOAST_ICONS[kind] || 'info', 'toast-icon'),
    h('span', { class: 'toast-text' }, text),
    action ? h('button', { class: 'btn small ghost toast-action', onclick: () => (action.run(), out(0)) }, action.label) : null
  );
  $('#toasts').append(el);
  out(ms);
}

// Open modals, innermost last: only it answers Escape and keeps Tab inside (D72)
const modals = [];
const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
const focusables = (root) => [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length && !el.closest('[hidden], .tip'));

// `actions`: buttons for the foot (or functions of `close` that return one); one with the class
// "side" goes at the left. `size: 'sm'` for confirms, `wide` for settings and lists. `alert`: a
// question about something that can't be undone (role="alertdialog", the focus starts on Cancel).
function modal(title, body, { actions = [], wide = false, size = '', dismissable = true, onClose, alert = false, titleIcon, className = '' } = {}) {
  const opener = document.activeElement;
  const id = 'modal-' + uid();
  const close = () => {
    const i = modals.indexOf(entry);
    if (i < 0) return;
    modals.splice(i, 1);
    root.remove();
    onClose?.();
    // Back to whatever opened it, unless that went away meanwhile
    if (opener?.isConnected && opener !== document.body && !modals.at(-1)?.box.contains(document.activeElement)) opener.focus({ preventScroll: true });
  };
  const box = h(
    'div',
    {
      class: ['modal', wide && 'wide', size, className].filter(Boolean).join(' '),
      role: alert ? 'alertdialog' : 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': id,
      tabindex: '-1',
    },
    h(
      'div',
      { class: 'modal-head' },
      h('h2', { id }, titleIcon ? icon(titleIcon, 'title-icon ' + titleIcon) : null, title),
      dismissable && h('button', { class: 'icon-btn close', title: 'Close', 'aria-label': 'Close', onclick: () => close() }, icon('close'))
    ),
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('div', { class: 'modal-foot' }, actions.map((a) => (typeof a === 'function' ? a(close) : a))) : null
  );
  const root = h('div', { class: 'modal-backdrop', onmousedown: (e) => dismissable && e.target === root && close() }, box);
  const entry = { box, close, dismissable };
  modals.push(entry);
  $('#modal-root').append(root);
  setTimeout(() => {
    if (box.contains(document.activeElement) || modals.at(-1) !== entry) return;
    const field = box.querySelector('.modal-body input:not([type="hidden"]):not([readonly]):not([type="checkbox"]):not([type="range"]), .modal-body textarea:not([readonly]), .modal-body select');
    const cancel = alert && [...box.querySelectorAll('.modal-foot .btn.ghost')].find((b) => !b.classList.contains('danger'));
    (field || cancel || box).focus({ preventScroll: true });
  }, 30);
  return close;
}
document.addEventListener('keydown', (e) => {
  const top = modals.at(-1);
  if (!top) return;
  if (e.key === 'Escape' && !e.defaultPrevented) {
    if (top.dismissable) (e.preventDefault(), top.close());
    return;
  }
  if (e.key !== 'Tab') return;
  // A popover opened from the dialog (a picker) keeps its own Tab order
  if (activePopover?.el.contains(document.activeElement)) return;
  const list = focusables(top.box);
  if (!list.length) return e.preventDefault();
  const i = list.indexOf(document.activeElement);
  if (i < 0 || (e.shiftKey && i === 0) || (!e.shiftKey && i === list.length - 1)) {
    e.preventDefault();
    list[i < 0 ? 0 : e.shiftKey ? list.length - 1 : 0].focus();
  }
});

function promptModal(title, label, value = '', okLabel = 'Save') {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { value, onkeydown: (e) => e.key === 'Enter' && ok() });
    const ok = () => {
      done = true;
      close();
      resolve(input.value.trim());
    };
    const close = modal(title, h('label', { class: 'field' }, h('span', {}, label), input), {
      actions: [h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'), h('button', { class: 'btn', onclick: ok }, okLabel)],
      onClose: () => !done && resolve(null),
    });
  });
}

// Asks for the passphrase of a profile file; resolves to it, or null
function askPassphrase() {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { type: 'password', autocomplete: 'off', onkeydown: (e) => e.key === 'Enter' && ok() });
    const ok = () => {
      done = true;
      close();
      resolve(input.value);
    };
    const close = modal('Profile passphrase', h('label', { class: 'field' }, h('span', {}, 'This profile file is protected. Enter its passphrase.'), input), {
      actions: [h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'), h('button', { class: 'btn', onclick: ok }, 'Open')],
      onClose: () => !done && resolve(null),
    });
  });
}

// Export a profile: its file holds the keys to that identity, so it is offered a passphrase
function exportDialog(p) {
  const pass = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'passphrase' });
  const again = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'again', onkeydown: (e) => e.key === 'Enter' && save() });
  const save = async () => {
    if (pass.value !== again.value) return toast('The two passphrases differ', 'error');
    try {
      await exportProfile(p, pass.value);
      close();
    } catch (e) {
      toast('Could not export the profile: ' + e.message, 'error');
    }
  };
  const close = modal(
    `Export ${p.name}`,
    h(
      'div',
      {},
      h('p', { class: 'muted' }, 'The file holds this profile’s keys. Whoever can read them can read and write your direct messages as you, so protect the file with a passphrase. You will need it to import the profile on another device.'),
      h('label', { class: 'field' }, h('span', {}, 'Passphrase'), pass),
      h('label', { class: 'field' }, h('span', {}, 'Repeat it'), again),
      h('p', { class: 'muted small' }, 'Left empty, the keys are saved unprotected. Only do that if the file never leaves your hands.')
    ),
    { actions: [h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'), h('button', { class: 'btn', onclick: save }, 'Export')] }
  );
}

// A yes/no question about something that can't be undone. `okLabel` names the action ("Delete
// channel", not "Delete", D72). `side`: { label, run } for a third choice at the left of the foot.
function confirmModal(title, text, okLabel, { side, cancel = 'Cancel', titleIcon } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const close = modal(title, typeof text === 'string' ? h('p', { class: 'confirm-text' }, text) : text, {
      size: 'sm',
      alert: true,
      titleIcon,
      actions: [
        side ? h('button', { class: 'btn ghost side', onclick: () => (close(), side.run()) }, side.label) : null,
        h('button', { class: 'btn ghost', onclick: () => close() }, cancel),
        h('button', { class: 'btn danger', onclick: () => ((done = true), close(), resolve(true)) }, okLabel),
      ].filter(Boolean),
      onClose: () => !done && resolve(false),
    });
  });
}

let activePopover = null;
function closePopover() {
  activePopover?.close();
}
// `doc`: the page it opens in, when that isn't the app's (the stage in a window of its own).
// Escape, or a press outside, closes it; the focus goes back to whatever had it before.
function popover(anchor, content, { align = 'end', className = '', onClose, doc = document } = {}) {
  closePopover();
  const opener = doc.activeElement;
  const el = h('div', { class: 'popover ' + className }, content);
  (doc === document ? $('#popovers') : doc.body).append(el);
  const { innerWidth, innerHeight } = doc.defaultView;
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
  const onDown = (e) => !el.contains(e.target) && !anchor.contains(e.target) && !e.target.closest?.('.modal-backdrop') && close();
  // In the capture phase, so Escape closes only the popover and not a dialog under it
  const onKey = (e) => e.key === 'Escape' && (e.stopPropagation(), e.preventDefault(), close());
  const close = () => {
    if (!el.isConnected) return;
    const had = el.contains(doc.activeElement);
    el.remove();
    doc.removeEventListener('mousedown', onDown, true);
    doc.removeEventListener('keydown', onKey, true);
    if (activePopover?.el === el) activePopover = null;
    if (had && opener?.isConnected && opener !== doc.body) opener.focus({ preventScroll: true });
    onClose?.();
  };
  setTimeout(() => {
    doc.addEventListener('mousedown', onDown, true);
    doc.addEventListener('keydown', onKey, true);
  });
  activePopover = { el, close, place };
  return activePopover;
}

// A menu's items (D72). Each is { label, run } with any of:
//   danger         red, and goes after a separator at the end
//   checked        an on/off item with a box (menuitemcheckbox)
//   selected       one of several choices; the chosen one gets a check at the end (menuitemradio)
//   disabled, why  shown but not usable; `why` says why, in its tooltip
//   kbd            the shortcut, as keycaps
//   icon, avatar   a leading icon from the set, or someone's avatar
// '-' is a separator (doubles and ones at the ends are dropped), { heading } a label, { note } a line of text.
function menuEl(items, close, label) {
  const list = items.filter(Boolean).filter((it, i, all) => it !== '-' || (i > 0 && i < all.length - 1 && all[i + 1] !== '-'));
  const iconCol = list.some((it) => it.icon); // labels line up when some items have an icon and some don't
  const el = h(
    'div',
    { class: 'menu', role: 'menu', 'aria-label': label || null, tabindex: '-1' },
    list.map((it) => {
      if (it === '-') return h('div', { class: 'menu-sep', role: 'separator' });
      if (it.heading) return h('div', { class: 'menu-label', role: 'presentation' }, it.heading);
      if (it.note) return h('div', { class: 'menu-note', role: 'presentation' }, it.note);
      const role = 'checked' in it ? 'menuitemcheckbox' : 'selected' in it ? 'menuitemradio' : 'menuitem';
      return h(
        'button',
        {
          class: 'menu-item' + (it.danger ? ' danger' : '') + (it.selected ? ' selected' : ''),
          role,
          'aria-checked': role === 'menuitem' ? null : String(!!(it.checked ?? it.selected)),
          'aria-disabled': it.disabled ? 'true' : null,
          title: it.disabled && it.why ? it.why : null,
          tabindex: '-1',
          onclick: () => {
            if (it.disabled) return;
            close();
            it.run();
          },
        },
        role === 'menuitemcheckbox' ? h('span', { class: 'menu-check', html: it.checked ? I.check : '' }) : it.avatar ? avatarEl(it.avatar, 24) : it.icon ? icon(it.icon, 'menu-icon') : iconCol ? h('span', { class: 'icon menu-icon' }) : null,
        h('span', { class: 'menu-text' }, it.label),
        it.kbd ? h('kbd', { class: 'menu-kbd' }, it.kbd) : null,
        it.selected ? icon('check', 'menu-end') : null
      );
    })
  );
  menuKeys(el, close);
  return el;
}

// ↑ ↓ Home End move, a letter jumps to the next item starting with it, Tab closes (focus goes back)
function menuKeys(el, close) {
  el.addEventListener('keydown', (e) => {
    const items = [...el.querySelectorAll('.menu-item')];
    if (!items.length) return;
    const i = items.indexOf(el.ownerDocument.activeElement);
    let n = null;
    if (e.key === 'ArrowDown') n = (i + 1) % items.length;
    else if (e.key === 'ArrowUp') n = (i <= 0 ? items.length : i) - 1;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = items.length - 1;
    else if (e.key === 'Tab') return (e.preventDefault(), close());
    else if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const k = e.key.toLowerCase();
      for (let j = 1; j <= items.length && n == null; j++) {
        const c = items[(i + j) % items.length];
        if (c.textContent.trim().toLowerCase().startsWith(k)) n = (i + j) % items.length;
      }
    }
    if (n == null) return;
    e.preventDefault();
    items[n].focus();
  });
}

// Was the last thing the person did a key? (A menu opened from the keyboard focuses its first item.)
let byKeyboard = false;
addEventListener('keydown', () => (byKeyboard = true), true);
addEventListener('pointerdown', () => (byKeyboard = false), true);

// A menu in a popover, from a button
function menuPopover(anchor, items, { align = 'start', label, className = '', doc } = {}) {
  let p;
  const el = menuEl(items, () => p.close(), label);
  p = popover(anchor, el, { align, className: 'menu-pop ' + className, doc });
  (byKeyboard ? el.querySelector('.menu-item') || el : el).focus({ preventScroll: true });
  return p;
}

// A right-click menu (also Shift+F10 and the menu key on whatever has the focus). See menuEl for `items`.
function contextMenu(e, items, label) {
  e.preventDefault();
  if (!items.some((it) => it && it !== '-' && !it.heading)) return;
  const at = e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : null;
  const target = e.target;
  const anchor = {
    getBoundingClientRect: () => {
      if (at) return { left: at.x, right: at.x, top: at.y, bottom: at.y };
      const r = target.getBoundingClientRect();
      return { left: r.left + 8, right: r.left + 8, top: r.bottom, bottom: r.bottom };
    },
    contains: () => false,
  };
  const doc = target.ownerDocument || document;
  let p;
  const el = menuEl(items, () => p.close(), label);
  p = popover(anchor, el, { align: 'start', className: 'menu-pop', doc });
  if (!at) p.place(); // below the element, not above
  (byKeyboard ? el.querySelector('.menu-item') || el : el).focus({ preventScroll: true });
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'F10' || !e.shiftKey) return;
  const t = document.activeElement;
  if (!t || t === document.body) return;
  e.preventDefault();
  t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
});

// ---------------------------------------------------------------- tooltips (D72)
//
// Icon buttons and rail icons keep using `title`. When the pointer or the keyboard reaches one, the
// title moves to data-tip (so the browser's own tooltip stays away) and shows here instead: after a
// pause on hover, at once on keyboard focus, with the shortcut from data-kbd. Lines after the first
// (the rail's) are drawn smaller. An icon-only button without a label gets the first line as one.
const TIP_DELAY = 400;
const tip = { el: null, target: null, timer: null };
function tipTarget(node) {
  const t = node?.closest?.('[title], [data-tip]');
  if (!t || t.closest('.tip, emoji-picker')) return null;
  if (t.hasAttribute('title')) {
    const text = t.getAttribute('title');
    t.removeAttribute('title');
    if (text) t.dataset.tip = text;
    else delete t.dataset.tip;
    if ((t.tagName === 'BUTTON' || t.tagName === 'A') && text && (!t.hasAttribute('aria-label') || t.dataset.tipLabel) && !t.textContent.trim()) {
      t.setAttribute('aria-label', text.split('\n')[0]);
      t.dataset.tipLabel = '1';
    }
  }
  return t.dataset.tip ? t : null;
}
function hideTip() {
  clearTimeout(tip.timer);
  tip.el?.remove();
  tip.el = tip.target = null;
}
function showTip(t) {
  hideTip();
  if (!t.isConnected) return;
  const [first, ...rest] = t.dataset.tip.split('\n');
  const el = h('div', { class: 'tip', role: 'tooltip' }, h('div', { class: 'tip-main' }, first, t.dataset.kbd ? h('kbd', {}, t.dataset.kbd) : null), rest.map((l) => h('div', { class: 'tip-line' }, l)));
  document.body.append(el);
  const r = t.getBoundingClientRect();
  const w = el.offsetWidth;
  const ht = el.offsetHeight;
  let left, top;
  if (t.closest('#rail')) [left, top] = [r.right + 10, r.top + r.height / 2 - ht / 2];
  else {
    [left, top] = [r.left + r.width / 2 - w / 2, r.top - ht - 6];
    if (top < 6) top = r.bottom + 6;
  }
  el.style.left = Math.max(6, Math.min(left, innerWidth - w - 6)) + 'px';
  el.style.top = Math.max(6, Math.min(top, innerHeight - ht - 6)) + 'px';
  tip.el = el;
  tip.target = t;
}
document.addEventListener('pointerover', (e) => {
  const t = tipTarget(e.target);
  if (t === tip.target) return;
  hideTip();
  if (t) tip.timer = setTimeout(() => t.matches(':hover') && showTip(t), TIP_DELAY);
});
document.addEventListener('pointerout', (e) => {
  if (tip.target && !tip.target.contains(e.relatedTarget)) hideTip();
});
document.addEventListener('focusin', (e) => {
  const t = tipTarget(e.target);
  if (t && /^(BUTTON|A)$/.test(t.tagName) && t === e.target && t.matches(':focus-visible')) showTip(t);
  else if (t !== tip.target) hideTip();
});
document.addEventListener('focusout', () => hideTip());
document.addEventListener('pointerdown', () => hideTip(), true);
document.addEventListener('keydown', (e) => e.key === 'Escape' && tip.el && hideTip(), true);
document.addEventListener('scroll', () => hideTip(), true);

// ---------------------------------------------------------------- controls (D72)

// On/off for an option that applies at once
function switchEl(checked, onchange, label, { disabled = false } = {}) {
  const el = h('button', {
    class: 'switch',
    role: 'switch',
    'aria-checked': String(!!checked),
    'aria-label': label,
    disabled,
    onclick: () => {
      const on = el.getAttribute('aria-checked') !== 'true';
      el.setAttribute('aria-checked', String(on));
      onchange(on);
    },
  });
  return el;
}

// Two to four choices side by side. options: [[value, label]]; arrows move between them.
function segmented(options, value, onchange, label, { disabled = false } = {}) {
  const el = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label });
  const set = (v, focus) => {
    for (const b of el.children) {
      const on = b.dataset.value === String(v);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
  };
  el.append(
    ...options.map(([v, text]) =>
      h('button', { role: 'radio', 'data-value': String(v), disabled, onclick: () => (set(v), onchange(v)) }, text)
    )
  );
  el.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const i = options.findIndex(([v]) => el.querySelector('[aria-checked="true"]')?.dataset.value === String(v));
    const [v] = options[(i + step + options.length) % options.length];
    set(v, true);
    onchange(v);
  });
  set(value);
  return el;
}

// A setting: its name and help on the left, its control on the right
function settingRow(title, help, control, { dim = false, id } = {}) {
  return h('div', { class: 'setting-row' + (dim ? ' dim' : ''), id }, h('div', { class: 'sr-label' }, h('div', { class: 'sr-title' }, title), help ? h('div', { class: 'sr-help' }, help) : null), control);
}

// Inherit / allow / deny for a permission that may be unset (undefined, true or false)
function triState(value, onChange, label, { disabled = false, inherit = 'Inherit' } = {}) {
  const key = (v) => (v === true ? 'allow' : v === false ? 'deny' : 'inherit');
  const el = segmented(
    [
      ['inherit', h('span', { class: 'tri-i', 'aria-hidden': 'true' }, '/')],
      ['allow', icon('check')],
      ['deny', icon('close')],
    ],
    key(value),
    (k) => onChange(k === 'allow' ? true : k === 'deny' ? false : undefined),
    label,
    { disabled }
  );
  el.classList.add('tri');
  const names = { inherit, allow: 'Allow', deny: 'Deny' };
  for (const b of el.children) (b.setAttribute('aria-label', names[b.dataset.value]), (b.title = names[b.dataset.value]));
  return el;
}

// A shortcut, shown as keycaps: click it, then press the keys. Escape clears it when `clearable`, and
// otherwise leaves it as it was; so does leaving the field. `read` turns the key event into the value
// (null: keep listening), `show` the value into "Ctrl+M" style text.
function hotkeyField(value, onSet, { label, read = comboFromEvent, show = (v) => v, clearable = true } = {}) {
  const btn = h('button', { class: 'hotkey-btn', 'aria-label': label });
  const draw = (v) => btn.replaceChildren(...(v ? show(v).split('+').map((k) => h('kbd', { class: 'key' }, k)) : [h('span', { class: 'muted' }, 'Click to set')]));
  btn.onclick = () => {
    if (btn.classList.contains('listening')) return;
    btn.classList.add('listening');
    btn.replaceChildren(h('span', {}, clearable ? 'Press a key… (Esc clears)' : 'Press a key… (Esc cancels)'));
    const done = () => {
      btn.classList.remove('listening');
      window.removeEventListener('keydown', onKey, true);
      btn.removeEventListener('blur', done);
      draw(value);
    };
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape' && !clearable) return done();
      const v = e.key === 'Escape' ? '' : read(e);
      if (v == null) return; // a modifier on its own
      value = v;
      onSet(v);
      done();
    };
    window.addEventListener('keydown', onKey, true);
    btn.addEventListener('blur', done);
  };
  draw(value);
  return btn;
}

// Marks under a slider: [[fraction of the track, label]]
function rangeTicks(marks) {
  return h('div', { class: 'range-ticks', 'aria-hidden': 'true' }, marks.map(([at, label]) => h('span', { style: { left: at * 100 + '%' }, class: at === 0 ? 'first' : at === 1 ? 'last' : '' }, label)));
}

// An empty list: an icon, a line, a line of help and at most one action
function emptyState(iconName, title, help, action) {
  return h('div', { class: 'empty' }, iconName ? icon(iconName, 'empty-icon') : null, h('strong', {}, title), help ? h('span', { class: 'muted small' }, help) : null, action || null);
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

// Role tags (roles and what they allow are set in Server settings or the admin dashboard). The server's order is the display order.
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
  // a DM contact may not be on the server in view
  const game = live?.game ? playingEl(live.game, live.gameIcon) : playingEl(DM.gameOf(p.id), DM.gameIconOf(p.id));
  // the game comes from the DM link when the contact isn't on this server; the camera is left out, as before
  const doing = live ? [...activityParts({ ...live, camera: false, game: null }), game].filter(Boolean) : [game || (p.seen && p.id !== me()?.id ? 'Last seen ' + fmtTime(p.seen) : '')].filter(Boolean);
  const other = S.connected && p.id && p.id !== me()?.id && S.server?.profiles?.[p.id];
  const roles = rolesOf(p.id);
  // Moderation sits behind "More", so Ban is never one stray click from Message (D72)
  const more = other ? memberItems(p.id, anchor, align).filter((it) => it !== '-') : [];
  const pop = popover(
    anchor,
    h(
      'div',
      { class: 'profile-card', role: 'dialog', 'aria-label': p.name },
      profileCardHead(p, [doing.length ? h('div', { class: 'small pc-doing' }, doing) : null, roles.length ? h('div', { class: 'role-tags' }, roles.map(roleTag)) : null]),
      other
        ? h(
            'div',
            { class: 'pc-actions' },
            h('button', { class: 'btn small grow', onclick: () => (pop.close(), openDm(p.id)) }, 'Message'),
            more.length ? h('button', { class: 'icon-btn outline', title: `More for ${p.name}`, onclick: (e) => {
                      // Where the button is now: the card closes when the menu opens, and the row it came from may be redrawn
                      const r = e.currentTarget.getBoundingClientRect();
                      menuPopover({ getBoundingClientRect: () => r, contains: () => false }, memberItems(p.id, anchor, align), { align: 'end', label: p.name });
                    } }, icon('more')) : null
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
      { class: 'field banner-edit' },
      h('span', {}, 'Profile background'),
      h(
        'div',
        { class: 'banner-grid' },
        card,
        h(
          'div',
          { class: 'banner-controls' },
          h(
            'div',
            { class: 'row tight' },
            imageChoices({ size: IMG.banner, dropOn: [card], onPick: (v) => ((draft.banner = v), refresh()) }),
            bannerColor,
            h('button', { class: 'btn small ghost danger', onclick: () => ((draft.banner = ''), refresh()) }, 'Remove')
          ),
          h('span', { class: 'muted small' }, 'Image, GIF or color. Shown when friends click your name. You can also drop an image on the card.')
        )
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
  $('#main').replaceChildren(); // the start-up spinner
  const { el, draft } = profileEditor({ name: '', color: randomColor(), avatar: '', status: '' });
  const importInput = h('input', {
    type: 'file',
    accept: '.json,application/json',
    hidden: true,
    onchange: async () => {
      try {
        warnIfKeyless(await importProfile(importInput.files[0], askPassphrase));
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
      h('p', { class: 'muted' }, 'No sign-up, no accounts. Your profile is saved only on this device.'),
      el,
      importInput
    ),
    {
      dismissable: false,
      wide: true,
      className: 'auto-height',
      actions: [
        h('button', { class: 'btn ghost side', onclick: () => importInput.click() }, 'Import profile…'),
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
          'Create profile'
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
              class: 'rail-server rail-dm' + (S.channelId === 'dm:' + c.id ? ' active' : '') + (userMuted(c.id) ? ' silenced' : ''),
              title: c.name + (DM.online(c.id) ? '' : ' (offline)') + (DM.gameOf(c.id) ? '\n' + playingText(DM.gameOf(c.id)) : '') + (userMuted(c.id) ? '\nNotifications muted' : ''),
              onclick: () => selectChannel('dm:' + c.id),
              oncontextmenu: (e) => contextMenu(e, dmItems(c), c.name),
            },
            avatarEl(c, 44),
            h('span', { class: 'presence' + (DM.online(c.id) ? '' : ' off') }),
            userMuted(c.id) ? h('span', { class: 'rail-muted', html: I.bellOff }) : null,
            c.unread ? h('span', { class: 'rail-badge' }, c.unread > 99 ? '99+' : c.unread) : null
          )
        )),
    h('div', { class: 'rail-sep' }),
    group('railServersHidden', 'Servers', railServersHidden, 'servers'),
    ...(railServersHidden ? [] : list).map((s) => {
      const label = serverLabel(s);
      const active = S.entry?.id === s.id;
      const calling = S.call?.entry.id === s.id; // the voice call is on this server, in view or not
      const muted = serverMuted(s.id);
      const mentions = mentionUnread.server(s.id);
      return h(
        'button',
        {
          class: 'rail-server' + (muted ? ' silenced' : '') + (active && !inDmView() ? ' active' : '') + (active && inDmView() ? ' current' : '') + (active && !S.connected ? ' offline' : '') + (active && !S.connected && S.conn?.socket.active ? ' connecting' : ''),
          title: `${label}\n${s.address}` + (isUnencrypted(s.address) ? '\nNot encrypted' : '') + (calling ? '\nYou’re in voice here' : '') + (muted ? '\nNotifications muted' : '') + (mentions ? `\n${mentions} unread mention${mentions > 1 ? 's' : ''}` : ''),
          onclick: () => connectTo(s),
          oncontextmenu: (e) =>
            contextMenu(
              e,
              [
                { label: 'Mute notifications', checked: muted, run: () => toggleServerMute(s.id) },
                { label: 'Edit…', run: () => serverDialog(s) },
                active && S.connected && canSeeServerSettings() && { label: 'Server settings…', run: () => openServerSettings() },
                '-',
                calling && { label: 'Leave voice', run: leaveVoice },
                active && S.connected && { label: 'Disconnect', run: () => disconnect(true) },
                '-',
                { label: 'Remove server…', danger: true, run: () => removeServer(s) },
              ],
              label
            ),
        },
        s.serverIcon ? h('img', { class: 'rail-icon', src: s.serverIcon, alt: '', referrerpolicy: 'no-referrer' }) : initials(label),
        calling ? h('span', { class: 'rail-call', html: I.speaker }) : null,
        muted ? h('span', { class: 'rail-muted', html: I.bellOff }) : null,
        mentions ? h('span', { class: 'rail-badge' }, mentions > 99 ? '99+' : mentions) : null
      );
    }),
    h('button', { class: 'rail-add', title: 'Connect to a server', onclick: () => serverDialog() }, icon('plus'))
  );
  syncBadge();
}

// Leave a server and drop its bookmark (and the invite in it): asked first, since getting back can need a new invite
async function removeServer(s) {
  const label = serverLabel(s);
  if (!(await confirmModal(`Remove ${label}`, `Leave ${label} and take it off your list? You’ll need an invite to join again, unless the server lets anyone in.`, 'Remove server'))) return;
  const active = S.entry?.id === s.id;
  await leaveServer(s);
  if (active) disconnect(true);
  if (S.call?.entry.id === s.id) leaveVoice();
  servers.remove(s.id);
  mentionUnread.clear(s.id);
  DM.setServers(servers.all());
  renderRail();
}

// A DM conversation's menu: in the rail and the DM list
function dmItems(c) {
  const free = !DMCALL.with(c.id);
  return [
    free && { label: 'Start a voice call', icon: 'phone', run: () => startDmCall(c.id) },
    free && { label: 'Start a video call', icon: 'cam', run: () => startDmCall(c.id, true) },
    userMuteItem(c.id, c.name),
    '-',
    { label: 'Delete conversation…', danger: true, run: () => deleteConversation(c.id) },
  ];
}

// Everything a menu on a person offers, in the same order everywhere (D72): who it is, your own
// choices about them, then moderation, then what can't be undone. `u` is a live user or a profile.
function personItems(u, anchor, { align = 'right', mention = false } = {}) {
  const self = u.id === me().id;
  const live = S.users.find((x) => x.id === u.id) || u;
  const name = profileOf(u.id, u.name).name;
  return [
    { heading: name },
    { label: 'Profile', run: () => profilePopover(anchor, live, align) },
    ...(self
      ? [{ label: 'Edit profile…', run: () => openSettings('profile') }]
      : [
          { label: 'Message', run: () => openDm(u.id) },
          mention && !inDmView() && S.connected && { label: 'Mention', run: () => mentionInComposer(u.id, name) },
          live.sid && inCall(live.voice) && { label: 'Volume…', run: () => userVolumePopover(anchor, live, align) },
          userMuteItem(u.id, name),
        ]),
    '-',
    ...memberItems(u.id, anchor, align),
  ];
}

// "@name " where the cursor is in the composer
function mentionInComposer(id, name) {
  const ta = $('#composer-input');
  if (!ta) return;
  const tag = nameTag(id, name);
  const text = `@${name}${tag ? '#' + tag : ''} `;
  const at = ta.selectionStart ?? ta.value.length;
  const pre = ta.value.slice(0, at);
  const add = (pre && !/\s$/.test(pre) ? ' ' : '') + text;
  ta.value = pre + add + ta.value.slice(ta.selectionEnd ?? at);
  ta.setSelectionRange(at + add.length, at + add.length);
  autosize(ta);
  ta.focus();
}

function serverDialog(existing) {
  // https is the default, so it is left out when the port says the rest ("https://host" alone means port 443)
  const addr = h('input', { placeholder: '192.168.1.20:3000', value: existing?.address?.replace(/^https:\/\/(?=[^/]+:\d+$)/, '') || '' });
  // The bookmark's `password` holds the invite (D51) until it has been used, or an older server's password
  const pass = h('input', { placeholder: 'XXXX-XXXX-XXXX-XXXX', autocomplete: 'off', spellcheck: 'false', value: existing?.password || '' });
  // A typed "http://": say what that means before the invite is sent over it
  const plain = h('p', { class: 'field-warn', hidden: true }, icon('unlock'), h('span', {}, UNENCRYPTED));
  const button = h('button', { class: 'btn' });
  const sync = () => {
    plain.hidden = !isUnencrypted(normalizeAddress(addr.value));
    button.textContent = !plain.hidden ? 'Connect without encryption' : existing ? 'Save & connect' : 'Connect';
  };
  addr.oninput = sync;
  sync();
  const save = (close) => {
    const address = normalizeAddress(addr.value);
    if (!address) return toast('Enter an IP or hostname', 'error');
    const entry = servers.upsert({ ...(existing || {}), address, password: pass.value.trim() });
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
      plain,
      h('label', { class: 'field' }, h('span', {}, 'Invite'), pass)
    ),
    { actions: [(c) => h('button', { class: 'btn ghost', onclick: () => c() }, 'Cancel'), (c) => ((button.onclick = () => save(c)), button)] }
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
  closeStage({ nav: true });
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
  if (pendingJump && pendingJump.entryId !== entry.id) pendingJump = null;
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
    else renderMain(`You didn't trust the certificate of ${entry.address}.`);
  });
}

// Bring the call's connection back into view
function viewConn(c) {
  S.conn = c;
  S.entry = c.entry;
  if (c.connected) showServer(c);
  else renderAll();
}

let pendingJump = null; // { entryId, channelId, messageId }: a message link into a server that is still connecting
// Draw the server in view from scratch. Messages aren't tracked in the background, so they load again.
function showServer(c) {
  S.messages.clear();
  const last = settings.get().lastChannel[c.entry.id];
  const target = chatById(S.channelId) || chatById(last) || c.server.channels.find((ch) => ch.type === 'text');
  S.channelId = null;
  renderAll();
  const jump = pendingJump?.entryId === c.entry.id ? pendingJump : null;
  pendingJump = null;
  if (jump) jumpToMessage(jump.channelId, jump.messageId);
  else if (target) selectChannel(target.id);
  checkAppAgainstServer();
}

const hostOf = (address) => {
  try {
    return new URL(address).host;
  } catch {
    return 'unknown';
  }
};

// Tell a server we're leaving it for good (its bookmark is being removed), so that coming back
// takes an invite again (D51). Best effort: a server that can't be reached still has us as a member.
async function leaveServer(entry) {
  const live = conns().find((c) => c.entry.id === entry.id && c.connected);
  if (live) return live.socket.timeout(2000).emitWithAck('server:leave', {}).catch(() => {});
  // Not connected: say hello on a socket of its own, in the background
  const profile = me();
  const socket = io(entry.address, { transports: ['websocket', 'polling'], reconnection: false, timeout: 5000 });
  const done = () => socket.disconnect();
  socket.on('connect_error', done);
  socket.on('connect', async () => {
    try {
      const identity = await identityFor(profile).catch(() => null);
      const res = await socket.timeout(5000).emitWithAck('hello', { profile: { ...profile, card: identity?.card }, proof: identity && (await identity.hello(socket.id, new URL(entry.address).host)) });
      if (res.ok) await socket.timeout(5000).emitWithAck('server:leave', {});
    } catch {}
    done();
  });
}

function openSocket(entry, rejoinVoice = null) {
  const host = hostOf(entry.address); // the only thing about a server that is logged
  log.info(`connecting to ${host}`);
  const socket = io(entry.address, { transports: ['websocket', 'polling'], reconnectionDelayMax: 5000 });
  const c = (S.conn = { entry, socket, voice: null, sid: null, connected: false, server: null, users: [], voiceChannel: null, rejoinVoice });
  // Every handler keeps `c` up to date; only the server in view is drawn
  const viewed = () => S.conn === c;
  const calling = () => S.call === c;
  c.voice = new VoiceClient(socket, {
    isPeer: (sid) => !!c.voice.channelId && c.users.some((u) => u.sid === sid && u.voice === c.voice.channelId),
    onPeersChange: renderChannels,
    onMediaChange: () => {
      renderChannels();
      renderVoicePanel();
      syncStage();
    },
  });
  c.voice.profileIdFor = (sid) => c.users.find((u) => u.sid === sid)?.id;
  c.voice.forceMutedFor = (sid) => !!c.users.find((u) => u.sid === sid)?.forceMuted;
  // Pictures come as references to this server (D58). They are made into addresses here, on the
  // payload itself: onAny listeners run before the handlers below.
  const media = mediaResolver(entry.address);
  socket.onAny((event, payload) => {
    if (event === 'users') media.users(payload);
    else if (event === 'profile') media.profile(payload);
    else if (event === 'emoji:added') media.emoji(payload?.emoji);
  });

  socket.on('connect', async () => {
    const identity = await identityFor(me()).catch(() => null);
    const res = await socket.emitWithAck('hello', {
      profile: { ...me(), card: identity?.card },
      invite: entry.password || '',
      password: entry.password || '', // servers from before invites (D51)
      proof: identity && (await identity.hello(socket.id, new URL(entry.address).host)),
      uploadKey: true,
      proto: 2, // pictures by reference, `profile:seen`, `emoji:added` and `emoji:removed` (D58)
    });
    if (res.error) {
      log.warn(`${host} refused hello: ${res.error}`);
      toast(res.error, 'error');
      if (calling()) (endCall(), renderVoicePanel(), renderRail()); // also closes a background connection
      if (!viewed()) return;
      socket.disconnect();
      renderRail();
      renderMain(res.error);
      if (res.invite || /password/i.test(res.error)) serverDialog(entry);
      return;
    }
    // We're a member now, known by the profile's key: the invite has done its job, so don't keep it
    if (typeof res.server?.inviteOnly === 'boolean' && entry.password) {
      entry.password = '';
      servers.upsert({ id: entry.id, password: '' });
      DM.setServers(servers.all());
    }
    DM.retry(entry.address); // its DM socket was refused if it got there before we had joined
    media.server(res.server);
    media.users(res.users);
    Object.assign(c, { sid: res.sid, uploadKey: typeof res.uploadKey === 'string' ? res.uploadKey : null, server: res.server, users: res.users, connected: true, perms: res.perms && typeof res.perms === 'object' ? res.perms : null }); // no perms: a server from before permissions
    c.voice.setAudioQuality(c.server.audioQuality); // a server from before the setting sends none: the highest
    log.info(`connected to ${host}`);
    if (steamName) sendActivity(c);
    rememberServerLook(c);
    pruneMentions(c);
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

  let errLogged = false;
  socket.on('connect_error', (err) => {
    if (!errLogged) ((errLogged = true), log.warn(`connect_error ${host}: ${err.message}`)); // once: it retries every few seconds
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
    log.info(`disconnected from ${host}: ${reason}`);
    errLogged = false;
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
            ? 'Someone removed you from this server. You need an invite to rejoin.'
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
      for (const sid of now) if (sid !== c.sid && (!was.has(sid) || !!prev.find((u) => u.sid === sid)?.forceMuted !== !!users.find((u) => u.sid === sid)?.forceMuted)) c.voice.applyVolume(sid);
    }
    syncForced(c);
    if (calling()) syncStage();
    if (!viewed()) return calling() && renderVoicePanel(); // its video button follows who is sharing
    // Only what changed is drawn again: a mute toggle isn't in the member list, and someone
    // who is in no voice channel and no game isn't in the channel list
    const listed = (us) => us.filter((u) => u.voice || u.playing);
    if (!sameUsers(listed(prev), listed(users), VOICE_ROW)) renderChannels();
    if (!sameUsers(prev, users, MEMBER_ROW)) renderMembers();
  });

  socket.on('profile', (p) => {
    if (!c.server) return;
    const was = c.server.profiles[p.id];
    c.server.profiles[p.id] = p;
    if (!viewed()) return;
    const same = (k) => was[k] === p[k];
    // Someone came or went: only their last-seen time moved, and nothing on screen shows that
    if (was && ['name', 'color', 'avatar', 'banner', 'status'].every(same)) return;
    // A name is in other people's messages too (mentions, replies, #tags of shared names): all of them.
    // A color or a picture is only on the person's own.
    if (S.channelId) was && same('name') ? redrawMessages((m) => m.author === p.id) : renderMessages(true);
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
    const { roles, memberRoles, defaultPerms, defaultGrantable, permissionsOn } = msg && typeof msg === 'object' ? msg : {};
    c.server.roles = Array.isArray(roles) ? roles : [];
    c.server.memberRoles = memberRoles && typeof memberRoles === 'object' && !Array.isArray(memberRoles) ? memberRoles : {};
    if (defaultPerms && typeof defaultPerms === 'object') c.server.defaultPerms = defaultPerms;
    if (Array.isArray(defaultGrantable)) c.server.defaultGrantable = defaultGrantable;
    if (typeof permissionsOn === 'boolean') c.server.permissionsOn = permissionsOn;
    if (!viewed()) return;
    renderMembers();
    if (S.channelId && !inDmView()) renderMessages(true); // role mentions read with the new names
  });

  // Our rights changed (after `roles`, and with a filtered `channels`)
  socket.on('perms', (perms) => {
    if (!perms || typeof perms !== 'object') return;
    c.perms = perms;
    syncForced(c);
    if (calling()) renderVoicePanel();
    if (!viewed()) return;
    renderHeader();
    renderChannels();
    renderMembers();
    syncComposer();
  });

  socket.on('voice:forcemuted', ({ muted, by } = {}) => {
    toast(muted ? `${by || 'A moderator'} muted you` : `${by || 'A moderator'} lifted your mute`, muted ? 'error' : 'info');
  });

  socket.on('server', ({ name, icon, game, audioQuality, inviteOnly }) => {
    Object.assign(c.server, { name, icon });
    if (typeof inviteOnly === 'boolean') c.server.inviteOnly = inviteOnly;
    if (audioQuality) c.voice.setAudioQuality((c.server.audioQuality = audioQuality));
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
    pruneMentions(c);
    if (calling()) renderVoicePanel();
    if (!viewed()) return;
    if (!chatById(S.channelId) && !inDmView()) {
      const first = channels.find((ch) => ch.type === 'text');
      if (first) selectChannel(first.id);
      else ((S.channelId = null), renderMain());
    }
    renderChannels();
    renderHeader();
    refreshChatTitle();
    if (S.channelId && !inDmView()) renderMessages(true); // #channel links follow renames
  });

  const onEmojis = (emojis) => {
    c.server.emojis = emojis;
    if (!viewed()) return;
    updatePickerEmojis();
    renderChannels();
    refreshChatTitle();
    if (S.channelId) renderMessages(true);
  };
  socket.on('emojis', onEmojis);
  // The one that changed, from servers that send that instead of the whole set (D58)
  socket.on('emoji:added', ({ emoji } = {}) => {
    if (c.server && emoji && typeof emoji.name === 'string') onEmojis([...c.server.emojis.filter((e) => e.name !== emoji.name), emoji]);
  });
  socket.on('emoji:removed', ({ name } = {}) => {
    if (c.server) onEmojis(c.server.emojis.filter((e) => e.name !== name));
  });
  // Someone went offline: their last-seen time, which a profile card shows (D58)
  socket.on('profile:seen', ({ id, seen } = {}) => {
    const p = c.server?.profiles?.[id];
    if (p && Number.isFinite(seen)) p.seen = seen;
  });

  socket.on('msg:new', ({ channelId, message }) => {
    if (!viewed()) return;
    const list = S.messages.get(channelId);
    if (list) list.push(message);
    S.typing.get(channelId)?.forEach((t, sid) => t.name === message.name && S.typing.get(channelId).delete(sid));
    const mine = message.author === me().id;
    const mentioned = mentionsMe(message, c.server, channelId);
    const seen = watching(channelId);
    if (channelId === S.channelId) {
      appendMessage(message, mine);
      renderTyping();
    } else if (!mine) {
      S.unread.add(channelId);
      renderChannels();
    }
    // Regular messages only mark the channel unread; a mention also badges it and notifies
    if (mentioned) {
      if (!seen) {
        mentionUnread.add(entry.id, channelId);
        renderRail();
        renderChannels();
      }
      notify({
        kind: 'mention',
        from: message.author,
        serverId: entry.id,
        title: mentionTitle(message.name, c.server.channels.find((ch) => ch.id === channelId)?.name || '', c.server.name),
        body: plainText(message.text, message),
        icon: profileOf(message.author).avatar,
        inView: seen,
        open: () => openChannel(entry, channelId),
      });
    }
    if (document.hidden && !mine) document.title = `(•) ${windowTitle}`;
  });

  socket.on('msg:update', ({ channelId, message }) => {
    linkPreviews.delete(`${c.server.id}/${channelId}/${message.id}`);
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
    linkPreviews.delete(`${c.server.id}/${channelId}/${messageId}`);
    if (!viewed()) return;
    const list = S.messages.get(channelId);
    const i = list ? list.findIndex((m) => m.id === messageId) : -1;
    if (i < 0) return;
    list.splice(i, 1);
    if (channelId !== S.channelId) return;
    messageNode(messageId)?.remove();
    // The one after it may no longer follow a message by the same person, and replies to it lose their quote
    redrawMessages((m, at) => at === i || m.replyTo === messageId);
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

  socket.on('voice:kicked', ({ reason, by } = {}) => {
    c.voice.leave(true);
    c.voiceChannel = null;
    if (calling()) endCall(true);
    renderRail();
    renderChannels();
    renderVoicePanel();
    toast(reason === 'kicked' ? `${by || 'A moderator'} removed you from voice` : reason === 'perms' ? 'You can no longer use that voice channel' : 'Voice channel was deleted', reason === 'deleted' || !reason ? 'info' : 'error');
  });
}

// Cache the server's name and icon on its bookmark, so the rail shows them offline too
function rememberServerLook(c) {
  const look = { serverName: c.server.name, serverIcon: c.server.icon || '', ...(typeof c.server.id === 'string' ? { serverId: c.server.id } : {}) };
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
  log.info('joining voice');
  try {
    await c.voice.join(channelId);
  } catch (e) {
    log.error('voice join failed', e);
    c.rejoinVoice = null;
    if (S.call === c && !c.voiceChannel) (endCall(), renderVoicePanel());
    renderRail();
    return toast('Could not join voice: ' + e.message, 'error');
  }
  c.voiceChannel = channelId;
  c.rejoinVoice = null;
  S.call = c;
  if (c.voice.micError) {
    log.warn(`microphone unavailable: ${c.voice.micError.name}: ${c.voice.micError.message}`);
    toast(
      window.isSecureContext
        ? `No microphone (${c.voice.micError.message}). You joined listen-only — soundboard still works.`
        : 'Mic needs a secure page. Open friendspeak from localhost or run the server with HTTPS=1. Joined listen-only.',
      'error',
      7000
    );
  }
  audio.setMuted(S.muted || S.deafened || forcedMute());
  c.voice.setDeafened(S.deafened);
  c.socket.emit('voice:state', { muted: micOff(), deafened: S.deafened });
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
  log.info('left voice');
  c.voice.leave(silent);
  c.voiceChannel = c.rejoinVoice = null;
  S.call = null;
  S.callRtt = null;
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
  if (forcedMute()) return toast('You were muted by a moderator', 'error');
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
  audio.setMuted(S.muted || S.deafened || forcedMute());
  audio.setMonitor(!S.deafened && settings.get().soundboardMonitor);
  S.voice?.setDeafened(S.deafened);
  DMCALL.sync(micOff(), S.deafened);
  for (const c of conns()) if (c.connected) c.socket.emit('voice:state', { muted: micOff(), deafened: S.deafened });
  renderUserPanel();
  syncStage();
  renderDmCall();
}

// Speaking indicators, polled from analysers. The two lists are live collections: the browser
// keeps them until the page changes, where a selector would search the whole page on every tick.
const voiceUserEls = document.getElementsByClassName('voice-user');
const tileEls = document.getElementsByClassName('tile');
setInterval(() => {
  if (!S.voiceChannel) return;
  const levels = S.voice.levels();
  if (audio.selfAnalyser) levels.set(S.call.sid, Level(audio.selfAnalyser));
  const mark = (el) => el.classList.toggle('speaking', (levels.get(el.dataset.sid) || 0) > 0.02);
  for (const el of voiceUserEls) mark(el);
  for (const el of tileEls) if (el.dataset.sid) mark(el);
  // In a window of its own, the stage's tiles aren't in this page
  if (S.stage?.pop) for (const t of S.stage.tiles.values()) if (t.el.dataset.sid) mark(t.el);
}, 90);

// ---------------------------------------------------------------- sidebar

// Under the header of a server reached over plain http, for as long as it is in view
const plainHttp = h('div', { class: 'plain-http', title: UNENCRYPTED, hidden: true }, icon('unlock'), 'Not encrypted');

function renderHeader() {
  const hd = $('#server-header');
  if (!plainHttp.isConnected) hd.after(plainHttp);
  plainHttp.hidden = inDmView() || !S.entry || !isUnencrypted(S.entry.address);
  if (inDmView()) return hd.replaceChildren(h('span', { class: 'server-title' }, h('span', {}, 'Direct messages')));
  if (!S.entry) return hd.replaceChildren(h('span', {}, 'friendspeak'));
  hd.replaceChildren(
    h(
      'button',
      {
        class: 'server-title',
        title: S.connected && canSeeServerSettings() ? 'Server settings' : '',
        disabled: !S.connected || !canSeeServerSettings(),
        onclick: () => openServerSettings(),
      },
      S.server?.icon ? h('img', { class: 'header-icon', src: S.server.icon, alt: '', referrerpolicy: 'no-referrer' }) : null,
      h('span', {}, S.server?.name || S.entry.serverName || S.entry.address)
    ),
    S.connected && S.server?.storage ? h('button', { class: 'icon-btn tiny', title: 'Server files', onclick: () => openFileBrowser() }, icon('folder')) : '', // not null: replaceChildren() would print it
    h('span', { class: 'conn-dot ' + (S.connected ? 'on' : 'off'), title: S.connected ? 'Connected' : 'Offline' })
  );
}

// Reordering channels (channel:move): drag one you can manage among those of its type
const CH_DRAG = 'application/x-friendspeak-channel';
let dragCh = null; // the channel being dragged

// before: the channel it goes in front of; none puts it last
async function moveChannel(ch, before) {
  try {
    const r = await S.socket.timeout(8000).emitWithAck('channel:move', { id: ch.id, before: before?.id ?? null });
    if (r?.error) toast(r.error, 'error');
  } catch {
    toast('This server can’t reorder channels until it is updated', 'error'); // an older server never answers
  }
}

// list: the channels of ch's type, as shown
function channelDrag(ch, list) {
  const mark = (el, where) => (el.classList.toggle('drop-before', where === 'before'), el.classList.toggle('drop-after', where === 'after'));
  const below = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY > r.top + r.height / 2;
  };
  const ours = (e) => dragCh && dragCh.type === ch.type && dragCh.id !== ch.id && e.dataTransfer.types.includes(CH_DRAG);
  return {
    draggable: canCh(ch.id, 'manage') && list.length > 1 ? 'true' : null,
    ondragstart: (e) => {
      dragCh = ch;
      e.dataTransfer.setData(CH_DRAG, ch.id);
      e.dataTransfer.effectAllowed = 'move';
    },
    ondragend: () => (dragCh = null),
    ondragover: (e) => {
      if (!ours(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      mark(e.currentTarget, below(e) ? 'after' : 'before');
    },
    ondragleave: (e) => mark(e.currentTarget, null),
    ondrop: (e) => {
      if (!ours(e)) return;
      e.preventDefault();
      mark(e.currentTarget, null);
      const moved = dragCh;
      dragCh = null;
      const rest = list.filter((c) => c.id !== moved.id);
      const before = below(e) ? rest[rest.indexOf(ch) + 1] : ch;
      if (list[list.findIndex((c) => c.id === moved.id) + 1] !== before) moveChannel(moved, before);
    },
  };
}

function renderChannels() {
  const box = $('#channel-list');
  if (inDmView()) return (box.replaceChildren(dmSidebar()), syncWatchTip());
  if (!S.server) return (box.replaceChildren(), syncWatchTip());
  const text = S.server.channels.filter((c) => c.type === 'text');
  const voice = S.server.channels.filter((c) => c.type === 'voice');
  const chMenu = (ch) => (e) => {
    const list = ch.type === 'text' ? text : voice;
    const at = list.indexOf(ch);
    const manage = canCh(ch.id, 'manage');
    const unread = S.unread.has(ch.id) || mentionUnread.channel(S.entry.id, ch.id);
    const video = ch.type === 'voice' && S.users.some((u) => u.voice === ch.id && (u.camera || u.sharing));
    contextMenu(
      e,
      [
        ch.type === 'text' && unread && { label: 'Mark as read', run: () => (S.unread.delete(ch.id), mentionUnread.clear(S.entry.id, ch.id), renderRail(), renderChannels()) },
        ch.type === 'text' && S.server.storage && { label: 'Browse files', run: () => openFileBrowser(ch.id) },
        ch.type === 'voice' && !inCall(ch.id) && canCh(ch.id, 'send') && { label: 'Join', run: () => joinVoice(ch.id) },
        video && { label: 'Open video', run: () => openVideoGrid(ch.id) },
        '-',
        manage && {
          label: 'Rename…',
          run: async () => {
            const n = await channelDialog('Rename channel', ch.name, { okLabel: 'Rename channel', type: ch.type });
            if (n) doAct('channel:rename', { id: ch.id, name: n });
          },
        },
        manage && hasPerms() && { label: 'Permissions…', run: () => channelPermsDialog(ch) },
        manage && at > 0 && { label: 'Move up', run: () => moveChannel(ch, list[at - 1]) },
        manage && at < list.length - 1 && { label: 'Move down', run: () => moveChannel(ch, list[at + 2]) },
        '-',
        manage && {
          label: 'Delete channel…',
          danger: true,
          run: async () => (await confirmModal('Delete channel', `Delete "${ch.name}" and its history?`, 'Delete channel')) && doAct('channel:delete', { id: ch.id }),
        },
      ],
      (ch.type === 'text' ? '#' : '') + ch.name
    );
  };
  const createChannel = async (type) => {
    const name = await channelDialog(`Create ${type} channel`, '', { okLabel: 'Create channel', type });
    if (!name) return;
    const r = await doAct('channel:create', { name, type });
    if (r.ok && type === 'text') selectChannel(r.channel.id);
  };
  // Rows are reached with Tab; Enter and Space act as a click, the menu key or Shift+F10 open the menu
  const rowKeys = (e) => (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && (e.preventDefault(), e.currentTarget.click());
  const cat = (label, type) =>
    h(
      'div',
      { class: 'cat', oncontextmenu: (e) => contextMenu(e, [can('manageChannels') && { label: `Create ${type} channel…`, run: () => createChannel(type) }], label) },
      h('span', {}, label),
      !can('manageChannels') ? null : h('button', { class: 'icon-btn tiny', title: `Create ${type} channel`, onclick: () => createChannel(type) }, icon('plus'))
    );
  box.replaceChildren(
    cat('Text channels', 'text'),
    ...text.map((ch) =>
      h(
        'div',
        {
          class: 'channel' + (ch.id === S.channelId ? ' active' : '') + (S.unread.has(ch.id) ? ' unread' : '') + (mentionUnread.channel(S.entry.id, ch.id) ? ' mentioned' : ''),
          role: 'link',
          tabindex: 0,
          'aria-current': ch.id === S.channelId ? 'page' : null,
          onkeydown: rowKeys,
          onclick: () => selectChannel(ch.id),
          oncontextmenu: chMenu(ch),
          ...channelDrag(ch, text),
        },
        icon('hash'),
        channelNameEl(ch.name, S.server.emojis),
        mentionUnread.channel(S.entry.id, ch.id) ? h('span', { class: 'count mention-count', title: 'Unread mentions' }, Math.min(99, mentionUnread.channel(S.entry.id, ch.id))) : null
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
            class: 'channel voice' + (inCall(ch.id) ? ' connected' : '') + (video ? ' has-video' : '') + (canCh(ch.id, 'send') ? '' : ' locked'),
            'data-watch': video ? 'ch:' + ch.id : null, // the hover card with "Start watching"
            role: 'button',
            tabindex: 0,
            onkeydown: rowKeys,
            onclick: () => (canCh(ch.id, 'send') ? joinVoice(ch.id) : toast('You don’t have permission to join this voice channel', 'error')),
            oncontextmenu: chMenu(ch),
            ...channelDrag(ch, voice),
          },
          icon('speaker'),
          channelNameEl(ch.name, S.server.emojis),
          canCh(ch.id, 'send') ? null : h('span', { class: 'icon lock', title: 'You can’t join this channel', html: I.lock }),
          video
            ? h(
                'button',
                {
                  class: 'video-badge',
                  'aria-label': inCall(ch.id) ? 'Open video grid' : 'Join and open video grid', // not a title: the hover card explains it
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
  syncWatchTip();
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
          title: c.name + (DM.gameOf(c.id) ? '\n' + playingText(DM.gameOf(c.id)) : '') + (userMuted(c.id) ? '\nNotifications muted' : ''),
          onclick: () => selectChannel('dm:' + c.id),
          oncontextmenu: (e) => contextMenu(e, dmItems(c), c.name),
        },
        h('div', { class: 'member-av' }, avatarEl(c, 20), h('span', { class: 'presence' + (DM.online(c.id) ? '' : ' off') })),
        h('span', { class: 'name' }, c.name),
        userMuted(c.id) ? h('span', { class: 'icon state', title: 'Notifications muted', html: I.bellOff }) : null,
        c.unread ? h('span', { class: 'count' }, c.unread) : null
      )
    ),
    h('p', { class: 'muted small dm-hint' }, 'End-to-end encrypted. Start one from a member list, or add a friend with a friend code.')
  );
}

async function removePrompt(profileId) {
  const name = profileOf(profileId).name;
  if (!(await confirmModal(`Remove ${name}`, `Disconnect ${name} and take them off the member list? They can come back unless you ban them.`, `Remove ${name}`))) return;
  await doAct('member:remove', { profileId });
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
        h('p', {}, `${name} will be disconnected and can't come back with this profile. People who can ban can lift it in Server settings → Bans.`),
        h('label', { class: 'check-row' }, withIp, h('span', {}, 'Also ban their IP address')),
        h('p', { class: 'muted small' }, 'A new profile gets around a profile ban. The IP ban is skipped when they share your network.')
      ),
      {
        size: 'sm',
        alert: true,
        actions: [
          h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'),
          h('button', { class: 'btn danger', onclick: () => ((done = true), close(), resolve(true)) }, `Ban ${name}`),
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
// `okLabel` names the action ("Create channel", "Rename channel"); `type` picks the field's icon
function channelDialog(title, value = '', { okLabel = 'Save', type = 'text' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const count = h('span', { class: 'field-count' });
    const input = h('input', { value, maxlength: 48, placeholder: 'e.g. 🎮-gaming', onkeydown: (e) => e.key === 'Enter' && ok(), oninput: () => (count.textContent = `${[...input.value].length} / 48`) });
    count.textContent = `${[...value].length} / 48`;
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
          { class: 'input-with-btn input-box' },
          icon(type === 'voice' ? 'speaker' : 'hash', 'input-icon'),
          input,
          h('button', { class: 'icon-btn', title: 'Add an emoji', onclick: (e) => (e.preventDefault(), openEmojiPicker(e.currentTarget, { mode: 'insert', target: input })) }, icon('smile'))
        ),
        count
      ),
      {
        actions: [h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'), h('button', { class: 'btn', onclick: ok }, okLabel)],
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
      icon('penguin'),
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
      'data-watch': u.sharing || u.camera ? 'u:' + u.sid : null,
      title: peer && !isMe && !u.sharing && !u.camera ? `connection: ${peer.state}` : '', // a streamer's row has the hover card instead
      role: 'button',
      tabindex: 0,
      onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && (e.preventDefault(), e.currentTarget.click()),
      onclick: (e) => (!isMe && together ? userVolumePopover(e.currentTarget, u) : profilePopover(e.currentTarget, u)),
      oncontextmenu: (e) => contextMenu(e, personItems(u, e.currentTarget), u.name),
    },
    avatarEl(u, 24),
    h('span', { class: 'name' }, u.name),
    u.sharing
      ? h(
          'button',
          {
            class: 'live-badge' + (S.stage?.tiles.get('screen:' + u.sid)?.live ? ' watching' : ''),
            'aria-label': together ? (isMe ? 'Preview your stream' : `Watch ${u.name}'s screen`) : `Join and watch ${u.name}'s screen`,
            onclick: (e) => (e.stopPropagation(), watchStream(u, 'screen')),
          },
          'LIVE'
        )
      : null,
    u.camera
      ? h(
          'button',
          {
            class: 'cam-badge' + (S.stage && together ? ' watching' : ''),
            'aria-label': together ? 'Show cameras' : 'Join and show cameras',
            onclick: (e) => (e.stopPropagation(), watchStream(u, 'camera')),
          },
          icon('cam')
        )
      : null,
    u.forceMuted ? h('span', { class: 'icon state forced', title: 'Muted by a moderator', html: I.lock }) : null,
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
  const muteBtn = h('button', { class: 'btn small ghost outline', onclick: () => (apply({ userMutes: { ...settings.get().userMutes, [u.id]: !settings.get().userMutes[u.id] } }), renderChannels()) });
  const resetBtn = h('button', { class: 'btn small ghost', onclick: () => reset() }, 'Reset');
  const draw = () => {
    const st = settings.get();
    const v = st.userVolumes[u.id] ?? 1;
    const muted = !!st.userMutes[u.id];
    slider.value = v;
    slider.classList.toggle('boost', v > 1);
    val.textContent = muted ? 'muted' : Math.round(v * 100) + '%';
    val.classList.toggle('boost', v > 1 && !muted);
    muteBtn.textContent = muted ? 'Unmute for me' : 'Mute for me';
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
      { class: 'user-pop', role: 'dialog', 'aria-label': `${u.name}’s volume` },
      h(
        'div',
        { class: 'user-pop-head' },
        avatarEl(u, 36),
        h('div', { class: 'grow' }, h('strong', {}, u.name), h('div', { class: 'muted small' }, u.voice && channelById(u.voice) ? 'In ' + channelById(u.voice).name : ''))
      ),
      h('label', { class: 'field' }, h('span', { class: 'field-head' }, 'User volume', val), slider),
      rangeTicks([[0, '0'], [1 / MAX_USER_VOLUME, '100%'], [1, Math.round(MAX_USER_VOLUME * 100) + '%']]),
      h('div', { class: 'row' }, muteBtn, resetBtn),
      h('p', { class: 'muted small' }, 'Only changes what you hear.')
    ),
    { align }
  );
}

// ---------------------------------------------------------------- watch tip
//
// Hovering a voice channel where someone streams, or a streamer's row, opens
// a card next to it with who is streaming and a "Start watching" button. It
// is an ordinary popover, opened after a short pause and closed a moment
// after the pointer leaves both the row and the card, so the pointer can
// cross the gap between them. It never opens over another popover (a menu, a
// profile card), and opening one of those closes it. Rows carry their key in
// `data-watch`: "ch:<channel id>" or "u:<sid>".

const WATCH_TIP_OPEN_MS = 350;
const WATCH_TIP_CLOSE_MS = 300;
let watchTip = null; // { key, pop, body, passed }
let watchTipWant = null; // the key under the pointer or the keyboard focus
let watchTipTimer = null;

const watchTipRow = (key) => $(`#channel-list [data-watch="${CSS.escape(key)}"]`);
const watchKeyAt = (el) => el?.closest?.('#channel-list [data-watch]')?.dataset.watch || null;

function watchTipRows(key) {
  const id = key.slice(key.indexOf(':') + 1);
  const users = S.users.filter((u) => u.voice && (key.startsWith('ch:') ? u.voice === id : u.sid === id));
  return users
    .flatMap((u) => [u.sharing && { u, kind: 'screen' }, u.camera && { u, kind: 'camera' }])
    .filter(Boolean)
    .map(({ u, kind }) => {
      const mine = u.sid === S.sid;
      const screen = kind === 'screen';
      // Cameras, and our own share, are shown for as long as the stage is open
      const on = inCall(u.voice) && !!S.stage && (!screen || mine || S.stage.watching.has(u.sid));
      const btn = !on
        ? h('button', { class: 'btn small', onclick: () => watchStream(u, kind) }, 'Start watching')
        : screen && !mine
          ? h('button', { class: 'btn small ghost', onclick: () => watchScreen(u.sid, false) }, 'Stop watching')
          : h('button', { class: 'btn small ghost', disabled: true }, 'Watching');
      return h(
        'div',
        { class: 'watch-row' },
        avatarEl(u, 28),
        h('div', { class: 'watch-who' }, h('strong', {}, u.name), h('span', { class: 'muted small' }, screen ? 'Sharing their screen' : 'Camera on')),
        btn
      );
    });
}

function showWatchTip(key) {
  clearTimeout(watchTipTimer);
  if (watchTip?.key === key) return;
  if (activePopover && activePopover !== watchTip?.pop) return;
  if (inDmView() || !S.server || !watchTipRow(key)) return;
  const rows = watchTipRows(key);
  if (!rows.length) return;
  const inside = (el) => !!el && (body.contains(el) || !!watchTipRow(key)?.contains(el));
  const body = h(
    'div',
    {
      class: 'watch-tip',
      onmouseenter: () => wantWatchTip(key),
      onmouseleave: () => wantWatchTip(null),
      onfocusin: () => wantWatchTip(key), // also when a rebuild (syncWatchTip) puts the focus back
      onfocusout: (e) => inside(e.relatedTarget) || wantWatchTip(null),
      // Tab leaves the card the way it came in: back to the row
      onkeydown: (e) => {
        if (e.key !== 'Tab') return;
        const btns = [...body.querySelectorAll('button:not(:disabled)')];
        const i = btns.indexOf(document.activeElement);
        if (e.shiftKey ? i > 0 : i < btns.length - 1) return;
        const back = watchTipRow(key)?.querySelector('button');
        if (!back) return;
        e.preventDefault();
        if (watchTip && !e.shiftKey) watchTip.passed = true; // the next Tab goes on down the list
        back.focus();
      },
    },
    rows
  );
  // The channel list is rebuilt often, so the row is looked up each time
  const anchor = { getBoundingClientRect: () => (watchTipRow(key) || body).getBoundingClientRect(), contains: (el) => !!watchTipRow(key)?.contains(el) };
  const pop = popover(anchor, body, { align: 'right', onClose: () => watchTip?.pop === pop && (watchTip = null) });
  watchTip = { key, pop, body, passed: false };
}

// What the pointer or the focus is on now: a row's key, or null for neither
function wantWatchTip(key, now = false) {
  if (key === watchTipWant && !now) return;
  watchTipWant = key;
  clearTimeout(watchTipTimer);
  if (key === (watchTip?.key ?? null)) return;
  const go = () => (key ? showWatchTip(key) : watchTip?.pop.close());
  if (now) go();
  else watchTipTimer = setTimeout(go, key ? WATCH_TIP_OPEN_MS : WATCH_TIP_CLOSE_MS);
}

// After the channel list is rebuilt: refresh the open card, or close it when
// its row is gone or nobody there streams any more
function syncWatchTip() {
  if (!watchTip) return;
  const { key, body, pop } = watchTip;
  const rows = !inDmView() && S.server && watchTipRow(key) ? watchTipRows(key) : [];
  if (!rows.length) return pop.close();
  const focused = body.contains(document.activeElement);
  body.replaceChildren(...rows);
  pop.place();
  if (!focused) return;
  (body.querySelector('button:not(:disabled)') || watchTipRow(key)?.querySelector('button'))?.focus();
  wantWatchTip(key); // the old button going away looked like the focus leaving
}

{
  const list = $('#channel-list');
  list.addEventListener('mouseover', (e) => {
    const key = watchKeyAt(e.target);
    if (key) wantWatchTip(key);
  });
  list.addEventListener('mouseout', (e) => {
    const key = watchKeyAt(e.target);
    if (key && watchKeyAt(e.relatedTarget) !== key) wantWatchTip(null);
  });
  // Keyboard: focusing a row's badge opens the card at once, and Tab goes into it
  list.addEventListener('focusin', (e) => {
    const key = watchKeyAt(e.target);
    if (key && e.target.matches(':focus-visible')) wantWatchTip(key, true);
  });
  list.addEventListener('focusout', (e) => {
    const key = watchKeyAt(e.target);
    if (key && watchKeyAt(e.relatedTarget) !== key && !watchTip?.body.contains(e.relatedTarget)) wantWatchTip(null);
  });
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || e.shiftKey || !watchTip || watchTip.passed || watchKeyAt(e.target) !== watchTip.key) return;
    const first = watchTip.body.querySelector('button:not(:disabled)');
    if (!first) return;
    e.preventDefault();
    first.focus();
  });
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
  const q = live && !c.voice.micError ? signalOf(S.callRtt) : null;
  const buttons = [
    // On its own row: the way back to the server the call is on
    away ? h('button', { class: 'vp-channel vp-jump', title: `Go to ${serverName}`, onclick: () => connectTo(c.entry) }, icon('jump'), h('span', {}, where)) : null,
    h(
      'div',
      { class: 'vp-info' },
      h(
        'div',
        { class: 'vp-status' + (live ? '' : ' pending') + (q ? ' q' + q.level : '') },
        q ? h('span', { class: 'icon vp-signal q' + q.level, role: 'img', 'aria-label': q.label, html: I.signal }) : null,
        !live ? 'Reconnecting…' : c.voice.micError ? 'Listen-only' : q?.level === 1 ? 'Poor connection' : 'Voice Connected',
        c.voice.local.screen ? h('span', { class: 'live-badge' }, 'LIVE') : null
      ),
      // the round trip first: the place is the part that may not fit
      away ? null : h('div', { class: 'vp-channel', title: where }, q ? h('span', { class: 'vp-rtt' }, `${Math.round(S.callRtt)} ms · `) : null, where)
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
    // The soundboard is in the user panel, just below
    h('button', { class: 'icon-btn danger', title: 'Disconnect', onclick: leaveVoice }, icon('hangup')),
  ];
  p.replaceChildren(...buttons.filter(Boolean)); // replaceChildren(null) would print "null"
}

// The call's connection, from the longest round trip to anyone in it (ms): 3 bars under 150, 2 under 300
const signalOf = (rtt) => (rtt == null ? null : rtt < 150 ? { level: 3, label: 'Good connection' } : rtt < 300 ? { level: 2, label: 'Slow connection' } : { level: 1, label: 'Poor connection' });
// Measured every few seconds while in a call. The panel is drawn again only when the bars change
// (redrawing takes the focus off its buttons); the number is updated in place.
setInterval(async () => {
  const c = S.call;
  const rtt = c?.voiceChannel ? await c.voice.roundTrip().catch(() => null) : null;
  if (c !== S.call) return;
  const before = signalOf(S.callRtt)?.level;
  S.callRtt = rtt;
  const rttEl = $('#voice-panel .vp-rtt');
  if (signalOf(rtt)?.level !== before || (rtt != null && !rttEl)) renderVoicePanel();
  else if (rttEl && rtt != null) rttEl.textContent = `${Math.round(rtt)} ms · `;
}, 3000);

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
    h(
      'button',
      { class: 'icon-btn' + (S.muted || S.deafened || forcedMute() ? ' off' : '') + (forcedMute() ? ' forced' : ''), title: (forcedMute() ? 'Muted by a moderator' : 'Mute') + MIC_HINT, onclick: toggleMute, oncontextmenu: micMenu },
      icon(S.muted || S.deafened || forcedMute() ? 'micOff' : 'mic')
    ),
    h('button', { class: 'icon-btn' + (S.deafened ? ' off' : ''), title: 'Deafen', onclick: toggleDeafen }, icon(S.deafened ? 'headOff' : 'head')),
    h('button', { class: 'icon-btn', title: 'Soundboard', onclick: (e) => openSoundboard(e.currentTarget) }, icon('board')),
    h('button', { class: 'icon-btn', title: 'Settings', onclick: () => openSettings() }, icon('gear'))
  );
}

function profileSwitcher(anchor) {
  const cur = me();
  menuPopover(
    anchor,
    [
      { heading: 'Profiles on this device' },
      ...profiles.all().map((p) => ({ label: p.name, avatar: p, selected: p.id === cur.id, run: () => p.id !== cur.id && switchProfile(p.id) })),
      '-',
      { label: 'Edit profile…', run: () => openSettings('profile') },
      { label: 'New profile', run: () => (switchProfile(profiles.create({ name: 'new friend' }).id), openSettings('profile')) },
    ],
    { label: 'Profiles' }
  );
}

// A profile is its own account (D50): leave the previous one's servers and
// call, then open this one's DMs, server list and the server it was last on.
function switchProfile(id) {
  DMCALL.stop();
  endCall();
  S.channelId = null; // a DM in view belongs to the previous profile
  disconnect();
  S.entry = null;
  profiles.setActive(id);
  DM.start(me(), servers.all());
  renderAll();
  const last = servers.get(servers.last());
  if (last) connectTo(last);
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
  // Everyone who has been here before and isn't now (banned people are listed in Server settings)
  // Worked out once, not per row
  const online = new Set(S.users.map((u) => u.id));
  const banned = new Set((S.server.bans || []).map((b) => b.profileId));
  const dup = sharedNames();
  const offline = Object.entries(S.server.profiles || {})
    .filter(([pid]) => !online.has(pid) && !banned.has(pid))
    .map(([pid, p]) => ({ ...p, id: pid, offline: true }))
    .sort(byName);
  const hideOffline = settings.get().hideOffline;
  const menu = (u) => (e) => contextMenu(e, personItems(u, e.currentTarget, { align: 'left', mention: true }), u.name);
  const row = (u) => {
    const roles = rolesOf(u.id);
    const doing = activityParts(u);
    return h(
      'div',
      {
        class: 'member' + (u.offline ? ' offline' : ''),
        role: 'button',
        tabindex: 0,
        onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && (e.preventDefault(), e.currentTarget.click()),
        onclick: (e) => profilePopover(e.currentTarget, u, 'left'),
        oncontextmenu: menu(u),
      },
      h('div', { class: 'member-av' }, avatarEl(u, 32), h('span', { class: 'presence' + (u.offline ? ' off' : '') })),
      h(
        'div',
        { class: 'member-names' },
        h('div', { class: 'member-name', style: { color: u.color } }, u.name, nameTag(u.id, u.name, dup) ? h('span', { class: 'name-tag' }, '#' + mentionTag(u.id)) : null),
        h(
          'div',
          { class: 'member-status' },
          doing.length ? doing : u.status || ''
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

// A small spinning ring for things on their way: the app, a server, messages
const spinner = (big = false) => h('span', { class: 'spinner' + (big ? ' big' : ''), role: 'status', 'aria-label': 'Loading' });

function renderMain(error) {
  updateTitle();
  const main = $('#main');
  mentionMenu = null; // its element goes with the composer
  search = null; // and the search field with the header
  if (!inDmView() && (!S.entry || (!S.connected && !S.server))) {
    const list = servers.all();
    const e = S.entry;
    const serverIcon = (s) => h('span', { class: 'home-server-icon' }, s.serverIcon ? h('img', { src: s.serverIcon, alt: '', referrerpolicy: 'no-referrer' }) : initials(serverLabel(s)));
    main.replaceChildren(
      h(
        'div',
        { class: 'home' },
        h('div', { class: 'home-logo' }, 'friendspeak'),
        // Connecting, or it failed: say so, with a way out (D72)
        e && !error ? [h('div', { class: 'home-loading' }, spinner(true)), h('p', { class: 'muted', role: 'status' }, `Connecting to ${e.address}…`), h('div', { class: 'home-actions' }, h('button', { class: 'btn ghost', onclick: () => disconnect(true) }, 'Cancel'))] : null,
        e && error
          ? h(
              'div',
              { class: 'home-error', role: 'alert' },
              icon(/Retrying/.test(error) ? 'warn' : 'errorCircle', 'empty-icon'),
              h('strong', {}, /Retrying/.test(error) ? 'Reconnecting' : 'Not connected'),
              h('p', { class: 'muted' }, error),
              h(
                'div',
                { class: 'row center-row' },
                /Retrying/.test(error) ? null : h('button', { class: 'btn small', onclick: () => connectTo(e) }, 'Try again'),
                h('button', { class: 'btn small ghost', onclick: () => serverDialog(e) }, 'Edit server'),
                h('button', { class: 'btn small ghost', onclick: () => disconnect(true) }, 'Cancel')
              )
            )
          : null,
        e ? null : h('p', { class: 'muted' }, 'Text, voice, GIFs and soundboards with your friends. Connect to a server by IP.'),
        e ? null : h('div', { class: 'home-actions' }, h('button', { class: 'btn big', onclick: () => serverDialog() }, 'Connect to a server')),
        !e && list.length
          ? h(
              'div',
              { class: 'home-servers' },
              h('div', { class: 'cat' }, 'Saved servers'),
              list.map((s) =>
                h(
                  'button',
                  { class: 'home-server', onclick: () => connectTo(s) },
                  serverIcon(s),
                  h('strong', {}, s.serverName || 'Server'),
                  h('span', { class: 'muted' }, s.address)
                )
              )
            )
          : null,
        e ? null : h('p', { class: 'muted small hosting' }, 'Hosting? Run the friendspeak server and connect to it here.')
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
    disabled: !dm && !canCh(ch.id, 'send'),
    onkeydown: onComposerKey,
    oninput: onComposerInput,
    onclick: (e) => updateMentionMenu(e.target),
    onkeyup: (e) => (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') && updateMentionMenu(e.target),
    onfocus: renderTyping,
    onblur: () => (closeMentionMenu(), renderTyping()),
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
    if (main.classList.contains('dropping')) return;
    // Say where the files go, and how much room is left (D72)
    const st = S.server?.storage;
    main.dataset.drop = dm
      ? `Drop to send to ${ch.name}\nImages go straight to ${ch.name}’s device.`
      : `Drop to upload to #${ch.name}` + (st ? `\n${fmtBytes(Math.max(0, st.max - st.used))} left on this server` : '');
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
      dm ? h('button', { class: 'badge warn dm-conflict', hidden: !DM.contacts.get(ch.with)?.conflict, title: 'Messages from a different key are being refused', onclick: () => trustKeyPrompt(ch.with) }, icon('warn'), 'Different key') : null,
      h('div', { class: 'spacer' }),
      dm ? h('div', { class: 'dm-call-btns' }) : null,
      searchBox(ch),
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
        h('button', { class: 'icon-btn emoji-btn', title: 'Emoji', onclick: (e) => openEmojiPicker(e.currentTarget, { mode: 'insert' }) }, icon('smile')),
        // A narrow composer (a small window) has no room for its buttons: they move into this menu (D72)
        h(
          'button',
          {
            class: 'icon-btn composer-more',
            title: 'Add to message',
            onclick: (e) => {
              const b = e.currentTarget;
              menuPopover(
                b,
                [
                  canUpload && { label: dm ? 'Send images' : 'Upload a file', icon: 'upload', run: () => fileIn.click() },
                  { label: 'GIF', icon: 'image', run: () => openGifPicker(b) },
                  { label: 'Emoji', icon: 'smile', run: () => openEmojiPicker(b, { mode: 'insert' }) },
                  { label: 'Soundboard', icon: 'board', run: () => openSoundboard(b) },
                ],
                { align: 'end', label: 'Add to message' }
              );
            },
          },
          icon('plus')
        )
      ),
      h('div', { id: 'typing', class: 'typing' })
    )
  );
  renderMessages();
  renderReplyBar();
  renderAttachTray();
  renderDmCall();
  syncComposer();
  ta.focus();
}

// The composer follows the channel's send permission (without rebuilding it, so a draft stays)
function syncComposer() {
  const ch = chatById(S.channelId);
  const ta = $('#composer-input');
  if (!ch || !ta || ch.type === 'dm') return;
  const ok = canCh(ch.id, 'send');
  ta.disabled = !ok;
  ta.placeholder = ok ? `Message #${ch.name}` : NOPE;
  ta.closest('.composer')?.classList.toggle('locked', !ok);
}

// Whether a DM can be delivered right now
const dmStatus = (peerId) =>
  DM.connected(peerId)
    ? dotted(['connected', playingEl(DM.gameOf(peerId), DM.gameIconOf(peerId))])
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
  updateTitle();
  const status = head.querySelector('.dm-status');
  if (status && ch.type === 'dm') status.replaceChildren(...[dmStatus(ch.with)].flat()); // text, or parts with the game's icon
  const conflict = head.querySelector('.dm-conflict');
  if (conflict && ch.type === 'dm') conflict.hidden = !DM.contacts.get(ch.with)?.conflict;
  const ta = $('#composer-input');
  if (ta && ch.type === 'dm') ta.placeholder = `Message @${ch.name}`;
  syncComposer();
}

async function selectChannel(id) {
  const ch = chatById(id);
  if (!ch) return;
  S.channelId = id;
  S.unread.delete(id);
  if (!isDm(id) && S.entry && mentionUnread.clear(S.entry.id, id)) renderRail();
  showGame(false);
  closeStage({ nav: true });
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
  // Draw the channel at once; its messages show a spinner until the history is here
  const fetching = !S.messages.has(id) && S.connected;
  renderRail();
  renderHeader();
  renderChannels();
  renderMembers();
  renderMain();
  if (!fetching) return;
  const res = await S.socket.emitWithAck('msg:history', { channelId: id });
  S.messages.set(id, res.messages || []);
  S.hasMore.set(id, (res.messages || []).length >= 50);
  if (S.channelId === id) renderMessages();
}

function isGrouped(m, prev) {
  return prev && prev.author === m.author && m.ts - prev.ts < 5 * 60e3 && !m.replyTo && sameDay(m.ts, prev.ts);
}

const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
// A day divider's words: Today, Yesterday, a weekday this week, or the date
function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 864e5);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: days < 7 ? 'long' : 'short', month: days < 7 ? undefined : 'long', day: days < 7 ? undefined : 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

// A divider before the first message of each day in the list. Run after any change to which
// messages are drawn: it only adds, moves or removes dividers, never the messages.
function syncDays(box = $('#messages')) {
  if (!box) return;
  let prevTs = null;
  const want = new Map(); // .msg element -> its day's label, for the first of each day
  for (const el of box.querySelectorAll(':scope > .msg[data-ts]')) {
    const ts = +el.dataset.ts;
    if (prevTs == null || !sameDay(ts, prevTs)) want.set(el, dayLabel(ts));
    prevTs = ts;
  }
  for (const sep of box.querySelectorAll(':scope > .day-sep')) {
    const next = sep.nextElementSibling;
    if (want.get(next) === sep.dataset.day) want.delete(next);
    else sep.remove();
  }
  for (const [el, day] of want) el.before(h('div', { class: 'day-sep', role: 'separator', 'data-day': day, 'aria-label': day }, h('span', {}, day)));
}

// formatText(), but a text it can't draw is shown plain: one message must never take the whole list down
function safeFormat(text, opts) {
  try {
    return formatText(text, opts);
  } catch (e) {
    log.error('a message could not be formatted', e); // the error, never the text
    const p = document.createElement('p');
    p.textContent = text;
    return { html: p.outerHTML, jumbo: false, embeds: [], links: [] };
  }
}

function messageEl(m, prev) {
  const grouped = isGrouped(m, prev);
  const author = profileOf(m.author, m.name);
  const mine = m.author === me().id;
  const inServer = !m.thread && !inDmView() && !!S.server; // DMs keep the plain @name matching
  const { html, jumbo, embeds, links } = safeFormat(m.text || '', {
    emojis: S.server?.emojis || [],
    myName: me().name,
    linkLabel: messageLinkLabel,
    ...(inServer ? { ...((marks) => (marks ? { mentions: marks } : { mentionables: mentionables() }))(mentionMarks(m)), channelMarks: channelMarks(m), channels: textChannels() } : {}),
  });
  const mentioned = !mine && (inServer ? mentionsMe(m) : /class="mention me"/.test(html));
  const replied = m.replyTo && S.messages.get(S.channelId)?.find((x) => x.id === m.replyTo);

  const reactions = Object.entries(m.reactions || {});
  const authorMenu = (e) => !m.note && contextMenu(e, personItems({ ...author, id: m.author }, e.currentTarget, { align: 'right', mention: true }), author.name);
  const canDelete = mine || m.note || (hasPerms() && !inDmView() && can('manageMessages'));
  // Right-click on a message: the hover bar's actions and Copy text (D72)
  const msgMenu = (e) => {
    if (e.defaultPrevented) return; // the author's own menu
    const el = e.currentTarget;
    contextMenu(
      e,
      [
        !m.note && { label: 'Add reaction', icon: 'addReact', run: () => openEmojiPicker(el.querySelector('.msg-actions button') || el, { mode: 'react', messageId: m.id }) },
        !m.note && { label: 'Reply', icon: 'reply', run: () => setReply(m) },
        m.text && { label: 'Copy text', run: () => navigator.clipboard.writeText(m.text).then(() => toast('Text copied', 'success')) },
        inServer && S.server.id && { label: 'Copy message link', icon: 'link', run: () => copyMessageLink(m) },
        mine && m.text && !m.note && { label: 'Edit', icon: 'edit', run: () => editMessage(m) },
        '-',
        canDelete && { label: 'Delete message…', icon: 'trash', danger: true, run: () => deleteMessageAsk(m, false) },
      ],
      'Message'
    );
  };
  return h(
    'div',
    {
      class: 'msg' + (grouped ? ' grouped' : '') + (mentioned ? ' mentioned' : '') + (m.pending ? ' pending' : '') + (m.mailed ? ' mailed' : '') + (m.note ? ' note' : ''),
      'data-id': m.id,
      'data-ts': m.ts,
      hidden: deleting.has(m.id),
      title: m.mailed ? 'Waiting in their mailbox' : m.pending ? 'Not delivered yet' : null,
      oncontextmenu: msgMenu,
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
        : h('button', { class: 'msg-avatar', onclick: (e) => profilePopover(e.currentTarget, { ...author, id: m.author }), oncontextmenu: authorMenu }, avatarEl(author, 40)),
      h(
        'div',
        { class: 'msg-body' },
        grouped
          ? null
          : h(
              'div',
              { class: 'msg-head' },
              h('span', { class: 'msg-author', style: { color: author.color }, onclick: (e) => profilePopover(e.currentTarget, { ...author, id: m.author }), oncontextmenu: authorMenu }, author.name),
              h('span', { class: 'msg-time' }, fmtTime(m.ts))
            ),
        m.text ? h('div', { class: 'msg-text' + (jumbo ? ' jumbo' : ''), html: m.edited ? html.replace(/(<\/p>)?$/, (end) => ' <span class="edited">(edited)</span>' + end) : html }) : null,
        m.files?.length ? h('div', { class: 'attachments' }, m.files.map(m.thread ? (f) => dmAttachmentEl(m, f) : attachmentEl)) : null,
        links.length ? h('div', { class: 'embeds' }, links.map(messagePreviewEl)) : null,
        embeds.length ? h('div', { class: 'embeds' }, embeds.map(embedEl)) : null,
        m.gif && isImage(m.gif.url)
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
      inServer && S.server.id ? h('button', { title: 'Copy message link', onclick: () => copyMessageLink(m) }, icon('link')) : null,
      mine && m.text && !m.note ? h('button', { title: 'Edit', onclick: () => editMessage(m) }, icon('edit')) : null,
      canDelete ? h('button', { title: 'Delete (Shift-click: at once, with Undo)', class: 'danger', onclick: (e) => deleteMessageAsk(m, e.shiftKey) }, icon('trash')) : null
    )
  );
}

// Delete a message: asked first, or at once with Shift, then with an Undo for a few seconds before
// it is sent (D72). The socket and channel are the ones in view now, whatever happens meanwhile.
const deleting = new Map(); // message id -> timer
async function deleteMessageAsk(m, quick) {
  const cid = S.channelId;
  const peer = inDmView() ? peerOf(cid) : null;
  const socket = S.socket;
  const send = () =>
    peer ? DM.deleteMessage(peer, m.id) : socket?.emitWithAck('msg:delete', { channelId: cid, messageId: m.id }).then((r) => r?.error && toast(r.error, 'error'));
  if (!quick) return (await confirmModal('Delete message', 'Delete this message? Tip: Shift-click the trash to delete at once, with an Undo.', 'Delete message')) && send();
  const shown = (on) => {
    const el = $(`.msg[data-id="${CSS.escape(m.id)}"]`);
    if (el) el.hidden = !on;
  };
  shown(false);
  deleting.set(m.id, setTimeout(() => (deleting.delete(m.id), send()), 6000));
  toast('Message deleted', 'success', 5500, { action: { label: 'Undo', run: () => (clearTimeout(deleting.get(m.id)), deleting.delete(m.id), shown(true)) } });
}

function renderMessages(keepScroll = false) {
  const box = $('#messages');
  if (!box) return;
  if (!S.messages.has(S.channelId) && !isDm(S.channelId) && S.connected) return box.replaceChildren(h('div', { class: 'messages-loading' }, spinner(true)));
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
              : `${p.name}’s key isn’t known yet. What you write is sent once they connect with a current friendspeak.`)
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
  syncDays(box);
  if (!keepScroll || atBottom) box.scrollTop = box.scrollHeight;
  else box.scrollTop = prevTop;
  // re-stick once images load
  for (const img of $$('img', box)) img.addEventListener('load', () => atBottomOrNew(box) && (box.scrollTop = box.scrollHeight), { once: true });
}

const atBottomOrNew = (box) => box.scrollHeight - box.scrollTop - box.clientHeight < 400;

const messageNode = (id) => $('#messages')?.querySelector(`.msg[data-id="${CSS.escape(String(id))}"]`);
// Draw again, in place, the messages in view that match(m, index): the rest of the list is left alone
function redrawMessages(match) {
  const list = S.messages.get(S.channelId);
  if (!list || !$('#messages')) return;
  list.forEach((m, i) => match(m, i) && messageNode(m.id)?.replaceWith(messageEl(m, list[i - 1])));
  syncDays();
}

function appendMessage(m, force) {
  const box = $('#messages');
  if (!box) return;
  const list = S.messages.get(S.channelId);
  if (!list) return; // the channel is still loading: the history on its way has this message
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  // A DM sorts in by when it was sent: one sent just before yours but delivered after it goes
  // above yours, not at the end. Drawn at the end it would sit under your name.
  if (list[list.length - 1] !== m) {
    renderMessages(true);
    if (atBottom || force) box.scrollTop = box.scrollHeight;
    return;
  }
  const el = messageEl(m, list[list.length - 2]);
  box.append(el);
  syncDays(box);
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
  const more = h('div', { class: 'older-loading' }, spinner());
  box.prepend(more);
  const res = await S.socket.emitWithAck('msg:history', { channelId: cid, before: list[0].id });
  loadingOlder = false;
  more.remove();
  if (cid !== S.channelId) return;
  const older = res.messages || [];
  S.hasMore.set(cid, older.length >= 50);
  const all = [...older, ...list];
  S.messages.set(cid, all);
  const fromBottom = box.scrollHeight - box.scrollTop;
  const first = messageNode(list[0].id);
  // The start of the channel has its intro to draw, so that goes the long way
  if (!S.hasMore.get(cid) || !first) renderMessages(true);
  else {
    // Put the older ones above what is there. Of those, only the first (it may now follow a message
    // by the same person) and replies to one of the older ones (their quote is known now) change.
    const frag = document.createDocumentFragment();
    older.forEach((m, i) => frag.append(messageEl(m, older[i - 1])));
    box.insertBefore(frag, first);
    const ids = new Set(older.map((m) => m.id));
    redrawMessages((m, i) => i === older.length || (i > older.length && ids.has(m.replyTo)));
  }
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
    icon('reply', 'reply-icon'),
    h('span', { class: 'grow' }, 'Replying to ', h('strong', {}, profileOf(S.replyTo.author, S.replyTo.name).name)),
    h('button', { class: 'icon-btn small', title: 'Cancel reply', onclick: () => ((S.replyTo = null), renderReplyBar(), $('#composer-input')?.focus()) }, icon('close'))
  );
}

function editMessage(m) {
  const el = $(`.msg[data-id="${m.id}"] .msg-text`);
  if (!el) return;
  const ta = h('textarea', { class: 'edit-box', rows: 1 });
  const start = inDmView() ? m.text : editableText(m); // mentions read with today's names
  ta.value = start;
  const done = (save) => {
    if (save && ta.value.trim() && ta.value !== start) {
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
  el.replaceWith(h('div', { class: 'edit-wrap' }, ta, h('div', { class: 'edit-hint muted small' }, h('kbd', { class: 'key' }, 'Esc'), ' to cancel', h('kbd', { class: 'key' }, 'Enter'), ' to save')));
  autosize(ta);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 300) + 'px';
}

// @-autocomplete in a server's composer: @everyone, roles, then people (online first)
let mentionMenu = null; // { el, items, index, at, ta }
function closeMentionMenu() {
  mentionMenu?.el.remove();
  mentionMenu = null;
}
function updateMentionMenu(ta) {
  if (inDmView() || !S.server) return closeMentionMenu();
  const upto = ta.value.slice(0, ta.selectionStart);
  const hash = /(?:^|\s)#([^\s#]*)$/.exec(upto);
  const m = hash || /(?:^|\s)@([^\n@]*)$/.exec(upto);
  if (!m) return closeMentionMenu();
  const q = m[1].toLowerCase();
  const at = upto.length - m[1].length - 1;
  const starts = (c) => c.name.toLowerCase().startsWith(q);
  // With a space in the query only names it still prefix-matches count
  const match = (c) => starts(c) || (!/\s/.test(q) && c.name.toLowerCase().includes(q));
  const rank = (a, b) => starts(b) - starts(a);
  const online = (c) => isOnline(c.id);
  const dup = sharedNames();
  // One entry per person; someone whose name is shared shows (and matches) their #tag
  const all = mentionCandidates()
    .filter((c) => !c.tagged)
    .map((c) => (c.kind === 'user' && nameTag(c.id, c.name, dup) ? { ...c, tag: mentionTag(c.id), name: `${c.name}#${mentionTag(c.id)}` } : c));
  const items = (
    hash
      ? textChannels().map((c) => ({ kind: 'channel', id: c.id, name: c.name })).filter(match).sort(rank)
      : [
      ...all.filter((c) => c.kind === 'everyone' && can('mentionEveryone') && match(c)),
      ...all.filter((c) => c.kind === 'role' && can('mentionRoles') && match(c)).sort(rank),
      ...all.filter((c) => c.kind === 'user' && c.id !== me().id && !isBanned(c.id) && match(c)).sort((a, b) => rank(a, b) || online(b) - online(a) || a.name.localeCompare(b.name)),
    ]
  ).slice(0, 60);
  if (!items.length) return closeMentionMenu();
  const keep = mentionMenu && mentionMenu.ta === ta;
  const index = keep ? Math.min(mentionMenu.index, items.length - 1) : 0;
  if (!keep) closeMentionMenu();
  const el = keep ? mentionMenu.el : h('div', { class: 'mention-menu', role: 'listbox' });
  if (!keep) ta.closest('.composer-wrap')?.append(el);
  mentionMenu = { el, items, index, at, ta };
  drawMentionMenu();
}
// Grouped (@everyone, roles, people, channels) with a key hint at the foot (D72)
const MM_GROUPS = { everyone: 'Everyone', role: 'Roles', user: 'People', channel: 'Channels' };
function drawMentionMenu() {
  const mm = mentionMenu;
  const holders = (id) => Object.values(S.server?.memberRoles || {}).filter((ids) => Array.isArray(ids) && ids.includes(id)).length;
  const rows = [];
  mm.items.forEach((c, i) => {
    if (c.kind !== mm.items[i - 1]?.kind) rows.push(h('div', { class: 'mm-group', role: 'presentation' }, MM_GROUPS[c.kind]));
    const attrs = {
      class: 'mm-item' + (i === mm.index ? ' active' : ''),
      role: 'option',
      'aria-selected': String(i === mm.index),
      onmousedown: (e) => (e.preventDefault(), insertMention(i)), // keep the focus in the composer
      onmousemove: () => mm.index !== i && ((mm.index = i), drawMentionMenu()),
    };
    if (c.kind === 'channel') return rows.push(h('div', attrs, icon('hash', 'mm-hash'), channelNameEl(c.name, S.server?.emojis, 'mm-name')));
    const p = c.kind === 'user' ? profileOf(c.id) : null;
    const color = typeof c.color === 'string' && /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : 'var(--muted)';
    const n = c.kind === 'role' ? holders(c.id) : 0;
    if (p && !isOnline(c.id)) attrs.class += ' offline';
    rows.push(
      h(
        'div',
        attrs,
        p ? avatarEl(p, 20) : h('span', { class: 'mm-dot', style: { background: c.kind === 'role' ? color : 'var(--accent)' } }),
        h('span', { class: 'mm-name' }, '@' + (c.tag ? c.name.slice(0, -c.tag.length - 1) : c.name), c.tag ? h('span', { class: 'name-tag' }, '#' + c.tag) : null),
        h('span', { class: 'mm-hint' }, c.kind === 'role' ? `${n} ${n === 1 ? 'person' : 'people'}` : c.kind === 'everyone' ? 'Notifies everyone' : isOnline(c.id) ? 'online' : 'offline')
      )
    );
  });
  mm.el.replaceChildren(
    h('div', { class: 'mm-list' }, rows),
    h('div', { class: 'mm-foot', 'aria-hidden': 'true' }, h('span', {}, h('kbd', { class: 'key' }, '↑'), h('kbd', { class: 'key' }, '↓'), ' move'), h('span', {}, h('kbd', { class: 'key' }, 'Tab'), ' or ', h('kbd', { class: 'key' }, 'Enter'), ' pick'), h('span', {}, h('kbd', { class: 'key' }, 'Esc'), ' close'))
  );
  mm.el.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}
function insertMention(i) {
  const { items, at, ta } = mentionMenu;
  const c = items[i];
  const end = ta.selectionStart;
  const text = `${c.kind === 'channel' ? '#' : '@'}${c.name} `;
  ta.value = ta.value.slice(0, at) + text + ta.value.slice(end);
  ta.setSelectionRange(at + text.length, at + text.length);
  closeMentionMenu();
  autosize(ta);
  ta.focus();
}

let lastTyping = 0;
function onComposerInput(e) {
  autosize(e.target);
  updateMentionMenu(e.target);
  if (Date.now() - lastTyping > 2500 && e.target.value) {
    lastTyping = Date.now();
    if (inDmView()) DM.typing(peerOf(S.channelId));
    else S.socket?.emit('typing', { channelId: S.channelId });
  }
}

function onComposerKey(e) {
  const ta = e.target;
  if (mentionMenu && !e.isComposing) {
    const n = mentionMenu.items.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      mentionMenu.index = (mentionMenu.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      return drawMentionMenu();
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') return e.preventDefault(), insertMention(mentionMenu.index);
    if (e.key === 'Escape') return e.preventDefault(), closeMentionMenu();
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const text = ta.value;
    ta.value = '';
    autosize(ta);
    closeMentionMenu();
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
  if (!canCh(cid, 'send')) return toast(NOPE, 'error'), false;
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
  // Nobody typing: the keys, while the composer has focus
  if (!names.length && document.activeElement?.id === 'composer-input') {
    if (!el.querySelector('.typing-hint'))
      el.replaceChildren(h('span', { class: 'typing-hint' }, h('kbd', {}, 'Enter'), ' send', h('kbd', {}, 'Shift+Enter'), ' new line'));
    return;
  }
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

// Your own files, or anyone's with Manage files
const canDeleteFile = (f) => f.by === me().id || can('manageFiles');

async function deleteFilesPrompt(files, skipConfirm) {
  if (!files.length) return;
  const what = files.length === 1 ? `"${files[0].name}"` : `${files.length} files`;
  if (!skipConfirm && !(await confirmModal('Delete file' + (files.length > 1 ? 's' : ''), `Permanently delete ${what} for everyone? This can't be undone.`, files.length === 1 ? 'Delete file' : `Delete ${files.length} files`))) return;
  await doAct('file:delete', { ids: files.map((f) => f.id) });
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
            class: 'icon-btn small attach-x',
            title: (a.progress != null ? 'Cancel upload of ' : 'Remove ') + a.file.name,
            onclick: () => {
              a.xhr?.abort();
              if (a.preview) URL.revokeObjectURL(a.preview);
              S.attachments.set(cid, (S.attachments.get(cid) || []).filter((x) => x !== a));
              renderAttachTray();
            },
          },
          icon('close')
        )
      );
    }),
    ...(st && total > st.max - st.used ? [h('div', { class: 'attach-warn error-text small' }, `Too big: ${fmtBytes(Math.max(0, st.max - st.used))} of server storage left`)] : [])
  );
}

// Raw-body POST with progress. The socket id says who we are, and the upload key from `hello` proves it.
// (The key's header only goes to a server that gave us one: an older server's CORS doesn't allow it.)
function uploadFile(a, channelId) {
  return new Promise((resolve, reject) => {
    const xhr = (a.xhr = new XMLHttpRequest());
    xhr.open('POST', `${S.entry.address}/api/files?channelId=${encodeURIComponent(channelId)}`);
    xhr.setRequestHeader('x-friendspeak-sid', S.sid);
    if (S.uploadKey) xhr.setRequestHeader('x-friendspeak-upload', S.uploadKey);
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

const lightboxArgs = new WeakMap(); // an image in a message -> [url, file]: what the lightbox shows for it
function attachmentEl(f) {
  const url = fileUrl(f);
  const kind = fileKind(f.type);
  const del = !canDeleteFile(f) ? null : h('button', { class: 'attach-del', title: 'Delete file (shift-click skips the prompt)', onclick: (e) => (e.stopPropagation(), deleteFilesPrompt([f], e.shiftKey)) }, icon('trash'));
  const card = () =>
    h(
      'div',
      { class: 'file-card' },
      h('span', { class: 'file-icon' }, fileEmoji(f.type)),
      h('div', { class: 'file-meta' }, h('a', { href: '#', class: 'file-name', title: f.name, onclick: (e) => (e.preventDefault(), downloadFile(f)) }, f.name), h('span', { class: 'muted small' }, fmtBytes(f.size))),
      h('button', { class: 'icon-btn', title: 'Download', onclick: () => downloadFile(f) }, icon('download'))
    );
  if (kind === 'image') {
    const img = h('img', { src: url, alt: f.name, loading: 'lazy', onclick: (e) => lightbox(url, f, e.currentTarget) });
    lightboxArgs.set(img, [url, f]); // so the lightbox can step to it from another image of the message
    return h('div', { class: 'attachment media' }, img, del);
  }
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
    lightboxArgs.set(img, [url, { ...f, blobUrl: url }]);
    img.onclick = () => lightbox(url, { ...f, blobUrl: url }, img);
    el.classList.remove('loading');
    state.remove();
  });
  return el;
}

function embedEl(e) {
  // A picture, video or sound file that a link points at, on any site: loading it tells that site our
  // address and that we are reading this chat, so it waits for a click unless the setting says to load it.
  if (['image', 'video', 'audio'].includes(e.kind)) {
    const media = () =>
      e.kind === 'image'
        ? ((img) => (lightboxArgs.set(img, [e.url, null]), img))(h('img', { src: e.url, loading: 'lazy', alt: '', referrerpolicy: 'no-referrer', onclick: (ev) => lightbox(e.url, null, ev.currentTarget) }))
        : h(e.kind, { src: e.url, controls: true, preload: 'metadata' });
    if (settings.get().loadLinkMedia) return h('div', { class: 'embed' }, media());
    let host = '';
    try {
      host = new URL(e.url).host;
    } catch {}
    const box = h('div', { class: 'embed' });
    box.append(h('button', { class: 'btn small ghost embed-load', title: 'Loading it shows your address to that site. Settings → Integrations can load these without asking.', onclick: () => box.replaceChildren(media()) }, `Show ${e.kind === 'audio' ? 'audio' : e.kind} from ${host}`));
    return box;
  }
  const frame = (src, style) =>
    h('iframe', {
      src,
      style,
      loading: 'lazy',
      // An embed is someone else's page: scripts and its own cookies, no top navigation, no clipboard
      sandbox: 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation',
      allow: 'autoplay; encrypted-media; fullscreen; picture-in-picture',
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

// An image, over everything (D72): who sent it and the file at the top, ← and → between the images of
// the same message, a click toggles its real size. `from` is the image clicked in the message.
function lightbox(url, f, from) {
  if (from) lightboxArgs.set(from, [url, f]);
  const msgEl = from?.closest('.msg');
  // Its siblings in the message: images that open here (they're registered on their first click, or are this one)
  const list = msgEl ? [...msgEl.querySelectorAll('.attachment img, .embed img')].filter((x) => lightboxArgs.has(x)) : [];
  let i = Math.max(0, list.indexOf(from));
  const argsOf = (el) => lightboxArgs.get(el) || [el.currentSrc || el.src, null];
  const m = msgEl && S.messages.get(S.channelId)?.find((x) => x.id === msgEl.dataset.id);
  const author = m && profileOf(m.author, m.name);
  const opener = document.activeElement;
  const img = h('img', { alt: '', onclick: () => img.classList.toggle('actual') });
  const stage = h('div', { class: 'lightbox-stage', onclick: (e) => e.target === stage && close() }, img);
  const what = h('span', { class: 'lightbox-what' });
  const dl = h('button', { class: 'icon-btn', title: 'Download' }, icon('download'));
  const open = h('a', { class: 'icon-btn', title: 'Open original', target: '_blank', rel: 'noopener noreferrer' }, icon('jump'));
  const count = h('span', { class: 'lightbox-count' });
  const show = (n) => {
    i = (n + list.length) % list.length || 0;
    const [u, file] = list.length ? argsOf(list[i]) : [url, f];
    img.src = u;
    img.alt = file?.name || '';
    img.classList.remove('actual');
    what.replaceChildren(...[author && h('strong', {}, author.name), author && file && ' · ', file && `${file.name} · ${fmtBytes(file.size)}`].filter(Boolean)); // replaceChildren(null) would print "null"
    dl.hidden = !file;
    dl.onclick = () => file && downloadFile(file);
    open.hidden = !!file;
    open.href = u;
    count.textContent = list.length > 1 ? `${i + 1} of ${list.length}` : '';
  };
  const close = () => {
    root.remove();
    document.removeEventListener('keydown', onKey, true);
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  };
  // Capture phase, so Escape closes only the lightbox and not a modal under it
  const onKey = (e) => {
    if (e.key === 'Escape') (e.stopPropagation(), close());
    else if (list.length > 1 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) (e.preventDefault(), show(i + (e.key === 'ArrowLeft' ? -1 : 1)));
  };
  const nav = (dir, label) => (list.length > 1 ? h('button', { class: 'icon-btn lightbox-nav', title: label, onclick: () => show(i + dir) }, icon(dir < 0 ? 'chevronLeft' : 'chevronRight')) : null);
  const closeBtn = h('button', { class: 'icon-btn', title: 'Close', onclick: () => close() }, icon('close'));
  const root = h(
    'div',
    { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Image' },
    h('div', { class: 'lightbox-bar' }, author ? avatarEl(author, 24) : null, what, h('span', { class: 'spacer' }), open, dl, closeBtn),
    h('div', { class: 'lightbox-body' }, nav(-1, 'Previous image'), stage, nav(1, 'Next image')),
    count
  );
  show(i);
  document.addEventListener('keydown', onKey, true);
  $('#modal-root').append(root);
  closeBtn.focus({ preventScroll: true });
}

async function jumpToMessage(channelId, messageId) {
  if (!chatById(channelId)) return toast('Message Unavailable');
  await selectChannel(channelId);
  const find = () => $(`.msg[data-id="${CSS.escape(messageId)}"]`);
  // Page back through history until the message is loaded (≤500 are kept)
  for (let i = 0; i < 12 && !find() && S.hasMore.get(channelId) && S.channelId === channelId && S.connected; i++) {
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

// ---------------------------------------------------------------- message links (D54) and channel links

// The bookmark of the server a message link names: known from connecting to it, or from its /dm socket
function linkedServer(serverId) {
  const list = servers.all();
  const address = DM.addressOf(serverId);
  return list.find((s) => s.serverId === serverId) || (address && list.find((s) => s.address === address)) || null;
}
// The pill a message link reads as: its channel on the server in view, else the server it is on
function messageLinkLabel({ server, channel }) {
  if (S.server?.id === server) {
    const ch = textChannels().find((c) => c.id === channel);
    return ch ? `#${ch.name} › message` : 'message link';
  }
  const entry = linkedServer(server);
  return entry ? `${serverLabel(entry)} › message` : 'message link';
}
function copyMessageLink(m) {
  navigator.clipboard.writeText(messageLink(S.server.id, S.channelId, m.id)).then(
    () => toast('Message link copied'),
    () => toast('Could not copy', 'error')
  );
}

// Previews are asked for once a minute at most; "server/channel/message" -> { at, preview: Promise<message | null> }
const linkPreviews = new Map();
function linkPreview(l) {
  const key = `${l.server}/${l.channel}/${l.message}`;
  const hit = linkPreviews.get(key);
  if (hit && Date.now() - hit.at < 60e3) return hit.preview;
  const preview = fetchLinkPreview(l).catch(() => null);
  linkPreviews.set(key, { at: Date.now(), preview });
  return preview;
}
// From the server itself, which only answers a member who can read the channel: over the
// connection in view (or the call's), else over the /dm socket kept to every bookmarked server
async function fetchLinkPreview({ server, channel, message }) {
  const live = conns().find((c) => c.connected && c.server?.id === server);
  let m;
  if (live) m = (await live.socket.timeout(8000).emitWithAck('msg:get', { channelId: channel, messageId: message }).catch(() => null))?.message;
  else {
    const entry = linkedServer(server);
    m = entry && (await DM.peek(entry.address, channel, message));
  }
  return m && typeof m === 'object' && typeof m.author === 'string' ? { ...m, profile: live?.server.profiles?.[m.author] } : null;
}

// The small preview under a message that links another one. Its height never changes, so the chat doesn't jump.
function messagePreviewEl(l) {
  const el = h('button', { class: 'msg-preview loading', type: 'button', disabled: true }, h('span', { class: 'muted' }, 'Loading message…'));
  linkPreview(l).then((p) => {
    el.classList.remove('loading');
    if (!p) {
      el.classList.add('gone');
      return el.replaceChildren(icon('link'), 'Message Unavailable');
    }
    const author = p.profile || profileOf(p.author, String(p.name || 'unknown').slice(0, 60));
    const where = S.server?.id === l.server ? '' : serverLabel(linkedServer(l.server) || { serverName: 'another server' });
    el.disabled = false;
    el.title = 'Go to message';
    el.onclick = () => openMessageLink(l);
    el.replaceChildren(
      h(
        'div',
        { class: 'mp-head' },
        avatarEl(author, 16),
        h('strong', { style: { color: author.color } }, author.name),
        h('span', { class: 'muted small' }, '#' + String(p.channelName || '').slice(0, 60) + (where ? ` · ${where}` : '')),
        h('span', { class: 'muted small' }, fmtTime(+p.ts || 0))
      ),
      h('div', { class: 'mp-text' }, plainText(String(p.text || '').replace(/<?friendspeak:\/\/msg\/[\w/-]+>?/g, '[message link]'), { gif: p.gif, files: p.files ? [0] : [] }))
    );
  });
  return el;
}

// Follow a message link: on the server in view, or connect to the one it names first
function openMessageLink({ server, channel, message }) {
  if (S.connected && S.server?.id === server) return jumpToMessage(channel, message);
  const entry = linkedServer(server);
  if (!entry) return toast('Message Unavailable');
  pendingJump = { entryId: entry.id, channelId: channel, messageId: message };
  connectTo(entry);
}

// Clicks on the links formatText() draws inside messages
function onLinkActivate(e) {
  if (e.type === 'keydown' && e.key !== 'Enter') return;
  const el = e.target.closest?.('.msg-text .chan-link[data-channel], .msg-text .msg-link');
  if (!el) return;
  e.preventDefault();
  if (el.classList.contains('msg-link')) return openMessageLink({ server: el.dataset.server, channel: el.dataset.channel, message: el.dataset.message });
  if (chatById(el.dataset.channel)) selectChannel(el.dataset.channel);
}
document.addEventListener('click', onLinkActivate);
document.addEventListener('keydown', onLinkActivate);

// ---------------------------------------------------------------- search

// The search field in the chat header: a server's text channels (or just the one in view), or the
// DM in view. Servers search their own history; DMs are searched here, where they are stored.
let search = null; // { box, input, drop, results, index, seq, q, note } for the header in view
let searchHere = false; // "this channel only"
function closeSearch(clear) {
  if (!search) return;
  search.drop.hidden = true;
  search.seq++; // an answer still on its way is dropped
  if (clear) search.input.value = '';
}
function searchBox(ch) {
  const input = h('input', {
    id: 'search-input',
    type: 'text',
    placeholder: 'Search',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': ch.type === 'dm' ? 'Search this conversation' : 'Search messages',
    oninput: () => (drawSearch(), runSearch()),
    onfocus: () => (drawSearch(), runSearch()),
    onkeydown: (e) => {
      const st = search;
      const n = st.results.length;
      if (e.key === 'Escape') return e.preventDefault(), closeSearch(true), input.blur();
      // Tab finishes the filter being typed with the first suggestion
      if (e.key === 'Tab' && !e.shiftKey && searchSuggestions()[0]?.finishes) return e.preventDefault(), searchSuggestions()[0].run();
      if (st.drop.hidden || !n) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        st.index = (st.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        drawSearch();
      } else if (e.key === 'Enter') (e.preventDefault(), pickSearch(st.index));
    },
  });
  const drop = h('div', { class: 'search-drop', hidden: true });
  const box = h('div', { class: 'search' }, icon('search'), input, drop);
  search = { box, input, drop, results: [], index: 0, seq: 0, q: '', note: '', idle: true };
  return box;
}
// Who a search can be `from:`: the server's people, or the two of us in a DM
function searchPeople() {
  if (inDmView()) return [me(), { ...profileOf(peerOf(S.channelId)), id: peerOf(S.channelId) }].map((p) => ({ id: p.id, name: String(p.name || '') }));
  return Object.entries(S.server?.profiles || {}).map(([id, p]) => ({ id, name: String(p?.name || '') })).filter((p) => p.name);
}
// Same as hasKind() in server.js
const hasKind = (m, k) => (k === 'gif' ? !!m.gif : k === 'link' ? /https?:\/\//.test(m.text || '') : Array.isArray(m.files) && (k === 'image' ? m.files.some((f) => /^image\//.test(f?.type || '')) : m.files.length > 0));
// The chips under the field: the filters there are, or ways to finish the one being typed.
// [{ label, run, finishes? }]; `run` rewrites the field, `finishes`: it completes what is being typed.
function searchSuggestions() {
  const st = search;
  if (!st) return [];
  const value = st.input.value;
  const put = (text) => () => {
    st.input.value = text;
    st.input.focus();
    drawSearch();
    runSearch();
  };
  const typing = /(?:^|\s)(from|in|has|before|after|on|during):("[^"]*|\S*)$/i.exec(value);
  if (!typing) {
    const lead = value && !/\s$/.test(value) ? value + ' ' : value;
    return SEARCH_FILTERS.filter((op) => op !== 'in' || !inDmView()).map((op) => ({ label: op + ':', run: put(lead + op + ':') }));
  }
  const op = typing[1].toLowerCase();
  const part = typing[2].replace(/^"/, '').toLowerCase();
  const head = value.slice(0, value.length - typing[2].length);
  const quoted = (v) => (/\s/.test(v) ? `"${v}"` : v);
  const options =
    op === 'from'
      ? [...new Set(searchPeople().map((p) => p.name))]
      : op === 'in'
        ? textChannels().map((c) => c.name)
        : op === 'has'
          ? SEARCH_HAS
          : ['today', 'yesterday', new Date(Date.now() - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 10)];
  return options
    .filter((v) => v.toLowerCase().includes(part) && v.toLowerCase() !== part)
    .sort((a, b) => b.toLowerCase().startsWith(part) - a.toLowerCase().startsWith(part))
    .slice(0, 6)
    .map((v) => ({ label: v, finishes: true, run: put(head + quoted(v) + ' ') }));
}
const runSearch = debounce(async () => {
  const st = search;
  const cid = S.channelId;
  if (!st || st.drop.hidden) return;
  const dm = isDm(cid);
  const f = parseSearch(st.input.value.slice(0, 300));
  const q = f.q.slice(0, 100);
  const seq = ++st.seq;
  const show = (results, note = '', idle = false) => search === st && seq === st.seq && (Object.assign(st, { results, index: 0, q, note, idle }), drawSearch());
  // Names become ids here: the server is asked about people and one channel, never about names
  const people = searchPeople();
  const from = [];
  for (const name of f.from) {
    const ids = name === 'me' ? [me().id] : people.filter((p) => p.name.toLowerCase() === name || `${p.name}#${mentionTag(p.id)}`.toLowerCase() === name).map((p) => p.id);
    if (!ids.length) return show([], `No one here is called “${name}”`);
    from.push(...ids);
  }
  const inChannel = dm ? null : f.in.map((name) => textChannels().find((c) => c.name.toLowerCase() === name) || name)[0];
  if (typeof inChannel === 'string') return show([], `There’s no channel called #${inChannel}`);
  if (f.bad.length) return show([], /^has:/.test(f.bad[0]) ? `“${f.bad[0]}” isn’t a filter: has: takes ${SEARCH_HAS.join(', ')}` : `“${f.bad[0]}” isn’t a date: use 2026-10-04, today or yesterday`);
  if (!q && !from.length && !f.has.length && f.before == null && f.after == null && !inChannel) return show([], '', true);
  if (dm) {
    const lower = q.toLowerCase();
    const hits = (await DM.history(peerOf(cid)))
      .filter((m) => !m.note && (!from.length || from.includes(m.author)) && (f.before == null || m.ts < f.before) && (f.after == null || m.ts >= f.after) && f.has.every((k) => hasKind(m, k)))
      .map((m) => {
        const text = String(m.text || '');
        const at = text.toLowerCase().indexOf(lower);
        const file = at < 0 && m.files?.find((x) => String(x.name || '').toLowerCase().includes(lower));
        return at >= 0 || file ? { channelId: cid, id: m.id, author: m.author, name: m.name, ts: m.ts, text: snippetAround(text, Math.max(0, at), at < 0 ? 0 : q.length), file: file ? file.name : undefined } : null;
      })
      .filter(Boolean)
      .reverse();
    return show(hits.slice(0, 50), hits.length > 50 ? 'Showing the newest 50 matches' : '');
  }
  const res = S.connected
    ? await S.socket
        .timeout(8000)
        .emitWithAck('msg:search', { q, channelId: inChannel ? inChannel.id : searchHere ? cid : undefined, from: from.length ? from : undefined, before: f.before ?? undefined, after: f.after ?? undefined, has: f.has.length ? f.has : undefined })
        .catch(() => null)
    : null;
  if (!Array.isArray(res?.results)) return show([], S.connected ? 'This server didn’t answer. Search needs a newer friendspeak server.' : 'Not connected');
  show(res.results.filter((r) => r && typeof r.id === 'string' && typeof r.channelId === 'string').slice(0, 50), res.more ? 'Showing the newest 50 matches' : '');
}, 200);
// `text` with every occurrence of `q` marked, as nodes (never HTML: this is user text)
function highlighted(text, q) {
  const out = [];
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let at = 0;
  for (let i = lower.indexOf(needle); needle && i >= 0; i = lower.indexOf(needle, at)) {
    out.push(text.slice(at, i), h('mark', {}, text.slice(i, i + needle.length)));
    at = i + needle.length;
  }
  return [...out, text.slice(at)];
}
function drawSearch() {
  const st = search;
  const dm = inDmView();
  const scope = (here, label) => h('button', { class: 'chip' + (searchHere === here ? ' on' : ''), onmousedown: (e) => (e.preventDefault(), (searchHere = here), drawSearch(), runSearch()) }, label);
  const hints = searchSuggestions();
  st.drop.hidden = false;
  st.drop.replaceChildren(
    ...[
    dm ? null : h('div', { class: 'search-scope' }, scope(false, 'All channels'), scope(true, '#' + (channelById(S.channelId)?.name || 'this channel'))),
    hints.length ? h('div', { class: 'search-filters' }, hints.map((s) => h('button', { class: 'chip', onmousedown: (e) => (e.preventDefault(), s.run()) }, s.label))) : null,
    h(
      'div',
      { class: 'search-results', role: 'listbox' },
      st.results.map((r, i) => {
        const author = profileOf(r.author, String(r.name || 'unknown').slice(0, 60));
        const text = String(r.text || '');
        return h(
          'div',
          {
            class: 'sr' + (i === st.index ? ' active' : ''),
            role: 'option',
            onmousedown: (e) => (e.preventDefault(), pickSearch(i)), // before the field loses focus
            onmousemove: () => st.index !== i && ((st.index = i), st.drop.querySelector('.sr.active')?.classList.remove('active'), st.drop.querySelectorAll('.sr')[i]?.classList.add('active')),
          },
          avatarEl(author, 28),
          h(
            'div',
            { class: 'sr-body' },
            h(
              'div',
              { class: 'sr-head' },
              h('strong', { style: { color: author.color } }, author.name),
              dm ? null : h('span', { class: 'muted small sr-channel' }, '#' + (channelById(r.channelId)?.name || 'unknown')),
              h('span', { class: 'muted small sr-time' }, fmtTime(+r.ts || 0))
            ),
            text ? h('div', { class: 'sr-text' }, highlighted(text, st.q)) : null,
            typeof r.file === 'string' ? h('div', { class: 'sr-text' }, '📎 ', highlighted(r.file.slice(0, 200), st.q)) : null
          )
        );
      })
    ),
    st.results.length
      ? null
      : st.idle
        ? h('div', { class: 'search-empty muted' }, st.note || 'Type to search. Filters narrow it down: from:name, has:image, before:2026-10-04…')
        : st.note
          ? emptyState('errorCircle', st.note)
          : emptyState('search', 'No messages match', 'Try fewer words, or other filters.'),
    st.results.length && st.note ? h('div', { class: 'search-note muted small' }, st.note) : null,
    ].filter(Boolean) // replaceChildren(null) would insert the text "null"
  );
  st.drop.querySelector('.sr.active')?.scrollIntoView({ block: 'nearest' });
}
function pickSearch(i) {
  const r = search?.results[i];
  if (!r) return;
  closeSearch(true);
  search.input.blur();
  jumpToMessage(r.channelId, r.id);
}
// composedPath: a chip that was clicked has already been redrawn, so it is no longer inside the box
document.addEventListener('mousedown', (e) => search && !search.drop.hidden && !e.composedPath().includes(search.box) && closeSearch());

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
  const search = h('input', { type: 'search', 'aria-label': 'Search files', placeholder: 'Search by name or uploader', oninput: () => ((view.q = search.value.trim().toLowerCase()), draw()) });
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
    const sel = view.files.filter((f) => view.selected.has(f.id) && canDeleteFile(f));
    const all = h('input', {
      type: 'checkbox',
      title: 'Select all',
      checked: list.length > 0 && list.every((f) => view.selected.has(f.id)),
      onchange: (e) => (list.forEach((f) => (e.target.checked ? view.selected.add(f.id) : view.selected.delete(f.id))), draw()),
    });
    bulk.replaceChildren(
      h('span', { class: 'muted small' }, (sel.length ? `${sel.length} selected · ` : '') + `${list.length} file${list.length === 1 ? '' : 's'} · ${fmtBytes(list.reduce((n, f) => n + f.size, 0))}`),
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
                canDeleteFile(f) ? h('button', { class: 'icon-btn danger', title: 'Delete (shift-click skips the prompt)', onclick: (e) => deleteFilesPrompt([f], e.shiftKey) }, icon('trash')) : null
              )
            );
          })
        : !view.loaded
          ? [0, 1, 2, 3].map(() => h('div', { class: 'file-row skel-row' }, h('span'), h('span', { class: 'skel' }), h('span', { class: 'skel' }), h('span', { class: 'skel' })))
          : [
              view.files.length
                ? emptyState('search', 'No files match', 'Try another name, uploader or type.')
                : view.scope
                  ? emptyState('folder', `No files in #${channelById(view.scope)?.name || 'this channel'} yet`, 'Drop some into the chat.', h('button', { class: 'btn small ghost', onclick: () => ((scopeSel.value = view.scope = ''), load()) }, 'Show all channels'))
                  : emptyState('folder', 'No files on this server yet', 'Files sent in any channel show up here.'),
            ])
    );
  }

  let seq = 0;
  async function load() {
    const n = ++seq;
    const r = await S.socket.emitWithAck('file:list', { channelId: view.scope });
    if (n !== seq || fileBrowser !== api) return;
    view.files = r.files || [];
    view.loaded = true;
    if (r.storage) S.server.storage = r.storage;
    draw();
  }

  const api = { reload: load };
  fileBrowser?.close?.();
  const close = modal(
    'Files',
    h('div', { class: 'file-browser' }, h('div', { class: 'file-toolbar' }, scopeSel, kindSel, search), usageBox, table),
    { wide: true, actions: [bulk], onClose: () => fileBrowser === api && (fileBrowser = null) }
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
    grid.replaceChildren(...[96, 140, 80, 120, 150, 90, 110, 70].map((px) => h('div', { class: 'gif-item skel', style: { height: px + 'px' }, 'aria-hidden': 'true' })));
    scroller.scrollTop = 0;
    try {
      const data = await searchGifs(q);
      if (my !== seq) return;
      if (!data.length) return grid.replaceChildren(emptyState('image', 'No GIFs found', 'Try other words.'));
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
          ? emptyState(
              'key',
              'GIFs need a free GIPHY API key',
              'Get one at developers.giphy.com and paste it in Settings → Integrations.',
              onPick ? null : h('button', { class: 'btn small', onclick: () => (pop.close(), openSettings('integrations')) }, 'Open settings')
            )
          : emptyState('errorCircle', 'GIPHY didn’t answer', e.message, h('button', { class: 'btn small ghost', onclick: () => run(input.value.trim()) }, 'Try again'))
      );
    }
  };
  let t;
  const input = h('input', { class: 'gif-search', 'aria-label': 'Search GIPHY', placeholder: 'Search GIPHY', oninput: (e) => (clearTimeout(t), (t = setTimeout(() => run(e.target.value.trim()), 300))) });
  const pop = popover(anchor, h('div', { class: 'gif-picker', role: 'dialog', 'aria-label': 'GIFs' }, input, scroller, h('div', { class: 'giphy-attr' }, 'Powered by GIPHY')), { className: 'gif-pop' });
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

// View → Zoom In/Out/Actual Size step the UI size setting (desktop/main.js)
let showUiScale = null; // updates Settings → Appearance while it's open
desktop?.onZoom((step) => {
  applyAppearance(settings.set({ uiScale: step ? stepUiScale(settings.get(), step) : 100 }));
  showUiScale?.();
});

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
            role: 'button',
            tabindex: 0,
            'aria-label': `Play ${s.name}`,
            onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && (e.preventDefault(), playSound(s)),
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
      h('button', { class: 'sound-tile add', onclick: () => fileInput.click() }, h('div', { class: 'sound-emoji' }, icon('plus')), h('div', { class: 'sound-name' }, 'Add sounds'))
    );
  };
  draw();
  const vol = h('input', {
    type: 'range',
    min: 0,
    max: 1,
    step: 0.01,
    value: settings.get().soundboardVolume,
    'aria-label': 'Soundboard volume',
    oninput: (e) => {
      settings.set({ soundboardVolume: +e.target.value });
      audio.setSoundboardVolume(+e.target.value);
    },
  });
  const panel = h(
    'div',
    {
      class: 'soundboard',
      role: 'dialog',
      'aria-label': 'Soundboard',
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
  const keyBtn = hotkeyField(draft.hotkey || '', (v) => (draft.hotkey = v), { label: 'Hotkey' });
  const volLabel = h('span', {}, Math.round(draft.volume * 100) + '%');
  const close = modal(
    'Edit sound',
    h(
      'div',
      {},
      h(
        'div',
        { class: 'row' },
        h('label', { class: 'field emoji-field' }, h('span', {}, 'Emoji'), h('input', { value: draft.emoji, oninput: (e) => (draft.emoji = [...e.target.value.trim()].slice(0, 2).join('')) })),
        h('label', { class: 'field grow' }, h('span', {}, 'Name'), h('input', { value: draft.name, maxlength: 40, oninput: (e) => (draft.name = e.target.value) }))
      ),
      h(
        'label',
        { class: 'field' },
        h('span', { class: 'field-head' }, 'Volume', volLabel),
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
            class: 'btn danger ghost side',
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
const SHARE_TIERS = { auto: 'Auto (up to 1440p60)', '720p30': '720p 30 fps', '1080p60': '1080p 60 fps', '1440p60': '1440p 60 fps' };
const SHARE_MODES = { smooth: 'Smooth: games and video', sharp: 'Sharp: text and code' };

// The saved share quality: { tier, mode }
function shareQuality() {
  const s = settings.get();
  return { tier: TIERS[s.shareTier] ? s.shareTier : 'auto', mode: MODES[s.shareMode] ? s.shareMode : 'smooth' };
}

// Tier and mode selects that edit `q` in place and call onChange(q)
function shareQualityFields(q, onChange) {
  const select = (key, options, label) => {
    const el = h('select', { onchange: (e) => ((q[key] = e.target.value), onChange?.(q)) }, Object.entries(options).map(([v, text]) => h('option', { value: v }, text)));
    el.value = q[key];
    return h('label', { class: 'field' }, h('span', {}, label), el);
  };
  return h('div', { class: 'share-quality' }, select('tier', SHARE_TIERS, 'Quality'), select('mode', SHARE_MODES, 'Optimize for'));
}

function sharePopover(anchor) {
  const q = shareQuality();
  let p;
  const menu = menuEl([{ label: 'Change source…', run: () => screenPicker({ switching: true }) }, { label: 'Stop sharing', danger: true, run: () => liveVoice()?.stopMedia('screen') }], () => p.close(), 'Screen share');
  menu.prepend(shareQualityFields(q, () => (settings.set({ shareTier: q.tier, shareMode: q.mode }), liveVoice()?.setQuality('screen', q))), h('div', { class: 'menu-sep', role: 'separator' }));
  p = popover(anchor, menu, { align: 'right', className: 'menu-pop' });
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
  const q = shareQuality();
  const quality = shareQualityFields(q);
  quality.classList.add('share-quality-row');
  const liveNote = DMCALL.voice ? null : h('span', { class: 'foot-note' }, 'Only people who click LIVE receive it.');

  if (!desktop) {
    const choice = (surface, ic, label, sub) =>
      h('button', { class: 'share-choice', onclick: () => (close(), share({ surface, withAudio, quality: q })) }, icon(ic), h('strong', {}, label), h('span', { class: 'muted small' }, sub));
    const close = modal(
      heading,
      h(
        'div',
        {},
        h('div', { class: 'share-choices' }, choice('monitor', 'screen', 'Entire screen', 'A whole display'), choice('window', 'window', 'Window', 'One app window')),
        audioBox('Share audio'),
        quality
      ),
      { actions: [liveNote, h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel')].filter(Boolean) }
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
  const tabSeg = segmented([['screen', 'Screens'], ['window', 'Windows']], tab, (k) => ((tab = k), draw()), 'Source type');
  tabs.append(tabSeg);
  const go = h('button', { class: 'btn', disabled: true, onclick: () => (close(), share({ sourceId: selected, withAudio: withAudio && info.systemAudio, quality: q })) }, icon('screen'), switching ? 'Switch' : 'Go Live');
  const draw = () => {
    const list = info.sources.filter((s) => s.type === tab);
    grid.replaceChildren(
      ...(list.length
        ? list.map((s) =>
            h(
              'button',
              {
                class: 'share-source' + (s.id === selected ? ' selected' : ''),
                title: s.name,
                'aria-pressed': String(s.id === selected),
                onclick: () => ((selected = s.id), (go.disabled = false), draw()),
                ondblclick: () => ((selected = s.id), go.click()),
              },
              h('span', { class: 'pick-check', html: I.check }),
              s.thumbnail ? h('img', { src: s.thumbnail, alt: '' }) : h('div', { class: 'share-thumb-empty' }, icon(tab === 'screen' ? 'screen' : 'window')),
              h('span', { class: 'share-name' }, s.icon ? h('img', { src: s.icon, alt: '' }) : null, s.name)
            )
          )
        : [emptyState(tab === 'window' ? 'window' : 'screen', tab === 'window' ? 'No windows found' : 'No screens found', tab === 'window' ? 'Open the app you want to share, then come back.' : null)])
    );
  };
  draw();
  const close = modal(
    heading,
    h(
      'div',
      {},
      info.status !== 'granted'
        ? h(
            'div',
            { class: 'alert danger', role: 'alert' },
            icon('warn'),
            h('div', {}, h('strong', {}, 'Screen Recording isn’t allowed. '), 'Allow friendspeak in System Settings → Privacy & Security → Screen & System Audio Recording, then restart it.')
          )
        : null,
      tabs,
      grid,
      h('div', { class: 'share-options' }, quality, info.systemAudio ? audioBox('Share system audio') : h('p', { class: 'muted small' }, 'System audio sharing isn’t supported on this OS; video only.'))
    ),
    { wide: true, actions: [liveNote, h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'), go].filter(Boolean) }
  );
}

// Ask for the screen or window; null when cancelled or failed (after a toast).
async function captureScreen({ surface, sourceId, withAudio, quality }) {
  const tier = TIERS[quality.tier];
  const fps = Math.min(tier.fps, MODES[quality.mode].maxFps);
  const video = {
    width: { ideal: tier.width, max: tier.width },
    height: { ideal: tier.height, max: tier.height },
    frameRate: { ideal: fps, max: fps },
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
  const fail = (e) => (log.warn(`screen share failed: ${e.name}: ${e.message}`), toast('Could not share screen: ' + e.message, 'error'), null);
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

// What the media sidecar should capture for a picker choice (D45), or null when this share
// has to go through the browser engine: no sidecar, the setting is off, or audio it can't capture.
function nativeShareSource(opts) {
  const type = opts.sourceId?.startsWith('window:') ? 'window' : 'screen';
  if (!opts.sourceId || !nativeMedia.can(type)) return null;
  if (opts.withAudio && !nativeMedia.caps.audio) return null;
  return { type, id: opts.sourceId, audio: !!opts.withAudio };
}

// Start the share natively. False (after a console note) when it didn't work, so the caller shares the old way.
async function shareNative(v, opts) {
  const source = nativeShareSource(opts);
  if (!source) return false;
  try {
    await v.setNativeMedia('screen', source, opts.quality);
    return true;
  } catch (e) {
    console.warn('native share', e);
    return false;
  }
}

async function startShare(opts) {
  await nativeMedia.load();
  const v = liveVoice();
  if (!v) return;
  if (!(await shareNative(v, opts))) {
    const stream = await captureScreen(opts);
    if (!stream) return;
    liveVoice().setMedia('screen', stream, opts.quality);
  }
  log.info('screen share started');
  settings.set({ shareTier: opts.quality.tier, shareMode: opts.quality.mode });
  audio.cue('join');
  renderVoicePanel();
}

async function switchShare(opts) {
  await nativeMedia.load();
  const v = liveVoice();
  if (!v) return;
  if (nativeShareSource(opts)) {
    // The sidecar opens the new source; everyone watching is moved over to it
    let ok = false;
    await v.restart('screen', async () => (ok = await shareNative(v, opts)));
    if (!ok) return startShare({ ...opts, sourceId: opts.sourceId });
  } else {
    const stream = await captureScreen(opts);
    if (!stream) return;
    await v.replaceMedia('screen', stream, opts.quality); // starts a new share if it ended while the picker was open
    reattachOwn(v, 'screen');
  }
  settings.set({ shareTier: opts.quality.tier, shareMode: opts.quality.mode });
  renderVoicePanel();
  toast('Switched what you’re sharing', 'info', 3000);
}

// A native share's fallbacks (voice.js). A viewer on an app from before native
// streams gets the browser engine's capture of the same source…
VoiceClient.legacyCapture = (kind, source) => (kind === 'screen' ? captureScreen({ sourceId: source.id, withAudio: source.audio, quality: shareQuality() }) : openCamera());
// …and if the sidecar's share ends by itself, the browser engine takes it over for everyone watching
VoiceClient.onNativeLost = (v, kind, source, reason, viewers) => {
  console.warn('native', kind, 'ended:', reason);
  if (liveVoice() !== v) return v.emitMedia();
  toast(kind === 'screen' ? 'Your share moved to the standard pipeline' : 'Your camera moved to the standard pipeline', 'info', 5000);
  v.restart(
    kind,
    async () => {
      const stream = await VoiceClient.legacyCapture(kind, source);
      if (stream && liveVoice() === v) v.setMedia(kind, stream, kind === 'screen' ? shareQuality() : undefined);
      else stream?.getTracks().forEach((t) => t.stop());
    },
    viewers
  ).then(renderVoicePanel);
};

// After replaceMedia our own preview keeps the same MediaStream object; reattach so it shows the new tracks
function reattachOwn(v, kind) {
  const own = v === DMCALL.voice ? dmCallUi.tiles.get(kind + ':' + me().id) : S.stage?.tiles.get(kind + ':' + S.call?.sid);
  if (!own?.video) return;
  own.video.srcObject = null;
  own.video.srcObject = v.local[kind];
  own.video.play().catch(() => {});
}

// ---------------------------------------------------------------- camera

// The camera with the chosen background (D37), or null after telling the user why not
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
    log.warn(`camera failed: ${e.name}: ${e.message}`);
    return toast(e.name === 'NotFoundError' ? 'No camera found.' : 'Could not start camera: ' + e.message, 'error', 6000), null;
  }
}

// Put the camera on the call: `stream` from the preview, or a new capture
async function startCamera(stream) {
  // A plain camera goes through the media sidecar where it can (D45): the camera's own best mode up to 1440p60.
  // With a background the browser engine keeps it, since that is where the background is made (D37).
  await nativeMedia.load();
  const v = liveVoice();
  if (v && nativeMedia.can('camera')) {
    if (!stream) setBackground(await loadBackground());
    if (!BACKGROUNDS[activeBackground().type]) {
      const id = settings.get().videoDevice;
      const name = stream?.getVideoTracks()[0]?.label || (id && (await navigator.mediaDevices.enumerateDevices().catch(() => [])).find((d) => d.deviceId === id)?.label) || '';
      stream?.getTracks().forEach((t) => t.stop()); // the sidecar opens the camera itself
      stream = null;
      try {
        await v.setNativeMedia('camera', { type: 'camera', name });
        return renderVoicePanel();
      } catch (e) {
        console.warn('native camera', e);
      }
    }
  }
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
      // Back to no background: the camera may go (back) to the media sidecar
      if (!BACKGROUNDS[bg.type] && nativeMedia.can('camera')) return await v.restart('camera', () => startCamera()), true;
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
      { class: 'bg-tile ' + cls + (selected ? ' selected' : ''), role: 'button', tabindex: 0, 'aria-pressed': String(!!selected), title: name, style: image ? { backgroundImage: image } : null, onclick, onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && (e.preventDefault(), onclick()) },
      h('span', { class: 'pick-check', html: I.check }),
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
            icon('close')
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
      h('div', { class: 'field' }, h('span', {}, 'Background'), picker.el)
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

// Switch microphones; in a call (or a mic test) the new one is live at once.
// A listen-only call (no mic when it started) gets its mic this way too.
async function switchMic(deviceId) {
  try {
    await audio.setInputDevice(deviceId, !!(liveVoice() || audio.micStream));
    if (liveVoice()?.micError) (liveVoice().micError = null), renderVoicePanel();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// Right-click on a mute button: pick the microphone
const MIC_HINT = ' (right-click for microphones)';
const micMenu = (e) => (e.preventDefault(), micPopover(e.currentTarget));
// The arrow by Mute: the microphone and the output, with the voice settings below (D72)
async function micPopover(anchor) {
  const devs = (await navigator.mediaDevices?.enumerateDevices().catch(() => [])) || [];
  const { inputDevice, outputDevice } = settings.get();
  const list = (kind, word) => [{ deviceId: '', label: 'Default' }, ...devs.filter((d) => d.kind === kind && d.deviceId !== 'default')].map((d, i) => ({ ...d, label: d.label || `${word} ${i}` }));
  menuPopover(
    anchor,
    [
      { heading: 'Microphone' },
      ...list('audioinput', 'Microphone').map((d) => ({ label: d.label, selected: d.deviceId === inputDevice, run: () => switchMic(d.deviceId) })),
      '-',
      { heading: 'Output' },
      ...list('audiooutput', 'Speakers').map((d) => ({ label: d.label, selected: d.deviceId === outputDevice, run: () => (settings.set({ outputDevice: d.deviceId }), applyOutputDevice(d.deviceId)) })),
      '-',
      { label: 'Voice settings…', icon: 'gear', run: () => openSettings('voice') },
    ],
    { label: 'Audio devices' }
  );
}

async function cameraPopover(anchor) {
  const devs = (await navigator.mediaDevices?.enumerateDevices().catch(() => [])) || [];
  const cams = devs.filter((d) => d.kind === 'videoinput');
  const cur = settings.get().videoDevice;
  const pick = async (id) => {
    settings.set({ videoDevice: id });
    if (liveVoice()?.local.camera) {
      liveVoice().stopMedia('camera', true);
      await startCamera();
    }
  };
  menuPopover(
    anchor,
    [
      { heading: 'Camera' },
      ...(cams.length ? [{ deviceId: '', label: 'Default camera' }, ...cams].map((d, i) => ({ label: d.label || `Camera ${i}`, selected: d.deviceId === cur, run: () => pick(d.deviceId) })) : [{ note: 'No cameras found' }]),
      '-',
      { label: 'Preview and background…', run: () => cameraDialog() },
    ],
    { align: 'end', label: 'Camera' }
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
    const body = h('div', { class: 'stage', oncontextmenu: stageMenu }, main, grid);
    const popBtns = h('div', { class: 'stage-controls' });
    // The stage can be in a window of its own (popOutStage), so ask the page it is in
    const toggleFullscreen = () => (body.ownerDocument.fullscreenElement ? body.ownerDocument.exitFullscreen() : body.requestFullscreen?.().catch(() => {}));
    // tiles: key ("screen:<sid>", "camera:<sid>", "user:<sid>") -> tile; watching: sids of screens we receive;
    // pop: the window the stage is in, when it isn't in the app ({ win, name, ready, onTop })
    S.stage = { tiles: new Map(), watching: new Set(), volumes: new Map(), muted: new Set(), focus: null, title, stats, controls, popBtns, main, grid, body, el: null, pop: null };
    S.stage.ro = new ResizeObserver(() => layoutStage());
    S.stage.ro.observe(grid);
    // The focused (or first) screen share or camera
    startStats(S.stage, { tile: statsTile, voice: () => S.voice, name: (sid) => S.call?.users.find((u) => u.sid === sid)?.name });
    S.stage.el = h(
      'div',
      { class: 'stage-view' },
      h(
        'header',
        { class: 'chat-header' },
        icon('cam'),
        title,
        stats,
        h('div', { class: 'spacer' }),
        controls,
        popBtns,
        h('button', { class: 'icon-btn', title: 'Fullscreen', onclick: toggleFullscreen }, icon('expand')),
        h('button', { class: 'btn small ghost', onclick: () => closeStage() }, 'Close')
      ),
      body
    );
    $('#stream-view').replaceChildren(S.stage.el);
    document.body.classList.add('stream-visible');
  } else S.stage.pop?.win.focus();
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

// The LIVE and camera badges and the hover card's button: join the person's
// voice channel if needed, then show their screen share on the stage, or the
// stage's grid for cameras
async function watchStream(u, kind) {
  const channelId = u.voice;
  if (!inCall(channelId)) {
    if (!canCh(channelId, 'send')) return toast('You don’t have permission to join this voice channel', 'error');
    await joinVoice(channelId);
  }
  if (!inCall(channelId)) return;
  // They may have stopped or left while we joined
  const still = kind === 'screen' && S.users.some((x) => x.sid === u.sid && x.voice === channelId && x.sharing);
  openStage(still ? { screen: u.sid } : {});
}

// Resolution, real frame rate and codec of the stream src.tile() picks, so
// people can see what they are getting (and the sharer sees what each viewer
// gets). Sampled once per second and fed to both st.stats (a line of text) and
// the stats panel, since rates are deltas between calls.
// st: the stage, or the DM call's view (dmCallUi); clearing st.timer stops it.
// src: { tile(), voice(): the VoiceClient, name(sid): a viewer's name }
function startStats(st, src) {
  const { stats } = st;
  let frames = 0;
  let last = null;
  st.history = [];
  st.statsSrc = src;
  stats.onclick = () => st.pop || openStatsPanel(st, stats); // the panel is drawn in the app's page
  const timer = (st.timer = setInterval(async () => {
    const tile = src.tile();
    const v = tile?.video;
    const total = v?.getVideoPlaybackQuality?.().totalVideoFrames || 0;
    const fps = tile === last ? Math.max(0, total - frames) : 0;
    frames = total;
    last = tile;
    const base = v?.videoWidth ? `${v.videoWidth}×${v.videoHeight} · ${fps} fps` : '';
    const info = tile && (await src.voice()?.videoStats(tile.sid, tile.kind).catch(() => null));
    if (src.tile() !== tile || st.timer !== timer) return;
    const full = base && [base, formatVideoStats(info)].filter(Boolean).join(' · ');
    stats.textContent = full;
    stats.title = full ? 'Stream stats: ' + full : '';
    stats.style.cursor = full && !st.pop ? 'pointer' : '';
    if (tile && info) {
      const hist = st.history;
      hist.push({ time: new Date().toISOString(), tile: tile.key, kind: tile.kind, role: Array.isArray(info) ? 'sender' : 'receiver', stats: info });
      if (hist.length > 60) hist.shift();
    }
    st.statsPanel?.update(tile, info);
  }, 1000));
}

function statsTile() {
  const st = S.stage;
  if (!st) return null;
  const focused = st.tiles.get(st.focus);
  if (focused?.kind === 'screen' || focused?.kind === 'camera') return focused.live ? focused : null;
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
      const doc = tile.el.ownerDocument;
      if (tile.video) doc.fullscreenElement ? doc.exitFullscreen() : tile.el.requestFullscreen?.().catch(() => {});
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
        streamSound(
          video,
          () => ({ volume: S.stage.volumes.get(sid) ?? 1, muted: S.stage.muted.has(sid) }),
          (o) => {
            if (o.volume != null) S.stage.volumes.set(sid, o.volume);
            if (o.muted != null) S.stage.muted[o.muted ? 'add' : 'delete'](sid);
            syncStage();
          }
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
        // The page the tile is in: the app's, or the stage's own window
        const doc = video.ownerDocument;
        const dpr = doc.defaultView?.devicePixelRatio || 1;
        const w = video.clientWidth * dpr;
        const h = video.clientHeight * dpr;
        if (w && h) S.voice?.view(sid, kind, { w, h, hidden: doc.hidden });
        else if (doc.hidden) S.voice?.view(sid, kind, { hidden: true });
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

function reportTiles() {
  if (!S.stage) return;
  for (const t of S.stage.tiles.values()) t.report?.();
}
document.addEventListener('visibilitychange', reportTiles);

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
        : `${v.codec}${hw(v.hw)} ${v.w || 0}×${v.h || 0}@${v.fps || 0} ${(v.mbps || 0).toFixed(1)} Mbps` + (v.rung ? ` [rung ${v.rung.h}p${v.rung.fps}]` : '') + (v.limit && v.limit !== 'none' ? ` (limited by ${v.limit})` : '')
    )
    .join(' | ');
}

// The "Stream stats" panel: live numbers for the tile startStats() samples, plus
// the last minute of samples (st.history) as JSON to paste into a bug report.
function openStatsPanel(st, anchor) {
  if (st.statsPanel) return;
  const body = h('div', { class: 'stats-body' }, h('p', { class: 'muted small' }, 'Waiting for the next sample…'));
  const copy = async () => {
    const mine = st.history.at(-1)?.role === 'sender';
    const kind = st.history.at(-1)?.kind;
    const header = {
      version: appUpdate?.current || null,
      userAgent: navigator.userAgent,
      devicePixelRatio: window.devicePixelRatio,
      trackSettings: mine ? st.statsSrc.voice()?.local[kind]?.getVideoTracks()[0]?.getSettings() || null : null,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify({ header, history: st.history }, null, 2));
      toast(`Copied ${st.history.length} stats samples`);
    } catch {
      toast('Could not copy the stats', 'error');
    }
  };
  const what = h('span', { class: 'muted small' });
  const panel = h(
    'div',
    { class: 'stats-panel-inner', role: 'dialog', 'aria-label': 'Stream stats' },
    h('div', { class: 'stats-head' }, h('strong', {}, 'Stream stats'), what, h('div', { class: 'spacer' }), h('button', { class: 'btn small', onclick: copy }, 'Copy samples'), h('button', { class: 'icon-btn small', title: 'Close', onclick: () => pop.close() }, icon('close'))),
    body
  );
  const pop = popover(anchor, panel, { align: 'start', className: 'stats-panel', onClose: () => st.statsPanel === api && (st.statsPanel = null) });
  const api = {
    close: () => pop.close(),
    update(tile, info) {
      what.textContent = tile ? `${st.statsSrc.name(tile.sid) || 'someone'} · ${tile.kind}` : '';
      body.replaceChildren(statsView(tile, info, st.statsSrc.name));
      pop.place();
    },
  };
  st.statsPanel = api;
}

function statsView(tile, info, nameOf) {
  const f = (x, d = 1) => (typeof x === 'number' && isFinite(x) ? x.toFixed(d) : '–');
  const size = (w, hh) => (w ? `${w}×${hh}` : '–');
  const hw = (x) => (x === true ? 'hw' : x === false ? 'sw' : '');
  if (!tile || !info) return h('p', { class: 'muted small' }, 'Nothing to measure: focus a live screen share or camera.');
  if (!Array.isArray(info)) {
    const rows = [
      ['Codec', `${info.codec} (${hw(info.hw) || '?'} decode${info.decoder ? ', ' + info.decoder : ''})`],
      ['Received', `${size(info.w, info.h)} @ ${f(info.fps, 0)} fps, ${f(info.mbps, 2)} Mbps, QP ${f(info.qp, 0)}`],
      ['Shown at', info.view ? (info.view.hidden ? 'hidden' : size(info.view.w, info.view.h)) : '–'],
      ['Decode', `${f(info.decMs)} ms/frame, jitter buffer ${f(info.jbMs, 0)} ms`],
      ['Dropped / frozen', `${info.dropped ?? '–'} frames dropped, ${info.freezes ?? '–'} freezes (${f(info.freezeSec)} s), ${info.keyframes ?? '–'} keyframes`, info.freezes > 0],
      ['Packets', `${info.lost ?? '–'} lost, NACK ${info.nack ?? '–'}, PLI ${info.pli ?? '–'}, jitter ${f(info.jitterMs, 0)} ms`, info.jitterMs > 30],
      ['Path', `${info.cand || '–'}, RTT ${f(info.pathRtt, 0)} ms`, info.pathRtt > 250],
    ];
    // A value past a limit worth knowing about is drawn in yellow (D72)
    return h('table', { class: 'stats-table' }, h('tbody', {}, rows.map(([k, v, warn]) => h('tr', { class: warn ? 'warn' : null }, h('th', {}, k), h('td', {}, v)))));
  }
  if (!info.length) return h('p', { class: 'muted small' }, 'No viewers yet.');
  const cols = ['Viewer', 'Capture', 'Rung', 'Encoded', 'Sent / target / avail Mbps', 'Encoder', 'Limit', 'QP', 'Enc ms', 'Loss', 'RTT ms', 'Path', 'Viewer size'];
  const row = (v) => {
    const name = nameOf(v.sid) || 'someone';
    const limit = v.limit && v.limit !== 'none' ? v.limit : 'none';
    return [
      name + (v.paused ? ' (away)' : ''),
      `${size(v.capW, v.capH)} @ ${f(v.capFps, 0)}`,
      v.rung ? `${v.rung.h}p${v.rung.fps}` + (v.needMbps != null ? `, needs ${f(v.needMbps)}` + (v.upMbps != null ? `, up at ${f(v.upMbps)}` : '') : '') : '–',
      `${size(v.w, v.h)} @ ${f(v.fps, 0)}`,
      `${f(v.sentMbps, 2)} / ${f(v.mbps, 2)} / ${f(v.availMbps, 1)}`,
      `${v.codec} ${hw(v.hw)} ${v.impl || ''}`.trim() + (v.note ? ` (${v.note})` : ''),
      limit,
      f(v.qp, 0),
      f(v.encMs),
      v.loss != null ? f(v.loss * 100, 1) + '%' : '–',
      f(v.rtt ?? v.pathRtt, 0),
      v.cand || '–',
      v.view ? (v.view.hidden ? 'hidden' : size(v.view.w, v.view.h)) : '–',
    ];
  };
  const first = info[0];
  return h(
    'div',
    {},
    first?.tier && h('p', { class: 'muted small' }, `Quality: ${SHARE_TIERS[first.tier] || 'Camera'}, ${first.mode}`),
    h(
      'table',
      { class: 'stats-table' },
      h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c)))),
      h('tbody', {}, info.map((v) => h('tr', {}, row(v).map((c) => h('td', {}, c)))))
    )
  );
}

// Right-click on the video grid: the tile under the pointer (focus, full screen, its sound), then
// who gets a tile, then the window and the stats (D72)
function stageMenu(e) {
  const st = settings.get();
  const s = S.stage;
  const flip = (key) => () => (settings.set({ [key]: !settings.get()[key] }), syncStage());
  const tile = s && [...s.tiles.values()].find((t) => t.el?.contains(e.target));
  const name = tile && (S.call?.users.find((u) => u.sid === tile.sid)?.name || 'someone');
  const theirs = tile?.kind === 'screen' && tile.live && tile.sid !== S.call?.sid;
  contextMenu(
    e,
    [
      tile && { heading: name + (tile.kind === 'screen' ? ' · screen' : tile.kind === 'camera' ? ' · camera' : '') },
      tile && { label: s.focus === tile.key ? 'Back to the grid' : 'Focus', run: () => setStageFocus(tile.key) },
      tile?.video && { label: 'Full screen', icon: 'expand', run: () => tile.el.requestFullscreen?.().catch(() => {}) },
      theirs && { label: 'Mute stream', checked: s.muted.has(tile.sid), run: () => (s.muted.has(tile.sid) ? s.muted.delete(tile.sid) : s.muted.add(tile.sid), syncStage()) },
      theirs && { label: 'Stop watching', run: () => watchScreen(tile.sid, false) },
      '-',
      { label: 'Show non-video participants', checked: st.stageNonVideo, run: flip('stageNonVideo') },
      { label: 'Show my own video', checked: st.stageOwnVideo, run: flip('stageOwnVideo') },
      '-',
      s && !s.pop && { label: 'Open in a window', icon: 'jump', run: () => popOutStage() },
      s && !s.pop && { label: 'Stream stats', run: () => openStatsPanel(s, s.stats) },
    ],
    'Video'
  );
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

  // Screens first, then everyone in the channel (camera or avatar). The grid's right-click menu
  // can leave out those without video, and your own camera and screen share.
  const { stageNonVideo, stageOwnVideo } = settings.get();
  const want = [
    ...inChannel.filter((u) => u.sharing && (stageOwnVideo || u.sid !== c.sid)).map((u) => ({ key: 'screen:' + u.sid, sid: u.sid, kind: 'screen', live: u.sid === c.sid || st.watching.has(u.sid) })),
    ...inChannel
      .filter((u) => (u.camera ? stageOwnVideo || u.sid !== c.sid : stageNonVideo))
      .map((u) => ({ key: (u.camera ? 'camera:' : 'user:') + u.sid, sid: u.sid, kind: u.camera ? 'camera' : 'user', live: true })),
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
  // Everything left out by the right-click menu: say so, rather than an empty grid
  if (!want.length) rest.push((st.empty ||= h('div', { class: 'stage-empty muted' }, 'No video to show. Right-click to show everyone.')));
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
      t.video.muted = t.sid === c.sid || S.deafened || audio.micTest || st.muted.has(t.sid);
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
  const pop = st.pop?.ready ? st.pop : null;
  // The window says which call it is, so it can be told apart in the taskbar and Alt-Tab (D72)
  const callCh = S.call?.server?.channels.find((c) => c.id === S.call.voiceChannel);
  if (pop) pop.win.document.title = [st.title.textContent, callCh?.name, S.call?.server?.name].filter(Boolean).join(' · ');
  st.popBtns.replaceChildren(
    ...(pop
      ? [
          desktop?.streamOnTop &&
            h(
              'button',
              { class: 'btn small ghost', title: 'Keep this window above other windows', onclick: () => ((pop.onTop = !pop.onTop), desktop.streamOnTop(pop.name, pop.onTop), syncStage()) },
              pop.onTop ? 'On top ✓' : 'Keep on top'
            ),
          h('button', { class: 'btn small ghost', title: 'Show the video grid in the app again', onclick: () => dockStage() }, 'Back to app'),
        ]
      : [h('button', { class: 'btn small ghost', title: 'Open the video grid in a window of its own', disabled: !!st.pop, onclick: () => popOutStage() }, 'Pop out')]
    ).filter(Boolean)
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
  // This page's observers don't see sizes change in another window
  if (pop) reportTiles();
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

// With `nav`, the app's view is moving on (a text channel, the game, another
// server): a stage in a window of its own isn't in the way, and stays.
function closeStage({ nav = false } = {}) {
  const st = S.stage;
  if (!st || (nav && st.pop)) return;
  clearInterval(st.timer);
  st.timer = null;
  st.statsPanel?.close();
  st.ro.disconnect();
  for (const key of [...st.tiles.keys()]) dropTile(key);
  if (S.call?.connected) for (const sid of st.watching) S.voice.watch(sid, 'screen', false);
  S.stage = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (st.pop && !st.pop.win.closed) st.pop.win.close();
  $('#stream-view').replaceChildren();
  document.body.classList.remove('stream-visible');
  if (S.server) renderChannels();
}

// "Pop out": the whole stage (header, grid, every stream being watched) moves
// to a window of its own, so it stays in view while you read a channel, play,
// or use another app. The window shows popout.html, a page of ours with no
// script: the stage's elements are moved into it and this page keeps driving
// them, because a stream can't leave the page that receives it. Closing the
// window closes the stage; "Back to app" (dockStage) moves it back.
function popOutStage() {
  const st = S.stage;
  if (!st) return;
  if (st.pop) return st.pop.win.focus();
  st.pop = popWindow({
    alive: (pop) => S.stage === st && st.pop === pop,
    ready(host) {
      st.statsPanel?.close();
      host.replaceChildren(st.el);
      document.body.classList.remove('stream-visible');
      stageMoved();
    },
    changed: () => (layoutStage(), reportTiles()),
    closed: () => closeStage(),
  });
  syncStage();
}

// A window showing popout.html, for the stage or a DM call's video to move
// into; null (after a toast) when it can't open. The result is
// { win, name, ready, onTop }.
// on: { alive(pop): is it still wanted, ready(host): move the elements into host,
//       changed(): it was resized, hidden or shown, closed() }
let stageWinSeq = 0;
function popWindow(on) {
  const name = 'friendspeak-stream-' + ++stageWinSeq;
  const win = window.open('/popout.html', name, 'width=1100,height=680');
  if (!win) return toast('Could not open a window for the video', 'error'), null;
  const pop = { win, name, ready: false, onTop: false };
  const mine = () => on.alive(pop);
  // The page loads in its own time; the elements stay in the app until then
  const timer = setInterval(() => {
    if (!mine()) return clearInterval(timer);
    if (win.closed) return clearInterval(timer), on.closed();
    const host = win.document.getElementById('stream');
    if (!host) return;
    clearInterval(timer);
    // The theme is variables and attributes on <html> (theme.js)
    for (const a of document.documentElement.attributes) win.document.documentElement.setAttribute(a.name, a.value);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    pop.ready = true;
    win.addEventListener('resize', () => mine() && on.changed());
    win.document.addEventListener('visibilitychange', () => mine() && on.changed());
    // Closed with its own close button (or reloaded, which empties it)
    win.addEventListener('pagehide', () => mine() && on.closed());
    on.ready(host);
  }, 50);
  return pop;
}

// "Back to app": the stage returns to the app's view and its window closes
function dockStage() {
  const st = S.stage;
  const pop = st?.pop;
  if (!pop) return;
  st.pop = null;
  if (pop.ready) {
    showGame(false);
    $('#stream-view').replaceChildren(st.el);
    document.body.classList.add('stream-visible');
  }
  if (!pop.win.closed) pop.win.close();
  stageMoved();
  desktop?.focus?.();
}

// A video stops when its element moves to another page
function stageMoved() {
  for (const t of S.stage.tiles.values()) if (t.video?.srcObject) t.video.play().catch(() => {});
  syncStage();
  reportTiles();
  if (S.server) renderChannels();
}

// The stage's window can't draw itself: it goes with this page
window.addEventListener('pagehide', () => (S.stage?.pop?.win.close(), dmCallUi.pop?.win.close()));

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
      icon('penguin'),
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
  if (visible) closeStage({ nav: true });
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
  S.socket.emitWithAck('game:login', {}).then(async (res) => {
    if (res.error) return toast(res.error, 'error');
    const url = new URL(res.path, S.entry.address);
    url.hash = new URLSearchParams({ u: res.username, t: res.token }).toString();
    await desktop?.allowGameWindow?.(url.origin); // the app opens this window only for the server it was told (desktop/main.js)
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
  // Only the game frame we opened. A key going down counts only while that frame has the keyboard:
  // the page in it is the server's, and could otherwise hold push-to-talk down for us at any time.
  if (!d || d.source !== 'friendspeak-game' || e.origin !== S.game.origin || !S.game.frame || e.source !== S.game.frame.contentWindow) return;
  if (d.event === 'keydown' && document.activeElement === S.game.frame) handleKeyDown(d, d.typing);
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

window.addEventListener('keydown', (e) => {
  if (handleKeyDown(e, typingInField(e))) return e.preventDefault();
  // Ctrl/Cmd+F: the search field of the chat in view
  const field = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyF' && !S.game.visible && !$('#modal-root')?.childElementCount && $('#search-input');
  if (field) (e.preventDefault(), field.focus(), field.select());
});
window.addEventListener('keyup', handleKeyUp);
window.addEventListener('blur', () => !S.game.open && audio.setPttHeld(false));
document.addEventListener('visibilitychange', () => !document.hidden && (document.title = windowTitle));

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
    onClose && h('button', { class: 'icon-btn small', title: 'Dismiss', onclick: () => (onClose(), renderBanners()) }, icon('close'))
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

// With the app's own title bar the update is a small pill at its end instead of a banner over the app
function renderUpdatePill() {
  const bar = $('#titlebar');
  if (!bar || bar.hidden) return false;
  const u = appUpdate;
  const show = u && ['available', 'downloading', 'ready'].includes(u.status);
  const pill = !show
    ? null
    : u.status === 'downloading'
      ? h('span', { class: 'update-pill busy', role: 'status' }, `Updating… ${u.progress}%`)
      : h(
          'button',
          {
            class: 'update-pill',
            title: u.status === 'ready' ? `friendspeak ${u.version} is downloaded. It installs when you restart the app.` : `friendspeak ${u.version} is available (you have ${u.current}).`,
            onclick: () => (u.status === 'ready' ? desktop.installUpdate() : desktop.downloadUpdate()),
          },
          u.status === 'ready' ? 'Restart to update' : u.canInstall ? `Update to ${u.version}` : `Download ${u.version}`
        );
  bar.querySelector('.update-pill')?.remove();
  if (pill) bar.append(pill);
  return true;
}

function appUpdateBanner() {
  const u = appUpdate;
  if (renderUpdatePill()) return null;
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

// A crash the user hasn't seen yet (desktop.logs.summary().unseen): opening the About tab or dismissing it marks it seen
let unseenCrashes = 0;
function crashBanner() {
  if (!unseenCrashes) return null;
  const seen = () => ((unseenCrashes = 0), desktop.logs.seen().catch(() => {}));
  return banner('warn', 'friendspeak ran into a problem last time. You can save a report from Settings → About & updates.', {
    action: h('button', { class: 'btn small', onclick: () => (seen(), renderBanners(), openSettings('about')) }, 'Open'),
    onClose: seen,
  });
}

function renderBanners() {
  clearTimeout(bannerTimer);
  $('#banners').replaceChildren(...[crashBanner(), maintenanceBanner(), appUpdateBanner()].filter(Boolean));
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
  log.info(`app started, version ${appUpdate.current}`);
  desktop.onUpdate((u) => {
    appUpdate = u;
    renderBanners();
    aboutRefresh?.();
  });
  renderBanners();
  // A crash the user hasn't seen: say so once; the About tab (or the notice) marks it seen
  unseenCrashes = (await desktop.logs?.summary().catch(() => null))?.unseen || 0;
  if (unseenCrashes) renderBanners();
}

// ---------------------------------------------------------------- settings

function openSettings(tab = 'profile') {
  const body = h('div', { class: 'settings-body' });
  // In two groups: about you, and about the app (D72)
  const tabs = {
    profile: ['My profile', settingsProfile, 'You'],
    appearance: ['Appearance', settingsAppearance, 'You'],
    voice: ['Voice & video', settingsVoice, 'You'],
    notifications: ['Notifications', settingsNotifications, 'You'],
    integrations: ['Integrations', settingsIntegrations, 'App'],
    about: ['About & updates', settingsAbout, 'App'],
  };
  let cleanup = null;
  const nav = h('nav', { class: 'settings-nav', 'aria-label': 'Settings' });
  const show = (key) => {
    cleanup?.();
    cleanup = null;
    for (const b of nav.querySelectorAll('button')) {
      b.classList.toggle('active', b.dataset.tab === key);
      b.setAttribute('aria-current', b.dataset.tab === key ? 'page' : 'false');
    }
    body.replaceChildren();
    body.scrollTop = 0;
    cleanup = tabs[key][1](body) || null;
  };
  let group = null;
  for (const [k, [label, , g]] of Object.entries(tabs)) {
    if (g !== group) nav.append(h('div', { class: 'nav-group' }, (group = g)));
    nav.append(h('button', { 'data-tab': k, onclick: () => show(k) }, label));
  }
  modal('Settings', h('div', { class: 'settings' }, nav, body), { wide: true, onClose: () => cleanup?.() });
  show(tab);
}

function settingsProfile(body) {
  const p = me();
  const { el, draft } = profileEditor(p);
  const redraw = () => settingsProfile(body.replaceChildren() || body);
  const importInput = h('input', {
    type: 'file',
    accept: '.json',
    hidden: true,
    onchange: async () => {
      try {
        const np = await importProfile(importInput.files[0], askPassphrase);
        toast(`Imported ${np.name}`, 'success');
        warnIfKeyless(np);
        switchProfile(np.id);
        redraw();
      } catch (e) {
        toast(e.message, 'error');
      }
    },
  });
  // The one tab that needs a save: it says when there is something to save (D72)
  const KEYS = ['name', 'status', 'color', 'avatar', 'banner'];
  const unsaved = h('span', { class: 'muted small', hidden: true }, 'Unsaved changes');
  const discard = h('button', { class: 'btn small ghost', hidden: true, onclick: redraw }, 'Discard');
  const dirtyTimer = setInterval(() => {
    const dirty = KEYS.some((k) => (draft[k] || '') !== (me()[k] || ''));
    unsaved.hidden = discard.hidden = !dirty;
  }, 250);
  const save = () => {
    if (!draft.name.trim()) return toast('Name required', 'error');
    if (!saveProfile(() => profiles.save({ ...draft, name: draft.name.trim() }))) return;
    applyProfileChange();
    toast('Profile saved', 'success');
  };
  const others = profiles.all().length > 1;
  body.append(
    h('h3', {}, 'My profile'),
    el,
    h('div', { class: 'row end save-row' }, unsaved, discard, h('button', { class: 'btn small', onclick: save }, 'Save profile')),
    h('h3', {}, 'Saved profiles'),
    h('p', { class: 'muted small' }, 'Profiles live only on this device. Export one to use it on another device. Keep the file private: whoever has it can be you.'),
    h(
      'div',
      { class: 'profile-list' },
      profiles.all().map((x) =>
        h(
          'div',
          { class: 'setting-row profile-row' + (x.id === p.id ? ' current' : '') },
          avatarEl(x, 32),
          h('div', { class: 'sr-label' }, h('div', { class: 'sr-title' }, x.name), h('div', { class: 'sr-help' }, x.id === p.id ? 'In use' : 'On this device')),
          x.id !== p.id ? h('button', { class: 'btn small ghost', onclick: () => (switchProfile(x.id), redraw()) }, 'Use') : null,
          h('button', { class: 'btn small ghost', onclick: () => exportDialog(x) }, 'Export…'),
          others
            ? h(
                'button',
                {
                  class: 'btn small ghost danger',
                  onclick: async () => {
                    if (
                      !(await confirmModal('Delete profile', `Delete profile "${x.name}" from this device? Its keys and its server list go with it: unless you've exported it, you can't connect as it again to servers that know it.`, 'Delete profile', {
                        side: { label: 'Export first…', run: () => exportDialog(x) },
                      }))
                    )
                      return;
                    profiles.remove(x.id);
                    if (x.id === p.id) switchProfile(profiles.all()[0].id);
                    redraw();
                  },
                },
                'Delete…'
              )
            : null
        )
      )
    ),
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'btn small secondary', onclick: () => (switchProfile(profiles.create({ name: 'new friend' }).id), redraw()) }, 'New profile'),
      h('button', { class: 'btn small ghost', onclick: () => importInput.click() }, 'Import…'),
      importInput
    )
  );
  return () => clearInterval(dirtyTimer);
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
    for (const t of tiles) {
      const on = t.theme ? now.theme === t.theme : now.theme === 'custom' && samePalette(colors, t.colors);
      t.el.classList.toggle('selected', on);
      t.el.setAttribute('aria-pressed', String(on));
    }
    for (const p of pickers) {
      p.input.value = colors[p.key];
      p.hex.textContent = colors[p.key];
    }
    customBadge.hidden = now.theme !== 'custom';
    const scale = uiScaleOf(now);
    scaleIn.value = UI_SCALES.indexOf(scale);
    scaleVal.textContent = scale + '%';
  };

  // A small mock of the app, drawn with the palette's own colors
  const tile = (name, colors, theme) => {
    const bar = (cls) => h('i', { class: cls });
    const el = h(
      'button',
      { class: 'theme-tile theme-scope', title: name, onclick: () => update(theme ? { theme } : { theme: 'custom', themeColors: colors }) },
      h('span', { class: 'pick-check', html: I.check }),
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
  const fontCustom = settingRow(
    'Font name',
    'A font installed on this computer, e.g. Fira Sans.',
    h('input', { value: st.fontCustom, 'aria-label': 'Font name', placeholder: 'Fira Sans', oninput: (e) => update({ fontCustom: e.target.value }) })
  );
  fontCustom.hidden = st.font !== 'custom';
  const fontSel = select('font', FONTS);
  fontSel.setAttribute('aria-label', 'Font');
  fontSel.addEventListener('change', () => (fontCustom.hidden = fontSel.value !== 'custom'));
  const sizeVal = h('span', { class: 'value' }, st.fontSize + 'px');
  const sizeIn = h('input', { type: 'range', 'aria-label': 'Text size', min: FONT_SIZE.min, max: FONT_SIZE.max, step: FONT_SIZE.step, value: st.fontSize, oninput: (e) => (update({ fontSize: +e.target.value }), (sizeVal.textContent = e.target.value + 'px')) });
  const scaleVal = h('span', { class: 'value' });
  const scaleIn = h('input', { type: 'range', 'aria-label': 'UI size', min: 0, max: UI_SCALES.length - 1, step: 1, oninput: (e) => update({ uiScale: UI_SCALES[e.target.value] }) });
  const mod = desktop?.platform === 'darwin' ? '⌘' : 'Ctrl';

  body.append(
    h('h3', {}, 'Theme'),
    h('div', { class: 'theme-grid' }, Object.entries(THEMES).map(([id, t]) => tile(t.name, t.colors, id))),
    h('h3', {}, 'Color schemes'),
    h('p', { class: 'muted small' }, 'Click a scheme to load its colors, then adjust them below.'),
    h('div', { class: 'theme-grid scroll' }, SCHEMES.map((s) => tile(s.name, s.colors))),
    h('h3', {}, 'Colors', customBadge),
    h('p', { class: 'muted small' }, 'Changing a color makes a custom theme from the one in use.'),
    ...COLOR_GROUPS.flatMap(([title, colors]) => [h('div', { class: 'color-group' }, title), h('div', { class: 'color-grid' }, colors.map(picker))]),
    h('h3', {}, 'Size and spacing'),
    settingRow('UI size', `Zooms the whole window (${mod} + and ${mod} −).`, h('div', { class: 'sr-control' }, scaleVal, scaleIn, h('button', { class: 'btn small ghost', onclick: () => update({ uiScale: 100 }) }, 'Reset'))),
    settingRow(
      'Text size',
      'Messages and lists.',
      h('div', { class: 'sr-control' }, sizeVal, sizeIn, h('button', { class: 'btn small ghost', onclick: () => (update({ fontSize: FONT_SIZE.base }), (sizeIn.value = FONT_SIZE.base), (sizeVal.textContent = FONT_SIZE.base + 'px')) }, 'Reset'))
    ),
    settingRow('Density', 'The space around rows and messages.', segmented(Object.entries(DENSITIES).map(([k, [label]]) => [k, label]), DENSITIES[st.density] ? st.density : 'cozy', (v) => update({ density: v }), 'Density')),
    settingRow('Font', null, fontSel),
    fontCustom
  );
  sync();
  showUiScale = sync;
  return () => (showUiScale = null);
}

function settingsVoice(body) {
  const st = settings.get();
  const inSel = h('select', { onchange: async (e) => ((busy = true), await switchMic(e.target.value), (busy = false)) }, h('option', { value: '' }, 'Default'));
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
  let busy = false; // the mic is starting
  let closed = false;
  const restartMic = async () => {
    if (!liveVoice() && !testing) return;
    busy = true;
    try {
      await audio.startMic();
      if (liveVoice()) liveVoice().micError = null;
    } catch (e) {
      toast(e.message, 'error');
    }
    busy = false;
  };
  const meter = h('div', { class: 'meter' }, h('div', { class: 'meter-fill' }));
  // Mic test: your mic is played back to you and everything else goes quiet
  // (audio.setMicTest). It also keeps the mic from friends, who see you muted.
  let testing = false;
  const testBtn = h('button', { class: 'btn small secondary' }, 'Test mic');
  const setTest = (on) => {
    testing = on;
    const done = audio.setMicTest(on); // restarts a running mic when the test changes its echo cancellation
    testBtn.textContent = on ? 'Stop test' : 'Test mic';
    syncVoiceState();
    return done;
  };
  const stopTest = () => {
    if (!liveVoice()) audio.stopMic(); // the test started it
    setTest(false).catch((e) => toast(e.message, 'error'));
  };
  testBtn.onclick = async () => {
    if (testing) return stopTest();
    if (busy) return;
    busy = true;
    try {
      await setTest(true); // first, so a mic that starts here starts the way the test wants it
      if (testing && !audio.micStream) await audio.startMic(); // not if it was stopped meanwhile
    } catch (e) {
      stopTest();
      toast(e.message, 'error');
    }
    busy = false;
  };
  const micNote = h('p', { class: 'alert warn small', role: 'status', hidden: true });
  // Noise gate, like Discord's input sensitivity: the bar is the mic's level
  // before the gate, and the slider on it is the level the gate opens at. At
  // the slider's bottom there is no gate.
  const gatePct = (db) => Math.min(100, Math.max(0, ((db - GATE.min) / (GATE.max - GATE.min)) * 100)) + '%';
  const gateVal = h('span', {});
  const gateSlider = h('input', {
    type: 'range',
    ...GATE,
    step: 1,
    value: Math.max(GATE.min, Math.min(GATE.max, st.micGate)),
    'aria-label': 'Noise gate threshold',
    oninput: (e) => (settings.set({ micGate: +e.target.value }), audio.micStream && audio.applyGate(), syncGate()), // a mic that starts later applies it itself
  });
  const gateBox = h('div', { class: 'gate' }, h('div', { class: 'gate-track' }), h('div', { class: 'gate-level' }), gateSlider);
  const syncGate = () => {
    const threshold = +gateSlider.value;
    const on = threshold > GATE.min;
    const live = audio.micStream ? audio.micGate.live : null;
    gateBox.classList.toggle('closed', !!live && !live.open);
    gateBox.style.setProperty('--thr', gatePct(threshold));
    gateBox.style.setProperty('--lvl', live ? gatePct(live.level) : '0%');
    const text = on ? `opens above ${threshold} dB`.replace('-', '−') : 'off';
    if (gateVal.textContent !== text) gateVal.textContent = text;
  };
  syncGate();
  let denoiseOn = st.noiseSuppression;
  const applyDenoise = () => audio.micStream && audio.applyDenoise(); // live; a mic that starts later applies it itself
  const iv = setInterval(() => {
    const lvl = audio.micStream ? Level(audio.micAnalyser) : 0;
    meter.firstChild.style.width = Math.min(100, lvl * 400) + '%';
    syncGate();
    if (testing && !busy && !audio.micStream) setTest(false); // the call it ran in ended, and took the mic with it
    // A device or OS can refuse a constraint without an error, and noise suppression may not run here
    const info = audio.micInfo;
    const note = [
      info?.want.autoGainControl && info.got.autoGainControl === false && 'This microphone or system didn’t apply automatic gain.',
      info?.want.echoCancellation && info.got.echoCancellation === false && 'This microphone or system didn’t apply echo cancellation.',
      denoiseOn && audio.denoise.state === 'failed' && `Noise suppression can’t run here (${audio.denoise.error}), so your mic is sent as it is.`,
    ]
      .filter(Boolean)
      .join(' ');
    if (micNote.textContent !== note) micNote.textContent = note;
    micNote.hidden = !note;
  }, 60);

  const pttBtn = hotkeyField(st.pttKey, (v) => settings.set({ pttKey: v }), { label: 'Push-to-talk key', read: (e) => e.code, show: (v) => v.replace(/^Key|^Digit/, ''), clearable: false });
  const pttRow = settingRow('Push-to-talk key', null, pttBtn, { dim: !st.ptt });
  const hotkeyBtn = (key, label) => hotkeyField(st[key] || '', (v) => (settings.set({ [key]: v }), syncHotkeys()), { label });
  // An option that applies at once: a setting row with a switch (D72)
  const check = (key, label, after, help) => settingRow(label, help, switchEl(st[key], (on) => (settings.set({ [key]: on }), after?.(on)), label));
  const select = (key, options, after) => {
    const el = h('select', { onchange: (e) => (settings.set({ [key]: e.target.value }), after?.(e.target.value)) }, Object.entries(options).map(([k, label]) => h('option', { value: k }, label)));
    el.value = st[key];
    return el;
  };
  const slider = (key, label, max, after, help) => {
    const val = h('span', { class: 'value' }, Math.round(st[key] * 100) + '%');
    return settingRow(
      label,
      help,
      h(
        'div',
        { class: 'sr-control' },
        val,
        h('input', { type: 'range', 'aria-label': label, min: 0, max, step: 0.01, value: st[key], oninput: (e) => (settings.set({ [key]: +e.target.value }), (val.textContent = Math.round(e.target.value * 100) + '%'), after(+e.target.value)) })
      )
    );
  };
  // Noise suppression (D47): one slider. Its left end is off; then the most the noise is turned down
  // by, from 6 to 40 dB; its right end is no limit. Bands name the range: None, Light, Normal, Strong (D72).
  const DL = DENOISE_LIMIT;
  const OFF = DL.min - DL.step;
  const TOP = DL.max + DL.step;
  const bandOf = (v) => (v <= OFF ? 'None' : v <= 14 ? 'Light' : v <= 28 ? 'Normal' : 'Strong');
  const denoiseText = (v) => (v <= OFF ? 'off' : v >= TOP ? 'maximum' : `up to ${v} dB quieter`);
  const denoiseVal = (now = settings.get()) => (!now.noiseSuppression ? OFF : Math.min(now.noiseSuppressionLimit, TOP));
  const denoiseBand = h('b', { class: 'band' });
  const denoiseAmount = h('span', { class: 'amount' });
  const pos = (v) => (v - OFF) / (TOP - OFF);
  // Each band's name under the middle of its stretch of the track
  const bands = rangeTicks([[0, 'None'], [(pos(DL.min) + pos(14)) / 2, 'Light'], [(pos(16) + pos(28)) / 2, 'Normal'], [1, 'Strong']]);
  bands.classList.add('denoise-bands');
  for (const el of bands.children) el.dataset.band = el.textContent;
  const showDenoise = (v) => {
    denoiseBand.textContent = bandOf(v);
    denoiseAmount.textContent = ' · ' + denoiseText(v);
    denoiseSlider.setAttribute('aria-valuetext', `${bandOf(v)}, ${denoiseText(v)}`);
    for (const el of bands.children) el.classList.toggle('on', el.dataset.band === bandOf(v));
  };
  const denoiseSlider = h('input', {
    type: 'range',
    'aria-label': 'Noise suppression strength',
    min: OFF,
    max: TOP,
    step: DL.step,
    value: denoiseVal(),
    oninput: (e) => {
      const v = +e.target.value;
      denoiseOn = v > OFF;
      settings.set(denoiseOn ? { noiseSuppression: true, noiseSuppressionLimit: v >= TOP ? DL.none : v } : { noiseSuppression: false });
      showDenoise(v);
      applyDenoise();
    },
  });
  const denoiseControl = h(
    'div',
    { class: 'denoise' },
    h('div', { class: 'denoise-head' }, h('span', { class: 'muted small' }, 'Strength'), h('span', { class: 'denoise-now' }, denoiseBand, denoiseAmount)),
    denoiseSlider,
    rangeTicks([[0, 'off'], [pos(10), '10 dB'], [pos(20), '20'], [pos(30), '30'], [1, 'max']]),
    bands
  );
  showDenoise(denoiseVal());

  inSel.setAttribute('aria-label', 'Input device');
  outSel.setAttribute('aria-label', 'Output device');
  camSel.setAttribute('aria-label', 'Camera');
  body.append(
    h('h3', {}, 'Devices'),
    h('div', { class: 'row two' }, h('label', { class: 'field grow' }, h('span', {}, 'Input device'), inSel), h('label', { class: 'field grow' }, h('span', {}, 'Output device'), outSel)),
    h('div', { class: 'field' }, h('span', { class: 'field-head' }, 'Mic level and noise gate', h('span', { class: 'muted' }, gateVal)), gateBox),
    h('p', { class: 'muted small' }, 'The bar shows how loud your mic is, in a call or a mic test. Set the marker above your background noise and below your voice, or all the way left for no gate.'),
    h('div', { class: 'row test-row' }, testBtn, h('span', { class: 'muted small grow' }, 'Only test with headphones on: on speakers your mic hears its own playback and screeches. While it runs you hear nobody else, and nobody hears you.')),
    micNote,
    h('h3', {}, 'Microphone'),
    slider('micVolume', 'Mic volume', MAX_MIC_VOLUME, (v) => audio.setMicVolume(v)),
    check('autoGain', 'Automatic gain', restartMic, 'Brings a quiet mic up (and a loud one down) to a steady speaking level.'),
    check('echoCancellation', 'Echo cancellation', restartMic, 'Keeps your speakers out of your mic. With headphones on you can turn it off.'),
    settingRow('Noise suppression', 'Takes keyboards, fans and other background noise out of your mic, on this device. Turn it down if it cuts sounds you want heard.', denoiseControl),
    h('h3', {}, 'Push to talk'),
    check('ptt', 'Use push to talk', (on) => (audio.updateGate(), pttRow.classList.toggle('dim', !on)), 'Instead of an open mic. Works while friendspeak is the focused window.'),
    pttRow,
    h('h3', {}, 'Shortcuts'),
    settingRow('Mute', null, hotkeyBtn('muteHotkey', 'Mute shortcut')),
    settingRow('Deafen', null, hotkeyBtn('deafenHotkey', 'Deafen shortcut')),
    h('p', { class: 'muted small' }, desktop ? 'Shortcuts with Ctrl/Alt/Cmd, F-keys or the numpad work even while other apps are focused.' : 'Shortcuts work while friendspeak is the focused window.'),
    h('h3', {}, 'Volume'),
    slider('masterVolume', 'Master volume', 1, (v) => (audio.setMasterVolume(v), syncStage(), renderDmCall()), 'Covers everything except the game.'),
    slider('voiceVolume', 'Voices', MAX_VOICES_VOLUME, (v) => audio.setVoiceVolume(v), 'Click someone in a voice channel to change only their volume.'),
    h('h3', {}, 'Soundboard'),
    slider('soundboardVolume', 'Soundboard volume', 1, (v) => audio.setSoundboardVolume(v)),
    check('soundboardMonitor', 'Hear my own soundboard', (on) => audio.setMonitor(on && !S.deafened)),
    h('h3', {}, 'Camera'),
    h('label', { class: 'field' }, h('span', {}, 'Camera'), camSel),
    h('div', { class: 'field' }, h('span', {}, 'Background'), picker.el),
    h('div', { class: 'field' }, h('div', { class: 'row' }, previewBtn), preview.el),
    ...streamingSettings(check)
  );
  return () => {
    closed = true;
    clearInterval(iv);
    preview.stop();
    picker.dispose();
    if (testing) stopTest();
  };
}

// Settings → Voice & Video → Streaming (desktop app): the native media sidecar
// (D45) and hardware acceleration (D46). `check` is settingsVoice's checkbox row.
function streamingSettings(check) {
  if (!desktop?.media) return [];
  const status = h('p', { class: 'muted small' }, 'Checking what this computer can do…');
  const restart = h('p', { class: 'alert warn small', hidden: true }, 'Restart friendspeak to apply this everywhere.');
  const hwBox = switchEl(true, () => {}, 'Hardware acceleration');
  const describe = (caps, prefs) => {
    const hw = prefs.hardwareAcceleration;
    const enc = caps ? (hw && caps.hardware.length ? `${caps.hardware.join(', ')} (hardware H.264)` : 'OpenH264 (software H.264)') : null;
    const gpu = prefs.gpu || {};
    const on = (x) => /^enabled/.test(x || '');
    status.textContent =
      (caps ? `Native streaming is available: shares are encoded with ${enc}.` : 'Native streaming isn’t available on this computer, so shares use the standard pipeline.') +
      ` This run: video decoding on the ${on(gpu.video_decode) ? 'GPU' : 'CPU'}, drawing on the ${on(gpu.gpu_compositing) ? 'GPU' : 'CPU'}.`;
    restart.hidden = hw === prefs.atStart;
  };
  Promise.all([nativeMedia.load(), desktop.prefs()]).then(([caps, prefs]) => {
    hwBox.setAttribute('aria-checked', String(!!prefs.hardwareAcceleration));
    describe(caps, prefs);
    hwBox.addEventListener('click', async () => describe(caps, await desktop.prefs({ hardwareAcceleration: hwBox.getAttribute('aria-checked') === 'true' })));
  });
  return [
    h('h3', {}, 'Streaming'),
    check('nativeStreaming', 'Native streaming', null, 'Smoother, sharper screen shares and camera.'),
    settingRow('Hardware acceleration', 'Uses the graphics card. Turn it off if streams or the window show glitches.', hwBox),
    status,
    restart,
  ];
}

function settingsNotifications(body) {
  const draw = () => {
    const st = settings.get();
    const set = (patch) => (settings.set(patch), draw());
    const sw = (key, label, help, { disabled = false } = {}) => settingRow(label, help, switchEl(st[key], (on) => set({ [key]: on }), label, { disabled }), { dim: disabled });
    const people = Object.entries(st.notifyMutedUsers);
    const muted = Object.keys(st.notifyMutedServers);
    const unmute = (key, id) => {
      const { [id]: _, ...rest } = st[key];
      set({ [key]: rest });
      renderRail();
      renderChannels();
    };
    const mutedRow = (who, onclick) => settingRow(who, null, h('button', { class: 'btn small ghost', onclick }, 'Unmute'));
    const offFor = { dm: !st.notify || !st.notifyDms, mention: !st.notify || !st.notifyMentions };
    // The slider keeps its place while you drag: it doesn't redraw the tab
    const volume = h('span', { class: 'value' }, Math.round(st.cueVolume * 100) + '%');
    body.replaceChildren(
      h('h3', {}, 'Desktop notifications'),
      sw('notify', 'Show notifications', 'Only mentions and DMs notify you. They show an unread badge even when muted.'),
      sw('notifyMentions', 'Mentions & replies', null, { disabled: !st.notify }),
      sw('notifyDms', 'Direct messages & calls', null, { disabled: !st.notify }),
      h('h3', {}, 'Muted people'),
      ...(people.length
        ? people.map(([id, name]) => mutedRow(name || 'unknown', () => unmute('notifyMutedUsers', id)))
        : [h('div', { class: 'empty boxed small-empty' }, h('span', { class: 'muted small' }, 'Nobody. Right-click someone and choose “Mute notifications”.'))]),
      h('h3', {}, 'Muted servers'),
      ...(muted.length
        ? muted.map((id) => {
            const sv = servers.get(id);
            return mutedRow(sv ? serverLabel(sv) : 'A server you removed', () => unmute('notifyMutedServers', id));
          })
        : [h('div', { class: 'empty boxed small-empty' }, h('span', { class: 'muted small' }, 'None. Right-click a server in the left bar and choose “Mute notifications”.'))]),
      h('h3', {}, 'Sounds'),
      sw('cues', 'Play sounds', 'Joins, leaves, messages and mentions.'),
      settingRow(
        'Sound volume',
        null,
        h(
          'div',
          { class: 'sr-control' },
          volume,
          h('input', { type: 'range', 'aria-label': 'Sound volume', min: 0, max: 1, step: 0.01, value: st.cueVolume, oninput: (e) => (settings.set({ cueVolume: +e.target.value }), (volume.textContent = Math.round(e.target.value * 100) + '%'), audio.setCueVolume(+e.target.value)) })
        ),
        { dim: !st.cues }
      ),
      ...CUES.map(({ kind, label }) => {
        const off = !!offFor[kind];
        return settingRow(
          label,
          off ? 'Off: its notifications are off' : null,
          h(
            'div',
            { class: 'sr-control' },
            h('button', { class: 'btn small ghost', title: `Play the ${label.toLowerCase()} sound`, onclick: () => audio.preview(kind) }, 'Play'),
            switchEl(!off && st.sounds[kind] !== false, (on) => set({ sounds: { ...settings.get().sounds, [kind]: on } }), label, { disabled: off })
          ),
          { dim: off || !st.cues }
        );
      })
    );
  };
  draw();
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
    h('label', { class: 'field' }, h('span', {}, 'GIPHY API key'), h('input', { value: st.giphyKey, placeholder: 'paste key', spellcheck: 'false', autocomplete: 'off', oninput: (e) => settings.set({ giphyKey: e.target.value.trim() }) })),
    h('h3', {}, 'Steam'),
    settingRow(
      'Show the Steam game I’m playing',
      desktop?.steamGame ? 'While a Steam game runs on this computer, its name shows next to yours on your servers and in your DMs. It is read from Steam here: no Steam sign-in.' : 'Needs the desktop app.',
      switchEl(st.steamPlaying, (on) => (settings.set({ steamPlaying: on }), pollSteam()), 'Show the Steam game I’m playing', { disabled: !desktop?.steamGame }),
      { dim: !desktop?.steamGame }
    ),
    h('h3', {}, 'Links'),
    settingRow(
      'Load pictures, video and audio from links without asking',
      'The site a link points to sees your address when its file loads. Off, each one waits for a click.',
      switchEl(st.loadLinkMedia, (on) => settings.set({ loadLinkMedia: on }), 'Load media from links without asking')
    )
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
          : u && h('button', { class: 'btn small secondary', disabled: ['checking', 'downloading'].includes(u.status), onclick: () => desktop.checkForUpdates() }, 'Check for updates');

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

    // A version card: the logo, the version, where the update stands, a bar while it downloads (D72)
    const busy = u && ['checking', 'downloading'].includes(u.status);
    body.replaceChildren(...[
      h('h3', {}, 'friendspeak app'),
      h(
        'div',
        { class: 'version-card' },
        h('div', { class: 'rail-logo' }, 'fs'),
        h(
          'div',
          { class: 'grow' },
          h('strong', {}, u ? `Version ${u.current}` : 'Version unknown'),
          h('div', { class: 'muted small vc-status', role: 'status' }, busy ? spinner() : null, status),
          u?.status === 'downloading' ? h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': u.progress, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('div', { style: { width: (u.progress || 0) + '%' } })) : null
        ),
        action
      ),
      desktop?.openReleases && h('p', {}, h('a', { href: '#', onclick: (e) => (e.preventDefault(), desktop.openReleases()) }, 'Release notes and downloads')),
      S.connected && h('h3', {}, 'This server'),
      S.connected && settingRow(`${S.server.name} · version ${su?.version || 'unknown (older than 1.1)'}`, serverStatus || null, null),
      desktop?.logs && logsSection(),
    ].filter(Boolean));
  };
  draw();
  aboutRefresh = draw;
  S.socket?.on('server:update', draw);
  return () => ((aboutRefresh = null), S.socket?.off('server:update', draw));
}

// Settings → About & updates → Logs and crash reports (issue #51). Log text is untrusted (it can quote
// servers and web pages), so it only ever goes in through textContent.
function logsSection() {
  const logs = desktop.logs;
  const status = h('div', { class: 'log-summary' }, '…');
  const when = (ts) => new Date(ts).toLocaleString();
  const draw = async () => {
    const s = await logs.summary().catch(() => null);
    if (!s) return status.replaceChildren('Logs are not available.');
    const crash = s.crashes[0];
    const bad = s.errors || crash;
    status.className = 'log-summary' + (bad ? ' alert danger' : ' muted small');
    status.replaceChildren(
      ...[
      bad ? icon('warn') : null,
      h(
        'span',
        { class: 'grow' },
        (s.errors ? `${s.errors} error${s.errors === 1 ? '' : 's'} in the last 7 days.` : 'No errors in the last 7 days.') + (crash ? ` Last crash: ${when(crash.ts)}.` : '') + ` (${fmtBytes(s.bytes)} on disk)`
      ),
      bad ? h('button', { class: 'btn small ghost', onclick: () => viewLogs() }, 'View log') : null,
      ].filter(Boolean)
    );
  };
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  logs.seen().catch(() => {}); // looking at it counts
  draw();
  return h(
    'div',
    { class: 'logs-section' },
    h('h3', {}, 'Logs and crash reports'),
    h('p', { class: 'muted small' }, 'Logs stay on this computer and never include your messages.'),
    status,
    h(
      'div',
      { class: 'about-row' },
      h('button', { class: 'btn small secondary', onclick: () => viewLogs() }, 'View log'),
      h('button', { class: 'btn small ghost', onclick: run(async () => {
        const r = await logs.save();
        if (r.error) toast('Could not save the report: ' + r.error, 'error');
        else if (r.saved) toast('Report saved', 'success');
      }) }, 'Save report…'),
      h('button', { class: 'btn small ghost', onclick: run(async () => {
        await navigator.clipboard.writeText(await logs.report());
        toast('Report copied', 'success');
      }) }, 'Copy report'),
      h('button', { class: 'btn small ghost', onclick: run(async () => {
        const r = await logs.reveal();
        if (r?.error) toast(r.error, 'error');
      }) }, 'Open folder'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small ghost danger', onclick: run(async () => {
        if (!(await confirmModal('Clear logs', 'Delete all logs and crash reports from this computer?', 'Clear logs'))) return;
        await logs.clear();
        toast('Logs cleared', 'success');
        draw();
      }) }, 'Clear logs…')
    )
  );
}

// The log in a window: crash reports on top, then the lines, newest at the bottom
function viewLogs() {
  const logs = desktop.logs;
  const RANK = { debug: 0, info: 1, warn: 2, error: 3 };
  let lines = [];
  let more = false;
  let min = 2;
  const level = segmented([[3, 'Errors'], [2, 'Warnings'], [0, 'Everything']], min, (v) => ((min = +v), draw()), 'Level');
  const find = h('input', { type: 'search', 'aria-label': 'Filter the log', placeholder: 'Filter', oninput: () => draw() });
  const crashBox = h('div', { class: 'log-crashes' });
  const box = h('div', { class: 'log-lines' });
  const olderBtn = h('button', { class: 'btn small ghost', onclick: () => load(true) }, 'Load older');
  const draw = () => {
    const q = find.value.trim().toLowerCase();
    const shown = lines.filter((l) => RANK[l.level] >= min && (!q || `${l.source} ${l.text} ${l.stack || ''}`.toLowerCase().includes(q)));
    box.replaceChildren(
      ...[more && h('div', { class: 'log-more' }, olderBtn)].filter(Boolean),
      ...shown.map((l) =>
        h(
          'div',
          { class: 'log-line ' + l.level },
          h('span', { class: 'log-time' }, new Date(l.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })),
          h('span', { class: 'log-level' }, l.level),
          h('span', { class: 'log-source' }, l.source),
          h('span', { class: 'log-text' }, l.text),
          l.stack && h('details', {}, h('summary', {}, 'stack'), h('pre', {}, l.stack))
        )
      ),
      ...(shown.length ? [] : [lines.length ? emptyState('search', 'Nothing matches', 'Try another word or level.') : emptyState('file', 'The log is empty')])
    );
  };
  const load = async (older) => {
    const r = await logs.read({ limit: 500, before: older ? lines[0]?.id : undefined }).catch(() => null);
    if (!r) return;
    lines = older ? [...r.lines, ...lines] : r.lines;
    more = r.more;
    draw();
    if (!older) box.scrollTop = box.scrollHeight;
  };
  logs.summary().then((s) =>
    crashBox.replaceChildren(
      ...(s?.crashes.length
        ? [h('h4', {}, 'Crash reports'), ...s.crashes.map((c) => h('div', { class: 'log-crash' }, h('span', { class: 'log-time' }, new Date(c.ts).toLocaleString()), h('span', { class: 'log-source' }, c.kind), h('span', { class: 'log-text' }, c.message)))]
        : [])
    )
  );
  load();
  modal('Log', h('div', { class: 'log-view' }, h('div', { class: 'row' }, level, find), crashBox, box), { wide: true });
}

const VOICE_QUALITIES = { max: 'Highest (510 kbps)', high: 'High (128 kbps)', standard: 'Standard (64 kbps)', low: 'Low (32 kbps)' };

// ---------------------------------------------------------------- members and roles: who may do what

// The server's permission keys, in its order: key, label, what it lets someone do
const PERM_INFO = [
  ['admin', 'Administrator', 'Everything. Ignores every other setting.'],
  ['view', 'See channels', 'Read messages and files in this server’s channels.'],
  ['send', 'Send messages and join voice', 'Message in text channels and join voice channels.'],
  ['mentionRoles', 'Mention roles', '@role mentions notify people.'],
  ['mentionEveryone', 'Mention @everyone', '@everyone notifies everyone.'],
  ['kick', 'Remove members', 'Disconnect people and take them off the member list.'],
  ['voiceKick', 'Kick from voice', 'Take people out of a voice channel.'],
  ['ban', 'Ban members', 'Ban and unban people.'],
  ['forceMute', 'Force mute', 'Mute people in voice so they can’t unmute themselves.'],
  ['manageRoles', 'Manage roles', 'Create and delete roles without permissions, and hand them out.'],
  ['manageChannels', 'Manage channels', 'Create, rename and delete channels.'],
  ['manageEmojis', 'Manage emojis', 'Add and remove custom emojis.'],
  ['manageFiles', 'Manage files', 'Delete other people’s files.'],
  ['manageMessages', 'Delete messages', 'Delete other people’s messages.'],
  ['createInvites', 'Create invites', 'Make invites and see who joined with them.'],
];

// Inherit / Allow / Deny for a setting that may be unset (true, false or undefined): a three-part
// control rather than a select per cell, so a table of overrides reads at a glance (D72)
const triSelect = (value, onChange, { disabled = false, inherit = 'Inherit', label = 'Permission' } = {}) => triState(value, onChange, label, { disabled, inherit });

// A checklist popover for someone's roles: ticks are saved as they're made
function rolesPopover(anchor, pid, align = 'right') {
  const name = profileOf(pid).name;
  const body = h('div', { class: 'roles-pop' });
  const draw = () => {
    const may = new Set(grantableRoles(pid).map((r) => r.id));
    const have = new Set(S.server.memberRoles?.[pid] || []);
    const roles = S.server.roles || [];
    const locked = roles.filter((r) => !may.has(r.id));
    body.replaceChildren(
      h('div', { class: 'menu-label' }, `Roles for ${name}`),
      ...roles.map((r) =>
        h(
          'label',
          { class: 'check-row' + (may.has(r.id) ? '' : ' disabled') },
          h('input', {
            type: 'checkbox',
            checked: have.has(r.id),
            disabled: !may.has(r.id),
            onchange: async (e) => {
              const now = new Set(S.server.memberRoles?.[pid] || []);
              e.target.checked ? now.add(r.id) : now.delete(r.id);
              await doAct('member:roles', { profileId: pid, roles: roles.filter((x) => now.has(x.id)).map((x) => x.id) });
              draw();
            },
          }),
          roleTag(r),
          may.has(r.id) ? null : icon('lock', 'lock-icon')
        )
      ),
      locked.length ? h('p', { class: 'muted small roles-note' }, `You can’t change ${locked.map((r) => r.name).join(', ')}.`) : null,
      roles.length ? null : h('p', { class: 'muted small' }, 'This server has no roles yet.')
    );
  };
  draw();
  body.setAttribute('role', 'group');
  body.setAttribute('aria-label', `Roles for ${name}`);
  popover(anchor, body, { align, className: 'roles-popover' });
}

// What the member menus offer for someone, given what we may do (nothing on a server from before permissions)
function memberItems(pid, anchor, align = 'right') {
  if (inDmView() || !S.connected || !S.server?.profiles?.[pid]) return [];
  const self = pid === me().id;
  const live = S.users.find((u) => u.id === pid);
  const items = [];
  if (hasPerms()) {
    const fm = live ? !!live.forceMuted : !!S.server.forceMuted?.includes(pid);
    if (!self && live?.voice && can('voiceKick') && canActOn(pid)) items.push({ label: 'Kick from voice', run: () => doAct('voice:kick', { profileId: pid }) });
    if (can('forceMute') && (self ? fm : canActOn(pid))) items.push({ label: fm ? 'Lift force mute' : 'Force mute', run: () => doAct('voice:forcemute', { profileId: pid, muted: !fm }) });
    if (grantableRoles(pid).length) items.push({ label: 'Roles…', run: () => rolesPopover(anchor, pid, align) });
  }
  items.push('-'); // what can't be undone goes last (contextMenu drops a separator with nothing after it)
  if (!self && can('kick') && canActOn(pid)) items.push({ label: 'Remove from server…', danger: true, run: () => removePrompt(pid) });
  if (!self && can('ban') && canActOn(pid) && !isBanned(pid)) items.push({ label: 'Ban…', danger: true, run: () => banPrompt(pid) });
  return items;
}

// Per-role overrides for one channel: See / Send (Join for voice) / Manage, for everyone and each role
function channelPermsDialog(ch) {
  const voice = ch.type === 'voice';
  const roles = S.server.roles || [];
  const ov = JSON.parse(JSON.stringify(ch.overrides && typeof ch.overrides === 'object' ? ch.overrides : {}));
  const set = (who, key, v) => {
    const o = (ov[who] ||= {});
    if (v === undefined) delete o[key];
    else o[key] = v;
    if (!Object.keys(o).length) delete ov[who];
  };
  const cols = [['view', 'See channel'], ['send', voice ? 'Join' : 'Send messages'], ['manage', 'Manage channel']];
  const rows = [{ id: 'everyone', name: 'everyone' }, ...roles];
  const close = modal(
    `Permissions for ${voice ? '' : '#'}${ch.name}`,
    h(
      'div',
      {},
      h('p', { class: 'muted small' }, '/ (inherit) keeps the server-wide setting; ✓ allows, ✕ denies.'),
      S.conn.perms?.open ? h('p', { class: 'banner-note' }, 'Permissions are off on this server, so these only take effect once someone is an administrator.') : null,
      h(
        'div',
        { class: 'perm-table' },
        h('span', {}),
        ...cols.map(([, label]) => h('span', { class: 'perm-col' }, label)),
        ...rows.flatMap((r) => [
          r.id === 'everyone' ? h('span', { class: 'perm-who strong' }, 'Everyone') : h('span', { class: 'perm-who' }, roleTag(r)),
          ...cols.map(([key, label]) => triSelect(ov[r.id]?.[key], (v) => set(r.id, key, v), { label: `${r.id === 'everyone' ? 'Everyone' : r.name}: ${label}` })),
        ])
      )
    ),
    {
      actions: [
        h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'),
        h(
          'button',
          {
            class: 'btn',
            onclick: async () => {
              const r = await doAct('channel:perms', { id: ch.id, overrides: ov });
              if (r?.ok) close();
            },
          },
          'Save'
        ),
      ],
      className: 'perms',
    }
  );
}

// ---------------------------------------------------------------- server settings

// Its own window, apart from app Settings: what this server lets you see and change depends on your roles.
function openServerSettings(tab = 'overview') {
  if (!S.connected) return toast('Connect to a server to manage it', 'error');
  if (!canSeeServerSettings()) return toast('Only administrators and moderators can open Server settings', 'error');
  const socket = S.socket;
  const st = { role: null }; // the Roles page's selection survives redraws
  const body = h('div', { class: 'settings-body' });
  const pages = {
    overview: ['Overview', serverOverview],
    ...(hasPerms() ? { roles: ['Roles', serverRoles] } : {}),
    members: ['Members', serverMembers],
    emojis: ['Emojis', serverEmojis],
    bans: ['Bans', serverBans],
    // Only for people who may create invites: nobody else is shown any (the server refuses them too)
    ...(S.conn.perms?.createInvites ? { invites: ['Invites', serverInvites] } : {}),
  };
  let cur = pages[tab] ? tab : 'overview';
  const nav = h('nav', { class: 'settings-nav', 'aria-label': 'Server settings' });
  // How many of each, next to the page's name (D72)
  const counts = () => ({
    roles: S.server?.roles?.length,
    members: Object.keys(S.server?.profiles || {}).filter((pid) => !isBanned(pid)).length,
    emojis: S.server?.emojis?.length,
    bans: S.server?.bans?.length,
    invites: st.invites?.filter((v) => inviteStatus(v) === 'active').length,
  });
  const show = (key, keepScroll) => {
    const top = keepScroll ? body.scrollTop : 0;
    cur = key;
    const n = counts();
    for (const b of nav.children) {
      b.classList.toggle('active', b.dataset.tab === key);
      b.setAttribute('aria-current', b.dataset.tab === key ? 'page' : 'false');
      b.querySelector('.n').textContent = n[b.dataset.tab] || '';
    }
    body.replaceChildren();
    pages[key][1](body, { st, redraw: () => show(cur, true) });
    body.scrollTop = top;
  };
  // The server changes under an open window: draw again, unless someone is typing
  const redraw = () => {
    if (!canSeeServerSettings()) return close(); // lost the role that let us in
    const a = document.activeElement;
    if (body.contains(a) && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !['checkbox', 'button'].includes(a.type)))) return;
    show(cur, true);
  };
  const events = ['roles', 'perms', 'channels', 'emojis', 'bans', 'server'];
  for (const ev of events) socket.on(ev, redraw);
  const onInvites = ({ invites } = {}) => Array.isArray(invites) && ((st.invites = invites), cur === 'invites' && redraw());
  socket.on('invites', onInvites);
  const gone = () => close();
  socket.on('disconnect', gone);
  nav.append(...Object.entries(pages).map(([k, [label]]) => h('button', { 'data-tab': k, onclick: () => show(k) }, h('span', {}, label), h('span', { class: 'n' }))));
  const title = [h('span', { class: 'title-img' }, S.server.icon ? h('img', { src: S.server.icon, alt: '', referrerpolicy: 'no-referrer' }) : initials(S.server.name)), S.server.name, h('span', { class: 'title-sub' }, 'Server settings')];
  const close = modal(title, h('div', { class: 'settings' }, nav, body), {
    wide: true,
    onClose: () => {
      for (const ev of events) socket.off(ev, redraw);
      socket.off('invites', onInvites);
      socket.off('disconnect', gone);
    },
  });
  show(cur);
}

function serverOverview(body) {
  const ro = !canServerSettings();
  const serverName = h('input', { maxlength: 40, value: S.server.name, disabled: ro });
  const preview = h('div', { class: 'server-icon-preview' });
  preview.replaceChildren(S.server.icon ? h('img', { src: S.server.icon, alt: '', referrerpolicy: 'no-referrer' }) : initials(S.server.name));
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
  const g = S.server.game || {};
  const gameToggle = switchEl(!!g.enabled, async (on) => (await update({ game: on })) || gameToggle.setAttribute('aria-checked', String(!!S.server.game?.enabled)), 'Club Penguin', { disabled: ro || !g.available });
  // Voice quality: the bitrate everyone sends their voice at in this server's channels
  const quality = h('select', { disabled: ro, 'aria-label': 'Voice quality', onchange: async () => (await update({ audioQuality: quality.value })) || (quality.value = AUDIO_QUALITY[S.server.audioQuality] ? S.server.audioQuality : 'max') }, Object.entries(VOICE_QUALITIES).map(([k, label]) => h('option', { value: k }, label)));
  quality.value = AUDIO_QUALITY[S.server.audioQuality] ? S.server.audioQuality : 'max';
  body.append(
    h('h3', {}, 'Overview'),
    h(
      'p',
      { class: 'muted small' },
      ro ? 'The server’s name, icon, voice quality and games can only be changed by an administrator. ' : 'The server’s name and icon are shown to everyone on it. The icon can be any image (it’s resized for you) or an animated GIF. An administrator can also set a link. ',
      h('span', {}, S.entry.address)
    ),
    h(
      'div',
      { class: 'row server-overview' },
      h(
        'div',
        { class: 'server-icon-edit' },
        preview,
        ro
          ? null
          : h(
              'div',
              { class: 'row tight center' },
              imageChoices({ size: IMG.icon, dropOn: [preview], uploadLabel: 'Upload icon', onPick: (icon) => update({ icon }) }),
              h('button', { class: 'btn small ghost danger', onclick: () => S.server.icon && update({ icon: '' }) }, 'Remove')
            )
      ),
      h(
        'div',
        { class: 'grow server-name-col' },
        h('label', { class: 'field' }, h('span', {}, 'Server name'), serverName),
        ro ? null : h('div', { class: 'row end' }, h('button', { class: 'btn small', onclick: saveName }, 'Save name'))
      )
    ),
    h('h3', {}, 'Voice'),
    settingRow('Voice quality', 'Lower it if a big channel strains someone’s upload.', quality),
    h('h3', {}, 'Games'),
    settingRow('Club Penguin', g.available ? 'Shows Club Penguin under Games for everyone on this server.' : g.reason || 'Club Penguin is not available on this server.', gameToggle, { dim: !g.available }),
    ...(S.server.storage
      ? [
          h('h3', {}, 'Files'),
          settingRow(
            `${fmtBytes(S.server.storage.used)} of ${fmtBytes(S.server.storage.max)} used`,
            h('div', { class: 'storage-bar' + (S.server.storage.used / S.server.storage.max > 0.9 ? ' full' : '') }, h('div', { style: { width: Math.min(100, (S.server.storage.used / (S.server.storage.max || 1)) * 100) + '%' } })),
            h('button', { class: 'btn small secondary', onclick: () => openFileBrowser() }, 'Browse files')
          ),
        ]
      : [])
  );
}

function serverRoles(body, { st, redraw }) {
  const sv = S.server;
  const p = S.conn.perms;
  const roles = Array.isArray(sv.roles) ? sv.roles : [];
  const open = !!p.open;
  const admin = !!p.admin;
  const canMake = !open && (admin || p.manageRoles);
  if (st.role !== 'default' && !roles.some((r) => r.id === st.role)) st.role = 'default';
  const pick = (id) => ((st.role = id), redraw());
  const dot = (r) => h('span', { class: 'role-dot', style: { background: typeof r.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : 'var(--muted)' } });
  const newRole = async () => {
    const name = await promptModal('New role', 'Name');
    if (!name) return;
    const r = await doAct('role:create', { name, color: randomColor() });
    if (r?.ok && r.role) pick(r.role.id);
  };
  const list = h(
    'div',
    { class: 'roles-list' },
    h('button', { class: 'roles-item' + (st.role === 'default' ? ' active' : ''), onclick: () => pick('default') }, 'Default permissions'),
    h('div', { class: 'nav-group' }, 'Roles, highest first'),
    ...roles.map((r) => h('button', { class: 'roles-item' + (st.role === r.id ? ' active' : ''), onclick: () => pick(r.id) }, dot(r), h('span', { class: 'name' }, r.name))),
    canMake ? h('button', { class: 'btn small', onclick: newRole }, 'New role') : null
  );

  // Checkboxes for the roles this one (or everybody) may hand out
  const grantList = (chosen, ro, save) =>
    h(
      'div',
      { class: 'grant-list' },
      roles.length ? null : h('p', { class: 'muted small' }, 'No roles yet.'),
      ...roles.map((x) =>
        h(
          'label',
          { class: 'check-row' + (ro ? ' disabled' : '') },
          h('input', {
            type: 'checkbox',
            checked: chosen.includes(x.id),
            disabled: ro,
            onchange: (e) => save(roles.filter((y) => (y.id === x.id ? e.target.checked : chosen.includes(y.id))).map((y) => y.id)),
          }),
          roleTag(x)
        )
      )
    );
  const grantNote = h('p', { class: 'muted small' }, 'Only roles without permissions can be handed out here.');

  let editor;
  if (st.role === 'default') {
    const dp = sv.defaultPerms || {};
    editor = h(
      'div',
      { class: 'roles-edit' },
      h('h3', {}, 'Default permissions'),
      h('p', { class: 'muted small' }, 'What everyone can do unless a role or channel says otherwise.' + (admin || open ? '' : ' Only administrators can change them.')),
      ...PERM_INFO.map(([key, label, desc]) =>
        settingRow(
          label,
          desc,
          switchEl(
            !!dp[key],
            async (on) => {
              if (key === 'admin' && on && !(await confirmModal('Make everyone an administrator', 'Everyone on this server, including people who join later, would have every permission. Do this only if you mean it.', 'Make everyone admin'))) return redraw();
              const r = await doAct('perms:default', { perms: { [key]: on } });
              if (r?.error) redraw();
            },
            label,
            { disabled: !admin }
          )
        )
      ),
      dp.manageRoles ? [h('h3', {}, 'Roles everyone can hand out'), grantNote, grantList(sv.defaultGrantable || [], !admin, (ids) => doAct('perms:default', { grantable: ids }))] : null
    );
  } else {
    const r = roles.find((x) => x.id === st.role);
    const idx = roles.indexOf(r);
    const canEdit = !open && (admin || (p.manageRoles && isAesthetic(r)));
    const name = h('input', { maxlength: 32, value: r.name, disabled: !canEdit });
    const color = h('input', { type: 'color', 'aria-label': 'Role color', value: /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : '#8b6cf6', disabled: !canEdit });
    const save = () => name.value.trim() && doAct('role:update', { id: r.id, name: name.value.trim(), color: color.value });
    name.addEventListener('keydown', (e) => e.key === 'Enter' && save());
    const setPerms = (key, v) => {
      const next = { ...(r.perms || {}) };
      if (v === undefined || (key === 'admin' && !v)) delete next[key];
      else next[key] = v;
      return doAct('role:update', { id: r.id, perms: next });
    };
    const holders = Object.entries(sv.memberRoles || {}).filter(([, ids]) => Array.isArray(ids) && ids.includes(r.id)).map(([pid]) => profileOf(pid, sv.profiles?.[pid]?.name).name);
    editor = h(
      'div',
      { class: 'roles-edit' },
      h('h3', {}, 'Role'),
      h(
        'div',
        { class: 'row form-row' },
        h('label', { class: 'field grow' }, h('span', {}, 'Name'), name),
        h('label', { class: 'field' }, h('span', {}, 'Color'), color),
        canEdit ? h('button', { class: 'btn', onclick: save }, 'Save') : null
      ),
      canEdit || admin
        ? h(
            'div',
            { class: 'row' },
            admin && !open ? h('button', { class: 'btn small ghost', disabled: idx === 0, onclick: () => doAct('role:update', { id: r.id, position: idx - 1 }) }, 'Move up') : null,
            admin && !open ? h('button', { class: 'btn small ghost', disabled: idx === roles.length - 1, onclick: () => doAct('role:update', { id: r.id, position: idx + 1 }) }, 'Move down') : null,
            canEdit
              ? h('button', { class: 'btn small ghost danger push-end', onclick: async () => (await confirmModal('Delete role', `Delete "${r.name}"? Everyone who has it loses it.`, 'Delete role')) && doAct('role:delete', { id: r.id }) }, 'Delete role…')
              : null
          )
        : h('p', { class: 'muted small' }, 'You can’t edit this role.'),
      h('p', { class: 'muted small' }, holders.length ? `Held by ${holders.join(', ')}.` : 'Nobody has this role yet. Give it to people from the Members page.'),
      h('h3', {}, 'Permissions'),
      h('p', { class: 'muted small' }, '/ inherits the default permissions; ✓ allows, ✕ denies. With several roles, the highest one wins.' + (admin && !open ? '' : ' Only administrators can change these.')),
      ...PERM_INFO.map(([key, label, desc]) =>
        settingRow(
          label,
          desc,
          key === 'admin'
            ? switchEl(!!r.perms?.admin, (on) => setPerms('admin', on ? true : undefined), label, { disabled: !admin || open })
            : triSelect(r.perms?.[key], (v) => setPerms(key, v), { disabled: !admin || open, label })
        )
      ),
      r.perms?.manageRoles === true
        ? [h('h3', {}, 'Roles this role can hand out'), grantNote, grantList(r.grantable || [], !admin || open, (ids) => doAct('role:update', { id: r.id, grantable: ids }))]
        : null
    );
  }
  body.append(
    ...[open ? h('p', { class: 'banner-note' }, 'Permissions are off: everyone can do everything. They apply once someone is made Administrator in the admin dashboard.') : null,
    h('div', { class: 'roles-page' }, list, editor)].filter(Boolean)
  );
}

// Everyone who has joined: roles, whether they're here, and the member menu on each row (D72)
function serverMembers(body, { st }) {
  const sv = S.server;
  const online = new Set(S.users.map((u) => u.id));
  const q = (st.memberQuery || '').toLowerCase();
  const people = Object.entries(sv.profiles || {})
    .filter(([pid]) => !isBanned(pid))
    .map(([pid, p]) => ({ ...p, id: pid }))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const list = h('div', { class: 'member-list' });
  const draw = () => {
    const shown = people.filter((u) => !q || (u.name || '').toLowerCase().includes(q) || rolesOf(u.id).some((r) => r.name.toLowerCase().includes(q)));
    list.replaceChildren(
      ...(shown.length
        ? shown.map((u) => {
            const rs = rolesOf(u.id);
            const more = memberItems(u.id, null, 'left').filter((it) => it !== '-' && !/^Roles/.test(it.label));
            return h(
              'div',
              { class: 'setting-row member-row' },
              avatarEl(u, 28),
              h(
                'div',
                { class: 'sr-label' },
                h('div', { class: 'sr-title' }, u.name),
                h('div', { class: 'sr-help' }, u.id === me().id ? 'You' : online.has(u.id) ? 'Online' : u.seen ? 'Last seen ' + fmtTime(u.seen) : 'Offline')
              ),
              h('span', { class: 'role-tags member-role-tags' }, isAdminPid(u.id) ? h('span', { class: 'role-tag admin-tag' }, 'Administrator') : null, rs.map(roleTag)),
              grantableRoles(u.id).length ? h('button', { class: 'btn small ghost', onclick: (e) => rolesPopover(e.currentTarget, u.id) }, 'Roles…') : null,
              more.length ? h('button', { class: 'icon-btn small', title: `More for ${u.name}`, onclick: (e) => menuPopover(e.currentTarget, memberItems(u.id, e.currentTarget, 'left'), { align: 'end', label: u.name }) }, icon('more')) : null
            );
          })
        : [emptyState('people', q ? 'Nobody matches' : 'Nobody yet', q ? 'Try another name or role.' : null)])
    );
  };
  const search = h('input', { type: 'search', class: 'head-search', placeholder: 'Search members', 'aria-label': 'Search members', value: st.memberQuery || '', oninput: () => ((st.memberQuery = search.value), serverMembers(body.replaceChildren() || body, { st }), body.querySelector('.head-search')?.focus()) });
  body.append(h('div', { class: 'page-head' }, h('h3', {}, 'Members'), search), list);
  draw();
}

function serverEmojis(body) {
  const ok = can('manageEmojis');
  const nameIn = h('input', { placeholder: 'party_parrot', maxlength: 32, spellcheck: 'false' });
  const fileIn = h('input', { type: 'file', accept: 'image/*', 'aria-label': 'Emoji image' });
  body.append(
    ...[h('h3', {}, 'Custom emojis'),
    h('p', { class: 'muted small' }, 'Use them as :name: or from the emoji picker.' + (ok ? ' GIFs must be under 256KB.' : ' Adding them needs the Manage emojis permission.')),
    ok
      ? h(
          'div',
          { class: 'row form-row upload-box' },
          h('label', { class: 'field grow' }, h('span', {}, 'Name'), nameIn),
          h('label', { class: 'field grow' }, h('span', {}, 'Image'), fileIn),
          h(
            'button',
            {
              class: 'btn',
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
        )
      : null,
    h(
      'div',
      { class: 'emoji-list' },
      S.server.emojis.length
        ? S.server.emojis.map((e) =>
            h(
              'div',
              { class: 'emoji-row' },
              h('img', { src: e.url, alt: e.name }),
              h('code', {}, `:${e.name}:`),
              h('span', { class: 'muted small grow' }, e.by ? `by ${e.by}` : ''),
              ok ? h('button', { class: 'btn small ghost danger', onclick: () => doAct('emoji:remove', { name: e.name }) }, 'Remove') : null
            )
          )
        : [emptyState('smile', 'No custom emojis yet', ok ? 'Upload one above.' : null)]
    )].filter(Boolean)
  );
}

function serverBans(body) {
  const ok = can('ban');
  body.append(
    h('h3', {}, 'Banned'),
    h('p', { class: 'muted small' }, ok ? 'Ban someone from their name in the member list.' : 'Banning and unbanning needs the Ban members permission.'),
    h(
      'div',
      { class: 'emoji-list' },
      S.server.bans?.length
        ? S.server.bans.map((b) =>
            h(
              'div',
              { class: 'emoji-row' },
              avatarEl({ ...profileOf(b.profileId, b.name) }, 28),
              h('strong', {}, profileOf(b.profileId, b.name).name),
              h('span', { class: 'muted small grow' }, `by ${b.by} · ${fmtTime(b.ts)}${b.ip ? ' · profile and IP' : ''}`),
              ok ? h('button', { class: 'btn small ghost', onclick: () => doAct('ban:remove', { id: b.id }) }, 'Unban') : null
            )
          )
        : [emptyState('shield', 'Nobody is banned')]
    )
  );
}

// Invites (D51): the tokens new people join with. Only people with Create invites get this page.
function serverInvites(body, { st, redraw }) {
  const p = S.conn.perms || {};
  const socket = S.socket;
  if (!st.invites) {
    st.invites = [];
    socket.emitWithAck('invite:list', {}).then((r) => {
      if (r.error) st.invitesError = r.error;
      else st.invites = r.invites;
      redraw();
    });
  }
  const copy = (text, what) => navigator.clipboard.writeText(text).then(() => toast(what + ' copied'), () => toast('Could not copy', 'error'));

  // Whether joining takes an invite at all: administrators
  const required = switchEl(
    S.server.inviteOnly !== false,
    async (on) => {
      const r = await socket.emitWithAck('server:update', { inviteOnly: on });
      if (r.error) (toast(r.error, 'error'), required.setAttribute('aria-checked', String(S.server.inviteOnly !== false)));
    },
    'Require an invite to join',
    { disabled: !p.admin }
  );

  // A new invite
  st.inviteType ||= 'permanent';
  const note = h('input', { maxlength: 40, placeholder: 'Who it is for (optional)', value: st.inviteNote || '', oninput: () => (st.inviteNote = note.value) });
  const type = h('select', { 'aria-label': 'Invite type', onchange: () => ((st.inviteType = type.value), redraw()) }, INVITE_TYPES.map(([k, label]) => h('option', { value: k }, label)));
  type.value = st.inviteType;
  const uses = h('input', { type: 'number', min: 2, max: 10000, value: st.inviteUses || 5, oninput: () => (st.inviteUses = uses.value) });
  const lasts = h('select', { onchange: () => (st.inviteLasts = lasts.value) }, INVITE_DURATIONS.map(([ms, label]) => h('option', { value: ms }, label)));
  lasts.value = st.inviteLasts || 864e5;
  const create = async () => {
    const payload = { label: note.value.trim() };
    if (type.value === 'single') payload.maxUses = 1;
    if (type.value === 'multi') payload.maxUses = Math.round(Number(uses.value));
    if (type.value === 'timed') payload.expiresIn = Number(lasts.value);
    const r = await socket.emitWithAck('invite:create', payload);
    if (r.error) return toast(r.error, 'error');
    st.inviteNote = '';
    st.justMade = r.invite?.id || null; // highlighted in the list (D72)
    toast('Invite created', 'success');
    redraw();
  };
  const remove = async (v) => {
    const active = inviteStatus(v) === 'active';
    if (active && !(await confirmModal('Revoke invite', 'Nobody can join with it any more. People who already joined with it stay.', 'Revoke invite'))) return;
    doAct('invite:remove', { id: v.id });
  };

  const row = (v) => {
    const i = inviteInfo(v);
    const active = i.status === 'Active';
    const mine = p.admin || v.by.id === me().id;
    return h(
      'div',
      { class: 'invite-row' + (active ? '' : ' inactive') + (st.justMade === v.id ? ' fresh' : '') },
      h(
        'div',
        { class: 'row' },
        h('strong', {}, v.label || 'Invite'),
        h('span', { class: 'invite-status' + (active ? ' active' : '') }, i.status),
        st.justMade === v.id ? h('span', { class: 'muted small' }, 'Just created') : null,
        h('span', { class: 'grow' }),
        mine ? h('button', { class: 'btn small ghost' + (active ? ' danger' : ''), onclick: () => remove(v) }, active ? 'Revoke…' : 'Remove') : null
      ),
      // A working invite's token: every one for an administrator, your own otherwise
      v.token ? h('div', { class: 'row tight' }, h('span', { class: 'invite-token' }, v.token), h('button', { class: 'btn small', onclick: () => copy(v.token, 'Invite') }, 'Copy')) : null,
      h(
        'div',
        { class: 'muted small' },
        `${i.type} · made by ${v.by.name}, ${fmtTime(v.ts)} · used ${i.uses}${v.maxUses ? '' : v.uses === 1 ? ' time' : ' times'} · `,
        h('span', { title: v.expires ? new Date(v.expires).toLocaleString() : null }, v.expires ? (active ? `${i.left} left` : 'time ended') : 'no time limit'),
        // Why it no longer works, in the open rather than in a tooltip (D72)
        v.revoked ? ` · revoked by ${v.revoked.by}, ${fmtTime(v.revoked.ts)}` : ''
      ),
      v.joins.length
        ? h(
            'details',
            { class: 'muted small' },
            h('summary', {}, `Who joined with it (${v.uses})`),
            v.joins.map((j) => h('div', {}, `${profileOf(j.id, j.name).name} · ${fmtTime(j.ts)}`)),
            v.uses > v.joins.length ? h('div', {}, `and ${v.uses - v.joins.length} earlier`) : null
          )
        : null
    );
  };

  body.append(
    h('h3', {}, 'Invites'),
    h('p', { class: 'muted small' }, 'A token someone enters once to join this server.'),
    settingRow('Require an invite to join', p.admin ? 'Off: anyone who knows the address can join.' : 'Only an administrator can change this.', required, { dim: !p.admin }),
    h('h3', {}, 'New invite'),
    h(
      'div',
      { class: 'row invite-form' },
      h('label', { class: 'field grow' }, h('span', {}, 'Note'), note),
      h('label', { class: 'field' }, h('span', {}, 'Type'), type),
      st.inviteType === 'multi' ? h('label', { class: 'field' }, h('span', {}, 'Uses'), uses) : null,
      st.inviteType === 'timed' ? h('label', { class: 'field' }, h('span', {}, 'Lasts'), lasts) : null,
      h('button', { class: 'btn', onclick: create }, 'Create')
    ),
    h('h3', {}, 'This server’s invites'),
    st.invitesError
      ? h('p', { class: 'muted small' }, st.invitesError)
      : h('div', { class: 'emoji-list' }, st.invites.length ? [...st.invites].reverse().map(row) : [emptyState('key', 'No invites yet', 'Make one above and send it to a friend.')])
  );
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

// Back in the window: the channel in view counts as read
window.addEventListener('focus', () => {
  if (S.entry && S.channelId && !isDm(S.channelId) && mentionUnread.clear(S.entry.id, S.channelId)) (renderRail(), renderChannels());
});

// Browsers block audio until a user gesture; unlock on first interaction.
window.addEventListener('pointerdown', () => audio.ensure(), { once: true });

boot();
