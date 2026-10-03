import { h, fmtTime, avatarEl, debounce } from '../util.js';
import { load, showDialog, confirmDialog, alertDialog, roleTags, idChip } from '../ui.js';

const table = (heads, rows) => h('div', { class: 'tablewrap' }, h('table', {},
  h('thead', {}, h('tr', {}, heads.map((t) => h('th', {}, t)))), h('tbody', {}, rows)));

function ident(u) {
  const name = h('span', {}, u.name);
  if (/^#[0-9a-f]{6}$/i.test(u.color || '')) name.style.color = u.color;
  return h('div', { class: 'ident' }, avatarEl(u, 28), name);
}

function doing(u) {
  const bits = [];
  if (u.voice) bits.push(`In voice: ${u.voiceName || u.voice}`);
  if (u.muted) bits.push('muted');
  if (u.deafened) bits.push('deafened');
  if (u.sharing) bits.push('sharing screen');
  if (u.camera) bits.push('camera on');
  if (u.playing) bits.push('playing the game');
  return bits.join(', ') || h('span', { class: 'muted' }, 'idle');
}

export default {
  id: 'users',
  title: 'Users',
  mount(root, { api, events }) {
    let data = null;
    let filter = '';
    const box = h('div', {});
    const scroller = () => root.closest('.main');
    const fail = (e) => alertDialog('Something went wrong', e.message);

    const editRoles = (u) => {
      if (!data.roles.length) {
        return showDialog({ title: `Roles for ${u.name}`, cancelLabel: null,
          content: h('p', {}, 'No roles yet. ', h('a', { href: '#/roles' }, 'Create one under Roles'), '.') });
      }
      const boxes = data.roles.map((r) => ({ r, input: h('input', { type: 'checkbox', checked: (u.roles || []).includes(r.id) }) }));
      return showDialog({
        title: `Roles for ${u.name}`, confirmLabel: 'Save',
        content: [h('p', { class: 'muted small' }, 'Roles with permissions can only go to people whose profile has a key.'),
          h('div', { class: 'checks' }, boxes.map(({ r, input }) => h('label', {}, input, roleTags([r.id], [r]))))],
        onConfirm: () => api.put(`users/${encodeURIComponent(u.id)}/roles`, { roles: boxes.filter((b) => b.input.checked).map((b) => b.r.id) }),
      });
    };

    const remove = async (u) => {
      const ok = await confirmDialog({ title: `Remove ${u.name}?`, confirmLabel: 'Remove', danger: true,
        body: 'This disconnects them and removes them from the member list. They can come back by connecting again.' });
      if (!ok) return;
      try { await api.post(`users/${encodeURIComponent(u.id)}/remove`); } catch (e) { fail(e); }
    };

    const resetKey = async (u) => {
      const ok = await confirmDialog({ title: `Reset ${u.name}’s key?`, confirmLabel: 'Reset key', danger: true,
        body: 'Only someone holding this profile’s key can connect as it. Reset it for someone who lost their key (no exported profile file): the next person to connect with this profile ID claims it with their key, so do this only when you know who that will be.' });
      if (!ok) return;
      try { await api.post(`users/${encodeURIComponent(u.id)}/reset-key`); } catch (e) { fail(e); }
    };

    const ban = async (u) => {
      const ip = u.ip || u.lastIp;
      const ipBox = h('input', { type: 'checkbox' });
      let skipped = false;
      const ok = await showDialog({
        title: `Ban ${u.name}?`, confirmLabel: 'Ban', danger: true,
        content: [h('p', {}, 'They are disconnected and cannot join again with this profile.'),
          ip && h('label', { class: 'row' }, ipBox, `Also ban their IP address (${ip})`)],
        onConfirm: async () => { skipped = (await api.post('bans', { profileId: u.id, ip: !!(ip && ipBox.checked) })).ipSkipped; },
      });
      if (ok && skipped) alertDialog('IP not banned', 'The profile was banned, but the IP part was skipped because the address is local or shared with you.');
    };

    const unban = async (b) => {
      const ok = await confirmDialog({ title: `Unban ${b.name || 'this user'}?`, confirmLabel: 'Unban', body: 'They will be able to connect again.' });
      if (!ok) return;
      try { await api.del(`bans/${encodeURIComponent(b.id)}`); } catch (e) { fail(e); }
    };

    const match = (name, id) => !filter || `${name} ${id}`.toLowerCase().includes(filter);
    const btn = (label, fn, cls = '') => h('button', { class: `btn small ghost ${cls}`, onClick: fn }, label);
    const userActions = (u) => h('td', { class: 'actions' },
      btn('Roles…', () => editRoles(u)), u.key && btn('Reset key', () => resetKey(u), 'danger'), btn('Remove', () => remove(u), 'danger'), btn('Ban…', () => ban(u), 'danger'));
    const keyCell = (u) => h('td', { class: 'mono nowrap', title: u.key ? 'The start of the key this profile must sign in with' : 'No key yet: an older app, which anyone can pose as' },
      u.key || h('span', { class: 'muted' }, 'none'));

    function render() {
      const d = data;
      const on = d.online.filter((u) => match(u.name, u.id));
      const off = d.offline.filter((u) => match(u.name, u.id));
      const bans = d.bans.filter((b) => match(b.name || '', b.profileId || ''));
      const section = (title, n, content) => [h('h2', {}, `${title} (${n})`), n ? content : h('p', { class: 'muted' }, filter ? 'Nothing matches.' : 'None.')];
      return h('div', {},
        section('Online', on.length, table(['User', 'Roles', 'Profile ID', 'Key', 'IP', 'Connected', 'Doing', ''],
          on.map((u) => h('tr', {},
            h('td', {}, ident(u)), h('td', {}, roleTags(u.roles, d.roles)), h('td', {}, idChip(u.id)), keyCell(u), h('td', { class: 'mono' }, u.ip),
            h('td', { class: 'nowrap' }, fmtTime(u.since)), h('td', {}, doing(u)), userActions(u))))),
        section('Offline', off.length, table(['User', 'Roles', 'Profile ID', 'Key', 'Last seen', 'Last IP', ''],
          off.map((u) => h('tr', {},
            h('td', {}, ident(u)), h('td', {}, roleTags(u.roles, d.roles)), h('td', {}, idChip(u.id)), keyCell(u),
            h('td', { class: 'nowrap' }, u.seen ? fmtTime(u.seen) : 'unknown'), h('td', { class: 'mono' }, u.lastIp || 'unknown'),
            userActions(u))))),
        section('Banned', bans.length, table(['Name', 'Profile ID', 'IP', 'Banned by', 'When', ''],
          bans.map((b) => h('tr', {},
            h('td', {}, b.name || h('span', { class: 'muted' }, 'unknown')), h('td', {}, b.profileId ? idChip(b.profileId) : ''),
            h('td', { class: 'mono' }, b.ip || h('span', { class: 'muted' }, 'profile only')), h('td', {}, b.by),
            h('td', { class: 'nowrap' }, fmtTime(b.ts)), h('td', { class: 'actions' }, btn('Unban', () => unban(b))))))));
    }

    // swap content in place, keeping the page scroll position
    const paint = () => {
      const sc = scroller(), top = sc?.scrollTop || 0;
      box.replaceChildren(render());
      if (sc) sc.scrollTop = top;
    };
    const refresh = async () => {
      try { data = await api.get('users'); paint(); } catch { /* keep what is shown */ }
    };

    const search = h('input', { type: 'search', placeholder: 'Filter by name or profile ID', 'aria-label': 'Filter users', onInput: () => { filter = search.value.trim().toLowerCase(); if (data) paint(); } });
    root.append(
      h('p', { class: 'note small' }, 'Behind a reverse proxy, every address shown here is the proxy’s address.'),
      h('div', { class: 'filterbar' }, search), box);
    load(box, async () => (data = await api.get('users')), render);
    const d = debounce(refresh, 400);
    return events.on('change', (e) => { if (e.topic === 'users' || e.topic === 'state') d(); });
  },
};
