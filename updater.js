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

function createUpdater({ version, mode = 'off', repo, token, cron = '0 6 * * 0', warn = 24 * 60 * 60e3, inDocker, watchtowerUrl, watchtowerToken, onChange, log = console }) {
  mode = ['notify', 'on'].includes(mode) ? mode : 'off';
  const releasesUrl = `https://github.com/${repo}/releases`;
  let schedule;
  try {
    schedule = parseCron(cron);
    nextRun(schedule, Date.now()); // e.g. "0 0 31 2 *" parses but never fires
  } catch (err) {
    log.error(`[update] MAINTENANCE_CRON "${cron}" is invalid (${err.message}); using "0 6 * * 0"`);
    cron = '0 6 * * 0';
    schedule = parseCron(cron);
  }
  if (mode === 'on' && !inDocker) {
    log.warn('[update] AUTO_UPDATE=on only works in the Docker image; falling back to notify');
    mode = 'notify';
  }
  if (mode === 'on' && !watchtowerToken) {
    log.warn('[update] AUTO_UPDATE=on without WATCHTOWER_TOKEN: new versions are announced, not installed (see README → Automatic updates)');
    mode = 'notify';
  }

  // latest: { version, url } of a newer release; at: when it will be installed
  const st = { latest: null, at: null, installing: false, lastError: null };
  let checkTimer = null;
  let windowTimer = null;

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
  const changed = () => onChange?.(info());

  async function check() {
    if (mode === 'off' || st.installing) return;
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'friendspeak-server', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(20e3),
      });
      if (res.status === 404) throw new Error(token ? 'no published release yet' : 'no release found (private repo? set GITHUB_TOKEN)');
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const rel = await res.json();
      const latest = String(rel.tag_name || '').replace(/^v/, '');
      st.lastError = null;
      if (!isNewer(latest, version)) {
        if (st.latest) Object.assign(st, { latest: null, at: null }), clearTimeout(windowTimer), changed();
        return;
      }
      const isNew = st.latest?.version !== latest;
      if (isNew) Object.assign(st, { latest: { version: latest, url: rel.html_url || `${releasesUrl}/tag/v${latest}` }, at: null });
      // Only promise a maintenance window when something can carry it out.
      // Checked again every time, so starting Watchtower later is enough.
      let scheduled = false;
      if (mode === 'on' && !st.at) {
        if (await watchtowerUp()) {
          st.at = nextRun(schedule, Date.now() + MIN_LEAD);
          scheduled = true;
          armWindow();
        } else if (isNew) log.warn(`[update] can't reach Watchtower at ${watchtowerUrl}; announcing ${latest} without installing it`);
      }
      if (isNew) log.log(`[update] friendspeak ${latest} is available` + (mode === 'on' ? '' : ' (AUTO_UPDATE=notify)'));
      if (scheduled) log.log(`[update] installing ${latest} at ${new Date(st.at).toString()}`);
      if (isNew || scheduled) changed();
    } catch (err) {
      if (st.lastError !== err.message) log.warn('[update] check failed:', err.message);
      st.lastError = err.message;
    }
  }

  // Any HTTP answer (401 without the token) means the sidecar is there
  async function watchtowerUp() {
    try {
      await fetch(new URL('/v1/update', watchtowerUrl), { signal: AbortSignal.timeout(5e3) });
      return true;
    } catch {
      return false;
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
    st.at = nextRun(schedule, Date.now() + MIN_LEAD);
    log.log(`[update] retrying at ${new Date(st.at).toString()}`);
    armWindow();
    changed();
  }

  return {
    info,
    start() {
      if (mode === 'off') return;
      setTimeout(check, 30e3).unref();
      checkTimer = setInterval(check, CHECK_EVERY);
      checkTimer.unref();
    },
    stop() {
      clearInterval(checkTimer);
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
