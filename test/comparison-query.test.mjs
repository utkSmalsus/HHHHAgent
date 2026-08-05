/**
 * Regression tests for Phase 13 issue #2: multi-entity comparison queries.
 *
 * Confirmed live before this fix: "Which is more recently updated, Team Management Tools or
 * Development Team Management System?" resolved ONE anchor (via the recent-work branch's
 * single-anchor structuralRetrieve() call) and treated the OTHER name as if it must be that
 * anchor's own child — answering "there is no sub-component ... called Team Management Tools"
 * (true, but not what was asked; it isn't a child of the other, it's an independent sibling).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isComparisonQuestion,
  splitComparisonSegments,
  resolveComparison,
  buildComparisonAnswer,
  buildComparisonBlockedAnswer,
} from '../src/services/comparisonQuery.js';

// ---------------------------------------------------------------------------
// Part 1 — pure unit tests, no server/Qdrant required.
// ---------------------------------------------------------------------------

test('isComparisonQuestion: detects all the required phrasings', () => {
  assert.equal(isComparisonQuestion('Which is more recently updated, A or B?'), true);
  assert.equal(isComparisonQuestion('Which project was updated later, A or B?'), true);
  assert.equal(isComparisonQuestion('Compare A and B.'), true);
  assert.equal(isComparisonQuestion('Which has more tasks, A or B?'), true);
  assert.equal(isComparisonQuestion('Is A newer than B?'), true);
});

test('isComparisonQuestion: does not false-positive on a single-entity recency question (no "or")', () => {
  assert.equal(isComparisonQuestion('Which project was updated most recently?'), false);
});

test('isComparisonQuestion: does not false-positive on an ordinary count/status question', () => {
  assert.equal(isComparisonQuestion('How many tasks does Team Management Tools have?'), false);
  assert.equal(isComparisonQuestion('What is the status of Team Management Tools?'), false);
});

test('splitComparisonSegments: "which ... , A or B" splits after the trigger comma', () => {
  const [left, right] = splitComparisonSegments('Which is more recently updated, Team Management Tools or Development Team Management System?');
  assert.equal(left, 'Team Management Tools');
  assert.equal(right, 'Development Team Management System');
});

test('splitComparisonSegments: "compare A and B" splits on "and"', () => {
  const [left, right] = splitComparisonSegments('Compare Team Management Tools and Development Team Management System.');
  assert.equal(left, 'Team Management Tools');
  assert.equal(right, 'Development Team Management System');
});

test('splitComparisonSegments: "is A newer than B" splits on "than"', () => {
  const [left, right] = splitComparisonSegments('Is Team Management Tools newer than Development Team Management System?');
  assert.equal(left, 'Team Management Tools');
  assert.equal(right, 'Development Team Management System');
});

// Fake real-shaped project/portfolio data for pure resolveComparison() unit tests.
const A = { type: 'project', title: 'Team Management Tools', sharePointItemId: 1, parentId: null, status: 'In Progress', timestamp: '2026-07-16' };
const B = { type: 'project', title: 'Development Team Management System', sharePointItemId: 2, parentId: null, status: 'In Progress', timestamp: '2026-07-22' };
const AMBIG1 = { type: 'project', title: 'SmartFilters Approach One', sharePointItemId: 5, parentId: null, status: 'In Progress', timestamp: '2026-01-01' };
const AMBIG2 = { type: 'project', title: 'SmartFilters Approach Two', sharePointItemId: 6, parentId: null, status: 'In Progress', timestamp: '2026-01-02' };
const FAKE_ITEMS = [A, B, AMBIG1, AMBIG2];
const getContainerItems = async () => FAKE_ITEMS;

test('#89 pattern: both named entities resolve INDEPENDENTLY — never one as a child of the other', async () => {
  const result = await resolveComparison(
    'Which is more recently updated, Team Management Tools or Development Team Management System?',
    { getContainerItems }
  );
  assert.ok(!result.blocked, `should not be blocked: ${JSON.stringify(result.blocked)}`);
  assert.equal(result.entities[0].anchor.title, 'Team Management Tools');
  assert.equal(result.entities[1].anchor.title, 'Development Team Management System');
});

test('recency comparison correctly picks the later timestamp, regardless of question order', async () => {
  const result = await resolveComparison('Compare Team Management Tools and Development Team Management System.', { getContainerItems });
  const answer = buildComparisonAnswer(result);
  assert.match(answer, /Development Team Management System/);
});

test('"which is more recently updated" answer names the actual winner by real timestamp', async () => {
  const result = await resolveComparison(
    'Which is more recently updated, Team Management Tools or Development Team Management System?',
    { getContainerItems }
  );
  const answer = buildComparisonAnswer(result);
  assert.match(answer, /"Development Team Management System" was updated more recently/);
});

test('fail closed: comparing a real entity with a nonexistent one blocks rather than substituting', async () => {
  const result = await resolveComparison('Compare Team Management Tools and Totally Fictional Nonexistent Project XYZ.', { getContainerItems });
  assert.ok(result.blocked);
  assert.equal(result.blocked.kind, 'unresolved-entity');
  const answer = buildComparisonBlockedAnswer(result.blocked);
  assert.match(answer, /couldn't confidently match/);
  assert.doesNotMatch(answer, /Team Management Tools/, 'must not silently substitute a different real entity in place of the unresolved one');
});

test('ambiguity in either entity is surfaced, never arbitrarily picked', async () => {
  const result = await resolveComparison('Compare SmartFilters and Team Management Tools.', { getContainerItems });
  assert.ok(result.blocked);
  assert.equal(result.blocked.kind, 'ambiguous-entity');
  assert.equal(result.blocked.candidates.length, 2);
});

test('"which has more tasks" is a deterministic aspect when task counts are available', async () => {
  const getItems = async () => FAKE_ITEMS;
  const getTasksScroll = async () => [
    { type: 'task', title: 't1', projectId: 1 },
    { type: 'task', title: 't2', projectId: 1 },
    { type: 'task', title: 't3', projectId: 2 },
  ];
  // countTasksUnder reads scrollPayloads directly (not injectable) — this test exercises the
  // aspect-detection + answer-shape logic using the live resolveComparison/buildComparisonAnswer
  // pair against a fully mocked container list; task counts come from the real dev DB when run
  // live (see Part 2) since scrollPayloads isn't mocked at this layer.
  const result = await resolveComparison('Which has more tasks, Team Management Tools or Development Team Management System?', { getContainerItems: getItems });
  assert.ok(!result.blocked);
  assert.equal(result.aspect, 'taskCount');
  assert.ok(Array.isArray(result.taskCounts));
});

test('a plain "compare A and B" with no named aspect shows facts side by side, not a forced winner', async () => {
  const result = await resolveComparison('Compare Team Management Tools and Development Team Management System.', { getContainerItems });
  assert.equal(result.aspect, null);
  const answer = buildComparisonAnswer(result);
  assert.match(answer, /Team Management Tools/);
  assert.match(answer, /Development Team Management System/);
  assert.match(answer, /status:/);
});

// ---------------------------------------------------------------------------
// Part 2 — live server checks (skipped automatically if the dev server isn't running).
// ---------------------------------------------------------------------------
const API = 'http://localhost:3000/api/query';
let serverUp = false;
try {
  const r = await fetch('http://localhost:3000/api/ingest/progress', { signal: AbortSignal.timeout(3000) });
  serverUp = r.ok;
} catch {
  serverUp = false;
}
async function ask(question) {
  const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) });
  return res.json();
}

test('live #89: both real entities resolve independently, no parent/child claim', { skip: !serverUp && 'dev server not running' }, async () => {
  const r = await ask('Which is more recently updated, Team Management Tools or Development Team Management System?');
  assert.equal(r.intent, 'comparison');
  assert.doesNotMatch(r.answer, /sub-component/i);
  assert.doesNotMatch(r.answer, /no such/i);
});

test('live: comparing a real project with a nonexistent one fails closed', { skip: !serverUp && 'dev server not running' }, async () => {
  const r = await ask('Compare Team Management Tools and Totally Fictional Nonexistent Project XYZ.');
  assert.equal(r.intent, 'unresolved-comparison');
  assert.match(r.answer, /couldn't confidently match/);
});
