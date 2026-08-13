import OpenAI from 'openai';
import { config } from '../config.js';
import { db } from '../db.js';
import { toolDefinitions, runTool, buildSystemPrompt } from './tools.js';
import { recommend } from './engine.js';
import { getTitle } from '../library.js';

/**
 * N.O.V.A.'s conversational layer, on the OpenAI API.
 *
 * The local engine in engine.js does the ranking; this layer does the talking,
 * the constraint-juggling ("something short and funny that isn't sci-fi") and
 * the learning. It reaches the library only through the tools in tools.js, so
 * it can never recommend a film that isn't actually on the server.
 *
 * Without an OPENAI_API_KEY, chat degrades to the engine's own output rather
 * than failing — recommendations still work, they just aren't a conversation.
 *
 * This uses the Chat Completions API, which means it also works against any
 * OpenAI-compatible endpoint (LM Studio, Ollama, OpenRouter, a local model)
 * by setting OPENAI_BASE_URL.
 */

let client = null;
function getClient() {
  if (!config.nova.apiKey) return null;
  if (!client) {
    client = new OpenAI({
      apiKey: config.nova.apiKey,
      ...(config.nova.baseUrl ? { baseURL: config.nova.baseUrl } : {}),
    });
  }
  return client;
}

export function novaAvailable() {
  return Boolean(config.nova.apiKey);
}

const MAX_HISTORY_MESSAGES = 20;
const MAX_TOOL_TURNS = 6;

const KNOWN_TOOLS = new Set(toolDefinitions.map((t) => t.name));

/** tools.js stays provider-neutral; this maps it to OpenAI's function shape. */
function openAiTools() {
  return toolDefinitions.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object',
        properties: t.input_schema.properties || {},
        required: t.input_schema.required || [],
      },
    },
  }));
}

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
 * Stream a reply from N.O.V.A.
 *
 * `emit(event)` is called with:
 *   { type: 'text',  text }        incremental reply text
 *   { type: 'tool',  name, label } a tool started running
 *   { type: 'refs',  titles }      title cards to show beside the reply
 *   { type: 'done',  content }     the finished reply
 *   { type: 'error', message }
 */
export async function streamNova({ user, message, emit }) {
  const openai = getClient();
  if (!openai) return fallbackReply({ user, message, emit });

  const userId = user.id;
  saveMessage(userId, 'user', message);

  const messages = [
    { role: 'system', content: buildSystemPrompt(user) },
    ...loadHistory(userId).map((m) => ({ role: m.role, content: m.content })),
  ];

  const refs = new Set();
  let fullText = '';

  try {
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn += 1) {
      const stream = await openai.chat.completions.create({
        model: config.nova.model,
        messages,
        tools: openAiTools(),
        stream: true,
      });

      let content = '';
      let finishReason = null;
      // Tool calls arrive in fragments spread across chunks and have to be
      // stitched back together by index before any of them can be run.
      const toolCalls = [];
      const announced = new Set();

      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta || {};

        if (delta.content) {
          content += delta.content;
          fullText += delta.content;
          emit({ type: 'text', text: delta.content });
        }

        for (const part of delta.tool_calls || []) {
          const i = part.index ?? 0;
          if (!toolCalls[i]) toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (part.id) toolCalls[i].id = part.id;
          if (part.function?.name) toolCalls[i].function.name += part.function.name;
          if (part.function?.arguments) toolCalls[i].function.arguments += part.function.arguments;

          // Tell the viewer what's happening as soon as the name is known —
          // but the name itself arrives in fragments, so wait until it matches
          // a real tool rather than announcing "get_recomm".
          const name = toolCalls[i].function.name;
          if (name && !announced.has(i) && KNOWN_TOOLS.has(name)) {
            announced.add(i);
            emit({ type: 'tool', name, label: toolLabel(name) });
          }
        }

        if (choice.finish_reason) finishReason = choice.finish_reason;
      }

      if (finishReason !== 'tool_calls' || !toolCalls.length) break;

      messages.push({
        role: 'assistant',
        content: content || null,
        tool_calls: toolCalls.filter(Boolean),
      });

      for (const call of toolCalls.filter(Boolean)) {
        let parsed = {};
        try {
          parsed = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          // A malformed argument blob shouldn't kill the turn — let the model
          // see the failure and correct itself.
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({ error: 'Could not parse the arguments for this tool call.' }),
          });
          continue;
        }

        try {
          const { result, refs: newRefs } = runTool(call.function.name, parsed, { userId });
          for (const id of newRefs) refs.add(id);
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        } catch (err) {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({ error: `Tool failed: ${err.message}` }),
          });
        }
      }
    }

    // Only show cards for titles actually named in the reply, so the row
    // matches what was said.
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
    console.error('[nova]', err);
    const friendly = await friendlyError(err, openai);
    emit({ type: 'error', message: friendly });
    return { error: friendly };
  }
}

/**
 * Turn an API failure into something a person running this at home can act on.
 * A wrong model name is the most likely first-run mistake, so that case looks
 * up what the key can actually reach and says so.
 */
async function friendlyError(err, openai) {
  const status = err?.status ?? err?.response?.status;
  const raw = String(err?.message || '');

  if (status === 401) {
    return 'That OpenAI API key was rejected. Check OPENAI_API_KEY in your .env file and restart the server.';
  }
  if (status === 429) {
    return /quota|billing/i.test(raw)
      ? 'Your OpenAI account is out of quota. Add credit at platform.openai.com/billing, then try again.'
      : "N.O.V.A. is being rate limited by OpenAI. Give it a moment and ask again.";
  }
  if (status === 404 || /model/i.test(raw)) {
    const suggestions = await listUsableModels(openai);
    return (
      `The model "${config.nova.model}" isn't available to this API key. ` +
      `Set NOVA_MODEL in your .env file to one you can use` +
      (suggestions.length ? `, for example: ${suggestions.join(', ')}.` : '.')
    );
  }
  if (status >= 500) return 'OpenAI had a problem at their end. Try again in a moment.';
  return `N.O.V.A. hit a problem: ${raw || 'unknown error'}`;
}

async function listUsableModels(openai) {
  try {
    const page = await openai.models.list();
    return (page.data || [])
      .map((m) => m.id)
      // Chat-capable families only — embeddings and audio models can't hold a
      // conversation, so suggesting them would send someone down a blind alley.
      .filter((id) => /^(gpt-|o[13457]|chatgpt)/i.test(id))
      .filter((id) => !/(embed|whisper|tts|audio|image|dall|moderation|realtime|transcribe)/i.test(id))
      .sort()
      .slice(0, 6);
  } catch {
    return [];
  }
}

function toolLabel(name) {
  switch (name) {
    case 'search_library': return 'Searching the library';
    case 'get_recommendations': return 'Scoring your library against your taste';
    case 'get_similar_titles': return 'Finding similar titles';
    case 'get_viewer_context': return 'Reading your viewing history';
    case 'get_title_details': return 'Pulling up the details';
    case 'update_taste_profile': return 'Updating your taste profile';
    case 'add_to_watchlist': return 'Adding to your watchlist';
    default: return 'Working';
  }
}

/**
 * No API key: N.O.V.A. still recommends, it just can't hold a conversation.
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
      '_Conversation is off — add an `OPENAI_API_KEY` to your `.env` and I can talk these through with you._';
  }

  for (const chunk of text.match(/.{1,24}/gs) || []) {
    emit({ type: 'text', text: chunk });
  }
  if (picks.length) emit({ type: 'refs', titles: picks });

  saveMessage(userId, 'assistant', text, picks.map((p) => p.id));
  emit({ type: 'done', content: text, refs: picks });
  return { content: text, refs: picks };
}
