import { h } from '../util.js';
import { loadingState, errorState } from '../ui.js';

const MAX_ROWS = 5000;
const LEVELS = ['debug', 'info', 'warn', 'error'];
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour12: false });

export default {
  id: 'log',
  title: 'Server log',
  fill: true,
  mount(root, { api, events }) {
    let entries = []; // { line, el }
    let more = false;
    let follow = true;
    let source = '*';
    let query = '';
    const levels = new Set(['info', 'warn', 'error']);
    const sources = new Set();

    const box = h('div', { class: 'logbox', role: 'log', 'aria-label': 'Server log', tabindex: '0' });
    const olderBtn = h('button', { class: 'btn small ghost', onClick: () => loadOlder() }, 'Load older');
    const older = h('div', { class: 'logmore', hidden: true }, olderBtn);
    const rows = h('div', {});
    const status = h('div', {});
    box.append(older, rows);

    const sourceSel = h('select', { 'aria-label': 'Source', onChange: () => { source = sourceSel.value; renderAll(); } });
    const followBox = h('input', { type: 'checkbox', checked: true, onChange: () => { follow = followBox.checked; if (follow) toBottom(); } });
    const search = h('input', { type: 'search', placeholder: 'Filter text', 'aria-label': 'Filter text', onInput: () => { query = search.value.toLowerCase(); renderAll(); } });

    const buildSources = () => {
      sourceSel.replaceChildren(h('option', { value: '*' }, 'All sources'), h('option', { value: '' }, '(no tag)'),
        [...sources].sort().map((s) => h('option', { value: s }, s)));
      sourceSel.value = source;
    };
    const noteSource = (s) => {
      if (s && !sources.has(s)) { sources.add(s); buildSources(); }
    };

    const matches = (l) =>
      levels.has(l.level) && (source === '*' || l.source === source) && (!query || l.text.toLowerCase().includes(query));
    const rowEl = (l) => h('div', { class: `logrow ${l.level}` },
      h('span', { class: 't' }, clock(l.ts)), h('span', { class: `lv ${l.level}` }, l.level), h('span', { class: 'tx' }, l.text));

    const toBottom = () => { box.scrollTop = box.scrollHeight; };
    const bar = h('div', { class: 'logbar' },
      LEVELS.map((lv) => h('label', {}, h('input', { type: 'checkbox', checked: levels.has(lv), onChange: (e) => { e.target.checked ? levels.add(lv) : levels.delete(lv); renderAll(); } }), lv)),
      sourceSel, search,
      h('label', {}, followBox, 'Follow'),
      h('button', { class: 'btn small ghost', onClick: () => { entries = []; renderAll(); } }, 'Clear view'));
    buildSources();

    function renderAll(keepScroll) {
      const prevHeight = box.scrollHeight;
      for (const e of entries) e.el = matches(e.line) ? rowEl(e.line) : null;
      rows.replaceChildren(...entries.filter((e) => e.el).map((e) => e.el));
      older.hidden = !more;
      if (keepScroll) box.scrollTop += box.scrollHeight - prevHeight;
      else if (follow) toBottom();
    }

    function append(l) {
      noteSource(l.source);
      const e = { line: l, el: matches(l) ? rowEl(l) : null };
      entries.push(e);
      lastId = Math.max(lastId, l.id);
      if (e.el) rows.append(e.el);
      while (entries.length > MAX_ROWS) {
        const d = entries.shift();
        d.el?.remove();
        more = true;
        older.hidden = false;
      }
      if (follow) toBottom();
    }

    box.addEventListener('scroll', () => {
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 8;
      if (atBottom !== follow) { follow = atBottom; followBox.checked = follow; }
    });

    let loadingOlder = false;
    async function loadOlder() {
      if (loadingOlder || !entries.length) return;
      loadingOlder = true;
      olderBtn.disabled = true;
      try {
        const r = await api.get(`logs?before=${entries[0].line.id}`);
        more = r.more;
        r.lines.forEach((l) => noteSource(l.source));
        entries = r.lines.map((line) => ({ line, el: null })).concat(entries);
        renderAll(true);
      } catch (err) {
        status.replaceChildren(errorState(err, () => { status.replaceChildren(); loadOlder(); }));
      }
      loadingOlder = false;
      olderBtn.disabled = false;
    }

    let gone = false;
    const seen = new Set();
    let ready = false;
    let lastId = 0; // newest id seen, survives Clear view
    const pending = [];
    // live lines that arrive while the first page loads are merged afterwards
    const off = events.on('log', (l) => {
      if (!ready) return pending.push(l);
      // a replay after reconnect can repeat lines we already hold
      const last = entries.at(-1)?.line.id ?? lastId;
      if (l.id > last) append(l);
    });

    async function init() {
      status.replaceChildren(loadingState());
      try {
        const r = await api.get('logs?limit=500');
        if (gone) return;
        status.replaceChildren();
        more = r.more;
        entries = [];
        r.lines.forEach((l) => { seen.add(l.id); noteSource(l.source); entries.push({ line: l, el: null }); });
        for (const l of pending) if (!seen.has(l.id)) { noteSource(l.source); entries.push({ line: l, el: null }); }
        lastId = Math.max(0, ...entries.map((e) => e.line.id));
        pending.length = 0;
        ready = true;
        renderAll();
        if (follow) toBottom();
      } catch (err) {
        if (!gone) status.replaceChildren(errorState(err, init));
      }
    }

    root.append(bar, status, box);
    init();
    return () => { gone = true; off(); };
  },
};
