import crypto from 'node:crypto';
import { db } from '../db.js';

/**
 * Who is watching what, on which device, right now.
 *
 * Live sessions are held in memory on purpose: a playback session is a thing
 * that exists only while a socket is open, and writing it to disk would mean
 * every crash left phantom "currently playing" rows to clean up. Devices are
 * the durable half — those are remembered so the household sees "Living room
 * Fire TV" instead of a user-agent string.
 */

const sessions = new Map();

export function startSession({ userId, deviceId, file, title, episode, decision, hardware, method }) {
  const id = crypto.randomUUID();
  sessions.set(id, {
    id,
    userId,
    deviceId,
    fileId: file.id,
    titleId: file.title_id,
    titleName: title?.title || file.filename,
    episode: episode ? { season: episode.season, number: episode.number, name: episode.name } : null,
    method,
    reasons: decision?.reasons || [],
    hardware: hardware?.available ? hardware.label : null,
    sourceVideo: file.video_codec,
    sourceAudio: file.audio_codec,
    sourceHeight: file.height,
    targetHeight: decision?.targetHeight || file.height,
    targetBitrate: decision?.targetBitrate || null,
    duration: file.duration || 0,
    position: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    process: null,
  });
  return id;
}

export function attachProcess(sessionId, proc) {
  const s = sessions.get(sessionId);
  if (s) s.process = proc;
}

export function touchSession(sessionId, position) {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (typeof position === 'number') s.position = position;
  s.updatedAt = Date.now();
}

export function endSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (s.process && !s.process.killed) {
    try { s.process.kill('SIGKILL'); } catch { /* already gone */ }
  }
  sessions.delete(sessionId);
}

/**
 * Sessions whose client stopped talking. A browser tab closed mid-stream
 * doesn't always get to say so, so anything silent for a while is assumed
 * gone rather than shown forever in the admin panel.
 */
const STALE_MS = 90_000;
export function reapStale() {
  const cutoff = Date.now() - STALE_MS;
  for (const [id, s] of sessions) {
    // A running transcode is proof of life even when progress reports stop.
    if (s.updatedAt < cutoff && !(s.process && !s.process.killed)) sessions.delete(id);
  }
}

export function activeSessions() {
  reapStale();
  return [...sessions.values()].map(publicSession);
}

export function transcodeCount() {
  reapStale();
  return [...sessions.values()].filter((s) => s.method === 'transcode').length;
}

export function sessionsForUser(userId) {
  reapStale();
  return [...sessions.values()].filter((s) => s.userId === userId).map(publicSession);
}

function publicSession(s) {
  const device = s.deviceId ? getDevice(s.deviceId) : null;
  const user = s.userId ? db.prepare('SELECT display_name FROM users WHERE id = ?').get(s.userId) : null;
  return {
    id: s.id,
    user: user?.display_name || 'Unknown',
    userId: s.userId,
    device: device?.name || 'Unknown device',
    deviceKind: device?.kind || 'unknown',
    title: s.titleName,
    titleId: s.titleId,
    episode: s.episode,
    method: s.method,
    reasons: s.reasons,
    hardware: s.hardware,
    source: [s.sourceVideo?.toUpperCase(), s.sourceHeight ? `${s.sourceHeight}p` : null].filter(Boolean).join(' '),
    target: [s.targetHeight ? `${s.targetHeight}p` : null, s.targetBitrate ? `${Math.round(s.targetBitrate / 1000)}kbps` : null]
      .filter(Boolean).join(' '),
    position: s.position,
    duration: s.duration,
    progress: s.duration > 0 ? Math.min(1, s.position / s.duration) : 0,
    startedAt: new Date(s.startedAt).toISOString(),
  };
}

// --- devices ----------------------------------------------------------------

/**
 * Work out what a client is from what it tells us. The Fire TV app appends
 * its own marker to the user agent, which is the one case worth trusting
 * completely — everything else is the usual best-effort sniffing.
 */
export function identifyDevice(userAgent = '', clientName = null) {
  const ua = userAgent.toLowerCase();

  if (ua.includes('eclipse-tv')) return { kind: 'firetv', name: clientName || 'Fire TV' };
  if (ua.includes('aft')) return { kind: 'firetv', name: clientName || 'Fire TV' };
  if (ua.includes('ipad')) return { kind: 'ipad', name: clientName || 'iPad' };
  if (ua.includes('iphone')) return { kind: 'iphone', name: clientName || 'iPhone' };
  if (ua.includes('android') && ua.includes('tv')) return { kind: 'tv', name: clientName || 'Android TV' };
  if (ua.includes('android')) return { kind: 'android', name: clientName || 'Android phone' };
  if (ua.includes('macintosh') || ua.includes('mac os')) return { kind: 'mac', name: clientName || 'Mac' };
  if (ua.includes('windows')) return { kind: 'pc', name: clientName || 'Windows PC' };
  if (ua.includes('linux')) return { kind: 'pc', name: clientName || 'Linux PC' };
  return { kind: 'unknown', name: clientName || 'Browser' };
}

/**
 * Devices are keyed by a value the client generates once and keeps, so the
 * same TV stays the same row across restarts instead of appearing anew each
 * time its user agent shifts by a version number.
 */
export function registerDevice({ userId, deviceKey, userAgent, clientName }) {
  if (!deviceKey) return null;
  const identity = identifyDevice(userAgent, clientName);

  db.prepare(`
    INSERT INTO devices (user_id, device_key, name, kind, user_agent, first_seen, last_seen)
    VALUES (@user_id, @device_key, @name, @kind, @user_agent, datetime('now'), datetime('now'))
    ON CONFLICT(device_key) DO UPDATE SET
      user_id = @user_id,
      kind = @kind,
      user_agent = @user_agent,
      last_seen = datetime('now'),
      -- A renamed device keeps the name its owner gave it.
      name = CASE WHEN devices.renamed = 1 THEN devices.name ELSE @name END
  `).run({
    user_id: userId ?? null,
    device_key: deviceKey,
    name: identity.name,
    kind: identity.kind,
    user_agent: (userAgent || '').slice(0, 500),
  });

  return db.prepare('SELECT * FROM devices WHERE device_key = ?').get(deviceKey);
}

export function getDevice(id) {
  return db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
}

export function listDevices() {
  return db
    .prepare(`
      SELECT d.*, u.display_name AS user_name
      FROM devices d LEFT JOIN users u ON u.id = d.user_id
      ORDER BY d.last_seen DESC
    `)
    .all()
    .map((d) => ({
      id: d.id,
      name: d.name,
      kind: d.kind,
      user: d.user_name,
      userAgent: d.user_agent,
      firstSeen: d.first_seen,
      lastSeen: d.last_seen,
      active: activeSessions().some((s) => s.deviceKind === d.kind && s.userId === d.user_id),
    }));
}
