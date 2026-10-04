import { h, fmtTime } from '../util.js';
import { load, copyText, confirmDialog, alertDialog } from '../ui.js';

function secretBox(secret, onDone) {
  const val = h('div', { class: 'secret' }, secret);
  const copy = h('button', { class: 'btn small', onClick: async () => {
    const ok = await copyText(secret, val);
    copy.textContent = ok ? 'Copied' : 'Press Ctrl+C to copy';
  } }, 'Copy');
  return h('div', { class: 'secret-box', role: 'status' },
    h('strong', {}, 'New admin key'),
    val,
    h('div', { class: 'small' }, 'Copy it now. It cannot be shown again.'),
    h('div', { class: 'row' }, copy, h('button', { class: 'btn small ghost', onClick: onDone }, 'Done')));
}

function badges(k, mfa) {
  return [
    mfa && (k.mfa ? h('span', { class: 'badge good' }, '2-step') : h('span', { class: 'badge warn', title: 'Set up the next time this key signs in' }, '2-step not set up')),
    k.env && h('span', { class: 'badge accent' }, 'env'),
    k.bootstrap && h('span', { class: 'badge' }, 'first-boot'),
    k.active === false && h('span', { class: 'badge warn' }, 'inactive'),
    k.current && h('span', { class: 'badge good' }, 'this session'),
  ];
}

export default {
  id: 'keys',
  title: 'Admin keys',
  mount(root, { api, events }) {
    const secretSlot = h('div', {});
    const formErr = h('div', { class: 'error-text small', role: 'alert' });
    const box = h('div', {});
    const name = h('input', { id: 'keyname', maxlength: 40, required: true, autocomplete: 'off' });
    const add = h('button', { type: 'submit', class: 'btn' }, 'New key');

    const revoke = async (k) => {
      const warn = k.current ? ' This is the key you are signed in with, so you will be signed out.' : '';
      const ok = await confirmDialog({ title: `Revoke "${k.name}"?`, body: `Sessions using this key end at once.${warn}`, confirmLabel: 'Revoke', danger: true });
      if (!ok) return;
      try { await api.del('keys/' + encodeURIComponent(k.id)); } catch (err) { alertDialog('Could not revoke', err.message); }
      refresh();
    };

    const resetMfa = async (k) => {
      const ok = await confirmDialog({ title: `Reset 2-step sign-in for "${k.name}"?`, body: 'For a lost or replaced phone. The authenticator app’s codes for this key stop working, and the key sets up a new one the next time it signs in. Until then the key alone is enough to do that.', confirmLabel: 'Reset', danger: true });
      if (!ok) return;
      try { await api.post(`keys/${encodeURIComponent(k.id)}/mfa/reset`); } catch (err) { alertDialog('Could not reset', err.message); }
      refresh();
    };

    const table = ({ keys, mfa }) => h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Name', 'Created', 'Last used', 'Status', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, keys.map((k) => h('tr', {},
        h('td', {}, k.name),
        h('td', { class: 'nowrap' }, fmtTime(k.created)),
        h('td', { class: 'nowrap' }, k.lastUsed ? fmtTime(k.lastUsed) : 'never'),
        h('td', {}, badges(k, mfa)),
        h('td', { class: 'nowrap' }, k.mfa && [h('button', { class: 'btn small ghost', onClick: () => resetMfa(k) }, 'Reset 2-step'), ' '], h('button', { class: 'btn small danger', disabled: k.env, title: k.env ? 'Set from ADMIN_KEY; remove it there' : null, onClick: () => revoke(k) }, 'Revoke')))))));

    const fetcher = () => api.get('keys');
    const refresh = () => load(box, fetcher, table);

    const form = h('form', { class: 'newkey', onSubmit: async (e) => {
      e.preventDefault();
      const n = name.value.trim();
      if (!n) return;
      add.disabled = true;
      formErr.textContent = '';
      try {
        const r = await api.post('keys', { name: n });
        name.value = '';
        secretSlot.replaceChildren(secretBox(r.secret, () => secretSlot.replaceChildren()));
        refresh();
      } catch (err) {
        formErr.textContent = err.message;
      }
      add.disabled = false;
    } },
      h('div', { class: 'field' }, h('label', { for: 'keyname' }, 'Name (1 to 40 characters)'), name),
      add);

    root.append(
      h('p', { class: 'prose' }, 'Admin keys are separate from the invites people join with. Give each admin their own key so one can be revoked without affecting the others. The first time a key signs in it sets up 2-step sign-in with an authenticator app, and needs that app’s code from then on (unless the server runs with ', h('code', {}, 'ADMIN_MFA=off'), '). If you lose every key, set ', h('code', {}, 'ADMIN_KEY'), ' or delete ', h('code', {}, 'admin.json'), ' in the data folder and restart the server.'),
      secretSlot, form, formErr, h('h2', {}, 'Keys'), box);
    refresh();

    // keep the table fresh quietly; the secret box is untouched
    const off = events.on('change', (e) => {
      if (e.topic !== 'keys') return;
      fetcher().then((d) => box.replaceChildren(table(d))).catch(() => {});
    });
    return () => { off(); secretSlot.replaceChildren(); };
  },
};
