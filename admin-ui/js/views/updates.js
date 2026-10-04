import { h, fmtTime, debounce } from '../util.js';
import { loadingState, errorState, confirmDialog } from '../ui.js';

const MODE_CHOICES = [
  ['off', 'Off', 'No update checks.'],
  ['notify', 'Notify', 'Check for new versions and tell everyone. The host installs by hand or with Update now.'],
  ['on', 'Install automatically', 'Also install new versions in the maintenance window.'],
];

const PRESETS = [
  ['Sundays 06:00', '0 6 * * 0'],
  ['Every day 04:00', '0 4 * * *'],
  ['Weekdays 03:30', '30 3 * * 1-5'],
  ['1st of the month 06:00', '0 6 1 * *'],
];

function countdown(at) {
  const s = Math.max(0, Math.round((at - Date.now()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default {
  id: 'updates',
  title: 'Updates',
  mount(root, { api, events }) {
    let st = null;
    let tick = null;
    let gone = false;
    const timer = h('span', { class: 'countdown' });
    const msg = h('div', { class: 'error-text small', role: 'alert' });

    // persistent containers: the settings box is never rebuilt, so typing and focus survive refetches
    const state = h('div', {});
    const factsBox = h('div', {});
    const settingsBox = h('div', { class: 'stack' });
    const actionsBox = h('div', { class: 'stack' });
    const content = h('div', { class: 'stack', hidden: true }, factsBox, settingsBox, actionsBox);

    const apply = (u) => { st = { ...u, docker: u.docker ?? st?.docker }; paint(); };
    const act = async (path) => {
      msg.textContent = '';
      try { apply((await api.post(path)).update); } catch (e) { msg.textContent = e.message; }
    };
    const updateNow = async () => {
      const ok = await confirmDialog({ title: `Update to ${st.latest.version}?`, confirmLabel: 'Update now',
        body: 'Everyone on the server will see a warning, and the server restarts in about 2 minutes.' });
      if (ok) act('update/now');
    };

    // ------------------------------------------------ settings (built once)

    const modeStatus = h('span', { class: 'small', role: 'status' });
    const cronStatus = h('span', { class: 'small', role: 'status' });
    const setStatus = {
      mode: (t, bad) => { modeStatus.className = bad ? 'small error-text' : 'small msg-ok'; modeStatus.textContent = t; },
      cron: (t, bad) => { cronStatus.className = bad ? 'small error-text' : 'small msg-ok'; cronStatus.textContent = t; },
    };

    const sourceLine = (el, key, envName) => {
      el.replaceChildren(...(st.overridden?.[key]
        ? ['Set here; the server’s environment says ', h('code', {}, st.env?.[key] ?? '?'), '. ',
          h('button', { type: 'button', class: 'linkbtn', onClick: () => save({ [key]: null }) }, 'Reset')]
        : [`From the server’s environment (${envName}).`]));
    };

    async function save(body) {
      const key = Object.keys(body)[0];
      const status = setStatus[key];
      status('Saving…');
      try {
        const r = await api.patch('updates', body);
        st = { ...r.update, docker: r.update.docker ?? st?.docker };
        status('Saved.');
        paint(key === 'cron');
      } catch (e) {
        status(e.message, true);
        paint(false); // puts the radios back to what the server has
      }
    }

    const radios = MODE_CHOICES.map(([value, label, help]) => {
      const input = h('input', { type: 'radio', name: 'umode', value, id: 'umode-' + value, onChange: () => { if (input.checked) save({ mode: value }); } });
      return { value, input, el: h('label', { class: 'choice', for: 'umode-' + value }, input, h('span', {}, h('strong', {}, label), h('span', { class: 'muted small choice-help' }, help))) };
    });
    const modeSource = h('div', { class: 'small muted' });
    const modeNote = h('div', { class: 'note small', role: 'note', hidden: true });

    const cronInput = h('input', { id: 'ucron', class: 'mono', spellcheck: 'false', autocomplete: 'off', 'aria-describedby': 'cron-help cron-preview', maxlength: 100 });
    const preview = h('div', { id: 'cron-preview', class: 'small', role: 'status' });
    const saveCron = h('button', { type: 'button', class: 'btn', disabled: true, onClick: () => save({ cron: cronInput.value.trim() }) }, 'Save');
    const cronSource = h('div', { class: 'small muted' });
    const cronNote = h('div', { class: 'small muted' });
    let lastCron = '';
    let seq = 0;
    let valid = null; // normalized cron of the last successful preview of the current text

    const updateSave = () => { saveCron.disabled = !(valid && st && valid !== st.cron); };

    const runPreview = async () => {
      const text = cronInput.value.trim();
      const mine = ++seq;
      if (!text) { valid = null; preview.className = 'small muted'; preview.textContent = 'Enter a schedule.'; updateSave(); return; }
      try {
        const r = await api.get('updates/preview?cron=' + encodeURIComponent(text));
        if (mine !== seq || gone) return;
        if (!r.ok) throw new Error(r.error || 'Invalid schedule');
        valid = r.cron;
        preview.className = 'small';
        preview.replaceChildren('Next: ' + r.next.map((t) => new Date(t).toLocaleString()).join('; '),
          ...(st?.tz ? [h('br'), 'Server time zone: ', h('code', {}, st.tz)] : []));
      } catch (e) {
        if (mine !== seq || gone) return;
        valid = null;
        preview.className = 'small error-text';
        preview.textContent = e.message;
      }
      updateSave();
    };
    const previewSoon = debounce(runPreview, 300);
    cronInput.addEventListener('input', () => { valid = null; updateSave(); previewSoon(); });

    const presets = h('div', { class: 'row', role: 'group', 'aria-label': 'Schedule presets' },
      PRESETS.map(([label, expr]) => h('button', { type: 'button', class: 'btn small ghost', onClick: () => { cronInput.value = expr; valid = null; updateSave(); runPreview(); } }, label)));

    settingsBox.append(
      h('fieldset', { class: 'card stack' },
        h('legend', {}, 'Update mode'),
        radios.map((r) => r.el), modeNote,
        h('div', { class: 'row' }, modeSource, modeStatus)),
      h('div', { class: 'card stack' },
        h('div', { class: 'field' }, h('label', { for: 'ucron' }, 'Maintenance window (cron schedule)'), cronInput),
        h('div', { id: 'cron-help', class: 'small muted' }, 'Five fields: minute, hour, day of month, month, day of week. Uses the server’s local time.'),
        presets, preview,
        h('div', { class: 'row' }, saveCron, cronStatus),
        cronSource, cronNote));

    function syncSettings(force) {
      const u = st;
      const asked = u.requestedMode || u.mode;
      for (const r of radios) r.input.checked = r.value === asked;
      modeNote.hidden = !(asked === 'on' && u.mode !== 'on');
      modeNote.textContent = u.docker
        ? 'Automatic installs need the Docker image with the Watchtower sidecar and WATCHTOWER_TOKEN. Until that is set up, the server only announces updates.'
        : 'Automatic installs need the Docker image (with the Watchtower sidecar). Outside Docker, the server only announces updates.';
      sourceLine(modeSource, 'mode', 'AUTO_UPDATE');
      sourceLine(cronSource, 'cron', 'MAINTENANCE_CRON');
      cronNote.textContent = u.mode === 'on' ? '' : 'The window is only used for automatic installs.';
      // leave the field alone while it has focus or holds an unsaved edit
      const dirty = cronInput.value !== lastCron;
      if (force || (!dirty && document.activeElement !== cronInput)) {
        cronInput.value = u.cron || '';
        lastCron = u.cron || '';
        runPreview();
      } else updateSave();
    }

    // ------------------------------------------------ read-only parts

    function howTo() {
      return h('div', { class: 'note small' }, h('strong', {}, 'This server can’t install updates itself. '),
        st.docker
          ? 'Re-pull the image and recreate the container. In Portainer, update the stack with “Re-pull image”. To let the dashboard do it, run the Watchtower sidecar (see the README).'
          : h('span', {}, 'Run ', h('code', {}, 'git pull && npm install'), ', then restart the server.'));
    }

    function manual() {
      clearInterval(tick);
      if (!st.manual || !st.at) return null;
      const upd = () => (timer.textContent = countdown(st.at));
      upd();
      tick = setInterval(upd, 1000);
      return h('div', { class: 'row' }, 'Installing in ', timer, h('button', { class: 'btn small danger', onClick: () => act('update/cancel') }, 'Cancel'));
    }

    function paint(forceCron) {
      const u = st;
      const wt = !u.docker ? 'Not applicable (not running in Docker)' : u.watchtower === true ? 'Reachable' : u.watchtower === false ? 'Not reachable' : 'Not checked yet';
      const hasNew = u.latest && u.latest.version !== u.version;
      const link = hasNew && typeof u.latest.url === 'string' && u.latest.url.startsWith('https://');
      const rows = [
        ['Current version', u.version],
        ['Latest version', hasNew ? (link ? h('a', { href: u.latest.url, target: '_blank', rel: 'noopener noreferrer' }, u.latest.version) : u.latest.version) : 'Up to date'],
        ['Last check', u.lastCheck ? fmtTime(u.lastCheck) : 'never'],
        u.lastError && ['Last error', h('span', { class: 'error-text' }, u.lastError)],
        u.nextWindow && ['Next window', fmtTime(u.nextWindow)],
        u.at && ['Install scheduled for', fmtTime(u.at)],
        ['Watchtower', wt],
      ].filter(Boolean);
      factsBox.replaceChildren(h('div', { class: 'card' }, h('dl', { class: 'kv' }, rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]))));
      syncSettings(forceCron === true);
      actionsBox.replaceChildren(
        u.installing && h('div', { class: 'note', role: 'status' }, 'Installing now. The dashboard reconnects when the server is back.'),
        manual(),
        h('div', { class: 'row' },
          u.mode !== 'off' && h('button', { class: 'btn ghost', onClick: () => act('update/check') }, 'Check now'),
          hasNew && u.canInstall && !u.installing && !u.manual && h('button', { class: 'btn', onClick: updateNow }, 'Update now')),
        u.mode === 'off' && h('p', { class: 'small muted' }, 'Update checks are off.'),
        hasNew && !u.canInstall && howTo(),
        msg);
    }

    async function init() {
      state.replaceChildren(loadingState());
      try {
        st = await api.get('updates');
        if (gone) return;
        state.replaceChildren();
        content.hidden = false;
        paint(true);
      } catch (e) {
        if (!gone) state.replaceChildren(errorState(e, init));
      }
    }

    root.append(state, content);
    init();
    const off = events.on('change', async (e) => {
      if (e.topic !== 'update' || !st) return;
      try { st = await api.get('updates'); paint(); } catch { /* keep */ }
    });
    return () => { gone = true; off(); clearInterval(tick); };
  },
};
