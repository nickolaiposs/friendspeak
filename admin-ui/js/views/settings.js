import { h, fileToDataUrl, debounce } from '../util.js';
import { load } from '../ui.js';

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
      const gif = d.giphy || {};
      const giphyKey = h('input', { id: 'sgiphy', type: 'password', maxlength: 100, autocomplete: 'off', spellcheck: 'false', placeholder: gif.set ? 'paste a new key to replace it' : 'paste key' });
      const setKey = async (key, done) => {
        out.textContent = '';
        try { await api.put('server/giphy', { key }); ok(done); await refresh(true); } catch (e) { bad(e.message); }
      };
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
          h('div', { class: 'field' }, h('label', { for: 'squality' }, 'Voice quality'), quality)),
        h('form', { class: 'card stack', onSubmit: (e) => { e.preventDefault(); if (giphyKey.value.trim()) setKey(giphyKey.value.trim(), 'GIPHY key saved.'); } },
          h('div', { class: 'field' }, h('label', { for: 'sgiphy' }, 'GIPHY API key'),
            h('div', { class: 'row' }, h('div', { class: 'grow' }, giphyKey), h('button', { type: 'submit', class: 'btn' }, 'Save'),
              gif.source === 'dashboard' && h('button', { type: 'button', class: 'btn danger small', onClick: () => setKey('', 'GIPHY key removed.') }, 'Remove'))),
          h('span', { class: 'small muted' },
            gif.source === 'dashboard' ? 'A key is set. ' : gif.source === 'env' ? 'Using the key from GIPHY_API_KEY. A key saved here replaces it. ' : 'No key set: members can only search GIFs with a key of their own. ',
            'Everyone on the server searches GIFs with this key unless they set their own. Get a free one at ',
            h('a', { href: 'https://developers.giphy.com/dashboard/', target: '_blank', rel: 'noopener noreferrer' }, 'developers.giphy.com'), '.')),
        h('div', { class: 'card stack' },
          h('label', { class: 'row', for: 'sgame' }, toggle, 'Penguin game'),
          !g.available && h('span', { class: 'small muted' }, g.reason || 'Not available on this server.')),
        out);
    }

    async function refresh(force) {
      // don't rebuild the form while someone is typing in it
      if (!force && box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' && document.activeElement.type !== 'checkbox') return;
      try { data = await api.get('server'); box.replaceChildren(render()); } catch { /* keep */ }
    }
    root.append(box);
    load(box, async () => (data = await api.get('server')), render);
    const d = debounce(() => refresh(false), 400);
    const off = events.on('change', (e) => { if (e.topic === 'state') d(); });
    return off;
  },
};
