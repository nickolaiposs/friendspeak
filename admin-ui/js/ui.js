import { h } from './util.js';

export const loadingState = (text = 'Loading…') => h('div', { class: 'state', role: 'status' }, text);

export const errorState = (err, retry) =>
  h('div', { class: 'state', role: 'alert' },
    h('div', { class: 'error-text' }, err.message || 'Something went wrong'),
    retry && h('button', { class: 'btn small ghost', onClick: retry }, 'Retry'));

// Replaces the children of `box` with a loading state, then with render(data) or an error with Retry.
export async function load(box, fetcher, render) {
  box.replaceChildren(loadingState());
  try {
    const data = await fetcher();
    box.replaceChildren(render(data));
  } catch (err) {
    box.replaceChildren(errorState(err, () => load(box, fetcher, render)));
  }
}

export async function copyText(text, fallbackEl) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const sel = getSelection();
    const r = document.createRange();
    r.selectNodeContents(fallbackEl);
    sel.removeAllRanges();
    sel.addRange(r);
    return false;
  }
}

// ---------------------------------------------------------------- dialogs

const openDialogs = new Set();
export const closeAllDialogs = () => [...openDialogs].forEach((d) => d.close());

// A modal <dialog> with custom content. Resolves true after Confirm (once onConfirm, if given,
// succeeds; if it throws, the message is shown in the dialog and it stays open), false otherwise.
export function showDialog({ title, content, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false, onConfirm }) {
  return new Promise((resolve) => {
    let result = false;
    const err = h('div', { class: 'error-text small', role: 'alert' });
    const ok = h('button', { type: 'submit', class: danger ? 'btn danger' : 'btn' }, confirmLabel);
    const dlg = h('dialog', { class: 'dlg' },
      h('form', { method: 'dialog', onSubmit: async (e) => {
        e.preventDefault();
        ok.disabled = true;
        err.textContent = '';
        try {
          await onConfirm?.();
          result = true;
          dlg.close();
        } catch (ex) {
          err.textContent = ex.message || 'Something went wrong';
          ok.disabled = false;
        }
      } },
        h('h2', {}, title),
        h('div', { class: 'dlg-body' }, content),
        err,
        h('div', { class: 'row dlg-actions' },
          cancelLabel && h('button', { type: 'button', class: 'btn ghost', onClick: () => dlg.close() }, cancelLabel),
          ok)));
    dlg.addEventListener('close', () => { openDialogs.delete(dlg); dlg.remove(); resolve(result); });
    openDialogs.add(dlg);
    document.body.append(dlg);
    dlg.showModal();
    (dlg.querySelector('input, select') || cancelLabel && dlg.querySelector('.ghost') || ok).focus();
  });
}

export const confirmDialog = ({ title, body, confirmLabel = 'Confirm', danger = false }) =>
  showDialog({ title, content: h('p', {}, body), confirmLabel, danger });

export const alertDialog = (title, body) => showDialog({ title, content: h('p', {}, body), cancelLabel: null });

// ---------------------------------------------------------------- roles

// Colored pill; the color is data, so it is applied with el.style (CSSOM)
export function roleTag(role) {
  const el = h('span', { class: 'roletag', title: role.name }, role.name);
  // pulled toward the page's text color, so a dark role stays readable on the dark theme
  el.style.color = `color-mix(in srgb, ${role.color} 72%, var(--text))`;
  el.style.background = `color-mix(in srgb, ${role.color} 14%, transparent)`;
  el.style.borderColor = `color-mix(in srgb, ${role.color} 40%, transparent)`;
  return el;
}

export const roleTags = (ids, roles) => {
  const byId = new Map(roles.map((r) => [r.id, r]));
  return (ids || []).map((id) => byId.get(id)).filter(Boolean).map(roleTag);
};

// A profile id that copies on click
export function idChip(id) {
  const btn = h('button', { type: 'button', class: 'idchip mono', title: `${id} (click to copy)`, onClick: async () => {
    const ok = await copyText(id, btn);
    btn.textContent = ok ? 'copied' : id;
    setTimeout(() => (btn.textContent = id.slice(0, 8) + (id.length > 8 ? '…' : '')), 1200);
  } }, id.slice(0, 8) + (id.length > 8 ? '…' : ''));
  return btn;
}
