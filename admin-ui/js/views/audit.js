import { h, fmtTime } from '../util.js';
import { loadingState, errorState } from '../ui.js';

export default {
  id: 'audit',
  title: 'Audit log',
  mount(root, { api }) {
    const body = h('tbody', {});
    const status = h('div', {});
    const moreBtn = h('button', { class: 'btn small ghost', onClick: () => fetchPage() }, 'Load more');
    const more = h('div', { class: 'state', hidden: true }, moreBtn);
    let oldest = null, gone = false, busy = false;
    const wrap = h('div', { class: 'tablewrap', hidden: true }, h('table', {},
      h('thead', {}, h('tr', {}, ['Time', 'Actor', 'IP', 'Action', 'Detail'].map((t) => h('th', {}, t)))), body));
    root.append(status, wrap, more);

    async function fetchPage() {
      if (busy) return;
      busy = true;
      moreBtn.disabled = true;
      if (oldest == null) status.replaceChildren(loadingState());
      try {
        const r = await api.get('audit' + (oldest != null ? `?before=${oldest}` : ''));
        if (gone) return;
        status.replaceChildren();
        for (const e of r.entries) {
          body.append(h('tr', { class: e.action === 'login.failed' ? 'failed' : null },
            h('td', { class: 'nowrap' }, fmtTime(e.ts)), h('td', {}, e.actor), h('td', { class: 'mono' }, e.ip),
            h('td', { class: 'mono' }, e.action), h('td', {}, e.detail)));
          oldest = e.ts;
        }
        if (!body.children.length) status.replaceChildren(h('div', { class: 'state' }, 'No entries yet.'));
        wrap.hidden = !body.children.length;
        more.hidden = !r.more;
      } catch (err) {
        if (!gone) status.replaceChildren(errorState(err, fetchPage));
      } finally {
        busy = false;
        moreBtn.disabled = false;
      }
    }
    fetchPage();
    return () => { gone = true; };
  },
};
