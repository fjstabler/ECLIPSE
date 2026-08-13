import express from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import { getMediaFile } from '../library.js';

export const router = express.Router();
router.use(requireAuth);

/**
 * The player posts progress every few seconds. This is what powers
 * "Continue watching" and, just as importantly, what teaches N.O.V.A. which
 * things actually got finished.
 */
router.post('/progress', (req, res) => {
  const fileId = Number(req.body.fileId);
  const position = Number(req.body.position) || 0;
  const duration = Number(req.body.duration) || 0;

  const file = getMediaFile(fileId);
  if (!file) return res.status(404).json({ error: 'File not found' });

  // Anything past 92% counts as watched — nobody sits through the credits.
  const completed = duration > 0 && position / duration >= 0.92 ? 1 : 0;

  db.prepare(`
    INSERT INTO playback_state (user_id, media_file_id, title_id, position, duration, completed, play_count, updated_at)
    VALUES (@user_id, @file_id, @title_id, @position, @duration, @completed, 1, datetime('now'))
    ON CONFLICT(user_id, media_file_id) DO UPDATE SET
      position = @position,
      duration = MAX(@duration, playback_state.duration),
      completed = MAX(@completed, playback_state.completed),
      play_count = playback_state.play_count + (CASE WHEN @completed = 1 AND playback_state.completed = 0 THEN 1 ELSE 0 END),
      updated_at = datetime('now')
  `).run({
    user_id: req.user.id,
    file_id: fileId,
    title_id: file.title_id,
    position,
    duration,
    completed,
  });

  res.json({ ok: true, completed: completed === 1 });
});

/** Called when playback stops, so the history has a durable record. */
router.post('/stopped', (req, res) => {
  const fileId = Number(req.body.fileId);
  const file = getMediaFile(fileId);
  if (!file) return res.status(404).json({ error: 'File not found' });

  db.prepare(`
    INSERT INTO watch_events (user_id, title_id, media_file_id, seconds_watched, completed)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    req.user.id,
    file.title_id,
    fileId,
    Number(req.body.secondsWatched) || 0,
    req.body.completed ? 1 : 0
  );

  res.json({ ok: true });
});

/** Mark watched / unwatched by hand. */
router.post('/watched', (req, res) => {
  const fileId = Number(req.body.fileId);
  const watched = req.body.watched !== false;
  const file = getMediaFile(fileId);
  if (!file) return res.status(404).json({ error: 'File not found' });

  if (watched) {
    db.prepare(`
      INSERT INTO playback_state (user_id, media_file_id, title_id, position, duration, completed, updated_at)
      VALUES (?, ?, ?, 0, COALESCE(?, 0), 1, datetime('now'))
      ON CONFLICT(user_id, media_file_id) DO UPDATE SET completed = 1, position = 0, updated_at = datetime('now')
    `).run(req.user.id, fileId, file.title_id, file.duration);
  } else {
    db.prepare('DELETE FROM playback_state WHERE user_id = ? AND media_file_id = ?').run(req.user.id, fileId);
  }

  res.json({ ok: true, watched });
});
