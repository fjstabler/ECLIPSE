import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { db } from '../db.js';
import { toolDefinitions, runTool, buildSystemPrompt } from './tools.js';
import { recommend } from './engine.js';
import { getTitle } from '../library.js';

/**
 * NOVA's conversational layer.
 *
 * The local engine in engine.js does the ranking; Claude does the talking, the
 * constraint-juggling ("something short and funny that isn't sci-fi") and the
 * learning. It reaches the library only through the tools in tools.js, so it
 * can never recommend a film that isn't actually on the server.
 *
 * If no ANTHROPIC_API_KEY is set, chat degrades to the engine's own output
 * rather than failing — recommendations still work, they just aren't a
 * conversation.
 */

let client = null;
function getClient() {
  if (!config.nova.apiKey) return null;
  if (!client) client = new Anthropic({ apiKey: config.nova.apiKey });
  return client;
}

export function novaAvailable() {
  return Boolean(config.nova.apiKey);
}

const MAX_HISTORY_MESSAGES = 20;
const MAX_TOOL_TURNS = 6;

function loadHistory(userId) {
  const rows = db
    .prepare('SELECT role, content FROM nova_messages WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(userId, MAX_HISTORY_MESSAGES);
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}

function saveMessage(userId, role, content, refs = []) {
  db.prepare('INSERT INTO nova_messages (user_id, role, content, refs) VALUES (?, ?, ?, ?)').run(
    userId,
    role,
    content,
    JSON.stringify(refs)
  );
}

export function getConversation(userId, limit = 40) {
  const rows = db
    .prepare('SELECT id, role, content, refs, created_at FROM nova_messages WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, limit);
  return rows.reverse().map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    refs: JSON.parse(r.refs || '[]'),
    createdAt: r.created_at,
  }));
}

export function clearConversation(userId) {
  db.prepare('DELETE FROM nova_messages WHERE user_id = ?').run(userId);
}

/**
 * Stream a reply from NOVA.
 *
 * `emit(event)` is called with:
 *   { type: 'text',  text }        incremental reply text
 *   { type: 'tool',  name, label } NOVA started using a tool
 *   { type: 'refs',  titles }      title cards to show beside the reply
 *   { type: 'done',  content }     the finished reply
 *   { type: 'error', message }
 */
export async function streamNova({ user, message, emit }) {
  const anthropic = getClient();

  if (!anthropic) {
    return fallbackReply({ user, message, emit });
  }

  const userId = user.id;
  saveMessage(userId, 'user', message);

  const history = loadHistory(userId);
  const messages = history.map((m) => ({ role: m.role, content: m.content }));

  const system = buildSystemPrompt(user);
  const refs = new Set();
  let fullText = '';

  try {
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn += 1) {
      const stream = await createStream(anthropic, { system, messages });

      stream.on('text', (delta) => {
        fullText += delta;
        emit({ type: 'text', text: delta });
      });

      const final = await stream.finalMessage();

      // Claude Opus 5 runs safety classifiers; a decline arrives as a normal
      // 200 with stop_reason "refusal" and no usable content.
      if (final.stop_reason === 'refusal') {
        const note = "I can't help with that one — ask me about something on the server instead.";
        emit({ type: 'text', text: note });
        fullText += note;
        break;
      }

      messages.push({ role: 'assistant', content: final.content });

      const toolUses = final.content.filter((b) => b.type === 'tool_use');
      if (!toolUses.length) break;

      const toolResults = [];
      for (const call of toolUses) {
        emit({ type: 'tool', name: call.name, label: toolLabel(call.name, call.input) });
        try {
          const { result, refs: newRefs } = runTool(call.name, call.input || {}, { userId });
          for (const id of newRefs) refs.add(id);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: JSON.stringify(result),
          });
        } catch (err) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: `Tool failed: ${err.message}`,
            is_error: true,
          });
        }
      }

      messages.push({ role: 'user', content: toolResults });
    }

    // Only surface cards NOVA actually named, so the row matches the reply.
    const mentioned = [...refs].filter((id) => {
      const t = getTitle(id);
      return t && fullText.toLowerCase().includes(t.title.toLowerCase());
    });
    const cards = (mentioned.length ? mentioned : [...refs].slice(0, 6))
      .map((id) => getTitle(id))
      .filter(Boolean)
      .slice(0, 8);

    if (cards.length) emit({ type: 'refs', titles: cards });

    saveMessage(userId, 'assistant', fullText, cards.map((c) => c.id));
    emit({ type: 'done', content: fullText, refs: cards });
    return { content: fullText, refs: cards };
  } catch (err) {
    console.error('[nova] ', err);
    const message = friendlyError(err);
    emit({ type: 'error', message });
    return { error: message };
  }
}

/**
 * Opus 5 can decline a request outright, so we ask the API to re-serve it on
 * the recommended fallback model. Not every account has that beta enabled, so
 * fall back to a plain request if the API rejects the parameter.
 */
async function createStream(anthropic, { system, messages }) {
  const base = {
    model: config.nova.model,
    max_tokens: 8000,
    system,
    messages,
    tools: toolDefinitions,
    thinking: { type: 'adaptive' },
    output_config: { effort: config.nova.effort },
  };

  try {
    return anthropic.beta.messages.stream({
      ...base,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
  } catch (err) {
    if (!isParamRejection(err)) throw err;
    return anthropic.messages.stream(base);
  }
}

function isParamRejection(err) {
  const status = err?.status ?? err?.response?.status;
  if (status !== 400 && status !== 404) return false;
  const text = String(err?.message || '');
  return /fallback|beta|unexpected|unknown|not.*support/i.test(text);
}

function friendlyError(err) {
  const status = err?.status ?? err?.response?.status;
  if (status === 401) return 'NOVA could not authenticate — check ANTHROPIC_API_KEY in your .env file.';
  if (status === 429) return 'NOVA is rate limited right now. Give it a moment and try again.';
  if (status >= 500) return 'NOVA had trouble reaching Claude. Try again in a moment.';
  return `NOVA hit a problem: ${err?.message || 'unknown error'}`;
}

function toolLabel(name, input) {
  switch (name) {
    case 'search_library':
      return input?.query ? `Searching the library for "${input.query}"` : 'Browsing the library';
    case 'get_recommendations':
      return 'Scoring your library against your taste';
    case 'get_similar_titles':
      return 'Finding similar titles';
    case 'get_viewer_context':
      return 'Reading your viewing history';
    case 'get_title_details':
      return 'Pulling up the details';
    case 'update_taste_profile':
      return 'Updating your taste profile';
    case 'add_to_watchlist':
      return 'Adding to your watchlist';
    default:
      return 'Working';
  }
}

/**
 * No API key: NOVA still recommends, it just can't hold a conversation.
 * The engine's own reasons carry the explanation instead.
 */
function fallbackReply({ user, message, emit }) {
  const userId = user.id;
  saveMessage(userId, 'user', message);

  const wantsSeries = /\b(series|show|tv|episode|binge)\b/i.test(message);
  const wantsFilm = /\b(film|movie|feature)\b/i.test(message);
  const kind = wantsSeries && !wantsFilm ? 'series' : wantsFilm && !wantsSeries ? 'movie' : null;

  const picks = recommend(userId, { limit: 4, kind });

  let text;
  if (!picks.length) {
    text =
      "There's nothing in the library to recommend yet — add some films or series to your media folder and I'll pick something out.";
  } else {
    const lines = picks.map((p) => `**${p.title}**${p.year ? ` (${p.year})` : ''} — ${p.reason}`);
    text =
      `Here's what stands out for you right now:\n\n${lines.join('\n\n')}\n\n` +
      '_Conversational NOVA is off — add an `ANTHROPIC_API_KEY` to your `.env` and I can talk these through with you._';
  }

  for (const chunk of text.match(/.{1,24}/gs) || []) {
    emit({ type: 'text', text: chunk });
  }
  if (picks.length) emit({ type: 'refs', titles: picks });

  saveMessage(userId, 'assistant', text, picks.map((p) => p.id));
  emit({ type: 'done', content: text, refs: picks });
  return { content: text, refs: picks };
}
