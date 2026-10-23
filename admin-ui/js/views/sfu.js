import { h, avatarEl, debounce } from '../util.js';
import { load } from '../ui.js';

// The SFU (D70): shares and cameras are published once to the server and forwarded to each viewer.
// Everything here is read-only; the media itself is end-to-end encrypted.

const table = (heads, rows) => h('div', { class: 'tablewrap' }, h('table', {},
  h('thead', {}, h('tr', {}, heads.map((t) => h('th', {}, t)))), h('tbody', {}, rows)));

const mbps = (bps) => (bps == null ? '–' : `${(bps / 1e6).toFixed(2)} Mbit/s`);
const KIND = { screen: 'Screen share', camera: 'Camera', shareAudio: 'Share sound' };
const state = (t) => {
  const bad = t.dtls === 'failed' || t.ice === 'disconnected' || t.ice === 'closed';
  return h('span', { class: `badge ${bad ? 'bad' : t.dtls === 'connected' ? 'good' : 'warn'}` }, `${t.ice} / ${t.dtls}`);
};

function who(m) {
  const name = h('span', {}, m.name);
  if (/^#[0-9a-f]{6}$/i.test(m.color || '')) name.style.color = m.color;
  return h('div', { class: 'ident' }, m.id && avatarEl(m, 24), name);
}

function producer(p) {
  const sizes = p.layers?.length ? p.layers.map((l) => `${l.w}×${l.h}${l.fps ? '@' + Math.round(l.fps) : ''}`).join(', ') : null;
  const streams = p.streams.length
    ? p.streams.map((s) => `${s.rid || 'stream'}: ${mbps(s.bitrate)}, score ${s.score}`).join(' · ')
    : 'no media yet';
  return h('tr', {}, h('td', {}, KIND[p.kind] || p.kind, p.paused && h('span', { class: 'badge warn' }, 'paused')), h('td', {}, sizes || '–'), h('td', { class: 'small' }, streams));
}

function consumer(c) {
  const layer = c.current == null ? 'none yet' : `${c.current}${c.preferred != null && c.preferred !== c.current ? ` (wants ${c.preferred})` : ''}`;
  return h('tr', {},
    h('td', {}, `${c.fromName}’s ${(KIND[c.kind] || c.kind).toLowerCase()}`),
    h('td', {}, c.kind === 'shareAudio' ? '–' : layer),
    h('td', {}, c.view ? `${c.view.w}×${c.view.h}` : '–'),
    h('td', {}, c.score ?? '–', c.paused && h('span', { class: 'badge warn' }, 'paused'), c.producerPaused && h('span', { class: 'badge' }, 'source paused')));
}

function member(m) {
  return h('div', { class: 'sfu-member' },
    who(m),
    m.transports.length > 0 && h('div', { class: 'small muted' }, m.transports.map((t) => h('span', { class: 'sfu-transport' }, `${t.direction === 'send' ? `sending (${t.owner === 'page' ? 'app' : `sidecar, ${t.owner}`})` : 'receiving'} `, state(t)))),
    m.producers.length > 0 && table(['Publishes', 'Layers', 'Arriving'], m.producers.map(producer)),
    m.consumers.length > 0 && table(['Watches', 'Layer', 'Tile', 'Score'], m.consumers.map(consumer)));
}

function render(s) {
  if (!s.running) return h('p', { class: 'muted' }, 'The SFU isn’t running (SFU=off, or it couldn’t start: see the log). Shares and cameras go peer to peer.');
  return h('div', {},
    h('h2', {}, `Workers (${s.workers.length})`),
    table(['Worker', 'Process', 'UDP port', 'Channels', 'CPU time', 'Memory'], s.workers.map((w) => h('tr', {},
      h('td', {}, w.index + 1), h('td', {}, w.pid), h('td', {}, w.port), h('td', {}, w.routers),
      h('td', {}, w.usage ? `${((w.usage.ru_utime + w.usage.ru_stime) / 1000).toFixed(1)} s` : '–'),
      h('td', {}, w.usage ? `${Math.round(w.usage.ru_maxrss / 1024)} MB` : '–')))),
    h('h2', {}, `Voice channels with streams (${s.rooms.length})`),
    s.rooms.length
      ? h('div', { class: 'sfu-rooms' }, s.rooms.map((r) => h('section', { class: 'card' },
        h('h2', {}, r.name || '(deleted channel)', h('span', { class: 'small muted' }, ` · worker ${r.worker + 1}`)),
        r.members.length ? r.members.map(member) : h('span', { class: 'muted' }, 'nobody'))))
      : h('p', { class: 'muted' }, 'Nobody is sharing or watching.'));
}

export default {
  id: 'sfu',
  title: 'Streams',
  mount(root, { api, events }) {
    const box = h('div', {});
    root.append(h('p', { class: 'note small' }, 'Screen shares and cameras go through the server (D70), end-to-end encrypted: the server forwards them without being able to see them.'), box);
    const fetcher = () => api.get('sfu');
    load(box, fetcher, render);
    const refresh = debounce(async () => { try { box.replaceChildren(render(await fetcher())); } catch { /* keep */ } }, 400);
    const off = events.on('change', (e) => { if (e.topic === 'sfu' || e.topic === 'users') refresh(); });
    const t = setInterval(refresh, 5000); // bitrates and scores move without a change event
    return () => { off(); clearInterval(t); };
  },
};
