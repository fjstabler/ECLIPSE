/**
 * A stand-in for the OpenAI Chat Completions API, used to exercise N.O.V.A.'s
 * streaming and tool-calling path without spending anything on a real key.
 *
 * It deliberately splits tool-call arguments across several SSE chunks, because
 * that fragmentation is the part of the client code most likely to break.
 *
 *   node scripts/mock-openai.js
 *   OPENAI_API_KEY=test OPENAI_BASE_URL=http://localhost:8399/v1 npm start
 */

import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8399);

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function chunk(delta, finish = null) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

const server = http.createServer((req, res) => {
  console.log(`[mock-openai] ${req.method} ${req.url}`);
  if (req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }));
    return;
  }

  if (!req.url.startsWith('/v1/chat/completions')) {
    res.writeHead(404).end();
    return;
  }

  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const request = JSON.parse(body || '{}');

    // Error modes, so the client's handling of a bad key or a model the account
    // can't reach can be checked without burning a real one.
    if (request.model === 'bad-model') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `The model \`bad-model\` does not exist`, code: 'model_not_found' } }));
      return;
    }
    if (request.model === 'unauthorised') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } }));
      return;
    }
    const hasToolResult = (request.messages || []).some((m) => m.role === 'tool');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    if (!hasToolResult) {
      // Turn one: ask for a tool, with the arguments dribbled out in pieces.
      sse(res, chunk({ role: 'assistant', content: '' }));
      sse(res, chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_recomm', arguments: '' } }] }));
      sse(res, chunk({ tool_calls: [{ index: 0, function: { name: 'endations' } }] }));
      sse(res, chunk({ tool_calls: [{ index: 0, function: { arguments: '{"li' } }] }));
      sse(res, chunk({ tool_calls: [{ index: 0, function: { arguments: 'mit":' } }] }));
      sse(res, chunk({ tool_calls: [{ index: 0, function: { arguments: ' 3}' } }] }));
      sse(res, chunk({}, 'tool_calls'));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Turn two: the model has the tool result and answers, naming a title from
    // it so the card-matching path is exercised too.
    const toolMessage = (request.messages || []).find((m) => m.role === 'tool');
    let firstTitle = 'something';
    try {
      const parsed = JSON.parse(toolMessage.content);
      firstTitle = parsed.recommendations?.[0]?.title || firstTitle;
    } catch { /* leave the default */ }

    for (const piece of [`Go with **${firstTitle}**`, ' tonight — it lines up', ' with what you have been watching.']) {
      sse(res, chunk({ content: piece }));
    }
    sse(res, chunk({}, 'stop'));
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

server.listen(PORT, () => console.log(`[mock-openai] listening on http://localhost:${PORT}/v1`));
