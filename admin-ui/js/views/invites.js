import { h, debounce, fmtTime, inviteInfo, inviteStatus, INVITE_TYPES, INVITE_DURATIONS } from '../util.js';
import { load, copyText, confirmDialog, alertDialog } from '../ui.js';

// Invites (D51): the tokens people join with. The dashboard sees every working one and can copy it again.
export default {
  id: 'invites',
  title: 'Invites',
  mount(root, { api, events }) {
    const out = h('div', { role: 'status', class: 'small' });
    const err = h('div', { class: 'error-text small', role: 'alert' });
    const box = h('div', {});
    const required = h('input', { id: 'invreq', type: 'checkbox', checked: true, onChange: async () => {
      out.textContent = '';
      try {
        await api.patch('server', { inviteOnly: required.checked });
        out.className = 'small msg-ok';
        out.textContent = required.checked ? 'Joining now needs an invite.' : 'Anyone with the address can join now.';
      } catch (e) {
        out.className = 'small error-text';
        out.textContent = e.message;
        refresh();
      }
    } });
    const note = h('input', { id: 'invnote', maxlength: 40, autocomplete: 'off', placeholder: 'Who it is for (optional)' });
    const type = h('select', { id: 'invtype' }, INVITE_TYPES.map(([k, label]) => h('option', { value: k }, label)));
    const uses = h('input', { id: 'invuses', type: 'number', min: 2, max: 10000, value: 5 });
    const lasts = h('select', { id: 'invlasts' }, INVITE_DURATIONS.map(([ms, label]) => h('option', { value: ms, selected: ms === 864e5 }, label)));
    const usesField = h('div', { class: 'field narrow', hidden: true }, h('label', { for: 'invuses' }, 'Uses'), uses);
    const lastsField = h('div', { class: 'field narrow', hidden: true }, h('label', { for: 'invlasts' }, 'Lasts'), lasts);
    type.addEventListener('change', () => { usesField.hidden = type.value !== 'multi'; lastsField.hidden = type.value !== 'timed'; });
    const make = h('button', { type: 'submit', class: 'btn' }, 'New invite');

    const remove = async (v) => {
      const active = inviteStatus(v) === 'active';
      if (active && !(await confirmDialog({ title: 'Revoke this invite?', body: 'Nobody can join with it any more. People who already joined with it stay.', confirmLabel: 'Revoke', danger: true }))) return;
      try { await api.del('invites/' + encodeURIComponent(v.id)); } catch (e) { alertDialog(active ? 'Could not revoke' : 'Could not remove', e.message); }
      refresh();
    };
    // A working invite's token, with a button to copy it. Invites that no longer work have none,
    // nor do ones made when the server kept only a hash.
    const tokenCell = (v) => {
      if (!v.token) return h('span', { class: 'muted' }, inviteStatus(v) === 'active' ? 'Not kept' : '');
      const val = h('code', {}, v.token);
      const b = h('button', { type: 'button', class: 'btn small', onClick: async () => {
        b.textContent = (await copyText(v.token, val)) ? 'Copied' : 'Press Ctrl+C to copy';
      } }, 'Copy');
      return h('div', { class: 'invite-cell' }, val, b);
    };
    const joined = (v) => (v.joins.length
      ? h('details', {}, h('summary', {}, `${v.uses} joined`), h('ul', { class: 'joins' }, v.joins.map((j) => h('li', {}, j.name, h('span', { class: 'muted small' }, ` ${fmtTime(j.ts)}`))), v.uses > v.joins.length && h('li', { class: 'muted small' }, `and ${v.uses - v.joins.length} earlier`)))
      : h('span', { class: 'muted' }, 'Nobody yet'));
    const table = ({ invites, inviteOnly }) => {
      required.checked = inviteOnly !== false;
      return invites.length
        ? h('div', { class: 'tablewrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['Invite', 'Note', 'Created by', 'Type', 'Uses', 'Time left', 'Status', 'Who joined', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, [...invites].reverse().map((v) => {
            const i = inviteInfo(v);
            const active = i.status === 'Active';
            return h('tr', {},
              h('td', {}, tokenCell(v)),
              h('td', {}, v.label || h('span', { class: 'muted' }, 'none')),
              h('td', {}, v.by.name, h('div', { class: 'muted small nowrap' }, fmtTime(v.ts))),
              h('td', { class: 'nowrap' }, i.type),
              h('td', { class: 'nowrap' }, i.uses),
              h('td', { class: 'nowrap', title: v.expires ? new Date(v.expires).toLocaleString() : null }, i.left),
              h('td', {}, h('span', { class: 'badge ' + (active ? 'good' : 'warn'), title: v.revoked ? `by ${v.revoked.by}, ${fmtTime(v.revoked.ts)}` : null }, i.status)),
              h('td', {}, joined(v)),
              h('td', {}, h('button', { class: 'btn small ' + (active ? 'danger' : 'ghost'), onClick: () => remove(v) }, active ? 'Revoke' : 'Remove')));
          }))))
        : h('div', { class: 'state' }, 'No invites.');
    };
    const fetchInvites = () => api.get('invites');
    const refresh = () => fetchInvites().then((r) => box.replaceChildren(table(r))).catch(() => {});

    const form = h('form', { class: 'newkey', onSubmit: async (e) => {
      e.preventDefault();
      make.disabled = true;
      err.textContent = '';
      try {
        const body = { label: note.value.trim() };
        if (type.value === 'single') body.maxUses = 1;
        if (type.value === 'multi') body.maxUses = Math.round(Number(uses.value));
        if (type.value === 'timed') body.expiresIn = Number(lasts.value);
        await api.post('invites', body);
        note.value = '';
        refresh();
      } catch (e2) {
        err.textContent = e2.message;
      }
      make.disabled = false;
    } },
      h('div', { class: 'field' }, h('label', { for: 'invnote' }, 'Note'), note),
      h('div', { class: 'field narrow' }, h('label', { for: 'invtype' }, 'Type'), type),
      usesField, lastsField, make);

    root.append(
      h('p', { class: 'prose' }, 'An invite is a token someone enters once to join, in the app under "Connect to a server". After that the server knows them by their profile key. Working invites can be copied again here and by administrators in the app; each records who made it and who joined with it.'),
      h('div', { class: 'card stack' },
        h('label', { class: 'row', for: 'invreq' }, required, 'Require an invite to join'),
        h('span', { class: 'small muted' }, 'Off: anyone who knows the address can join. People already on the server never need an invite to come back.'),
        out),
      h('h2', {}, 'New invite'),
      form, err,
      h('h2', {}, 'This server’s invites'),
      box);
    load(box, fetchInvites, table);
    // every state change redraws the table (uses and time left); the form is left alone
    const d = debounce(refresh, 400);
    const tick = setInterval(refresh, 60e3);
    const off = events.on('change', (e) => { if (e.topic === 'state') d(); });
    return () => { off(); clearInterval(tick); };
  },
};
