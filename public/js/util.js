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

// Markdown-lite renderer. Input is raw user text; output is safe HTML plus
// the embeds its links produce (rendered by the caller). Wrapping a link in
// <angle brackets> keeps it a plain link without an embed.
export function formatText(text, { emojis = [], myName = '' } = {}) {
  const emojiMap = new Map(emojis.map((e) => [e.name, e.url]));
  const jumbo = EMOJI_ONLY.test(text) && [...text.replace(/:[a-z0-9_]+:/g, 'x')].length <= 27;
  const blocks = [];
  const stash = (html) => `\u0000${blocks.push(html) - 1}\u0000`;
  let s = escapeHtml(text);

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
  s = s.replace(/&lt;(https?:\/\/(?:(?!&gt;)[^\s])+)&gt;/g, (_, url) => link(url, false));
  s = s.replace(/https?:\/\/(?:(?!&lt;|&gt;|&quot;)[^\s\u0000])+/g, (url) => {
    // trailing punctuation belongs to the sentence, not the link
    const tail = /(?:[.,:;!?)\]]|&#39;)+$/.exec(url)?.[0] || '';
    return link(url.slice(0, url.length - tail.length), true) + tail;
  });

  const inline = (t) =>
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
        `${pre}<span class="mention${myName && name.toLowerCase() === myName.toLowerCase() ? ' me' : ''}">@${name}</span>`
      );

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
  return { html: s, jumbo, embeds };
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

// Is this an uploaded (data URL) or linked (https) image, rather than an emoji or color?
export const isImage = (v) => typeof v === 'string' && /^(data:image\/|https:\/\/)/.test(v);

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
  const label = p.avatar || (p.name || '?').slice(0, 1).toUpperCase();
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

export function normalizeAddress(input) {
  let a = String(input || '').trim();
  if (!a) return '';
  const explicitScheme = /^https?:\/\//i.test(a);
  if (!explicitScheme) a = (location.protocol === 'https:' ? 'https://' : 'http://') + a;
  try {
    const u = new URL(a);
    // "192.168.1.20" means the default friendspeak port; "https://host" means exactly that
    if (!explicitScheme && !/^https?:\/\/[^/]+:\d+/.test(a)) u.port = '3000';
    return u.origin;
  } catch {
    return '';
  }
}
