import { h, fmtTime, fmtBytes, debounce } from '../util.js';
import { load, meter, usageBar } from '../ui.js';

const table = (heads, rows) => h('div', { class: 'tablewrap' }, h('table', {},
  h('thead', {}, h('tr', {}, heads.map((t) => h('th', {}, t)))), h('tbody', {}, rows)));

function render(d) {
  const total = d.used || 1;
  return h('div', {},
    h('div', { class: 'card stack' },
      h('div', {}, h('strong', {}, fmtBytes(d.used)), ` of ${fmtBytes(d.max)} used, ${d.count} file${d.count === 1 ? '' : 's'}`),
      usageBar(d.used, d.max)),
    h('h2', {}, 'By channel'),
    d.channels.length ? table(['Channel', 'Size', 'Files', 'Share'], d.channels.map((c) => h('tr', {},
      h('td', {}, c.name), h('td', { class: 'nowrap' }, fmtBytes(c.bytes)), h('td', {}, c.count), h('td', {}, meter((c.bytes / total) * 100, `${c.name} share`, true)))))
      : h('p', { class: 'muted' }, 'No files yet.'),
    h('h2', {}, `Largest files (${d.largest.length})`),
    d.largest.length ? table(['Name', 'Size', 'Type', 'Channel', 'Uploaded by', 'When'], d.largest.map((f) => h('tr', {},
      h('td', {}, f.name), h('td', { class: 'nowrap' }, fmtBytes(f.size)), h('td', { class: 'mono' }, f.type), h('td', {}, f.channelName),
      h('td', {}, f.byName), h('td', { class: 'nowrap' }, fmtTime(f.ts))))) : h('p', { class: 'muted' }, 'None.'),
    h('h2', {}, 'Data folder'),
    table(['File', 'Size'], d.data.map((f) => h('tr', {}, h('td', { class: 'mono' }, f.name), h('td', { class: 'nowrap' }, fmtBytes(f.bytes))))));
}

export default {
  id: 'storage',
  title: 'Storage',
  mount(root, { api, events }) {
    const box = h('div', {});
    root.append(h('p', { class: 'note small' }, 'Files are deleted in the app, from the Files panel.'), box);
    const fetcher = () => api.get('storage');
    load(box, fetcher, render);
    const refresh = debounce(async () => { try { box.replaceChildren(render(await fetcher())); } catch { /* keep */ } }, 1000);
    return events.on('change', (e) => { if (e.topic === 'state') refresh(); });
  },
};
