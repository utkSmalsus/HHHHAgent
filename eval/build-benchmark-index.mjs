/**
 * Builds an ISOLATED benchmark index for one embedding model.
 *
 * Production safety: this only READS the production collection and writes to a separate,
 * explicitly-named temp collection. It never modifies `enterprise_knowledge`.
 *
 * The corpus (which points are included) is selected DETERMINISTICALLY and identically for every
 * model, so recall differences reflect the embedding model and nothing else. Text and chunking are
 * carried over from production unchanged — this re-embeds existing chunks, it does not re-chunk.
 *
 * Usage:
 *   node eval/build-benchmark-index.mjs --model bge-m3 --collection bench_bge_m3 [--size 3000]
 */
import { DATASET } from './dataset.mjs';

const QDRANT = process.env.QDRANT_URL || 'http://localhost:6333';
const SOURCE = 'enterprise_knowledge';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}
const MODEL = arg('model');
const TARGET = arg('collection');
const SIZE = Number(arg('size', 3000));
const CONCURRENCY = Number(arg('concurrency', 4));

if (!MODEL || !TARGET) throw new Error('--model and --collection are required');
if (TARGET === SOURCE) throw new Error('refusing to write to the production collection');

async function embed(text) {
  const res = await fetch('http://127.0.0.1:11434/api/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: text || ' ' }),
  });
  const data = await res.json();
  if (!res.ok || !data.embeddings?.[0]) {
    throw new Error(`embed failed: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data.embeddings[0];
}

async function scrollAll(collection) {
  const points = [];
  let offset = null;
  do {
    const res = await fetch(`${QDRANT}/collections/${collection}/points/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 1000, offset, with_payload: true, with_vector: false }),
    });
    const data = await res.json();
    points.push(...(data.result?.points || []));
    offset = data.result?.next_page_offset ?? null;
  } while (offset);
  return points;
}

// ── corpus selection (identical for every model) ─────────────────────────────
const all = await scrollAll(SOURCE);
console.log(`source: ${all.length} points`);

const wantedTitles = new Set();
for (const c of DATASET) {
  if (c.expect.meetingTitle) wantedTitles.add(c.expect.meetingTitle);
  if (c.expect.titleExact) wantedTitles.add(c.expect.titleExact);
}

const targets = all.filter((p) => wantedTitles.has(p.payload?.title));
const rest = all.filter((p) => !wantedTitles.has(p.payload?.title));

// Deterministic stride sample of distractors — same set every run, no randomness.
const need = Math.max(0, SIZE - targets.length);
const stride = Math.max(1, Math.floor(rest.length / need));
const distractors = [];
for (let i = 0; i < rest.length && distractors.length < need; i += stride) distractors.push(rest[i]);

const corpus = [...targets, ...distractors];
console.log(`corpus: ${corpus.length} points (${targets.length} eval targets + ${distractors.length} distractors)`);

// ── create isolated collection ───────────────────────────────────────────────
const dims = (await embed('dimension probe')).length;
console.log(`model ${MODEL} → ${dims} dims`);

await fetch(`${QDRANT}/collections/${TARGET}`, { method: 'DELETE' });
const createRes = await fetch(`${QDRANT}/collections/${TARGET}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ vectors: { size: dims, distance: 'Cosine' } }),
});
if (!createRes.ok) throw new Error(`create failed: ${(await createRes.text()).slice(0, 200)}`);

// ── embed + upsert ───────────────────────────────────────────────────────────
const started = Date.now();
let done = 0;
let failed = 0;

async function worker(slice) {
  const batch = [];
  for (const p of slice) {
    try {
      const vector = await embed(p.payload?.text || '');
      batch.push({ id: p.id, vector, payload: p.payload });
    } catch (err) {
      failed += 1;
      if (failed <= 3) console.warn(`  embed failure: ${err.message.slice(0, 120)}`);
    }
    done += 1;
    if (done % 250 === 0) {
      const rate = done / ((Date.now() - started) / 1000);
      console.log(`  ${done}/${corpus.length} (${rate.toFixed(1)}/s, eta ${Math.round((corpus.length - done) / rate)}s)`);
    }
    if (batch.length >= 100) {
      await upsert(batch.splice(0, batch.length));
    }
  }
  if (batch.length) await upsert(batch);
}

async function upsert(points) {
  const res = await fetch(`${QDRANT}/collections/${TARGET}/points?wait=true`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ points }),
  });
  if (!res.ok) throw new Error(`upsert failed: ${(await res.text()).slice(0, 200)}`);
}

const shards = Array.from({ length: CONCURRENCY }, (_, i) =>
  corpus.filter((_, idx) => idx % CONCURRENCY === i)
);
await Promise.all(shards.map(worker));

const info = await (await fetch(`${QDRANT}/collections/${TARGET}`)).json();
console.log(
  `\ndone: ${info.result?.points_count} points in ${TARGET} ` +
    `(${Math.round((Date.now() - started) / 1000)}s, ${failed} embed failures)`
);
