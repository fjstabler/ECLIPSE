import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { db } from './db.js';
import { config } from './config.js';

const scrypt = promisify(crypto.scrypt);

const AVATAR_COLOURS = [
  '#6c5ce7', '#e17055', '#00b894', '#0984e3', '#d63031',
  '#e84393', '#fdcb6e', '#00cec9', '#a29bfe', '#55efc4',
];

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return { hash: derived.toString('hex'), salt };
}

export async function verifyPassword(password, hash, salt) {
  const derived = await scrypt(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  // Length check first — timingSafeEqual throws on a mismatch.
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

export async function createUser({ username, displayName, password, isAdmin = false, isKids = false }) {
  const clean = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9_.-]{2,32}$/.test(clean)) {
    throw new Error('Username must be 2-32 characters: letters, numbers, dot, dash or underscore.');
  }
  if (!password || String(password).length < 4) {
    throw new Error('Password must be at least 4 characters.');
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(clean);
  if (existing) throw new Error('That username is already taken.');

  const { hash, salt } = await hashPassword(String(password));
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const colour = AVATAR_COLOURS[count % AVATAR_COLOURS.length];

  const info = db.prepare(`
    INSERT INTO users (username, display_name, password_hash, password_salt, avatar_color, is_admin, is_kids)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(clean, displayName?.trim() || clean, hash, salt, colour, isAdmin ? 1 : 0, isKids ? 1 : 0);

  db.prepare('INSERT OR IGNORE INTO taste_profiles (user_id) VALUES (?)').run(info.lastInsertRowid);
  return getUserById(info.lastInsertRowid);
}

export function getUserById(id) {
  return db
    .prepare('SELECT id, username, display_name, avatar_color, is_admin, is_kids, created_at FROM users WHERE id = ?')
    .get(id);
}

export function listUsers() {
  return db
    .prepare('SELECT id, username, display_name, avatar_color, is_admin, is_kids FROM users ORDER BY id')
    .all();
}

export async function authenticate(username, password) {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim().toLowerCase());
  if (!row) return null;
  const ok = await verifyPassword(String(password || ''), row.password_hash, row.password_salt);
  if (!ok) return null;
  return getUserById(row.id);
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + config.session.maxAgeDays * 86400_000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  return { token, expires };
}

export function destroySession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function userForToken(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    destroySession(token);
    return null;
  }
  return getUserById(row.user_id);
}

export function pruneSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
}

// --- Express middleware -----------------------------------------------------

export function attachUser(req, res, next) {
  const token = req.cookies?.[config.session.cookieName];
  req.user = userForToken(token);
  req.sessionToken = token;
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (!req.user.is_admin) return res.status(403).json({ error: 'Administrator access required' });
  next();
}

export function setSessionCookie(res, token, expires) {
  res.cookie(config.session.cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    expires: new Date(expires),
    // Home networks are usually plain HTTP, so this can't be forced on.
    secure: false,
    path: '/',
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(config.session.cookieName, { path: '/' });
}
