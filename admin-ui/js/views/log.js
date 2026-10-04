import { h, fmtBytes, debounce } from '../util.js';
import { loadingState, errorState } from '../ui.js';

const MAX_ROWS = 5000;
const LEVELS = ['debug', 'info', 'warn', 'error'];
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour12: false });
const stamp = (ts) => (new Date(ts).toDateString() === new Date().toDateString() ? clock(ts)
  : `${new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock(ts)}`);
const day = (ts) => new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
const localInput = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16);

// Matches of `query` get a <mark>; built from text nodes only, since log text is hostile
function highlight(text, query) {
  if (!query) return text;
  const lower = text.toLowerCase(), out = [];
  let i = 0, j;
  while ((j = lower.indexOf(query, i)) >= 0) {
    out.push(text.slice(i, j), h('mark', {}, text.slice(j, j + query.length)));
    i = j + query.length;
  }
  out.push(text.slice(i));
  return out;
}

export const logRow = (l, query = '') => h('div', { class: `logrow ${l.level}` },
  h('span', { class: 't', title: new Date(l.ts).toLocaleString() }, stamp(l.ts)),
  h('span', { class: `lv ${l.level}` }, l.level), h('span', { class: 'tx' }, highlight(l.text, query)));

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
    let seq = 0; // newest request; older answers are dropped
    const levels = new Set(['info', 'warn', 'error']);
    const sources = new Set();

    const box = h('div', { class: 'logbox', role: 'log', 'aria-label': 'Server log', tabindex: '0' });
    const olderBtn = h('button', { class: 'btn small ghost', onClick: () => loadOlder() }, 'Load older');
    const older = h('div', { class: 'logmore', hidden: true }, olderBtn);
    const rows = h('div', {});
    const empty = h('div', { class: 'logmore muted', hidden: true }, 'No lines match.');
    const status = h('div', {});
    const info = h('div', { class: 'muted small loginfo' });
    box.append(older, rows, empty);

    const sourceSel = h('select', { 'aria-label': 'Source', onChange: () => { source = sourceSel.value; refetch(); } });
    const followBox = h('input', { type: 'checkbox', checked: true, onChange: () => { follow = followBox.checked; if (follow) toBottom(); } });
    const search = h('input', { type: 'search', placeholder: 'Search the log', 'aria-label': 'Search the log' });
    const fromIn = h('input', { type: 'datetime-local', 'aria-label': 'From', onChange: () => refetch() });
    const toIn = h('input', { type: 'datetime-local', 'aria-label': 'To', onChange: () => refetch() });
    const liveBtn = h('button', { class: 'btn small', hidden: true, onClick: () => { fromIn.value = toIn.value = ''; refetch(); } }, 'Back to live');
    const exportLink = h('a', { class: 'btn small ghost', download: '' }, 'Export');

    const ms = (v, end) => (v ? Date.parse(v) + (end ? 59999 : 0) : NaN);
    const from = () => ms(fromIn.value), to = () => ms(toIn.value, true);
    const historical = () => to() < Date.now();

    const filterParams = () => {
      const p = new URLSearchParams();
      if (levels.size < LEVELS.length) p.set('level', [...levels].join(','));
      if (source !== '*') p.set('source', source || '-');
      if (query) p.set('q', query);
      if (!isNaN(from())) p.set('from', from());
      if (!isNaN(to())) p.set('to', to());
      return p;
    };

    const buildSources = () => {
      sourceSel.replaceChildren(h('option', { value: '*' }, 'All sources'), h('option', { value: '' }, '(no tag)'),
        [...sources].sort().map((s) => h('option', { value: s }, s)));
      sourceSel.value = source;
    };
    const noteSource = (s) => {
      if (s && !sources.has(s)) { sources.add(s); buildSources(); }
    };

    // live lines are matched here with the same rules the server applies
    const matches = (l) =>
      levels.has(l.level) && (source === '*' || (l.source || '') === source) && (!query || l.text.toLowerCase().includes(query)) &&
      (isNaN(from()) || l.ts >= from());
    const rowEl = (l) => logRow(l, query);

    const toBottom = () => { box.scrollTop = box.scrollHeight; };
    const bar = h('div', { class: 'logbar' },
      LEVELS.map((lv) => h('label', {}, h('input', { type: 'checkbox', checked: levels.has(lv), onChange: (e) => { e.target.checked ? levels.add(lv) : levels.delete(lv); refetch(); } }), lv)),
      sourceSel, search,
      h('label', {}, 'From', fromIn), h('label', {}, 'To', toIn), liveBtn,
      h('label', {}, followBox, 'Follow'),
      h('button', { class: 'btn small ghost', onClick: () => { entries = []; more = false; renderAll(); } }, 'Clear view'),
      exportLink);
    buildSources();
    search.addEventListener('input', debounce(() => { query = search.value.toLowerCase(); refetch(); }, 300));

    function renderAll(keepScroll) {
      const prevHeight = box.scrollHeight;
      for (const e of entries) e.el = rowEl(e.line);
      rows.replaceChildren(...entries.map((e) => e.el));
      empty.hidden = entries.length > 0 || !ready;
      older.hidden = !more;
      if (keepScroll) box.scrollTop += box.scrollHeight - prevHeight;
      else if (follow) toBottom();
    }

    function append(l) {
      noteSource(l.source);
      const e = { line: l, el: rowEl(l) };
      entries.push(e);
      rows.append(e.el);
      empty.hidden = true;
      while (entries.length > MAX_ROWS) {
        entries.shift().el?.remove();
        more = true;
        older.hidden = false;
      }
      if (follow) toBottom();
    }

    box.addEventListener('scroll', () => {
      if (historical()) {
        if (box.scrollTop < 40 && more) loadOlder();
        return;
      }
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 8;
      if (atBottom !== follow) { follow = atBottom; followBox.checked = follow; }
      if (box.scrollTop < 40 && more) loadOlder();
    });

    let loadingOlder = false;
    async function loadOlder() {
      if (loadingOlder || !entries.length) return;
      loadingOlder = true;
      olderBtn.disabled = true;
      const mine = seq;
      try {
        const p = filterParams();
        p.set('before', entries[0].line.id);
        const r = await api.get(`logs?${p}`);
        if (mine === seq && !gone) {
          more = r.more;
          r.lines.forEach((l) => noteSource(l.source));
          entries = r.lines.map((line) => ({ line, el: null })).concat(entries);
          if (historical() && entries.length > MAX_ROWS) entries.length = MAX_ROWS;
          renderAll(true);
        }
      } catch (err) {
        if (!gone) status.replaceChildren(errorState(err, () => { status.replaceChildren(); loadOlder(); }));
      }
      loadingOlder = false;
      olderBtn.disabled = false;
    }

    let gone = false;
    let ready = false;
    let lastId = 0; // newest live id seen, survives Clear view and refetches
    const pending = [];
    // live lines that arrive while a page loads are merged afterwards
    const off = events.on('log', (l) => {
      lastId = Math.max(lastId, l.id);
      if (!ready) return pending.push(l);
      if (historical()) return;
      // a replay after reconnect can repeat lines we already hold
      const last = entries.at(-1)?.line.id ?? 0;
      if (l.id > last && matches(l)) append(l);
    });

    function refetch() {
      const hist = historical();
      follow = !hist;
      followBox.checked = follow;
      followBox.disabled = hist;
      liveBtn.hidden = !fromIn.value && !toIn.value;
      liveBtn.textContent = hist ? 'Back to live' : 'Clear dates';
      exportLink.href = new URL(`api/logs/export?${filterParams()}`, location.href).href;
      return fetchFirst();
    }

    async function fetchFirst() {
      const mine = ++seq;
      ready = false;
      pending.length = 0;
      if (!entries.length && !status.firstChild) status.replaceChildren(loadingState());
      if (!levels.size) {
        status.replaceChildren();
        entries = [];
        more = false;
        ready = true;
        return renderAll();
      }
      try {
        const p = filterParams();
        p.set('limit', 500);
        const r = await api.get(`logs?${p}`);
        if (gone || mine !== seq) return;
        status.replaceChildren();
        more = r.more;
        entries = r.lines.map((line) => ({ line, el: null }));
        r.lines.forEach((l) => noteSource(l.source));
        const top = Math.max(0, ...r.lines.map((l) => l.id));
        ready = true;
        if (!historical()) for (const l of pending) if (l.id > top && matches(l)) { noteSource(l.source); entries.push({ line: l, el: null }); }
        pending.length = 0;
        renderAll();
        if (follow) toBottom();
        else if (historical()) toBottom();
      } catch (err) {
        if (!gone && mine === seq) status.replaceChildren(errorState(err, fetchFirst));
      }
    }

    async function loadInfo() {
      try {
        const i = await api.get('logs/info');
        if (gone) return;
        if (!i.persisted) {
          info.textContent = 'Log persistence is off on this server (LOG_RETENTION_DAYS=0): only the last lines in memory are shown.';
          return;
        }
        info.textContent = `Kept for ${i.retentionDays} days, up to ${fmtBytes(i.maxBytes)} · ${fmtBytes(i.bytes)} stored` + (i.oldest ? ` · oldest line ${day(i.oldest)}` : '');
        if (i.oldest) fromIn.min = toIn.min = localInput(i.oldest);
      } catch { /* an older server has no stored log */ }
    }

    root.append(bar, info, status, box);
    refetch();
    loadInfo();
    return () => { gone = true; off(); };
  },
};
