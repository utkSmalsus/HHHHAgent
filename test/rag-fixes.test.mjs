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
import { isHierarchyQuestion } from '../src/services/structuralRetrieve.js';
import { isOwnedByPersonQuestion } from '../src/services/ownerLookup.js';
import { isExactLookupQuestion } from '../src/services/exactLookup.js';

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
// Entity-scoped phrasings must route to the deterministic tree walk rather than
// the generic capped hybrid path (which returns ~10 similarity-ranked chunks and
// silently omits most of a project's real tasks).
// ---------------------------------------------------------------------------
test('"going on in / happening in / status of / update on X" route to the tree walk', () => {
  for (const q of [
    'what is going on in Development Team Management System',
    "what's going on in Team Management Tools",
    'what is happening in the Meeting Tool project',
    'status of Team Management Tools',
    'update on Task Profile Migration SPA',
  ]) {
    assert.ok(isHierarchyQuestion(q), `should route to structural retrieval: "${q}"`);
  }
});

test('the new patterns do not swallow ownership or exact-lookup questions', () => {
  // These are handled by earlier branches in query.js; they must keep matching there.
  for (const q of ['which tasks belong to Deepak Trivedi', 'tasks owned by Ranu Trivedi']) {
    assert.ok(isOwnedByPersonQuestion(q), `ownership question must still match: "${q}"`);
  }
  for (const q of ['show me the comments on Team Management issues', 'description of the SmartSearch task']) {
    assert.ok(isExactLookupQuestion(q), `exact-lookup question must still match: "${q}"`);
  }
  // A plain topical question with no container phrasing must NOT be forced down the walk.
  assert.ok(!isHierarchyQuestion('who attended the SCRUM meeting'), 'plain question should not route structurally');
});

// ---------------------------------------------------------------------------
// A week/month-scale period is a LIST question and must not be resolved to one
// meeting (the NL date parser collapses "last week" to a single day).
// ---------------------------------------------------------------------------
test('period phrases do not resolve to a single meeting', async () => {
  const { resolveMeetingByExplicitDate } = await import('../src/services/meetingQuery.js');
  const now = new Date('2026-08-04T12:00:00Z');
  for (const q of [
    'What meetings happened last week?',
    'what meetings did we have this week',
    'meetings last month',
    'recent meetings',
  ]) {
    assert.equal(await resolveMeetingByExplicitDate(q, now), null, `must not pick one meeting for: "${q}"`);
  }
});

test('a genuine single calendar date still resolves to its meeting', async () => {
  const { resolveMeetingByExplicitDate } = await import('../src/services/meetingQuery.js');
  const now = new Date('2026-08-04T12:00:00Z');
  const hit = await resolveMeetingByExplicitDate('summarize the scrum 25/06/2026 meeting', now);
  assert.ok(hit, 'an explicit date must still resolve a meeting');
  assert.match(hit.title, /25\/06\/2026/, `expected the 25/06/2026 meeting, got "${hit.title}"`);
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
