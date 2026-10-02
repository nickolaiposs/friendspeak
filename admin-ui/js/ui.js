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
