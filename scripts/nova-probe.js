/**
 * Drive N.O.V.A.'s conversational layer directly, bypassing HTTP, so streaming
 * and tool-calling can be checked in isolation. Point it at a mock or a real
 * OpenAI key:
 *
 *   node scripts/mock-openai.js &
 *   OPENAI_API_KEY=test OPENAI_BASE_URL=http://localhost:8399/v1 \
 *     NOVA_MODEL=mock-model node scripts/nova-probe.js
 */

import { db } from '../server/db.js';
import { streamNova } from '../server/nova/openai.js';

const user = db
  .prepare('SELECT id, username, display_name, is_admin FROM users ORDER BY id LIMIT 1')
  .get();

if (!user) {
  console.error('No profile exists yet — start the server and create one first.');
  process.exit(1);
}

console.log(`asking as ${user.display_name}…\n`);

const events = [];
const started = Date.now();

const timer = setTimeout(() => {
  console.error(`\nTIMED OUT after 25s. Events seen: ${events.map((e) => e.type).join(', ') || 'none'}`);
  process.exit(1);
}, 25000);

const result = await streamNova({
  user,
  message: process.argv[2] || 'What should I watch tonight?',
  emit: (event) => {
    events.push(event);
    if (event.type === 'text') process.stdout.write(event.text);
    else if (event.type === 'tool') console.log(`\n[tool] ${event.name} — ${event.label}`);
    else if (event.type === 'refs') console.log(`\n[cards] ${event.titles.map((t) => t.title).join(', ')}`);
    else if (event.type === 'error') console.log(`\n[error] ${event.message}`);
  },
});

clearTimeout(timer);

console.log(`\n\n--- ${Date.now() - started}ms ---`);
console.log('event types:', events.map((e) => e.type).join(' → '));
console.log('tools used :', events.filter((e) => e.type === 'tool').map((e) => e.name).join(', ') || 'none');
console.log('reply      :', JSON.stringify(result.content?.slice(0, 120) || result.error));
process.exit(0);
