import { h, debounce } from '../util.js';
import { load } from '../ui.js';

function status(g) {
  if (g.off) return ['Turned off by the host (GAME=off)', 'warn'];
  if (!g.available) return [`Not available${g.reason ? ': ' + g.reason : ''}`, 'warn'];
  if (!g.enabled) return ['Turned off in server settings', 'warn'];
  return ['Running', 'good'];
}

function render(g) {
  const [text, kind] = status(g);
  return h('div', { class: 'card stack' },
    h('dl', { class: 'kv' },
      h('dt', {}, 'Status'), h('dd', {}, h('span', { class: `badge ${kind}` }, text)),
      g.world && [h('dt', {}, 'World'), h('dd', {}, g.world)],
      h('dt', {}, 'Players online'), h('dd', {}, g.players == null ? 'not running' : `${g.players} of ${g.maxUsers}`)),
    h('p', { class: 'small muted' }, 'To turn the game on or off, use ', h('a', { href: '#/settings' }, 'Server settings'), '.'));
}

export default {
  id: 'game',
  title: 'Penguin game',
  mount(root, { api, events }) {
    const box = h('div', {});
    root.append(box);
    const fetcher = () => api.get('game');
    load(box, fetcher, render);
    const refresh = async () => { try { box.replaceChildren(render(await fetcher())); } catch { /* keep */ } };
    const off = events.on('change', (e) => { if (e.topic === 'state') debounce(refresh, 400)(); });
    const t = setInterval(refresh, 15000);
    return () => { off(); clearInterval(t); };
  },
};
