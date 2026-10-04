import { h } from '../util.js';
import { load, showDialog, confirmDialog, alertDialog } from '../ui.js';

const DEFAULT_COLOR = '#8b6cf6';

// Server-wide permissions, in the order of PERM_KEYS in server.js ('admin' is the Administrator checkbox)
const PERMS = [
  ['view', 'See channels'],
  ['send', 'Send messages / join voice'],
  ['mentionRoles', 'Mention roles'],
  ['mentionEveryone', 'Mention @everyone'],
  ['kick', 'Remove members'],
  ['voiceKick', 'Kick from voice'],
  ['ban', 'Ban members'],
  ['forceMute', 'Force mute'],
  ['manageRoles', 'Manage roles'],
  ['manageChannels', 'Manage channels'],
  ['manageEmojis', 'Manage emojis'],
  ['manageFiles', 'Manage files'],
  ['manageMessages', 'Delete messages'],
  ['createInvites', 'Create invites'],
];

function swatch(color) {
  const el = h('span', { class: 'swatch', 'aria-hidden': 'true' });
  el.style.background = color;
  return el;
}

export default {
  id: 'roles',
  title: 'Roles',
  mount(root, { api, events }) {
    let data = null;
    const box = h('div', {});
    const fail = (e) => alertDialog('Something went wrong', e.message);

    const holders = (roleId) => Object.entries(data.memberRoles).filter(([, ids]) => ids.includes(roleId)).map(([id]) => id);
    const nameOf = (id) => data.profiles[id]?.name || id;

    const run = async (fn) => {
      try { await fn(); } catch (e) { fail(e); }
      refresh();
    };

    const setRoles = (id, ids) => api.put(`users/${encodeURIComponent(id)}/roles`, { roles: ids });
    const move = (r, pos) => run(() => api.patch(`roles/${encodeURIComponent(r.id)}`, { position: pos }));

    const edit = (r) => {
      const name = h('input', { id: 'rename', maxlength: 32, value: r.name, required: true });
      const color = h('input', { type: 'color', value: r.color, 'aria-label': 'Color' });
      return showDialog({
        title: 'Edit role', confirmLabel: 'Save',
        content: [h('div', { class: 'field' }, h('label', { for: 'rename' }, 'Name'), name), h('div', { class: 'field' }, h('label', {}, 'Color'), color)],
        onConfirm: () => api.patch(`roles/${encodeURIComponent(r.id)}`, { name: name.value.trim(), color: color.value }),
      }).then(refresh);
    };

    const del = async (r) => {
      const n = holders(r.id).length;
      const ok = await confirmDialog({ title: `Delete ${r.name}?`, confirmLabel: 'Delete', danger: true,
        body: n ? `${n} member${n === 1 ? '' : 's'} will lose this role.` : 'Nobody holds this role.' });
      if (ok) run(() => api.del(`roles/${encodeURIComponent(r.id)}`));
    };

    // A role's grantable roles: who it may hand out (needs Manage roles)
    const grantList = (selected, except) => {
      const boxes = data.roles.filter((x) => x.id !== except).map((x) => ({ x, input: h('input', { type: 'checkbox', checked: selected.includes(x.id) }) }));
      const el = h('div', { class: 'checks' }, boxes.length ? boxes.map(({ x, input }) => h('label', {}, input, swatch(x.color), x.name)) : h('span', { class: 'muted small' }, 'No other roles.'));
      return { el, value: () => boxes.filter((b) => b.input.checked).map((b) => b.x.id) };
    };

    // Permissions editor for a role: Administrator, then Inherit / Allow / Deny per permission
    function permsEditor(r) {
      const admin = h('input', { type: 'checkbox', checked: r.perms.admin === true, id: `adm-${r.id}` });
      const selects = PERMS.map(([k, label]) => {
        const sel = h('select', { class: 'inline-sel', 'aria-label': `${label} for ${r.name}` },
          h('option', { value: '' }, 'Inherit'), h('option', { value: 'allow' }, 'Allow'), h('option', { value: 'deny' }, 'Deny'));
        sel.value = typeof r.perms[k] === 'boolean' ? (r.perms[k] ? 'allow' : 'deny') : '';
        return { k, label, sel };
      });
      const grants = grantList(r.grantable, r.id);
      const grantBox = h('div', { class: 'field' }, h('label', {}, 'Roles this role may give and take away (only roles without permissions)'), grants.el);
      const sync = () => {
        for (const { sel } of selects) sel.disabled = admin.checked;
        grantBox.hidden = admin.checked || selects.find((s) => s.k === 'manageRoles').sel.value !== 'allow';
      };
      admin.addEventListener('change', sync);
      for (const { sel } of selects) sel.addEventListener('change', sync);
      sync();
      const err = h('div', { class: 'error-text small', role: 'alert' });
      const save = h('button', { class: 'btn small', onClick: async () => {
        err.textContent = '';
        const perms = {};
        if (admin.checked) perms.admin = true;
        else for (const { k, sel } of selects) if (sel.value) perms[k] = sel.value === 'allow';
        const grantable = !admin.checked && perms.manageRoles === true ? grants.value() : [];
        try { await api.patch(`roles/${encodeURIComponent(r.id)}`, { perms, grantable }); refresh(); } catch (e) { err.textContent = e.message; }
      } }, 'Save permissions');
      return h('details', { class: 'perms' },
        h('summary', {}, 'Permissions', permSummary(r)),
        h('label', { class: 'permrow admin' }, admin, h('span', {}, h('strong', {}, 'Administrator'), h('span', { class: 'muted small' }, ' can do everything and ignores every other setting'))),
        h('div', { class: 'permgrid' }, selects.map(({ label, sel }) => h('label', { class: 'permrow' }, h('span', {}, label), sel))),
        grantBox, err, save);
    }
    const permSummary = (r) => {
      const n = Object.keys(r.perms).length;
      return h('span', { class: 'muted small' }, r.perms.admin ? ' Administrator' : n ? ` ${n} set` : ' none (label only)');
    };

    // What everybody gets: a checkbox per permission, Administrator included
    function defaultsCard() {
      const rows = [['admin', 'Administrator'], ...PERMS].map(([k, label]) => ({ k, label, input: h('input', { type: 'checkbox', checked: data.defaultPerms[k] === true }) }));
      const grants = grantList(data.defaultGrantable, null);
      const err = h('div', { class: 'error-text small', role: 'alert' });
      const save = h('button', { class: 'btn small', onClick: async () => {
        err.textContent = '';
        const perms = Object.fromEntries(rows.map(({ k, input }) => [k, input.checked]));
        try { await api.put('permissions', { perms, grantable: grants.value() }); refresh(); } catch (e) { err.textContent = e.message; }
      } }, 'Save default permissions');
      return h('section', { class: 'rolecard' },
        h('div', { class: 'head' }, h('span', { class: 'name' }, 'Default permissions (everyone)')),
        h('p', { class: 'muted small' }, 'What every member can do unless a role they hold says otherwise. Giving Administrator here makes everyone an administrator.'),
        h('div', { class: 'permgrid' }, rows.map(({ label, input }) => h('label', { class: 'permrow' }, input, h('span', {}, label)))),
        h('div', { class: 'field' }, h('label', {}, 'Roles everyone may give and take away, when Manage roles is on'), grants.el),
        err, save);
    }

    function roleCard(r, i, all) {
      const ids = holders(r.id);
      const candidates = Object.keys(data.profiles).filter((id) => !ids.includes(id)).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
      const picker = h('select', { class: 'inline-sel', 'aria-label': `Add a member to ${r.name}` },
        h('option', { value: '' }, 'Add member…'), candidates.map((id) => h('option', { value: id }, nameOf(id))));
      const add = h('button', { class: 'btn small ghost', onClick: () => picker.value && run(() => setRoles(picker.value, [...(data.memberRoles[picker.value] || []), r.id])) }, 'Add');
      return h('section', { class: 'rolecard' },
        h('div', { class: 'head' },
          swatch(r.color), h('span', { class: 'name' }, r.name), h('span', { class: 'muted small' }, `${ids.length} member${ids.length === 1 ? '' : 's'}`),
          h('button', { class: 'btn small ghost', disabled: i === 0, 'aria-label': `Move ${r.name} up`, onClick: () => move(r, i - 1) }, 'Up'),
          h('button', { class: 'btn small ghost', disabled: i === all.length - 1, 'aria-label': `Move ${r.name} down`, onClick: () => move(r, i + 1) }, 'Down'),
          h('button', { class: 'btn small ghost', onClick: () => edit(r) }, 'Edit'),
          h('button', { class: 'btn small danger', onClick: () => del(r) }, 'Delete')),
        permsEditor(r),
        h('div', { class: 'members' },
          ids.map((id) => {
            const n = h('span', {}, nameOf(id));
            const c = data.profiles[id]?.color;
            if (/^#[0-9a-f]{6}$/i.test(c || '')) n.style.color = c;
            return h('span', { class: 'member' }, n,
              h('button', { 'aria-label': `Remove ${nameOf(id)} from ${r.name}`, title: 'Remove', onClick: () => run(() => setRoles(id, data.memberRoles[id].filter((x) => x !== r.id))) }, '×'));
          }),
          candidates.length > 0 && [picker, add]));
    }

    const render = () => h('div', {},
      defaultsCard(),
      data.roles.length ? h('div', { class: 'rolelist' }, data.roles.map(roleCard)) : h('p', { class: 'muted' }, 'No roles yet.'));

    const refresh = async () => {
      try { data = await api.get('roles'); showBanner(); box.replaceChildren(render()); } catch { /* keep what is shown */ }
    };

    const banner = h('div', { class: 'note', role: 'note' });
    const showBanner = () => {
      banner.hidden = !data || data.permissionsOn;
      banner.replaceChildren(h('strong', {}, 'Open: '), 'everyone can do everything, as before. Permissions start applying once someone holds a role with Administrator. Until then the app can’t edit roles; set them up here.');
    };

    const name = h('input', { id: 'newrole', maxlength: 32, required: true, autocomplete: 'off' });
    const color = h('input', { type: 'color', value: DEFAULT_COLOR, 'aria-label': 'Color' });
    const formErr = h('div', { class: 'error-text small', role: 'alert' });
    const form = h('form', { class: 'rolenew', onSubmit: async (e) => {
      e.preventDefault();
      formErr.textContent = '';
      try {
        await api.post('roles', { name: name.value.trim(), color: color.value });
        name.value = '';
        refresh();
      } catch (err) { formErr.textContent = err.message; }
    } },
      h('div', { class: 'field' }, h('label', { for: 'newrole' }, 'New role name (up to 32 characters)'), name),
      h('div', { class: 'field' }, h('label', {}, 'Color'), color),
      h('button', { type: 'submit', class: 'btn' }, 'New role'));

    root.append(
      banner, form, formErr, box);
    load(box, async () => (data = await api.get('roles')), (d) => (showBanner(), render(d)));
    return events.on('change', (e) => { if (e.topic === 'state') refresh(); });
  },
};
