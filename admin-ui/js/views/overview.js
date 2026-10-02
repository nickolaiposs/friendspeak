import { h, fmtBytes, fmtTime, debounce } from '../util.js';
import { load, usageBar } from '../ui.js';

function fmtUptime(s) {
  s = Math.max(0, Math.floor(s));
  const d = Math.floor(s / 86400), hr = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${hr}h`;
  if (hr) return `${hr}h ${m}m`;
  return m ? `${m}m ${s % 60}s` : `${s}s`;
}

const kv = (rows) => h('dl', { class: 'kv' }, rows.filter(Boolean).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
const card = (title, ...kids) => h('section', { class: 'card' }, h('h2', {}, title), ...kids);
const yn = (v, yes = 'Yes', no = 'No') => h('span', { class: `badge ${v ? 'good' : ''}` }, v ? yes : no);

function updateSummary(u) {
  let state = 'Up to date';
  const v = u.latest?.version;
  if (u.installing) state = 'Installing';
  else if (u.mode === 'off') state = 'Checks are off (AUTO_UPDATE)';
  else if (v && v !== u.version) {
    const link = typeof u.latest.url === 'string' && u.latest.url.startsWith('https://');
    state = link ? h('span', {}, 'Version ', h('a', { href: u.latest.url, target: '_blank', rel: 'noopener noreferrer' }, v), ' available') : `Version ${v} available`;
  }
  return [
    ['Mode', u.mode === 'on' && u.cron ? `${u.mode} (${u.cron})` : u.mode],
    ['Status', state],
    u.at && ['Next window', fmtTime(u.at)],
  ];
}

function render(o, uptimeEl) {
    const g = o.game || {};
  const icon = /^(data:image\/|https:\/\/)/.test(o.icon || '') && h('img', { src: o.icon, alt: '', referrerpolicy: 'no-referrer' });
  return h('div', {},
    h('div', { class: 'title-row' }, icon, h('div', {}, h('div', { class: 'name' }, o.name), h('div', { class: 'muted small' }, `Version ${o.version}`))),
    h('div', { class: 'cards' },
      card('Server', kv([
        ['Uptime', uptimeEl],
        ['Started', fmtTime(o.startedAt)],
        ['Node', o.node],
        ['Platform', o.platform],
        ['Memory', `${fmtBytes(o.memory.rss)} rss, ${fmtBytes(o.memory.heapUsed)} heap`],
        ['Hosting', o.docker ? 'Docker' : 'Plain Node'],
      ])),
      card('Access', kv([
        ['HTTPS', yn(o.https, 'On', 'Off')],
        o.fingerprint && ['Fingerprint', h('span', { class: 'mono small' }, o.fingerprint)],
        ['Server password', yn(o.password, 'Set', 'Not set')],
        ['Local admin access', yn(o.adminLocal, 'On', 'Off')],
      ])),
      card('Counts', kv([
        ['Online', o.counts.online],
        ['Known profiles', o.counts.profiles],
        ['Bans', o.counts.bans],
        ['Channels', o.counts.channels],
      ])),
      card('Storage', h('div', {}, `${fmtBytes(o.storage.used)} of ${fmtBytes(o.storage.max)}`), usageBar(o.storage.used, o.storage.max)),
      card('Game', kv([
        ['Available', yn(g.available)],
        ['Enabled', yn(g.enabled)],
        g.world && ['World', g.world],
        g.reason && ['Note', g.reason],
      ])),
      card('Updates', kv(updateSummary(o.update || {})), h('p', { class: 'small' }, h('a', { href: '#/updates' }, 'Manage updates')))));
}

export default {
  id: 'overview',
  title: 'Overview',
  mount(root, { api, events }) {
    const box = h('div', {});
    root.append(box);
    let started = 0, base = 0;
    const uptimeEl = h('span', {});
    const tick = () => (uptimeEl.textContent = fmtUptime(base + (Date.now() - started) / 1000));
    const fetcher = async () => {
      const o = await api.get('overview');
      base = o.uptime;
      started = Date.now();
      tick();
      return o;
    };
    const first = () => load(box, fetcher, (o) => render(o, uptimeEl));
    // background refreshes keep the current content, and only replace it on success
    const refresh = async () => {
      try { box.replaceChildren(render(await fetcher(), uptimeEl)); } catch { /* keep what is shown */ }
    };
    first();
    const off = events.on('change', debounce(refresh, 500));
    const t1 = setInterval(tick, 1000);
    const t2 = setInterval(refresh, 30000);
    return () => { off(); clearInterval(t1); clearInterval(t2); };
  },
};
