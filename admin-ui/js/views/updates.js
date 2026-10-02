import { h, fmtTime } from '../util.js';
import { load, confirmDialog, alertDialog } from '../ui.js';

const MODES = {
  off: 'Update checks are off.',
  notify: 'The server checks for new versions and tells everyone, but never installs by itself.',
  on: 'The server checks for new versions and installs them in the maintenance window.',
};

function countdown(at) {
  const s = Math.max(0, Math.round((at - Date.now()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default {
  id: 'updates',
  title: 'Updates',
  mount(root, { api, events }) {
    const box = h('div', {});
    const msg = h('div', { class: 'error-text small', role: 'alert' });
    let st = null;
    let tick = null;
    const timer = h('span', { class: 'countdown' });

    const apply = (u) => { st = { ...u, docker: u.docker ?? st?.docker }; paint(); };
    const act = async (path) => {
      msg.textContent = '';
      try { apply((await api.post(path)).update); } catch (e) { msg.textContent = e.message; }
    };
    const updateNow = async () => {
      const ok = await confirmDialog({ title: `Update to ${st.latest.version}?`, confirmLabel: 'Update now',
        body: 'Everyone on the server will see a warning, and the server restarts in about 2 minutes.' });
      if (ok) act('update/now');
    };

    function manual() {
      if (!st.manual || !st.at) return null;
      const upd = () => (timer.textContent = countdown(st.at));
      upd();
      clearInterval(tick);
      tick = setInterval(upd, 1000);
      return h('div', { class: 'row' }, 'Installing in ', timer, h('button', { class: 'btn small danger', onClick: () => act('update/cancel') }, 'Cancel'));
    }

    function howTo() {
      return h('div', { class: 'note small' }, h('strong', {}, 'This server can’t install updates itself. '),
        st.docker
          ? 'Re-pull the image and recreate the container. In Portainer, update the stack with “Re-pull image”. To let the dashboard do it, run the Watchtower sidecar (see the README).'
          : h('span', {}, 'Run ', h('code', {}, 'git pull && npm install'), ', then restart the server.'));
    }

    function render() {
      const u = st;
      const wt = !u.docker ? 'Not applicable (not running in Docker)' : u.watchtower === true ? 'Reachable' : u.watchtower === false ? 'Not reachable' : 'Not checked yet';
      const hasNew = u.latest && u.latest.version !== u.version;
      const link = hasNew && typeof u.latest.url === 'string' && u.latest.url.startsWith('https://');
      clearInterval(tick);
      const rows = [
        ['Current version', u.version],
        ['Mode', `${u.mode}. ${MODES[u.mode] || ''}`],
        ['Latest version', hasNew ? (link ? h('a', { href: u.latest.url, target: '_blank', rel: 'noopener noreferrer' }, u.latest.version) : u.latest.version) : 'Up to date'],
        ['Last check', u.lastCheck ? fmtTime(u.lastCheck) : 'never'],
        u.lastError && ['Last error', h('span', { class: 'error-text' }, u.lastError)],
        u.cron && ['Maintenance cron', h('code', {}, u.cron)],
        u.at && ['Next window', fmtTime(u.at)],
        ['Watchtower', wt],
      ].filter(Boolean);
      return h('div', { class: 'stack' },
        h('div', { class: 'card' }, h('dl', { class: 'kv' }, rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]))),
        u.installing && h('div', { class: 'note', role: 'status' }, 'Installing now. The dashboard reconnects when the server is back.'),
        manual(),
        h('div', { class: 'row' },
          u.mode !== 'off' && h('button', { class: 'btn ghost', onClick: () => act('update/check') }, 'Check now'),
          hasNew && u.canInstall && !u.installing && !u.manual && h('button', { class: 'btn', onClick: updateNow }, 'Update now')),
        u.mode === 'off' && h('p', { class: 'small muted' }, 'Checks are off. Set ', h('code', {}, 'AUTO_UPDATE=notify'), ' or ', h('code', {}, 'on'), ' to enable them.'),
        hasNew && !u.canInstall && howTo(),
        msg);
    }

    const paint = () => box.replaceChildren(render());
    const fetcher = async () => (st = await api.get('updates'));
    root.append(box);
    load(box, fetcher, render);
    const off = events.on('change', async (e) => {
      if (e.topic !== 'update') return;
      try { await fetcher(); paint(); } catch { /* keep */ }
    });
    return () => { off(); clearInterval(tick); };
  },
};
