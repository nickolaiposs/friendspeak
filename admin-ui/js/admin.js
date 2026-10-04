import { h } from './util.js';
import { api, connectEvents, setUnauthorizedHandler } from './api.js';
import { loadingState, closeAllDialogs } from './ui.js';
import overview from './views/overview.js';
import users from './views/users.js';
import roles from './views/roles.js';
import log from './views/log.js';
import crashes from './views/crashes.js';
import keys from './views/keys.js';
import audit from './views/audit.js';
import channels from './views/channels.js';
import storage from './views/storage.js';
import game from './views/game.js';
import updates from './views/updates.js';
import settings from './views/settings.js';

// Add a view: create a module exporting { id, title, mount(root, ctx) } and list it here.
const groups = [
  ['Server', [overview, users, roles, channels, storage, game, updates, settings]],
  ['Admin', [log, crashes, keys, audit]],
];
const views = groups.flatMap(([, v]) => v);

const root = document.getElementById('root');
let events = null;
let cleanup = null;
let session = null;
let onHash = null;
let retryTimer = null;

function teardown() {
  cleanup?.();
  cleanup = null;
  if (onHash) removeEventListener('hashchange', onHash);
  onHash = null;
  events?.close();
  events = null;
  clearTimeout(retryTimer);
  retryTimer = null;
}

async function start() {
  teardown();
  root.replaceChildren(loadingState());
  try {
    session = await api.get('session');
  } catch (err) {
    const down = err.status === 0;
    root.replaceChildren(h('div', { class: 'state', role: 'alert' },
      h('div', { class: 'error-text' }, down ? 'Can\u2019t reach the server. Retrying\u2026' : err.message),
      h('button', { class: 'btn small ghost', onClick: start }, 'Retry')));
    if (down) retryTimer = setTimeout(start, 3000);
    return;
  }
  if (session.authed) showApp();
  else showLogin();
}

setUnauthorizedHandler(() => start());

// ---------------------------------------------------------------- login

function showLogin() {
  const s = session;
  const card = h('div', { class: 'login-card' }, h('h1', {}, s.name || 'friendspeak'),
    h('p', { class: 'muted' }, 'Admin dashboard. Anyone with an admin key has full control of this server.'));
  if (!s.canLogin) {
    card.append(
      h('p', {}, 'Admin access from another machine needs an encrypted connection. Start the server with ', h('code', {}, 'HTTPS=1'), ', or put it behind a TLS reverse proxy.'),
      h('p', { class: 'muted' }, 'On the server’s own machine, ', h('code', {}, `http://localhost:${location.port || 80}/admin`), ' works without a key.'));
  } else {
    card.append(loginForm(s));
  }
  if (s.fingerprint) {
    card.append(h('div', { class: 'field' },
      h('label', {}, 'Server certificate SHA-256 fingerprint'),
      h('div', { class: 'fp' }, s.fingerprint),
      h('span', { class: 'muted small' }, 'Compare it with the Certificate: line in the server log and with what the browser shows for this site’s certificate.')));
  }
  root.replaceChildren(h('div', { class: 'login' }, card));
  card.querySelector('input')?.focus();
}

function loginForm() {
  const input = h('input', { id: 'key', type: 'password', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'login-err' });
  const toggle = h('button', { type: 'button', class: 'btn small ghost', onClick: () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.textContent = show ? 'Hide' : 'Show';
  } }, 'Show');
  const err = h('div', { id: 'login-err', class: 'error-text small', role: 'alert' });
  const btn = h('button', { type: 'submit', class: 'btn' }, 'Sign in');
  let timer = null;

  const lock = (secs) => {
    btn.disabled = true;
    const tick = () => {
      if (secs <= 0) { clearInterval(timer); btn.disabled = false; err.textContent = ''; return; }
      err.textContent = `Too many attempts. Try again in ${secs}s.`;
      secs--;
    };
    clearInterval(timer);
    tick();
    timer = setInterval(tick, 1000);
  };

  return h('form', { class: 'field', onSubmit: async (e) => {
    e.preventDefault();
    const key = input.value.trim();
    if (!key) return;
    btn.disabled = true;
    err.textContent = '';
    try {
      await api.post('login', { key });
      input.value = '';
      clearInterval(timer);
      start();
    } catch (ex) {
      if (ex.status === 429) return lock(Math.ceil(ex.data?.retryAfter || 30));
      err.textContent = ex.message;
      btn.disabled = false;
    }
  } },
    h('label', { for: 'key' }, 'Admin key'),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, input), toggle),
    err,
    h('div', {}, btn));
}

// ---------------------------------------------------------------- app

function showApp() {
  const s = session;
  const state = h('div', { class: 'conn-state', role: 'status', hidden: true }, 'reconnecting…');
  const retry = h('button', { class: 'btn small ghost', hidden: true, onClick: () => start() }, 'Retry');
  const brandIcon = h('div', { class: 'logo', 'aria-hidden': 'true' }, (s.name || 'f').slice(0, 1).toUpperCase());
  const brand = h('div', { class: 'brand' }, brandIcon, h('span', {}, s.name || 'friendspeak'));
  const nav = h('nav', { class: 'nav', 'aria-label': 'Admin sections' },
    groups.flatMap(([name, vs]) => [h('div', { class: 'nav-h' }, name), vs.map((v) => h('a', { href: `#/${v.id}`, 'data-id': v.id }, v.title))].flat()));
  const foot = h('div', { class: 'side-foot' },
    state, retry,
    s.local ? h('div', { class: 'local-badge' }, 'Local access: no key needed from this machine')
      : [h('div', { class: 'small muted who' }, 'Signed in as ', h('strong', {}, s.actor || '?')),
        h('button', { class: 'btn small ghost', onClick: async () => { try { await api.post('logout'); } catch {} start(); } }, 'Sign out')]);
  const title = h('h1', {});
  const body = h('div', { class: 'viewbody' });
  const main = h('main', { class: 'main' }, title, body);
  root.replaceChildren(h('div', { class: 'shell' }, h('aside', { class: 'side' }, brand, nav, foot), main));

  const opened = Date.now();
  let wasUp = false;
  events = connectEvents({
    onState: (up) => { if (up) wasUp = true; state.hidden = up; if (up) retry.hidden = true; },
    onClosed: () => {
      // restart once; if a fresh stream is refused right away (never opened), stop and offer a button
      if (!wasUp && Date.now() - opened < 5000) { state.hidden = false; retry.hidden = false; }
      else start();
    },
  });
  // "closed" means the server is shutting down: keep the page and let the stream reconnect
  events.on('bye', (e) => {
    if (e.reason === 'closed') state.hidden = false;
    else start();
  });
  const ctx = { api, session: s, events };

  // pick up the server icon, if any, without blocking the shell
  api.get('overview').then((o) => {
    if (/^(data:image\/|https:\/\/)/.test(o.icon || '')) brandIcon.replaceWith(h('img', { src: o.icon, alt: '', referrerpolicy: 'no-referrer' }));
  }).catch(() => {});

  const route = () => {
    closeAllDialogs();
    cleanup?.();
    cleanup = null;
    const id = location.hash.replace(/^#\//, '');
    const view = views.find((v) => v.id === id) || views[0];
    for (const a of nav.querySelectorAll('a')) {
      if (a.dataset.id === view.id) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    document.title = `${view.title} - ${s.name || 'friendspeak'} admin`;
    title.textContent = view.title;
    main.classList.toggle('fill', !!view.fill);
    body.replaceChildren();
    cleanup = view.mount(body, ctx) || null;
  };
  onHash = route;
  addEventListener('hashchange', onHash);
  route();
}

start();
