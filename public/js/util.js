export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const uid = () =>
  crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);

const EMOJI_ONLY =
  /^(?:\s|\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|:[a-z0-9_]+:)+$/u;

// What a link embeds as, or null. Only https media (http would be mixed
// content), and only providers whose embed works without extra scripts.
export function linkEmbed(url) {
  let m;
  if ((m = /^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/.exec(url))) {
    const t = /[?&#]t=(?:(\d+)h)?(?:(\d+)m)?(\d+)s?/.exec(url);
    const start = t ? (+t[1] || 0) * 3600 + (+t[2] || 0) * 60 + (+t[3] || 0) : 0;
    return { kind: 'youtube', url, id: m[1], start };
  }
  if ((m = /^https?:\/\/(?:www\.)?vimeo\.com\/(\d+)/.exec(url))) return { kind: 'iframe', url, provider: 'Vimeo', src: `https://player.vimeo.com/video/${m[1]}`, ratio: '16 / 9' };
  if ((m = /^https?:\/\/(?:www\.)?streamable\.com\/([a-z0-9]+)$/i.exec(url))) return { kind: 'iframe', url, provider: 'Streamable', src: `https://streamable.com/e/${m[1]}`, ratio: '16 / 9' };
  if ((m = /^https:\/\/open\.spotify\.com\/(?:intl-[\w-]+\/)?(track|album|playlist|episode|show|artist)\/(\w+)/.exec(url)))
    return { kind: 'iframe', url, provider: 'Spotify', src: `https://open.spotify.com/embed/${m[1]}/${m[2]}`, height: m[1] === 'track' || m[1] === 'episode' ? 152 : 352 };
  if (/^https:\/\/(?:www\.|m\.)?soundcloud\.com\/[\w-]+\/(?!sets\/)[\w-]+\/?(?:\?.*)?$/.test(url))
    return { kind: 'iframe', url, provider: 'SoundCloud', src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(url.split('?')[0])}&visual=false`, height: 166 };
  if (!url.startsWith('https://')) return null;
  const path = url.split(/[?#]/)[0].toLowerCase();
  if (/\.(gif|png|jpe?g|webp|avif)$/.test(path)) return { kind: 'image', url };
  if (/\.(mp4|webm|mov|m4v)$/.test(path)) return { kind: 'video', url };
  if (/\.(mp3|ogg|oga|opus|wav|m4a|flac|aac)$/.test(path)) return { kind: 'audio', url };
  return null;
}

const MAX_EMBEDS = 5;

// A mention's span around inner HTML that is already safe
function mentionSpan(c, inner) {
  const color = c.kind === 'role' && /^#[0-9a-f]{6}$/i.test(c.color || '') ? ` style="color:${c.color}"` : '';
  const kind = ['user', 'role', 'everyone'].includes(c.kind) ? c.kind : 'user';
  return `<span class="mention${c.me ? ' me' : ''}${kind === 'role' ? ' role' : ''}${kind === 'everyone' ? ' everyone' : ''}" data-kind="${kind}" data-id="${escapeHtml(String(c.id ?? ''))}"${color}>${inner}</span>`;
}

// Mentions: '@' at the start or after whitespace, then a candidate name (case-insensitive,
// may contain spaces), then the end or a char that isn't [\w-]. Longest candidate wins.
// server.js repeats these rules (it is CommonJS), keep the two in step.
// candidates: [{ kind: 'everyone' | 'role' | 'user', id, name }]
// Channel links follow the same rules with '#' (`sigil`).
function scanMentions(text, candidates, onMatch, sigil = '@') {
  const list = candidates
    .filter((c) => c && typeof c.name === 'string' && c.name)
    .map((c) => ({ c, key: c.name.toLowerCase() }))
    .sort((a, b) => b.key.length - a.key.length);
  for (let i = text.indexOf(sigil); i >= 0; i = text.indexOf(sigil, i + 1)) {
    if (i > 0 && !/\s/.test(text[i - 1])) continue;
    const hit = list.find(({ key }) => text.slice(i + 1, i + 1 + key.length).toLowerCase() === key && !/[\w-]/.test(text[i + 1 + key.length] || ''));
    if (hit) onMatch(hit.c, i, i + 1 + hit.key.length);
  }
}

// Tells apart people with the same name: @Bob#k3f9. server.js repeats it.
export function mentionTag(id) {
  let h = 0;
  for (const ch of String(id)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0; // spread it, so similar ids get unlike tags
  h = (h ^ (h >>> 16)) >>> 0;
  return (h % 1679616).toString(36).padStart(4, '0');
}

// Candidates mentioned in text (deduped by kind+id), code spans ignored
export function findMentions(text, candidates) {
  const plain = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]+`/g, ' ');
  const found = new Map();
  scanMentions(plain, candidates || [], (c) => found.set(c.kind + ':' + c.id, { kind: c.kind, id: c.id, name: c.name }));
  return [...found.values()];
}

// A link to a text channel around its name, which is already safe. `gone`: deleted, or not ours to see.
function channelSpan(c, name) {
  return c.gone
    ? `<span class="chan-link gone" title="This channel was deleted, or you can’t see it">#${name}</span>`
    : `<span class="chan-link" role="link" tabindex="0" data-channel="${escapeHtml(String(c.id ?? ''))}">#${name}</span>`;
}

// A link to a message on a server (D54), as it is written in a message
export const messageLink = (server, channel, message) => `friendspeak://msg/${server}/${channel}/${message}`;
const MESSAGE_LINK = /(&lt;)?friendspeak:\/\/msg\/([\w-]{1,64})\/([\w-]{1,64})\/([\w-]{1,64})(&gt;)?/g;

// The text around a match, on one line: what a search result shows. server.js repeats it.
export function snippetAround(text, at, len) {
  const from = Math.max(0, at - 40);
  const to = Math.min(text.length, at + len + 120);
  return (from > 0 ? '…' : '') + text.slice(from, to).replace(/\s+/g, ' ').trim() + (to < text.length ? '…' : '');
}

// What is typed in a search field: words, plus filters like from:bob in:general has:image
// before:2026-10-04 after:yesterday on:today (a name with spaces goes in "quotes").
// Returns { q, from: [name], in: [name], has: [kind], before, after (times, local days), bad: [what couldn't be read] }.
export const SEARCH_FILTERS = ['from', 'in', 'has', 'before', 'after', 'on'];
export const SEARCH_HAS = ['file', 'image', 'gif', 'link'];
export function parseSearch(input) {
  const out = { q: '', from: [], in: [], has: [], before: null, after: null, bad: [] };
  const words = [];
  const day = (v, add = 0) => {
    const now = new Date();
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
    const d = v === 'today' ? [now.getFullYear(), now.getMonth(), now.getDate()] : v === 'yesterday' ? [now.getFullYear(), now.getMonth(), now.getDate() - 1] : m ? [+m[1], +m[2] - 1, +m[3]] : null;
    const t = d ? new Date(d[0], d[1], d[2] + add).getTime() : NaN;
    return Number.isFinite(t) ? t : null;
  };
  for (const m of String(input).matchAll(/\b(from|in|has|before|after|on|during):(?:"([^"]*)"?|(\S*))|(\S+)/gi)) {
    if (!m[1]) {
      words.push(m[4]);
      continue;
    }
    const op = m[1].toLowerCase();
    const v = (m[2] ?? m[3] ?? '').trim().toLowerCase();
    if (!v) continue; // still being typed
    if (op === 'from' || op === 'in') out[op].push(op === 'in' ? v.replace(/^#/, '') : v.replace(/^@/, ''));
    else if (op === 'has') {
      const kind = SEARCH_HAS.find((k) => k === v || k + 's' === v);
      if (kind) out.has.push(kind);
      else out.bad.push(`has:${v}`);
    } else if (day(v) == null) out.bad.push(`${op}:${v}`);
    else if (op === 'before') out.before = Math.min(out.before ?? Infinity, day(v));
    else if (op === 'after') out.after = Math.max(out.after ?? -Infinity, day(v, 1));
    else {
      out.after = Math.max(out.after ?? -Infinity, day(v));
      out.before = Math.min(out.before ?? Infinity, day(v, 1));
    }
  }
  out.q = words.join(' ');
  return out;
}

// Markdown-lite renderer. Input is raw user text; output is safe HTML plus
// the embeds its links produce (rendered by the caller). Wrapping a link in
// <angle brackets> keeps it a plain link without an embed.
// mentions ([{ at, len, kind, id, name, me, color?, tag? }]) are where the server found mentions in
// the raw text: each is drawn with the name given (the current one), so renames carry over.
// Otherwise mentionables ([{ kind, id, name, me, color? }]) turn known @names (with spaces) into
// highlighted spans; without either only @word is marked, and `me` goes by myName.
// Channel links work the same way: channelMarks ([{ at, len, id, name, gone? }]) are where the
// server found #channel, else channels ([{ id, name }]) turns the #names it knows into links.
// A message link (see messageLink) becomes a pill labelled by linkLabel({ server, channel, message })
// and is listed in `links`, for the caller to draw a preview; in <angle brackets> it is only the pill.
export function formatText(text, { emojis = [], myName = '', mentionables = null, mentions = null, channels = null, channelMarks = null, linkLabel = null } = {}) {
  const emojiMap = new Map(emojis.map((e) => [e.name, e.url]));
  const jumbo = EMOJI_ONLY.test(text) && [...text.replace(/:[a-z0-9_]+:/g, 'x')].length <= 27;
  const blocks = [];
  const stash = (html) => `\u0000${blocks.push(html) - 1}\u0000`;
  // Swap each known mention for a marker (\u0002n\u0002) before anything else, so its
  // position still holds; the marker becomes the mention at the end
  const marks = [];
  // \u0000 and \u0002 are the markers used below: in someone's text they would be taken for one
  // (a lone \u00000\u0000 line broke the whole message list). Swapped for a same-length character, so positions hold.
  let raw = String(text).replace(/[\u0000\u0002]/g, '\ufffd');
  const known = [...(Array.isArray(mentions) ? mentions : []), ...(Array.isArray(channelMarks) ? channelMarks.map((m) => m && { ...m, kind: 'channel' }) : [])];
  let end = Infinity;
  for (const m of known.filter((m) => m && Number.isInteger(m.at) && Number.isInteger(m.len) && m.len > 0).sort((a, b) => b.at - a.at)) {
    if (m.at + m.len > end || raw[m.at] !== (m.kind === 'channel' ? '#' : '@')) continue;
    raw = raw.slice(0, m.at) + `\u0002${marks.push(m) - 1}\u0002` + raw.slice(m.at + m.len);
    end = m.at;
  }
  let s = escapeHtml(raw);

  // stash code so nothing inside it gets formatted
  s = s.replace(/```(?:[a-z0-9]*\n)?([\s\S]*?)```/g, (_, code) => stash(`<pre><code>${code.replace(/^\n|\n$/g, '')}</code></pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_, code) => stash(`<code>${code}</code>`));

  const embeds = [];
  const link = (url, embed) => {
    const raw = url.replace(/&amp;/g, '&');
    const e = embed && embeds.length < MAX_EMBEDS && linkEmbed(raw);
    if (e && !embeds.some((x) => x.url === e.url)) embeds.push(e);
    return stash(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  };
  const links = [];
  s = s.replace(MESSAGE_LINK, (_, lt, server, channel, message, gt) => {
    const l = { server, channel, message };
    const bare = !(lt && gt);
    if (bare && links.length < MAX_EMBEDS && !links.some((x) => x.server === server && x.channel === channel && x.message === message)) links.push(l);
    return (
      (bare ? lt || '' : '') +
      stash(`<span class="msg-link" role="link" tabindex="0" data-server="${server}" data-channel="${channel}" data-message="${message}">${escapeHtml(String(linkLabel?.(l) || 'message link'))}</span>`) +
      (bare ? gt || '' : '')
    );
  });
  s = s.replace(/&lt;(https?:\/\/(?:(?!&gt;)[^\s])+)&gt;/g, (_, url) => link(url, false));
  s = s.replace(/https?:\/\/(?:(?!&lt;|&gt;|&quot;)[^\s\u0000])+/g, (url) => {
    // trailing punctuation belongs to the sentence, not the link
    const tail = /(?:[.,:;!?)\]]|&#39;)+$/.exec(url)?.[0] || '';
    return link(url.slice(0, url.length - tail.length), true) + tail;
  });

  const inlineBase = (t) =>
    t
      .replace(/\|\|(.+?)\|\|/g, '<span class="spoiler" tabindex="0">$1</span>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(.+?)__/g, '<u>$1</u>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~(.+?)~~/g, '<s>$1</s>')
      .replace(/:([a-z0-9_]+):/g, (m, name) =>
        emojiMap.has(name)
          ? `<img class="cemoji${jumbo ? ' jumbo' : ''}" src="${escapeHtml(emojiMap.get(name))}" alt=":${name}:" title=":${name}:">`
          : m
      )
      .replace(/(^|\s)@([\w-]+)/g, (m, pre, name) =>
        mentionables || mentions
          ? m
          : `${pre}<span class="mention${myName && name.toLowerCase() === myName.toLowerCase() ? ' me' : ''}">@${name}</span>`
      );
  // Known mentions: matched on the escaped text, so names with spaces or & work
  const mentionHtml = (t) => {
    if (!mentionables?.length) return t;
    const cands = mentionables.map((m) => ({ ...m, name: escapeHtml(m.name) }));
    const hits = [];
    scanMentions(t, cands, (c, from, to) => hits.push([c, from, to]));
    let o = '';
    let at = 0;
    for (const [c, from, to] of hits) {
      if (from < at) continue;
      o += t.slice(at, from) + mentionSpan(c, t.slice(from, to));
      at = to;
    }
    return o + t.slice(at);
  };
  // Known channels, the same way
  const channelHtml = (t) => {
    if (channelMarks || !channels?.length || !t.includes('#')) return t;
    const hits = [];
    scanMentions(t, channels.map((c) => ({ ...c, name: escapeHtml(c.name) })), (c, from, to) => hits.push([c, from, to]), '#');
    let o = '';
    let at = 0;
    for (const [c, from, to] of hits) {
      if (from < at) continue;
      o += t.slice(at, from) + channelSpan(c, t.slice(from + 1, to));
      at = to;
    }
    return o + t.slice(at);
  };
  const inline = (t) => channelHtml(mentions ? inlineBase(t) : mentionHtml(inlineBase(t)));

  // Line-level blocks: headings, -# subtext, > quotes, - and 1. lists.
  // Plain lines are joined with <br>; block elements bring their own spacing.
  const out = [];
  let para = [];
  let list = null; // { tag, items, start }
  let quote = null;
  const flush = (keep) => {
    if (para.length && keep !== 'para') out.push(`<p>${para.join('<br>')}</p>`), (para = []);
    if (list && keep !== 'list') out.push(`<${list.tag}${list.start > 1 ? ` start="${list.start}"` : ''}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`), (list = null);
    if (quote && keep !== 'quote') out.push(`<blockquote>${quote.join('<br>')}</blockquote>`), (quote = null);
  };
  for (const line of s.split('\n')) {
    let m;
    if ((m = /^(#{1,3}) +(.+)$/.exec(line))) {
      flush();
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
    } else if ((m = /^-# +(.+)$/.exec(line))) {
      flush();
      out.push(`<div class="subtext">${inline(m[1])}</div>`);
    } else if ((m = /^&gt; ?(.*)$/.exec(line))) {
      flush('quote');
      (quote ||= []).push(inline(m[1]));
    } else if ((m = /^ {0,3}(?:([-*+])|(\d{1,9})[.)]) +(.+)$/.exec(line))) {
      const tag = m[1] ? 'ul' : 'ol';
      if (list && list.tag !== tag) flush();
      flush('list');
      (list ||= { tag, items: [], start: m[2] ? +m[2] : 1 }).items.push(inline(m[3]));
    } else if (/^\u0000\d+\u0000$/.test(line) && blocks[+line.slice(1, -1)].startsWith('<pre>')) {
      flush();
      out.push(line);
    } else {
      flush('para');
      para.push(inline(line));
    }
  }
  flush();
  s = out.join('').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[i]);
  s = s.replace(/\u0002(\d+)\u0002/g, (_, i) => {
    const c = marks[i];
    if (c.kind === 'channel') return channelSpan(c, escapeHtml(String(c.name)));
    return mentionSpan(c, '@' + escapeHtml(String(c.name)) + (c.tag ? `<span class="mention-tag">#${escapeHtml(String(c.tag))}</span>` : ''));
  });
  return { html: s, jumbo, embeds, links };
}

export function fmtBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) (n /= 1024), i++;
  return `${i ? n.toFixed(n < 10 ? 1 : 0) : n} ${units[i]}`;
}

export function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today at ${time}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday at ${time}`;
  return `${d.toLocaleDateString()} ${time}`;
}

export const shortTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const SERVER_MEDIA = /^(https?:\/\/[^/\s"'<>]+)\/media\/[0-9a-f]{64}$/;
const mediaOrigins = new Set(); // of the servers mediaResolver() was asked for
// Is this an uploaded (data URL) or linked (https) image, rather than an emoji or color?
// An image a profile, a server or a GIF message may point at: one that travels with it (a data URL),
// or a GIF on GIPHY, which is where the picker gets them. Not any https address: whoever runs it would
// learn the address of everyone who is shown the picture, and when. server.js has the same rule.
// Or one a server we are connected to serves itself (D57): that server knows our address already.
export const isImage = (v) => typeof v === 'string' && (/^(data:image\/|https:\/\/(?:media\d*|i)\.giphy\.com\/[^\s"'<>]+$)/.test(v) || mediaOrigins.has(SERVER_MEDIA.exec(v)?.[1]));
// Pictures a server sends by reference ('/media/<hash>', D57) made into addresses on that server,
// in place: { profile(p), emoji(e), users(list), server(helloAck.server) }. Asking for one is what
// makes isImage() accept that server's pictures.
export function mediaResolver(address) {
  const origin = new URL(address).origin;
  mediaOrigins.add(origin);
  const abs = (v) => (typeof v === 'string' && /^\/media\/[0-9a-f]{64}$/.test(v) ? origin + v : v);
  const profile = (p) => {
    if (!p || typeof p !== 'object') return;
    if (p.avatar) p.avatar = abs(p.avatar);
    if (p.banner) p.banner = abs(p.banner);
  };
  const emoji = (e) => {
    if (e && typeof e === 'object') e.url = abs(e.url);
  };
  return {
    profile,
    emoji,
    users: (list) => Array.isArray(list) && list.forEach(profile),
    server: (sv) => {
      if (sv?.profiles && typeof sv.profiles === 'object') Object.values(sv.profiles).forEach(profile);
      if (Array.isArray(sv?.emojis)) sv.emojis.forEach(emoji);
    },
  };
}

// Turn any image file the browser can decode into a data URL that fits in
// maxBytes: downscaled to `max` px on the long side and re-encoded. Animated
// GIF/WebP/APNG files that already fit are kept as-is so they stay animated
// (browsers can't re-encode animation). maxBytes counts the decoded bytes.
export function fileToDataUrl(file, { max = 128, maxBytes = 200 * 1024 } = {}) {
  const kb = Math.round(maxBytes / 1024);
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('No file chosen'));
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const url = reader.result;
      const fits = file.size <= maxBytes;
      const keepable = /^image\/(gif|webp|png|apng)$/.test(file.type);
      if (file.type === 'image/gif' && !fits)
        return reject(new Error(`That GIF is ${Math.round(file.size / 1024)}KB; the limit is ${kb}KB. Pick a smaller one, or choose one from GIPHY.`));
      const img = new Image();
      img.onerror = () => reject(new Error('That file isn’t an image this browser can read'));
      img.onload = () => {
        // Small enough already: keep the original bytes (and any animation)
        if (keepable && fits && Math.max(img.width, img.height) <= max * 2) return resolve(url.replace(/^data:image\/apng/, 'data:image/png'));
        if (file.type === 'image/gif') return resolve(url);
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * scale));
        c.height = Math.max(1, Math.round(img.height * scale));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const limit = maxBytes * 1.37;
        const png = c.toDataURL('image/png');
        if (png.length <= limit) return resolve(png);
        for (const q of [0.9, 0.8, 0.65, 0.5]) {
          const jpg = c.toDataURL('image/jpeg', q);
          if (jpg.length <= limit) return resolve(jpg);
        }
        reject(new Error(`Couldn’t shrink that image under ${kb}KB`));
      };
      img.src = url;
    };
    reader.readAsDataURL(file);
  });
}

export function avatarEl(profile, size = 40) {
  const p = profile || {};
  const style = { width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.45) + 'px' };
  if (isImage(p.avatar)) {
    return h('div', { class: 'avatar', style }, h('img', { src: p.avatar, alt: '', referrerpolicy: 'no-referrer' }));
  }
  // An emoji or a couple of letters. Anything longer is an image address this app doesn't load (see isImage): the initial instead
  const label = (p.avatar && p.avatar.length <= 16 && !/^(https?:|data:)/i.test(p.avatar) ? p.avatar : '') || (p.name || '?').slice(0, 1).toUpperCase();
  return h('div', { class: 'avatar', style: { ...style, background: p.color || '#8b6cf6' } }, label);
}

// A channel name with :custom: server emojis shown as images (unicode emojis are just text)
export function channelNameEl(name, emojis = [], cls = 'name') {
  const byName = new Map(emojis.map((e) => [e.name, e.url]));
  const parts = String(name).split(/(:[a-z0-9_]+:)/);
  return h(
    'span',
    { class: cls, title: name },
    parts.map((part) => {
      const url = /^:[a-z0-9_]+:$/.test(part) && byName.get(part.slice(1, -1));
      return url ? h('img', { class: 'cemoji', src: url, alt: part }) : part;
    })
  );
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

// Human readable key combo from a KeyboardEvent, e.g. "Ctrl+Shift+1".
export function comboFromEvent(e) {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  parts.push(e.code.replace(/^Key/, '').replace(/^Digit/, ''));
  return parts.join('+');
}

// ---- invites (D51): shared by the app's server settings and the admin dashboard ----

// 'active', or why an invite no longer lets anyone in (the rule of inviteStatus() in server.js)
export const inviteStatus = (v, now = Date.now()) => (v.revoked ? 'revoked' : v.expires && v.expires <= now ? 'expired' : v.maxUses && v.uses >= v.maxUses ? 'used' : 'active');

// What is left of a time span: "3d 4h", "2h 5m", "12m", "under a minute"
export function fmtLeft(ms) {
  const m = Math.floor(ms / 60e3);
  if (m < 1) return 'under a minute';
  const d = Math.floor(m / 1440);
  const hr = Math.floor((m % 1440) / 60);
  return d ? `${d}d${hr ? ` ${hr}h` : ''}` : hr ? `${hr}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`;
}

// An invite in words: { type, uses, left, status }
export function inviteInfo(v, now = Date.now()) {
  const status = inviteStatus(v, now);
  const type = [v.maxUses === 1 ? 'One use' : v.maxUses ? 'Multi-use' : '', v.expires ? 'Time-expiring' : ''].filter(Boolean).join(', ') || 'Never expires';
  return {
    type,
    uses: v.maxUses ? `${v.uses} of ${v.maxUses}` : String(v.uses),
    left: !v.expires ? 'No limit' : status === 'active' ? fmtLeft(v.expires - now) : v.expires <= now ? 'Ended' : '',
    status: { active: 'Active', revoked: 'Revoked', expired: 'Expired', used: 'Used up' }[status],
  };
}

// The kinds of invite the UIs offer, and what each sends to the server
export const INVITE_TYPES = [
  ['permanent', 'Never expires (until revoked)'],
  ['single', 'One use'],
  ['multi', 'Multi-use'],
  ['timed', 'Time-expiring'],
];
export const INVITE_DURATIONS = [
  [30 * 60e3, '30 minutes'],
  [3600e3, '1 hour'],
  [6 * 3600e3, '6 hours'],
  [864e5, '1 day'],
  [7 * 864e5, '7 days'],
  [30 * 864e5, '30 days'],
];

export function normalizeAddress(input) {
  let a = String(input || '').trim();
  if (!a) return '';
  const explicitScheme = /^https?:\/\//i.test(a);
  if (!explicitScheme) a = 'https://' + a; // a plain http server takes a typed "http://"
  try {
    const u = new URL(a);
    // "192.168.1.20" means https on the default friendspeak port; "https://host" means exactly that
    if (!explicitScheme && !/^https?:\/\/[^/]+:\d+/.test(a)) u.port = '3000';
    return u.origin;
  } catch {
    return '';
  }
}
