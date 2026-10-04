import { h, fmtTime, fmtBytes, avatarEl, debounce } from '../util.js';
import { load } from '../ui.js';

const table = (heads, rows) => h('div', { class: 'tablewrap' }, h('table', {},
  h('thead', {}, h('tr', {}, heads.map((t) => h('th', {}, t)))), h('tbody', {}, rows)));

function occupant(o) {
  const name = h('span', {}, o.name);
  if (/^#[0-9a-f]{6}$/i.test(o.color || '')) name.style.color = o.color;
  const marks = [o.muted && 'muted', o.deafened && 'deafened', o.sharing && 'sharing', o.camera && 'camera'].filter(Boolean);
  return h('div', { class: 'ident' }, avatarEl(o, 24), name, marks.length > 0 && h('span', { class: 'marks' }, marks.join(', ')));
}

function render({ channels }) {
  const text = channels.filter((c) => c.type === 'text');
  const voice = channels.filter((c) => c.type === 'voice');
  return h('div', {},
    h('h2', {}, `Text channels (${text.length})`),
    text.length ? table(['Name', 'Messages', 'Last message', 'Files'], text.map((c) => h('tr', {},
      h('td', {}, c.name), h('td', {}, c.messages), h('td', { class: 'nowrap' }, c.lastMessage ? fmtTime(c.lastMessage) : 'never'), h('td', {}, c.files))))
      : h('p', { class: 'muted' }, 'None.'),
    h('h2', {}, `Voice channels (${voice.length})`),
    voice.length ? h('div', { class: 'voicelist' }, voice.map((c) => h('section', { class: 'card' },
      h('h2', {}, c.name),
      c.occupants.length ? h('div', { class: 'checks' }, c.occupants.map(occupant)) : h('span', { class: 'muted' }, 'empty'))))
      : h('p', { class: 'muted' }, 'None.'));
}

export default {
  id: 'channels',
  title: 'Channels',
  mount(root, { api, events }) {
    const box = h('div', {});
    root.append(h('p', { class: 'note small' }, 'Channels are managed in the app.'), box);
    const fetcher = () => api.get('channels');
    load(box, fetcher, render);
    const refresh = debounce(async () => { try { box.replaceChildren(render(await fetcher())); } catch { /* keep */ } }, 400);
    return events.on('change', (e) => { if (e.topic === 'users' || e.topic === 'state') refresh(); });
  },
};
