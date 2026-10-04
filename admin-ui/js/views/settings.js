import { h, fileToDataUrl, debounce, fmtTime, inviteInfo, inviteStatus, INVITE_TYPES, INVITE_DURATIONS } from '../util.js';
import { load, copyText, confirmDialog, alertDialog } from '../ui.js';

// A new invite's token: shown once, with buttons to copy it
function tokenBox(token, onDone) {
  const val = h('div', { class: 'secret' }, token);
  const copier = (label, text) => {
    const b = h('button', { type: 'button', class: 'btn small', onClick: async () => {
      b.textContent = (await copyText(text, val)) ? 'Copied' : 'Press Ctrl+C to copy';
    } }, label);
    return b;
  };
  return h('div', { class: 'secret-box', role: 'status' },
    h('strong', {}, 'New invite'),
    val,
    h('div', { class: 'small' }, 'Copy it now. Only a hash of it is kept, so it cannot be shown again. Friends enter it in the app under "Connect to a server".'),
    h('div', { class: 'row' }, copier('Copy invite', token), h('button', { type: 'button', class: 'btn small ghost', onClick: onDone }, 'Done')));
}

const QUALITIES = { max: 'Highest (510 kbps)', high: 'High (128 kbps)', standard: 'Standard (64 kbps)', low: 'Low (32 kbps)' };

export default {
  id: 'settings',
  title: 'Server settings',
  mount(root, { api, events }) {
    const box = h('div', {});
    const out = h('div', { role: 'status', class: 'small' });
    let data = null;
    const ok = (t) => { out.className = 'small msg-ok'; out.textContent = t; };
    const bad = (t) => { out.className = 'small error-text'; out.textContent = t; };

    const patch = async (body, done) => {
      out.textContent = '';
      try { await api.patch('server', body); ok(done); await refresh(true); } catch (e) { bad(e.message); }
    };

    function render() {
      const d = data;
      const name = h('input', { id: 'sname', maxlength: 40, value: d.name, autocomplete: 'off' });
      const preview = d.icon && /^(data:image\/|https:\/\/)/.test(d.icon)
        ? h('img', { class: 'icon-preview', src: d.icon, alt: 'Server icon', referrerpolicy: 'no-referrer' })
        : h('div', { class: 'icon-preview', 'aria-hidden': 'true' }, (d.name || '?').slice(0, 1).toUpperCase());
      const file = h('input', { type: 'file', accept: 'image/*', class: 'sr', hidden: true, onChange: async () => {
        const f = file.files[0];
        if (!f) return;
        try { await patch({ icon: await fileToDataUrl(f, { max: 256, maxBytes: 512 * 1024 }) }, 'Icon updated.'); } catch (e) { bad(e.message); }
        file.value = '';
      } });
      const link = h('input', { id: 'slink', type: 'url', placeholder: 'https://example.com/icon.png', autocomplete: 'off' });
      const g = d.game || {};
      const toggle = h('input', { id: 'sgame', type: 'checkbox', checked: !!g.enabled, disabled: !g.available, onChange: () => patch({ game: toggle.checked }, toggle.checked ? 'Game turned on.' : 'Game turned off.') });
      const quality = h('select', { id: 'squality', onChange: () => patch({ audioQuality: quality.value }, 'Voice quality saved.') },
        Object.entries(QUALITIES).map(([k, label]) => h('option', { value: k, selected: k === (QUALITIES[d.audioQuality] ? d.audioQuality : 'max') }, label)));
      const inviteOnly = h('input', { id: 'sinvite', type: 'checkbox', checked: d.inviteOnly !== false, onChange: () => patch({ inviteOnly: inviteOnly.checked }, inviteOnly.checked ? 'Joining now needs an invite.' : 'Anyone with the address can join now.') });
      return h('div', { class: 'stack' },
        h('form', { class: 'card stack', onSubmit: (e) => { e.preventDefault(); patch({ name: name.value.trim() }, 'Name saved.'); } },
          h('div', { class: 'field' }, h('label', { for: 'sname' }, 'Server name'), name),
          h('div', {}, h('button', { type: 'submit', class: 'btn' }, 'Save'))),
        h('div', { class: 'card stack' },
          h('div', { class: 'row' }, preview,
            h('div', { class: 'row' },
              h('button', { type: 'button', class: 'btn ghost', onClick: () => file.click() }, 'Upload image…'), file,
              d.icon && h('button', { type: 'button', class: 'btn danger small', onClick: () => patch({ icon: '' }, 'Icon removed.') }, 'Remove'))),
          h('form', { class: 'field', onSubmit: (e) => { e.preventDefault(); if (link.value.trim()) patch({ icon: link.value.trim() }, 'Icon updated.'); } },
            h('label', { for: 'slink' }, 'Or an https:// image link'), h('div', { class: 'row' }, h('div', { class: 'grow' }, link), h('button', { type: 'submit', class: 'btn ghost' }, 'Use link')))),
        h('div', { class: 'card stack' },
          h('div', { class: 'field' }, h('label', { for: 'squality' }, 'Voice quality'), quality),
          h('span', { class: 'small muted' }, 'The bitrate everyone sends their voice at in the voice channels. Each person sends to every other person in a channel.')),
        h('div', { class: 'card stack' },
          h('label', { class: 'row', for: 'sgame' }, toggle, 'Penguin game'),
          !g.available && h('span', { class: 'small muted' }, g.reason || 'Not available on this server.')),
        h('div', { class: 'card stack' },
          h('label', { class: 'row', for: 'sinvite' }, inviteOnly, 'Require an invite to join'),
          h('span', { class: 'small muted' }, 'Off: anyone who knows the address can join. People already on the server never need an invite to come back.')),
        out,
        h('p', { class: 'small muted' }, 'These are the same settings anyone can change in the app under Server settings. Requiring invites takes an administrator there.'));
    }

    // ---------- invites ----------

    const tokenSlot = h('div', {});
    const invErr = h('div', { class: 'error-text small', role: 'alert' });
    const invBox = h('div', {});
    const note = h('input', { id: 'invnote', maxlength: 40, autocomplete: 'off', placeholder: 'Who it is for (optional)' });
    const type = h('select', { id: 'invtype' }, INVITE_TYPES.map(([k, label]) => h('option', { value: k }, label)));
    const uses = h('input', { id: 'invuses', type: 'number', min: 2, max: 10000, value: 5 });
    const lasts = h('select', { id: 'invlasts' }, INVITE_DURATIONS.map(([ms, label]) => h('option', { value: ms, selected: ms === 864e5 }, label)));
    const usesField = h('div', { class: 'field narrow', hidden: true }, h('label', { for: 'invuses' }, 'Uses'), uses);
    const lastsField = h('div', { class: 'field narrow', hidden: true }, h('label', { for: 'invlasts' }, 'Lasts'), lasts);
    type.addEventListener('change', () => { usesField.hidden = type.value !== 'multi'; lastsField.hidden = type.value !== 'timed'; });
    const make = h('button', { type: 'submit', class: 'btn' }, 'New invite');

    const removeInvite = async (v) => {
      const active = inviteStatus(v) === 'active';
      if (active && !(await confirmDialog({ title: 'Revoke this invite?', body: 'Nobody can join with it any more. People who already joined with it stay.', confirmLabel: 'Revoke', danger: true }))) return;
      try { await api.del('invites/' + encodeURIComponent(v.id)); } catch (e) { alertDialog(active ? 'Could not revoke' : 'Could not remove', e.message); }
      refreshInvites();
    };
    const joined = (v) => (v.joins.length
      ? h('details', {}, h('summary', {}, `${v.uses} joined`), h('ul', { class: 'joins' }, v.joins.map((j) => h('li', {}, j.name, h('span', { class: 'muted small' }, ` ${fmtTime(j.ts)}`))), v.uses > v.joins.length && h('li', { class: 'muted small' }, `and ${v.uses - v.joins.length} earlier`)))
      : h('span', { class: 'muted' }, 'Nobody yet'));
    const invTable = ({ invites }) => (invites.length
      ? h('div', { class: 'tablewrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Note', 'Created by', 'Type', 'Uses', 'Time left', 'Status', 'Who joined', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, [...invites].reverse().map((v) => {
          const i = inviteInfo(v);
          const active = i.status === 'Active';
          return h('tr', {},
            h('td', {}, v.label || h('span', { class: 'muted' }, 'none')),
            h('td', {}, v.by.name, h('div', { class: 'muted small nowrap' }, fmtTime(v.ts))),
            h('td', { class: 'nowrap' }, i.type),
            h('td', { class: 'nowrap' }, i.uses),
            h('td', { class: 'nowrap', title: v.expires ? new Date(v.expires).toLocaleString() : null }, i.left),
            h('td', {}, h('span', { class: 'badge ' + (active ? 'good' : 'warn'), title: v.revoked ? `by ${v.revoked.by}, ${fmtTime(v.revoked.ts)}` : null }, i.status)),
            h('td', {}, joined(v)),
            h('td', {}, h('button', { class: 'btn small ' + (active ? 'danger' : 'ghost'), onClick: () => removeInvite(v) }, active ? 'Revoke' : 'Remove')));
        }))))
      : h('div', { class: 'state' }, 'No invites.'));
    const fetchInvites = () => api.get('invites');
    const refreshInvites = () => fetchInvites().then((r) => invBox.replaceChildren(invTable(r))).catch(() => {});

    const invForm = h('form', { class: 'newkey', onSubmit: async (e) => {
      e.preventDefault();
      make.disabled = true;
      invErr.textContent = '';
      try {
        const body = { label: note.value.trim() };
        if (type.value === 'single') body.maxUses = 1;
        if (type.value === 'multi') body.maxUses = Math.round(Number(uses.value));
        if (type.value === 'timed') body.expiresIn = Number(lasts.value);
        const r = await api.post('invites', body);
        note.value = '';
        tokenSlot.replaceChildren(tokenBox(r.token, () => tokenSlot.replaceChildren()));
        refreshInvites();
      } catch (err) {
        invErr.textContent = err.message;
      }
      make.disabled = false;
    } },
      h('div', { class: 'field' }, h('label', { for: 'invnote' }, 'Note'), note),
      h('div', { class: 'field narrow' }, h('label', { for: 'invtype' }, 'Type'), type),
      usesField, lastsField, make);

    async function refresh(force) {
      // don't rebuild the form while someone is typing in it
      if (!force && box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' && document.activeElement.type !== 'checkbox') return;
      try { data = await api.get('server'); box.replaceChildren(render()); } catch { /* keep */ }
    }
    root.append(box,
      h('h2', {}, 'Invites'),
      h('p', { class: 'prose' }, 'An invite is a token someone enters once to join. After that the server knows them by their profile key. Each invite records who made it and who joined with it. In the app, people with the "Create invites" permission can make and see them.'),
      tokenSlot, invForm, invErr, invBox);
    load(box, async () => (data = await api.get('server')), render);
    load(invBox, fetchInvites, invTable);
    // every state change redraws the table (uses and time left); the token box and the forms are left alone
    const d = debounce(() => { refresh(false); refreshInvites(); }, 400);
    const tick = setInterval(refreshInvites, 60e3);
    const off = events.on('change', (e) => { if (e.topic === 'state') d(); });
    return () => { off(); clearInterval(tick); tokenSlot.replaceChildren(); };
  },
};
