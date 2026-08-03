import { tests } from './tests.mjs';
import { writeFileSync } from 'fs';

const BASE = 'http://localhost:3000';
const histories = {}; // thread id -> [{role, text}]

async function ask(question, thread) {
  const history = thread ? (histories[thread] || []) : [];
  const t0 = Date.now();
  let data, error = null;
  try {
    const res = await fetch(`${BASE}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, history }),
      signal: AbortSignal.timeout(120000),
    });
    data = await res.json();
  } catch (e) {
    error = e.message;
    data = { success: false, answer: null };
  }
  const ms = Date.now() - t0;
  if (thread) {
    const h = histories[thread] || (histories[thread] = []);
    h.push({ role: 'user', text: question });
    h.push({ role: 'bot', text: data.answer || '' });
  }
  return { data, ms, error };
}

const results = [];
let i = 0;
for (const t of tests) {
  i += 1;
  process.stderr.write(`[${i}/${tests.length}] ${t.id} (${t.category}): ${t.q.slice(0, 60)}...\n`);
  const { data, ms, error } = await ask(t.q, t.thread);
  const row = {
    id: t.id,
    category: t.category,
    thread: t.thread,
    question: t.q,
    expected: t.expected,
    answer: data.answer || null,
    intent: data.intent || null,
    format: data.format || null,
    confidence: data.confidence ?? null,
    sourceCount: data.sources?.qdrant?.length ?? 0,
    ms,
    error,
  };
  results.push(row);
  process.stderr.write(`   -> intent=${row.intent} confidence=${row.confidence} ${ms}ms ${error ? 'ERROR: ' + error : ''}\n`);
}

writeFileSync('./qa/results.json', JSON.stringify(results, null, 2));
process.stderr.write(`\nDone. ${results.length} tests. Total time: ${(results.reduce((s, r) => s + r.ms, 0) / 1000).toFixed(1)}s\n`);
