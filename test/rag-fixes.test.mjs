/**
 * Focused regression checks for the RAG correctness fixes.
 * Run: npm test   (node --test, no framework/fixtures needed)
 *
 * These are pure-function checks only — no Qdrant/Ollama required, so they run anywhere.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { rankBm25Candidates } from '../src/services/hybridSearch.js';
import { scoreRecordMatch, bm25Score } from '../src/utils/textMatch.js';
import { chunkText } from '../src/utils/chunking.js';

// ---------------------------------------------------------------------------
// Fix 1 — BM25 candidates were dropped because the filter/sort read `r.bm25`
// while the built property is `r.bm25Score` (undefined > 0 === false, and
// undefined + n === NaN so the comparator never ordered anything).
// ---------------------------------------------------------------------------
test('BM25-only candidate survives the gate (was dropped by the r.bm25 typo)', () => {
  const query = 'quarterly revenue forecast';
  // Matches ONE query term in its title and nothing else — a real BM25 hit, but
  // scoreRecordMatch drops to ~0.035 (below the 0.2 keyword-gate threshold).
  const bm25OnlyPayload = { type: 'task', title: 'Quarterly Report', text: '' };

  const match = scoreRecordMatch(query, bm25OnlyPayload);
  assert.ok(match.score <= 0.2, `precondition: match.score should be <=0.2, got ${match.score}`);
  assert.ok(bm25Score(query, 'Quarterly Report') > 0, 'precondition: should have a real BM25 score');

  const ranked = rankBm25Candidates(query, [bm25OnlyPayload], { intent: 'summary' });
  assert.equal(ranked.length, 1, 'BM25-only candidate must not be filtered out');
  assert.ok(ranked[0].bm25Score > 0, 'bm25Score must be populated on the result');
});

test('BM25 actually orders results (comparator returned NaN before the fix)', () => {
  const query = 'quarterly revenue forecast';
  const weak = { type: 'task', title: 'Quarterly Report', text: '' };
  const strong = { type: 'task', title: 'Quarterly Revenue Forecast Report', text: '' };

  const ranked = rankBm25Candidates(query, [weak, strong], { intent: 'summary' });
  assert.equal(ranked.length, 2);
  assert.equal(
    ranked[0].payload.title,
    'Quarterly Revenue Forecast Report',
    'the stronger BM25/keyword match must sort first'
  );
  assert.ok(ranked[0].bm25Score >= ranked[1].bm25Score, 'results must be ordered by real scores');
});

// ---------------------------------------------------------------------------
// Fix 3 — long transcripts must be chunked (not truncated), so content at the
// START, MIDDLE and END all remain reachable.
// ---------------------------------------------------------------------------
test('chunkText covers a long transcript start-to-end with no content loss', () => {
  const marker = (s) => `UNIQUE_MARKER_${s}`;
  const filler = 'यह एक लंबी बैठक की चर्चा है। We discussed the roadmap in detail. '.repeat(400);
  const transcript = [
    marker('START'),
    filler,
    marker('MIDDLE'),
    filler,
    marker('END'),
  ].join('\n\n');

  assert.ok(transcript.length > 8000, 'precondition: transcript must exceed the old 8000 cap');

  const chunks = chunkText(transcript);
  assert.ok(chunks.length > 1, 'a long transcript must produce multiple chunks');

  for (const where of ['START', 'MIDDLE', 'END']) {
    assert.ok(
      chunks.some((c) => c.includes(marker(where))),
      `content at ${where} must survive chunking (old slice(0,8000) lost MIDDLE/END)`
    );
  }
});
