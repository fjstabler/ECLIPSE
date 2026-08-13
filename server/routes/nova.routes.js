import express from 'express';
import { requireAuth } from '../auth.js';
import { streamNova, getConversation, clearConversation, novaAvailable } from '../nova/claude.js';
import { tasteSummary } from '../nova/engine.js';

export const router = express.Router();
router.use(requireAuth);

router.get('/status', (req, res) => {
  res.json({ available: novaAvailable(), taste: tasteSummary(req.user.id) });
});

router.get('/conversation', (req, res) => {
  res.json({ messages: getConversation(req.user.id) });
});

router.delete('/conversation', (req, res) => {
  clearConversation(req.user.id);
  res.json({ ok: true });
});

/**
 * Chat with NOVA over Server-Sent Events.
 *
 * SSE rather than WebSockets: the traffic is one-directional once the message
 * is sent, and it survives a reverse proxy without extra configuration.
 */
router.post('/chat', async (req, res) => {
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Say something to NOVA first' });
  if (message.length > 4000) return res.status(400).json({ error: 'That message is too long' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  let closed = false;
  req.on('close', () => {
    closed = true;
  });

  const emit = (event) => {
    if (closed) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Some proxies drop an idle connection; a comment every 15s keeps it open.
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15000);

  try {
    await streamNova({ user: req.user, message, emit });
  } catch (err) {
    emit({ type: 'error', message: err.message });
  } finally {
    clearInterval(heartbeat);
    if (!closed) res.end();
  }
});
