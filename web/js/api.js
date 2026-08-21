/** Thin wrapper over the ECLIPSE HTTP API. */

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });

  if (res.status === 204) return null;

  let data = null;
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) data = await res.json();

  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body),
  put: (url, body) => request('PUT', url, body),
  del: (url) => request('DELETE', url),

  // auth
  me: () => request('GET', '/api/auth/me'),
  setup: (body) => request('POST', '/api/auth/setup', body),
  login: (body) => request('POST', '/api/auth/login', body),
  logout: () => request('POST', '/api/auth/logout'),
  createUser: (body) => request('POST', '/api/auth/users', body),
  taste: () => request('GET', '/api/auth/taste'),
  saveTaste: (body) => request('PUT', '/api/auth/taste', body),

  // library
  home: () => request('GET', '/api/library/home'),
  titles: (params) => request('GET', `/api/library/titles?${new URLSearchParams(params)}`),
  title: (id) => request('GET', `/api/library/titles/${id}`),
  genres: () => request('GET', '/api/library/genres'),
  search: (q) => request('GET', `/api/library/search?q=${encodeURIComponent(q)}`),
  recommendations: (params) => request('GET', `/api/library/recommendations?${new URLSearchParams(params || {})}`),
  rate: (id, score) => request('POST', `/api/library/titles/${id}/rate`, { score }),
  toggleWatchlist: (id) => request('POST', `/api/library/titles/${id}/watchlist`),
  watchlist: () => request('GET', '/api/library/watchlist'),
  history: () => request('GET', '/api/library/history'),

  // playback
  playbackContext: (fileId) => request('GET', `/api/stream/context/${fileId}`),
  progress: (body) => request('POST', '/api/playback/progress', body),
  stopped: (body) => request('POST', '/api/playback/stopped', body),
  setWatched: (fileId, watched) => request('POST', '/api/playback/watched', { fileId, watched }),

  // nova
  novaStatus: () => request('GET', '/api/nova/status'),
  novaConversation: () => request('GET', '/api/nova/conversation'),
  novaClear: () => request('DELETE', '/api/nova/conversation'),

  // admin
  adminStatus: () => request('GET', '/api/admin/status'),
  adminScan: (full) => request('POST', '/api/admin/scan', { full }),
  adminUnmatched: () => request('GET', '/api/admin/unmatched'),
  adminMatchTitle: (id, tmdbId) => request('POST', `/api/admin/titles/${id}/match`, { tmdbId }),
  adminEditTitle: (id, body) => request('PATCH', `/api/admin/titles/${id}`, body),
  adminUsers: () => request('GET', '/api/admin/users'),
  adminDeleteUser: (id) => request('DELETE', `/api/admin/users/${id}`),
};

/**
 * Stream a N.O.V.A. reply over Server-Sent Events.
 * `onEvent` receives { type, ... } objects as they arrive.
 */
export async function novaChat(message, onEvent, signal) {
  const res = await fetch('/api/nova/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
    credentials: 'same-origin',
    signal,
  });

  if (!res.ok) {
    let detail = `N.O.V.A. is unavailable (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) detail = data.error;
    } catch { /* body wasn't json */ }
    onEvent({ type: 'error', message: detail });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line.
    const frames = buffer.split('\n\n');
    buffer = frames.pop() || '';

    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue; // ": ping" comments and the like
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          onEvent(JSON.parse(payload));
        } catch {
          // A partial frame; the next chunk will complete it.
        }
      }
    }
  }
}
