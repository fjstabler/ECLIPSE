import express from 'express';
import { isFirstRun } from '../db.js';
import {
  authenticate, authenticateWithPin, setPin, createUser, createSession, destroySession, listUsers,
  setSessionCookie, clearSessionCookie, requireAuth, requireAdmin,
} from '../auth.js';
import { getTasteProfile, saveTasteProfile } from '../nova/engine.js';
import { novaAvailable } from '../nova/openai.js';
import { hasTmdb } from '../metadata/tmdb.js';
import { config } from '../config.js';
import { getPreferences, savePreferences } from '../preferences.js';
import { registerDevice } from '../media/sessions.js';

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
      // Lets the sign-in screen ask for four digits instead of a password,
      // which is the difference between painless and miserable on a remote.
      hasPin: u.has_pin === 1,
    })),
    features: {
      nova: novaAvailable(),
      transcode: config.ffmpeg.enabled,
      // Drives the "artwork isn't set up yet" notice on the home screen.
      metadata: hasTmdb(),
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
  // Either credential opens the same door. A PIN only works if the profile
  // has set one; it is never a way around a password that exists.
  const usingPin = Boolean(req.body.pin);
  const user = usingPin
    ? await authenticateWithPin(req.body.username, req.body.pin)
    : await authenticate(req.body.username, req.body.password);

  if (!user) {
    return res.status(401).json({
      error: usingPin ? 'That PIN is not right' : 'That username and password do not match',
    });
  }
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

/** Playback settings — how this viewer wants the player to behave. */
/** Set or clear this profile's PIN. */
router.put('/pin', requireAuth, async (req, res) => {
  try {
    res.json(await setPin(req.user.id, req.body?.pin));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/preferences', requireAuth, (req, res) => {
  res.json(getPreferences(req.user.id));
});

router.put('/preferences', requireAuth, (req, res) => {
  // savePreferences clamps everything it's given, so the body goes straight
  // in — a settings form can't push the player into an unusable state.
  res.json(savePreferences(req.user.id, req.body || {}));
});

/**
 * A client saying hello. It hands over the key it generated once and kept,
 * so the household sees the same device on the list rather than a new row
 * each time a user agent gains a version number.
 */
router.post('/device', requireAuth, (req, res) => {
  const device = registerDevice({
    userId: req.user.id,
    deviceKey: req.body?.deviceKey || req.get('x-eclipse-device'),
    userAgent: req.get('user-agent'),
    clientName: req.body?.name,
  });
  if (!device) return res.status(400).json({ error: 'A device key is required' });
  res.json({ id: device.id, name: device.name, kind: device.kind });
});
