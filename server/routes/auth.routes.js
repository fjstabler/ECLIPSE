import express from 'express';
import { isFirstRun } from '../db.js';
import {
  authenticate, createUser, createSession, destroySession, listUsers,
  setSessionCookie, clearSessionCookie, requireAuth, requireAdmin,
} from '../auth.js';
import { getTasteProfile, saveTasteProfile } from '../nova/engine.js';
import { novaAvailable } from '../nova/claude.js';
import { config } from '../config.js';

export const router = express.Router();

/** Who am I, and is this server set up yet? */
router.get('/me', (req, res) => {
  res.json({
    user: req.user || null,
    firstRun: isFirstRun(),
    // The picker on the sign-in screen; no secrets here.
    profiles: isFirstRun() ? [] : listUsers().map((u) => ({
      id: u.id, username: u.username, displayName: u.display_name,
      avatarColor: u.avatar_color, isKids: u.is_kids === 1,
    })),
    features: {
      nova: novaAvailable(),
      transcode: config.ffmpeg.enabled,
    },
  });
});

/** First-run setup creates the administrator. Only works while there are no users. */
router.post('/setup', async (req, res) => {
  if (!isFirstRun()) return res.status(409).json({ error: 'This server is already set up' });
  try {
    const user = await createUser({
      username: req.body.username,
      displayName: req.body.displayName || req.body.username,
      password: req.body.password,
      isAdmin: true,
    });
    const { token, expires } = createSession(user.id);
    setSessionCookie(res, token, expires);
    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/login', async (req, res) => {
  const user = await authenticate(req.body.username, req.body.password);
  if (!user) return res.status(401).json({ error: 'That username and password do not match' });
  const { token, expires } = createSession(user.id);
  setSessionCookie(res, token, expires);
  res.json({ user });
});

router.post('/logout', (req, res) => {
  destroySession(req.sessionToken);
  clearSessionCookie(res);
  res.json({ ok: true });
});

/** Additional household profiles. */
router.post('/users', requireAdmin, async (req, res) => {
  try {
    const user = await createUser({
      username: req.body.username,
      displayName: req.body.displayName || req.body.username,
      password: req.body.password,
      isAdmin: Boolean(req.body.isAdmin),
      isKids: Boolean(req.body.isKids),
    });
    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/taste', requireAuth, (req, res) => {
  res.json(getTasteProfile(req.user.id));
});

router.put('/taste', requireAuth, (req, res) => {
  const arr = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 40) : undefined);
  const saved = saveTasteProfile(req.user.id, {
    about: typeof req.body.about === 'string' ? req.body.about.slice(0, 2000) : undefined,
    likedGenres: arr(req.body.likedGenres),
    dislikedGenres: arr(req.body.dislikedGenres),
    favouritePeople: arr(req.body.favouritePeople),
    moods: arr(req.body.moods),
    avoid: arr(req.body.avoid),
  });
  res.json(saved);
});
