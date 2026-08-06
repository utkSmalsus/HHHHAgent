// One-off: re-runs only the items that errored in results/baseline.json (infrastructure outage
// mid-run) and merges them back in place, preserving every already-valid result untouched.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(__dirname, 'results', 'baseline.json');
const dataset = JSON.parse(fs.readFileSync(path.join(__dirname, 'dataset.json'), 'utf8'));
const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));

const datasetById = new Map(dataset.items.map((it) => [it.id, it]));
const failedIds = baseline.results.filter((r) => r.error).map((r) => r.id);
console.log('Retrying', failedIds.length, 'failed items:', failedIds.join(', '));

async function ask(question, history) {
  const res = await fetch('http://localhost:3000/api/query', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, history }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Rebuild conversation history for any failed conversation turns, from already-valid results.
const resultById = new Map(baseline.results.map((r) => [r.id, r]));
function historyFor(item) {
  if (!item.conversationId) return [];
  const turns = dataset.items.filter((it) => it.conversationId === item.conversationId && it.turn < item.turn).sort((a, b) => a.turn - b.turn);
  const h = [];
  for (const t of turns) {
    const r = resultById.get(t.id);
    if (r && !r.error) {
      h.push({ role: 'user', text: t.question });
      h.push({ role: 'assistant', text: r.answer });
    }
  }
  return h;
}

for (const id of failedIds) {
  const item = datasetById.get(id);
  const idx = baseline.results.findIndex((r) => r.id === id);
  try {
    const t0 = Date.now();
    const resp = await ask(item.question, historyFor(item));
    baseline.results[idx] = {
      id, ...(item.conversationId ? { conversationId: item.conversationId, turn: item.turn } : {}),
      question: item.question, answer: resp.answer, intent: resp.intent, confidence: resp.confidence, ms: Date.now() - t0,
    };
    process.stdout.write('.');
  } catch (err) {
    baseline.results[idx] = { id, question: item.question, error: String(err.message || err) };
    process.stdout.write('E');
  }
}

const stillErrors = baseline.results.filter((r) => r.error).length;
baseline.errors = stillErrors;
baseline.runAt = new Date().toISOString();
baseline.note = 'Merged: original run interrupted by a Docker/Qdrant crash mid-run; failed items re-run after infrastructure recovery, all other results untouched.';
fs.writeFileSync(BASELINE, JSON.stringify(baseline, null, 2));
console.log(`\nDone. ${stillErrors} still erroring.`);
