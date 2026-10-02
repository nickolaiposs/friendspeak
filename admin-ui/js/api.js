// fetch wrapper for /admin/api/ and the shared EventSource
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => (onUnauthorized = fn);

async function request(method, path, body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(new URL('api/' + path, location.href), opts);
  } catch {
    throw Object.assign(new Error('Could not reach the server'), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== 'login' && path !== 'session') onUnauthorized();
    throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  patch: (path, body) => request('PATCH', path, body),
  del: (path) => request('DELETE', path),
};

// One EventSource; events.on(type, fn) returns an unsubscribe function.
export function connectEvents({ onState, onClosed } = {}) {
  const handlers = new Map();
  const es = new EventSource(new URL('api/events', location.href));
  const emit = (type, data) => [...(handlers.get(type) || [])].forEach((fn) => fn(data));
  for (const type of ['log', 'change', 'bye']) {
    es.addEventListener(type, (e) => {
      let data = {};
      try { data = JSON.parse(e.data); } catch {}
      emit(type, data);
    });
  }
  es.onopen = () => onState?.(true);
  es.onerror = () => {
    onState?.(false);
    // a non-200 answer (e.g. 401) closes the stream for good
    if (es.readyState === EventSource.CLOSED) onClosed?.();
  };
  return {
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
      return () => handlers.get(type).delete(fn);
    },
    close: () => es.close(),
  };
}
