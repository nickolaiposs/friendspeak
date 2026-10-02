// Server self-update (D29). Checks GitHub Releases for a newer friendspeak,
// schedules it for the next maintenance window (a cron expression), warns
// connected clients ahead of time, and at the window asks a Watchtower sidecar
// to pull the new image and recreate this container.
//
//   AUTO_UPDATE=off     no checks (default)
//   AUTO_UPDATE=notify  check and tell clients an update exists; the host updates by hand
//   AUTO_UPDATE=on      also install it at the window (Docker + Watchtower only)
//
// Without Watchtower (no token, or the sidecar isn't running) `on` behaves
// like `notify`: the server keeps running and just announces the update.
//
// The container itself never touches Docker: it is read-only with no
// capabilities. Only the Watchtower sidecar has the Docker socket.

const CHECK_EVERY = 6 * 60 * 60e3;
const MIN_LEAD = 10 * 60e3; // never schedule a window that starts in less than this
const FINAL_WARNING = 10 * 60e3; // clients re-show a dismissed warning this close to the window
const GIVE_UP_AFTER = 15 * 60e3; // still running this long after triggering → the update failed

function createUpdater({ version, mode: envMode = 'off', repo, token, cron: envCron = '0 6 * * 0', warn = 24 * 60 * 60e3, inDocker, watchtowerUrl, watchtowerToken, onChange, overrides, log = console }) {
  const MODES = ['off', 'notify', 'on'];
  const DEFAULT_CRON = '0 6 * * 0';
  const releasesUrl = `https://github.com/${repo}/releases`;
  const normCron = (c) => String(c).trim().split(/\s+/).join(' ');
  // Throws if it doesn't parse, or parses but never fires (e.g. "0 0 31 2 *")
  const compile = (c) => {
    const sch = parseCron(c);
    nextRun(sch, Date.now());
    return sch;
  };

  // The environment values and the dashboard's overrides are kept apart. The
  // requested mode, the effective mode and the active schedule are derived from
  // them in derive(), and nowhere else.
  const env = { mode: MODES.includes(envMode) ? envMode : 'off', cron: normCron(envCron) };
  try {
    compile(env.cron);
  } catch (err) {
    log.error(`[update] MAINTENANCE_CRON "${envCron}" is invalid (${err.message}); using "${DEFAULT_CRON}"`);
    env.cron = DEFAULT_CRON;
  }
  const ov = {}; // { mode?, cron? }, saved by the caller (state.json)
  if (overrides && typeof overrides === 'object') {
    if (MODES.includes(overrides.mode)) ov.mode = overrides.mode;
    else if (overrides.mode !== undefined) log.warn('[update] ignoring the saved update mode (not off, notify or on)');
    if (typeof overrides.cron === 'string') {
      try {
        compile(normCron(overrides.cron));
        ov.cron = normCron(overrides.cron);
      } catch (err) {
        log.warn(`[update] ignoring the saved maintenance window "${overrides.cron}" (${err.message})`);
      }
    } else if (overrides.cron !== undefined) log.warn('[update] ignoring the saved maintenance window (not text)');
  }

  let requestedMode, mode, cron, schedule;
  const warned = {}; // each downgrade is logged when it starts to apply, not on every change
  function derive() {
    requestedMode = ov.mode ?? env.mode;
    mode = requestedMode;
    cron = ov.cron ?? env.cron;
    schedule = parseCron(cron);
    const why = mode === 'on' && !inDocker ? 'docker' : mode === 'on' && !watchtowerToken ? 'token' : null;
    if (why) mode = 'notify';
    if (why !== warned.why) {
      if (why === 'docker') log.warn('[update] AUTO_UPDATE=on only works in the Docker image; falling back to notify');
      if (why === 'token') log.warn('[update] AUTO_UPDATE=on without WATCHTOWER_TOKEN: new versions are announced, not installed (see README → Automatic updates)');
      warned.why = why;
    }
  }
  derive();

  // latest: { version, url } of a newer release; at: when it will be installed
  // manual: an install requested from the admin dashboard is counting down
  // watchtower: result of the last probe (null: never probed); lastCheck: last finished check
  const st = { latest: null, at: null, installing: false, lastError: null, lastCheck: null, watchtower: null, manual: false };
  const canInstall = !!inDocker && !!watchtowerToken; // independent of `mode`: AUTO_UPDATE=notify can still be installed by hand
  let checkTimer = null;
  let firstTimer = null;
  let windowTimer = null;
  let started = false; // start() was called
  let stopped = false; // stop() was called: nothing may start timers again

  function info() {
    return {
      version,
      mode,
      cron,
      changelog: releasesUrl,
      latest: st.latest,
      at: st.at,
      warnFrom: st.at ? st.at - warn : null,
      finalFrom: st.at ? st.at - FINAL_WARNING : null,
      installing: st.installing,
    };
  }
  // info() plus what the admin dashboard shows
  const status = () => ({
    ...info(),
    lastCheck: st.lastCheck,
    lastError: st.lastError,
    watchtower: st.watchtower,
    canInstall,
    manual: st.manual,
    requestedMode,
    env: { ...env },
    overridden: { mode: 'mode' in ov, cron: 'cron' in ov },
    nextWindow: nextRun(schedule, Date.now()),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const changed = () => onChange?.(info());

  // One check at a time: a check requested while another runs shares its result
  let running = null;
  function check() {
    return (running ||= runCheck().finally(() => (running = null)));
  }

  async function runCheck() {
    if (mode === 'off' || st.installing) return;
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'friendspeak-server', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(20e3),
      });
      if (res.status === 404) throw new Error(token ? 'no published release yet' : 'no release found (private repo? set GITHUB_TOKEN)');
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const rel = await res.json();
      if (mode === 'off') return; // switched off while the request was out
      const latest = String(rel.tag_name || '').replace(/^v/, '');
      st.lastError = null;
      st.lastCheck = Date.now();
      if (!isNewer(latest, version)) {
        if (st.latest) Object.assign(st, { latest: null, at: null, manual: false }), clearTimeout(windowTimer), changed();
        return;
      }
      const isNew = st.latest?.version !== latest;
      if (isNew) Object.assign(st, { latest: { version: latest, url: rel.html_url || `${releasesUrl}/tag/v${latest}` } }), st.manual || (st.at = null); // a requested install keeps its time
      // Only promise a maintenance window when something can carry it out.
      // Checked again every time, so starting Watchtower later is enough.
      let scheduled = false;
      if (mode === 'on' && !st.at) {
        const up = await watchtowerUp();
        if (up && mode === 'on' && !st.at && st.latest) {
          st.at = nextRun(schedule, Date.now() + MIN_LEAD);
          scheduled = true;
          armWindow();
        } else if (!up && isNew) log.warn(`[update] can't reach Watchtower at ${watchtowerUrl}; announcing ${latest} without installing it`);
      }
      if (isNew) log.log(`[update] friendspeak ${latest} is available` + (mode === 'on' ? '' : ' (AUTO_UPDATE=notify)'));
      if (scheduled) log.log(`[update] installing ${latest} at ${new Date(st.at).toString()}`);
      if (isNew || scheduled) changed();
    } catch (err) {
      if (st.lastError !== err.message) log.warn('[update] check failed:', err.message);
      st.lastError = err.message;
      st.lastCheck = Date.now();
    }
  }

  // Any HTTP answer (401 without the token) means the sidecar is there
  async function watchtowerUp() {
    try {
      await fetch(new URL('/v1/update', watchtowerUrl), { signal: AbortSignal.timeout(5e3) });
      return (st.watchtower = true);
    } catch {
      return (st.watchtower = false);
    }
  }

  // setTimeout can't wait longer than ~24.8 days, so re-arm in steps
  function armWindow() {
    clearTimeout(windowTimer);
    if (!st.at) return;
    const wait = st.at - Date.now();
    windowTimer = setTimeout(wait > 2 ** 30 ? armWindow : install, Math.min(Math.max(wait, 0), 2 ** 30));
    windowTimer.unref();
  }

  async function install() {
    st.installing = true;
    st.manual = false;
    changed();
    log.log(`[update] maintenance window: asking Watchtower to install ${st.latest.version}`);
    // Watchtower answers only after the update finishes, and by then it has
    // stopped this container (SIGTERM → normal shutdown). So the request is
    // fire and forget: if this process is still alive later, it failed.
    fetch(new URL('/v1/update', watchtowerUrl), { method: 'POST', headers: { authorization: `Bearer ${watchtowerToken}` } }).then(
      (res) => !res.ok && fail(`Watchtower answered ${res.status}`),
      (err) => fail(`can't reach Watchtower at ${watchtowerUrl} (${err.cause?.code || err.message})`)
    );
    windowTimer = setTimeout(() => fail('this container is still running the old version (did the image get published?)'), GIVE_UP_AFTER);
    windowTimer.unref();
  }

  // Try again at the next window
  function fail(reason) {
    if (!st.installing) return;
    clearTimeout(windowTimer);
    log.error('[update] update failed:', reason);
    st.installing = false;
    // `on` tries again at the next window; a hand-started install in `notify` mode doesn't
    st.at = mode === 'on' ? nextRun(schedule, Date.now() + MIN_LEAD) : null;
    if (st.at) log.log(`[update] retrying at ${new Date(st.at).toString()}`);
    armWindow();
    changed();
  }

  // The admin dashboard's "Update now": install in `delay` ms, with the usual warning to clients
  async function installSoon(delay = 120e3) {
    if (st.installing) return { error: 'An update is already being installed' };
    if (!st.latest) return { error: 'No newer version is known' };
    if (!canInstall) return { error: 'This server can’t install updates itself (it needs the Docker image with the Watchtower sidecar)' };
    if (!(await watchtowerUp())) return { error: `Watchtower isn’t answering at ${watchtowerUrl}` };
    if (st.installing || !st.latest) return { error: st.installing ? 'An update is already being installed' : 'No newer version is known' }; // changed while probing
    st.at = Date.now() + delay;
    st.manual = true;
    armWindow();
    log.log(`[update] installing ${st.latest.version} at ${new Date(st.at).toString()} (requested from the admin dashboard)`);
    changed();
    return { ok: true };
  }

  // Back out of a requested install that hasn't started
  function cancelInstall() {
    if (!st.manual || st.installing) return { error: 'Nothing to cancel' };
    clearTimeout(windowTimer);
    st.manual = false;
    st.at = mode === 'on' ? nextRun(schedule, Date.now() + MIN_LEAD) : null;
    armWindow();
    log.log('[update] the requested install was cancelled');
    changed();
    return { ok: true };
  }

  async function checkNow() {
    if (mode === 'off') return { error: 'Update checks are off (AUTO_UPDATE)' };
    await check();
    return status();
  }

  // Periodic checks exist only while checks are on, and never after stop()
  function syncTimers() {
    if (stopped || !started) return;
    if (mode === 'off') {
      clearInterval(checkTimer);
      clearTimeout(firstTimer);
      checkTimer = firstTimer = null;
    } else if (!checkTimer) {
      checkTimer = setInterval(check, CHECK_EVERY);
      checkTimer.unref();
    }
  }

  // `on` just became the effective mode with a newer version already known
  async function scheduleKnown() {
    const ready = () => mode === 'on' && st.latest && !st.at && !st.installing;
    if (!ready() || !(await watchtowerUp()) || !ready()) return;
    st.at = nextRun(schedule, Date.now() + MIN_LEAD);
    armWindow();
    log.log(`[update] installing ${st.latest.version} at ${new Date(st.at).toString()}`);
    changed();
  }

  // Change the update mode and/or the maintenance window at runtime (the admin
  // dashboard). A value sets the override, null removes it, undefined leaves it.
  async function configure({ mode: m, cron: c } = {}) {
    if (st.installing) return { error: 'An update is being installed' };
    if (m !== undefined && m !== null && !MODES.includes(m)) return { error: 'Mode must be off, notify or on' };
    let newCron;
    if (c !== undefined && c !== null) {
      try {
        if (typeof c !== 'string') throw new Error('expected text');
        compile((newCron = normCron(c)));
      } catch (err) {
        return { error: `Invalid schedule: ${err.message}` };
      }
    }
    const before = { mode, cron, saved: JSON.stringify(ov) };
    if (m === null) delete ov.mode;
    else if (m !== undefined) ov.mode = m;
    if (c === null) delete ov.cron;
    else if (newCron !== undefined) ov.cron = newCron;
    derive();

    let checkAtOnce = false;
    if (mode !== before.mode) {
      log.log(`[update] update mode is now ${mode}` + (mode !== requestedMode ? ` (${requestedMode} requested)` : ''));
      if (mode === 'off') {
        Object.assign(st, { latest: null, at: null, manual: false });
        clearTimeout(windowTimer);
      } else if (before.mode === 'off') checkAtOnce = true;
      else if (mode === 'notify' && st.at && !st.manual) {
        st.at = null; // `on` is over: the scheduled window goes, a requested install stays
        clearTimeout(windowTimer);
      }
    }
    if (cron !== before.cron) {
      log.log(`[update] maintenance window is now "${cron}"`);
      if (mode === 'on' && st.at && !st.manual) {
        st.at = nextRun(schedule, Date.now() + MIN_LEAD);
        armWindow();
      }
    }
    syncTimers();
    if (mode !== before.mode || cron !== before.cron || JSON.stringify(ov) !== before.saved) changed();
    if (checkAtOnce && started && !stopped) {
      clearTimeout(firstTimer);
      check();
    } else if (mode === 'on' && before.mode !== 'on') await scheduleKnown();
    return { ok: true };
  }

  // The next three runs of a schedule, for the dashboard; changes nothing
  function preview(c) {
    try {
      if (typeof c !== 'string') throw new Error('expected text');
      const norm = normCron(c);
      const sch = compile(norm);
      const first = nextRun(sch, Date.now());
      const second = nextRun(sch, first);
      return { ok: true, cron: norm, next: [first, second, nextRun(sch, second)] };
    } catch (err) {
      return { error: `Invalid schedule: ${err.message}` };
    }
  }

  return {
    info,
    status,
    checkNow,
    installSoon,
    cancelInstall,
    configure,
    preview,
    overrides: () => ({ ...ov }),
    start() {
      started = true;
      if (stopped || mode === 'off') return;
      firstTimer = setTimeout(check, 30e3);
      firstTimer.unref();
      syncTimers();
    },
    stop() {
      stopped = true;
      clearInterval(checkTimer);
      clearTimeout(firstTimer);
      clearTimeout(windowTimer);
    },
  };
}

// "1.10.0" > "1.9.2"; pre-release suffixes are ignored
function isNewer(a, b) {
  const pa = String(a).split(/[.-]/).map(Number);
  const pb = String(b).split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

// ---------------------------------------------------------------- cron

// Standard 5 fields: minute hour day-of-month month day-of-week, in the
// server's local time (set TZ). Supports *, lists, ranges and steps
// ("0 6 * * 0", "30 4 * * 1-5", "0 */6 * * *"). Sunday is 0 or 7.
const FIELDS = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function parseCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('expected 5 fields');
  const sets = parts.map((part, i) => {
    const [lo, hi] = FIELDS[i];
    const set = new Set();
    for (const item of part.split(',')) {
      const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
      if (!m) throw new Error(`bad field "${part}"`);
      const from = m[1] === '*' ? lo : +m[2];
      const to = m[1] === '*' ? hi : m[3] !== undefined ? +m[3] : m[4] ? hi : from;
      const step = m[4] ? +m[4] : 1;
      if (from < lo || to > hi || from > to || step < 1) throw new Error(`out of range "${part}"`);
      for (let v = from; v <= to; v += step) set.add(v);
    }
    return set;
  });
  if (sets[4].has(7)) sets[4].add(0);
  // Like cron: if both day fields are restricted, either one matching is enough
  return { sets, anyDom: parts[2] === '*', anyDow: parts[4] === '*' };
}

function nextRun({ sets: [min, hour, dom, mon, dow], anyDom, anyDow }, after) {
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const dayOk = () => {
    const a = dom.has(d.getDate());
    const b = dow.has(d.getDay());
    return anyDom ? b : anyDow ? a : a || b;
  };
  for (let guard = 0; guard < 600_000; guard++) {
    if (!mon.has(d.getMonth() + 1) || !dayOk()) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
    } else if (!hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
    } else if (!min.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
    } else return d.getTime();
  }
  throw new Error('cron expression never matches');
}

module.exports = { createUpdater, parseCron, nextRun, isNewer };
