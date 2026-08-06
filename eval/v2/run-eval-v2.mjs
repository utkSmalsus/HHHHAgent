/**
 * Eval V2 runner — sends every dataset.json question to the LIVE agent (POST /api/query) and
 * records the raw answer. This is a MEASUREMENT tool: it never modifies production code, never
 * pre-expands a conversational follow-up's pronoun before sending it, and never grades anything
 * itself (see scorer.mjs for that, run as a separate step).
 *
 * Usage: node eval/v2/run-eval-v2.mjs [--base-url http://localhost:3000] [--out eval/v2/results/baseline.json]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, arr) => {
    if (arg.startsWith('--')) acc.push([arg.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);
const BASE_URL = args['base-url'] || 'http://localhost:3000';
const OUT = args.out || path.join(__dirname, 'results', 'baseline.json');

const dataset = JSON.parse(fs.readFileSync(path.join(__dirname, 'dataset.json'), 'utf8'));

async function ask(question, history) {
  const res = await fetch(`${BASE_URL}/api/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, history }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Group items by conversationId so multi-turn scenarios run turn-by-turn with REAL prior-turn
// history (client-side conversation state), never a pre-expanded/rewritten follow-up question.
const singles = dataset.items.filter((it) => !it.conversationId);
const conversations = new Map();
for (const it of dataset.items) {
  if (!it.conversationId) continue;
  if (!conversations.has(it.conversationId)) conversations.set(it.conversationId, []);
  conversations.get(it.conversationId).push(it);
}
for (const turns of conversations.values()) turns.sort((a, b) => a.turn - b.turn);

const results = [];
let errors = 0;

console.log(`Running Eval V2 (${dataset.version}) — ${dataset.totalQuestions} questions against ${BASE_URL}`);

for (const it of singles) {
  try {
    const t0 = Date.now();
    const resp = await ask(it.question, []);
    results.push({ id: it.id, question: it.question, answer: resp.answer, intent: resp.intent, confidence: resp.confidence, ms: Date.now() - t0 });
    process.stdout.write('.');
  } catch (err) {
    errors++;
    results.push({ id: it.id, question: it.question, error: String(err.message || err) });
    process.stdout.write('E');
  }
}

for (const [cid, turns] of conversations) {
  const history = [];
  for (const it of turns) {
    try {
      const t0 = Date.now();
      const resp = await ask(it.question, history);
      results.push({ id: it.id, conversationId: cid, turn: it.turn, question: it.question, answer: resp.answer, intent: resp.intent, confidence: resp.confidence, ms: Date.now() - t0 });
      history.push({ role: 'user', text: it.question });
      history.push({ role: 'assistant', text: resp.answer });
      process.stdout.write('.');
    } catch (err) {
      errors++;
      results.push({ id: it.id, conversationId: cid, turn: it.turn, question: it.question, error: String(err.message || err) });
      process.stdout.write('E');
    }
  }
}

console.log(`\nDone. ${results.length} results, ${errors} errors.`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ version: dataset.version, runAt: new Date().toISOString(), baseUrl: BASE_URL, total: results.length, errors, results }, null, 2));
console.log('Wrote', OUT);
