/**
 * Retrieval evaluation harness — measures RETRIEVAL ONLY (no LLM generation involved).
 *
 * Parameterized by collection + embedder so the identical code path measures the current
 * production model and any candidate model, keeping the comparison honest.
 *
 * Primary metric is RAW VECTOR SEARCH (no keyword rerank, no gating): that isolates embedding
 * quality, which is the variable under test. The app's reranked pipeline is reported separately
 * for the baseline so we can see how much the existing rerank contributes.
 *
 * Usage:
 *   node eval/run-eval.mjs                          # baseline, production collection
 *   node eval/run-eval.mjs --collection X --model Y # a candidate index
 */
import { DATASET } from './dataset.mjs';

const QDRANT = process.env.QDRANT_URL || 'http://localhost:6333';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const COLLECTION = arg('collection', 'enterprise_knowledge');
const EMBED_MODEL = arg('model', null); // null → use the app's configured embedder
const LABEL = arg('label', EMBED_MODEL || 'current (nomic-embed-text)');
const K_MAX = 20;

// ── embedding ────────────────────────────────────────────────────────────────
async function embedViaOllama(text, model) {
  const res = await fetch('http://127.0.0.1:11434/api/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: text }),
  });
  const data = await res.json();
  if (!res.ok || !data.embeddings?.[0]) {
    throw new Error(`embed failed (${model}): ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data.embeddings[0];
}

async function getEmbedder() {
  if (EMBED_MODEL) return (t) => embedViaOllama(t, EMBED_MODEL);
  const { embedText } = await import('../src/services/ai.js');
  return (t) => embedText(t, { isQuery: true });
}

// ── corpus / ground truth ────────────────────────────────────────────────────
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
    if (!res.ok) throw new Error(`scroll failed: ${JSON.stringify(data).slice(0, 200)}`);
    points.push(...(data.result?.points || []));
    offset = data.result?.next_page_offset ?? null;
  } while (offset);
  return points;
}

/** Resolve each case to the set of point ids that count as a correct hit. */
function resolveTargets(corpus, testCase) {
  const { meetingTitle, type, titleExact, marker } = testCase.expect;
  let pool = corpus;

  if (meetingTitle) {
    pool = pool.filter((p) => p.payload?.title === meetingTitle);
    if (!pool.length) return { ids: new Set(), error: `no meeting titled "${meetingTitle}"` };
  }
  if (titleExact) {
    pool = pool.filter((p) => p.payload?.title === titleExact && (!type || p.payload?.type === type));
    if (!pool.length) return { ids: new Set(), error: `no ${type} titled "${titleExact}"` };
  }
  if (marker) {
    const withMarker = pool.filter((p) => String(p.payload?.text || '').includes(marker));
    if (!withMarker.length) return { ids: new Set(), error: `marker not found: "${marker.slice(0, 40)}"` };
    pool = withMarker;
  }
  return { ids: new Set(pool.map((p) => p.id)), chunks: pool };
}

// ── search ───────────────────────────────────────────────────────────────────
async function vectorSearch(collection, vector, limit) {
  const res = await fetch(`${QDRANT}/collections/${collection}/points/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vector, limit, with_payload: true }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`search failed: ${JSON.stringify(data).slice(0, 200)}`);
  return data.result || [];
}

// ── metrics ──────────────────────────────────────────────────────────────────
function summarize(rows) {
  const n = rows.length;
  if (!n) return null;
  const at = (k) => rows.filter((r) => r.rank && r.rank <= k).length / n;
  const mrr = rows.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / n;
  return {
    n,
    'Recall@1': at(1),
    'Recall@5': at(5),
    'Recall@10': at(10),
    'Recall@20': at(20),
    MRR: mrr,
  };
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;

function printGroup(name, rows) {
  const m = summarize(rows);
  if (!m) return;
  console.log(
    `${name.padEnd(26)} n=${String(m.n).padStart(3)}  ` +
      `R@1 ${pct(m['Recall@1']).padStart(6)}  R@5 ${pct(m['Recall@5']).padStart(6)}  ` +
      `R@10 ${pct(m['Recall@10']).padStart(6)}  R@20 ${pct(m['Recall@20']).padStart(6)}  ` +
      `MRR ${m.MRR.toFixed(3)}`
  );
}

// ── main ─────────────────────────────────────────────────────────────────────
const embed = await getEmbedder();
const corpus = await scrollAll(COLLECTION);
console.log(`\n### EVAL: ${LABEL}`);
console.log(`collection: ${COLLECTION} (${corpus.length} points) | dataset: ${DATASET.length} cases\n`);

const { scoreRecordMatch, bm25Score } = await import('../src/utils/textMatch.js');

const rows = [];
const groundTruthErrors = [];

for (const c of DATASET) {
  const target = resolveTargets(corpus, c);
  if (target.error) {
    groundTruthErrors.push(`${c.id}: ${target.error}`);
    rows.push({ ...c, rank: null, invalid: true });
    continue;
  }

  const vec = await embed(c.question);
  const hits = await vectorSearch(COLLECTION, vec, K_MAX);
  const pos = hits.findIndex((h) => target.ids.has(h.id));
  const hit = pos >= 0 ? hits[pos] : null;

  // Lexical signals for the EXPECTED record (diagnostic, not used for ranking here).
  const expectedPayload = target.chunks[0]?.payload || {};
  const kw = scoreRecordMatch(c.question, expectedPayload).score;
  const doc = [expectedPayload.title, expectedPayload.projectName, expectedPayload.text]
    .filter(Boolean)
    .join(' ');
  const bm = bm25Score(c.question, doc);

  rows.push({
    ...c,
    rank: pos >= 0 ? pos + 1 : null,
    vectorScore: hit?.score ?? null,
    keywordScore: kw,
    bm25: bm,
    targetChunks: target.ids.size,
    topHit: hits[0]?.payload?.title,
  });
}

// ── per-case table ───────────────────────────────────────────────────────────
console.log('id   lang            type          rank  vec     kw     bm25   expected');
console.log('-'.repeat(108));
for (const r of rows) {
  console.log(
    `${r.id.padEnd(5)}${(r.language || '').padEnd(16)}${(r.queryType || '').padEnd(14)}` +
      `${(r.rank ? String(r.rank) : r.invalid ? 'GT!' : '>20').padStart(4)}  ` +
      `${(r.vectorScore != null ? r.vectorScore.toFixed(3) : '  -  ').padStart(6)}  ` +
      `${(r.keywordScore ?? 0).toFixed(2).padStart(5)}  ` +
      `${(r.bm25 ?? 0).toFixed(2).padStart(5)}  ` +
      `${String(r.expect.meetingTitle || r.expect.titleExact || '').slice(0, 42)}`
  );
}

if (groundTruthErrors.length) {
  console.log(`\n!! GROUND TRUTH PROBLEMS (${groundTruthErrors.length}) — excluded from metrics:`);
  groundTruthErrors.forEach((e) => console.log('   ' + e));
}

const valid = rows.filter((r) => !r.invalid);

console.log('\n────────────────────────── OVERALL ──────────────────────────');
printGroup('ALL', valid);

console.log('\n────────────────────── BY LANGUAGE ───────────────────────');
printGroup('English (en->en)', valid.filter((r) => r.language === 'en->en'));
printGroup('Hindi/Hinglish (all)', valid.filter((r) => r.language !== 'en->en'));
printGroup('  en->hi / en->hinglish', valid.filter((r) => r.language === 'en->hi' || r.language === 'en->hinglish'));
printGroup('  hi->hi / hinglish->hi', valid.filter((r) => r.language === 'hi->hi' || r.language === 'hinglish->hi'));

console.log('\n────────────────────── BY CATEGORY ───────────────────────');
printGroup('Meeting transcript', valid.filter((r) => r.category === 'meeting-transcript'));
printGroup('Structured SharePoint', valid.filter((r) => r.category === 'structured'));

console.log('\n──────────────────── BY QUERY TYPE ───────────────────────');
printGroup('Exact keyword/title', valid.filter((r) => r.queryType === 'exact-title'));
printGroup('Semantic/paraphrased', valid.filter((r) => r.queryType === 'paraphrased' || r.queryType === 'semantic'));
printGroup('Person/owner', valid.filter((r) => r.queryType === 'person'));
printGroup('Status', valid.filter((r) => r.queryType === 'status'));
printGroup('Latest/recent', valid.filter((r) => r.queryType === 'recent'));
printGroup('Date-specific', valid.filter((r) => r.queryType === 'date'));
printGroup('Action-item', valid.filter((r) => r.queryType === 'action-item'));
printGroup('Transcript begin', valid.filter((r) => r.queryType === 'begin'));
printGroup('Transcript middle', valid.filter((r) => r.queryType === 'middle'));
printGroup('Transcript end', valid.filter((r) => r.queryType === 'end'));

// Machine-readable output for cross-model comparison.
if (process.env.EVAL_JSON) {
  const out = { label: LABEL, collection: COLLECTION, overall: summarize(valid), rows };
  await (await import('node:fs/promises')).writeFile(process.env.EVAL_JSON, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${process.env.EVAL_JSON}`);
}
