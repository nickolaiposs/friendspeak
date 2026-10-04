import { h, fmtTime, fmtBytes } from '../util.js';
import { load, loadingState, errorState, copyText, confirmDialog, alertDialog } from '../ui.js';
import { logRow } from './log.js';

const KINDS = { uncaughtException: 'Crash', unhandledRejection: 'Unhandled rejection', startup: 'Failed to start', 'unclean-exit': 'Stopped unexpectedly' };
const kindLabel = (k) => KINDS[k] || k || 'Unknown';
const firstLine = (s) => String(s ?? '').split('\n')[0];
const kv = (rows) => h('dl', { class: 'kv' }, rows.filter(Boolean).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));

function fmtUptime(s) {
  s = Math.max(0, Math.floor(s));
  const d = Math.floor(s / 86400), hr = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${hr}h` : hr ? `${hr}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

export default {
  id: 'crashes',
  title: 'Crash reports',
  mount(root, { api, events }) {
    const list = h('div', {});
    const detail = h('div', { hidden: true });
    root.append(list, detail);
    let current = null; // id being viewed
    let gone = false;

    const showList = () => { current = null; detail.hidden = true; detail.replaceChildren(); list.hidden = false; refresh(); };

    const remove = async (c, after) => {
      const ok = await confirmDialog({ title: 'Delete this report?', body: `${kindLabel(c.kind)}, ${fmtTime(c.ts)}. It cannot be restored.`, confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      try { await api.del('crashes/' + encodeURIComponent(c.id)); } catch (err) { return alertDialog('Could not delete', err.message); }
      after();
    };

    const removeAll = async (n) => {
      const ok = await confirmDialog({ title: `Delete all ${n} crash reports?`, body: 'They cannot be restored.', confirmLabel: 'Delete all', danger: true });
      if (!ok) return;
      try { await api.del('crashes'); } catch (err) { alertDialog('Could not delete', err.message); }
      refresh();
    };

    async function open(c) {
      current = c.id;
      list.hidden = true;
      detail.hidden = false;
      detail.replaceChildren(loadingState());
      try {
        const r = await api.get('crashes/' + encodeURIComponent(c.id));
        if (gone || current !== c.id) return;
        detail.replaceChildren(renderDetail(r));
      } catch (err) {
        if (gone || current !== c.id) return;
        detail.replaceChildren(h('div', { class: 'row' }, h('button', { class: 'btn small ghost', onClick: showList }, 'Back')),
          errorState(err, () => open(c)));
      }
    }

    function renderDetail(r) {
      const json = JSON.stringify(r, null, 2);
      const stack = h('pre', { class: 'stack-trace' }, r.stack || r.message || '(no stack recorded)');
      const copy = h('button', { class: 'btn small ghost', onClick: async () => {
        const ok = await copyText(json, stack);
        copy.textContent = ok ? 'Copied' : 'Press Ctrl+C to copy';
        setTimeout(() => (copy.textContent = 'Copy report'), 1500);
      } }, 'Copy report');
      const download = () => {
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        const a = h('a', { href: url, download: `friendspeak-crash-${r.id}.json` });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
      const m = r.memory || {};
      return h('div', {},
        h('div', { class: 'row crash-actions' },
          h('button', { class: 'btn small ghost', onClick: showList }, 'Back'),
          h('span', { class: 'grow' }),
          copy,
          h('button', { class: 'btn small ghost', onClick: download }, 'Download'),
          h('button', { class: 'btn small danger', onClick: () => remove(r, showList) }, 'Delete')),
        h('h2', {}, kindLabel(r.kind)),
        h('div', { class: 'card' }, kv([
          ['Time', r.ts && fmtTime(r.ts)],
          ['Kind', h('span', {}, kindLabel(r.kind), ' ', h('span', { class: `badge ${r.fatal ? 'bad' : 'warn'}` }, r.fatal ? 'fatal' : 'not fatal'))],
          ['Message', firstLine(r.message)],
          r.version && ['Version', r.version],
          r.node && ['Node', r.node],
          (r.platform || r.arch) && ['Platform', [r.platform, r.arch].filter(Boolean).join(' ')],
          r.uptime != null && ['Uptime', fmtUptime(r.uptime)],
          (m.rss != null || m.heapUsed != null) && ['Memory', `${fmtBytes(m.rss || 0)} rss, ${fmtBytes(m.heapUsed || 0)} heap`],
          r.online != null && ['People online', r.online],
          r.docker != null && ['Hosting', r.docker ? 'Docker' : 'Plain Node'],
          r.startedAt && ['Started', fmtTime(r.startedAt)],
        ])),
        h('h2', {}, 'Stack'),
        stack,
        h('h2', {}, 'Log before the crash'),
        r.lines?.length ? h('div', { class: 'logbox crashlog' }, r.lines.map((l) => logRow(l))) : h('p', { class: 'muted' }, 'No log lines were saved with this report.'));
    }

    const table = ({ crashes }) => {
      if (!crashes.length) return h('div', { class: 'state' }, 'No crash reports. The server writes one when it crashes or stops unexpectedly.');
      return h('div', {},
        h('div', { class: 'row crash-actions' }, h('span', { class: 'grow muted small' }, `${crashes.length} report${crashes.length === 1 ? '' : 's'}`),
          h('button', { class: 'btn small danger', onClick: () => removeAll(crashes.length) }, 'Delete all')),
        h('div', { class: 'tablewrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['Time', 'Kind', 'Version', 'Message', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, crashes.map((c) => h('tr', { class: 'clickable', onClick: () => open(c) },
            h('td', { class: 'nowrap' }, fmtTime(c.ts)),
            h('td', { class: 'nowrap' }, h('span', { class: `badge ${c.fatal === false ? 'warn' : 'bad'}` }, kindLabel(c.kind))),
            h('td', { class: 'nowrap' }, c.version),
            h('td', { class: 'msg', title: firstLine(c.message) }, firstLine(c.message)),
            h('td', { class: 'actions', onClick: (e) => e.stopPropagation() },
              h('button', { class: 'btn small ghost', onClick: () => open(c) }, 'View'),
              h('button', { class: 'btn small danger', onClick: () => remove(c, refresh) }, 'Delete'))))))));
    };

    const fetcher = () => api.get('crashes');
    const refresh = () => load(list, fetcher, table);
    refresh();

    // keep the list fresh quietly while it is showing
    const off = events.on('change', async (e) => {
      if (e.topic !== 'crashes' || current) return;
      try { const r = await fetcher(); if (!gone && !current) list.replaceChildren(table(r)); } catch { /* keep */ }
    });
    return () => { gone = true; off(); };
  },
};
