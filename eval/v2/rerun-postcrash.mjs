// Re-runs every item that was part of the post-crash retry batch (MEET_020 onward), now that
// infrastructure has been stable and warmed up for a while, to rule out transient-recovery-window
// artifacts contaminating the baseline (confirmed live: HI_007 "couldn't match Ranu Trivedi" was
// exactly this — reran clean seconds later).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(__dirname, 'results', 'baseline.json');
const dataset = JSON.parse(fs.readFileSync(path.join(__dirname, 'dataset.json'), 'utf8'));
const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const datasetById = new Map(dataset.items.map((it) => [it.id, it]));

const startIdx = baseline.results.findIndex((r) => r.id === 'MEET_020');
const targetIds = baseline.results.slice(startIdx).map((r) => r.id);
console.log('Re-running', targetIds.length, 'post-crash items fresh:', targetIds.join(', '));

async function ask(question, history) {
  const res = await fetch('http://localhost:3000/api/query', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, history }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const resultById = new Map(baseline.results.map((r) => [r.id, r]));
function historyFor(item) {
  if (!item.conversationId) return [];
  const turns = dataset.items.filter((it) => it.conversationId === item.conversationId && it.turn < item.turn).sort((a, b) => a.turn - b.turn);
  const h = [];
  for (const t of turns) {
    const r = resultById.get(t.id);
    if (r && !r.error) { h.push({ role: 'user', text: t.question }); h.push({ role: 'assistant', text: r.answer }); }
  }
  return h;
}

const rerun = [];
for (const id of targetIds) {
  const item = datasetById.get(id);
  try {
    const t0 = Date.now();
    const resp = await ask(item.question, historyFor(item));
    const entry = { id, ...(item.conversationId ? { conversationId: item.conversationId, turn: item.turn } : {}), question: item.question, answer: resp.answer, intent: resp.intent, confidence: resp.confidence, ms: Date.now() - t0 };
    rerun.push(entry);
    resultById.set(id, entry); // so later conversation turns build on the FRESH answer
    process.stdout.write('.');
  } catch (err) {
    const entry = { id, question: item.question, error: String(err.message || err) };
    rerun.push(entry);
    resultById.set(id, entry);
    process.stdout.write('E');
  }
}
console.log('\nDone.', rerun.filter(r=>r.error).length, 'errors.');
fs.writeFileSync(path.join(__dirname, 'results', 'rerun-postcrash.json'), JSON.stringify(rerun, null, 2));
console.log('Wrote results/rerun-postcrash.json (baseline.json NOT modified yet — compare then merge deliberately)');
