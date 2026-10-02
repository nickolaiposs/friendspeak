import { h } from '../util.js';
import { load, showDialog, confirmDialog, alertDialog } from '../ui.js';

const DEFAULT_COLOR = '#8b6cf6';

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
      data.roles.length ? h('div', { class: 'rolelist' }, data.roles.map(roleCard)) : h('p', { class: 'muted' }, 'No roles yet.'));

    const refresh = async () => {
      try { data = await api.get('roles'); box.replaceChildren(render()); } catch { /* keep what is shown */ }
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
      h('div', { class: 'note', role: 'note' }, h('strong', {}, 'Roles are labels only. '),
        'They show next to a name in the app and grant nothing. They are attached to profile IDs, which can be copied, so don’t treat them as a security feature.'),
      form, formErr, box);
    load(box, async () => (data = await api.get('roles')), render);
    return events.on('change', (e) => { if (e.topic === 'state') refresh(); });
  },
};
