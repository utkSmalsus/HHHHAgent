/**
 * Regression tests for the container (project/portfolio) and temporal (date) structured-filter
 * fix — same silent-global bug class as the person/status fix (see structured-filters.test.mjs),
 * now for "how many tasks does TEAM MANAGEMENT TOOLS have" (was answering 14,581, the whole
 * collection) and for date-scoped questions ("which projects were updated yesterday", "latest 5
 * projects") which were previously mis-routed to disambiguation garbage or vague LLM summaries.
 *
 * Part 1 (pure, no server): unit tests for the entity-title/vocabulary collision guards in
 * structuredFilters.js — three were found LIVE while building this fix, each a real project/
 * portfolio whose title happens to contain a word this module's own filter vocabulary uses
 * ("Annex Updated", "Week Task Distribution", "Overdue Projects", "Annex II 2026").
 * Part 2 (live, requires `npm start` + real Qdrant data): the 20 scenarios from the task spec.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveContainerFilter,
  resolveDateFilter,
  applyDateRange,
  applyDateSort,
} from '../src/services/structuredFilters.js';

const FAKE_CONTAINERS = [
  { type: 'project', title: 'Team Management Tools', sharePointItemId: 1, parentId: 2, timestamp: '2026-07-16' },
  { type: 'project', title: 'Development Team Management System', sharePointItemId: 2, parentId: null, timestamp: '2026-07-22' },
  // The exact real-data collisions found live — vocabulary this module strips being ALSO a real title.
  { type: 'portfolio', title: 'Annex Updated', sharePointItemId: 10, parentId: null, timestamp: '2025-01-01' },
  { type: 'portfolio', title: 'Week Task Distribution', sharePointItemId: 11, parentId: null, timestamp: '2025-01-01' },
  { type: 'portfolio', title: 'Overdue Projects', sharePointItemId: 12, parentId: null, timestamp: '2025-01-01' },
  { type: 'project', title: 'Annex II 2026', sharePointItemId: 13, parentId: null, timestamp: '2025-01-01' },
];
const getContainerItems = async () => FAKE_CONTAINERS;
const resolve = (q) => resolveContainerFilter(q, { getContainerItems });

// ---------------------------------------------------------------------------
// Part 1 — vocabulary/entity-title collision guards (found live during this fix)
// ---------------------------------------------------------------------------
test('a real project resolves correctly by name (baseline, no collision)', async () => {
  const r = await resolve('How many tasks does Team Management Tools have?');
  assert.equal(r.resolved?.title, 'Team Management Tools');
});

test('"most recently UPDATED project" does not anchor to a portfolio literally named "Annex Updated"', async () => {
  const r = await resolve('What is the most recently updated project?');
  assert.equal(r.requested, false, 'a pure recency question has no real container reference');
  assert.equal(r.resolved, null);
});

test('"updated this WEEK" does not anchor to a portfolio literally named "Week Task Distribution"', async () => {
  const r = await resolve('Which projects were updated this week?');
  assert.equal(r.requested, false);
  assert.equal(r.resolved, null);
});

test('"how many OVERDUE tasks" does not anchor to a portfolio literally named "Overdue Projects"', async () => {
  const r = await resolve('How many overdue tasks are there?');
  assert.equal(r.requested, false);
  assert.equal(r.resolved, null);
});

test('an explicit date ("02/08/2026") does not anchor to a project literally named "Annex II 2026"', async () => {
  const r = await resolve('How many tasks were due on 02/08/2026?');
  assert.equal(r.requested, false);
  assert.equal(r.resolved, null);
});

test('a bogus project name still fails closed (requested but unresolved)', async () => {
  const r = await resolve('How many tasks does Fake Project XYZ have?');
  assert.equal(r.requested, true);
  assert.equal(r.resolved, null);
  assert.equal(r.candidateText, 'Fake Project XYZ');
});

test('resolveDateFilter: recency sort has no range, just a descending sort spec', () => {
  const r = resolveDateFilter('Show the latest 5 projects.', 'project');
  assert.equal(r.sort?.field, 'timestamp');
  assert.equal(r.sort?.direction, 'desc');
  assert.equal(r.range, null);
});

test('resolveDateFilter: "due" phrasing picks dueDate for tasks, timestamp for projects', () => {
  assert.equal(resolveDateFilter('tasks due today', 'task').field, 'dueDate');
  assert.equal(resolveDateFilter('projects updated today', 'project').field, 'timestamp');
});

test('resolveDateFilter: malformed date fails closed, not silently ignored', () => {
  const r = resolveDateFilter('which tasks were due on 45/67/2026', 'task');
  assert.equal(r.requested, true);
  assert.equal(r.unresolvable, true);
});

test('applyDateRange / applyDateSort compose correctly on a small fixture', () => {
  const items = [
    { title: 'A', timestamp: '2026-01-01' },
    { title: 'B', timestamp: '2026-06-01' },
    { title: 'C', timestamp: '2026-03-01' },
  ];
  const ranged = applyDateRange(items, { requested: true, field: 'timestamp', range: { start: new Date('2026-02-01'), end: new Date('2026-12-01') } });
  assert.deepEqual(ranged.map((i) => i.title), ['B', 'C']);
  const sorted = applyDateSort(items, { sort: { field: 'timestamp', direction: 'desc' } });
  assert.deepEqual(sorted.map((i) => i.title), ['B', 'C', 'A']);
});

// ---------------------------------------------------------------------------
// Part 2 — live, the 20 scenarios from the task spec
// ---------------------------------------------------------------------------
const API = 'http://localhost:3000/api/query';
async function ask(question) {
  const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) });
  return res.json();
}
const numIn = (s) => Number((String(s || '').match(/\d[\d,]*/) || ['0'])[0].replace(/,/g, ''));

let serverUp = false;
try {
  const r = await fetch('http://localhost:3000/api/ingest/progress', { signal: AbortSignal.timeout(2000) });
  serverUp = r.ok;
} catch {
  serverUp = false;
}

test('1. "How many tasks does Team Management Tools have?" — scoped, not global 14581', { skip: !serverUp }, async () => {
  const j = await ask('How many tasks does Team Management Tools have?');
  assert.match(j.answer, /Team Management Tools/);
  assert.ok(numIn(j.answer) < 5000);
});

test('2. "Show tasks for Team Management Tools." — real task list (pre-existing hierarchy path)', { skip: !serverUp }, async () => {
  const j = await ask('Show tasks for Team Management Tools.');
  assert.equal(j.intent, 'hierarchy');
  assert.ok((j.sources?.qdrant || []).length > 0);
});

test('3. "How many overdue tasks does Team Management Tools have?" — container + overdue both retained', { skip: !serverUp }, async () => {
  const j = await ask('How many overdue tasks does Team Management Tools have?');
  assert.match(j.answer, /Team Management Tools/);
  assert.ok(numIn(j.answer) < 1000, 'must not be the ~1104 global overdue count');
});

test('4. "How many completed tasks does Team Management Tools have?" — container + status both retained', { skip: !serverUp }, async () => {
  const j = await ask('How many completed tasks does Team Management Tools have?');
  assert.match(j.answer, /Team Management Tools/);
});

test('5. "How many tasks does Ranu Trivedi have in Team Management Tools?" — person + container', { skip: !serverUp }, async () => {
  const j = await ask('How many tasks does Ranu Trivedi have in Team Management Tools?');
  assert.match(j.answer, /Ranu Trivedi/);
  assert.match(j.answer, /Team Management Tools/);
});

test('6. "How many overdue tasks does Ranu Trivedi have in Team Management Tools?" — all three filters', { skip: !serverUp }, async () => {
  const j = await ask('How many overdue tasks does Ranu Trivedi have in Team Management Tools?');
  assert.match(j.answer, /Ranu Trivedi/);
  assert.match(j.answer, /Team Management Tools/);
});

test('7. nonexistent project must NOT return the global count', { skip: !serverUp }, async () => {
  const j = await ask('How many tasks does Fake Project XYZ have?');
  assert.equal(j.intent, 'unresolved-container-filter');
  assert.ok(numIn(j.answer) < 5000);
});

test('8. portfolio vs project semantics distinguished correctly by title', { skip: !serverUp }, async () => {
  const j = await ask('How many tasks belong to Team Management System (Hardware/Software and Licenses)?');
  assert.match(j.answer, /Team Management System \(Hardware\/Software and Licenses\)/);
});

test('9. "Which projects were updated yesterday?" — real deterministic list, not an LLM summary', { skip: !serverUp }, async () => {
  const j = await ask('Which projects were updated yesterday?');
  assert.equal(j.intent, 'date-list');
});

test('10. "Which tasks are due today?" — deterministic, not disambiguation garbage', { skip: !serverUp }, async () => {
  const j = await ask('Which tasks are due today?');
  assert.equal(j.intent, 'date-list');
});

test('11. "Which tasks were due yesterday?" — deterministic, not a generic fallback', { skip: !serverUp }, async () => {
  const j = await ask('Which tasks were due yesterday?');
  assert.equal(j.intent, 'date-list');
});

test('12. "What meetings happened yesterday?" — untouched, still routes to meetingQuery.js', { skip: !serverUp }, async () => {
  const j = await ask('What meetings happened yesterday?');
  assert.equal(j.intent, 'meeting-detail');
});

test('13. "What is the most recently updated project?" — real sort, single result', { skip: !serverUp }, async () => {
  const j = await ask('What is the most recently updated project?');
  assert.equal(j.intent, 'date-list');
  assert.equal((j.sources?.qdrant || []).length, 1);
});

test('14. "Show the latest 5 projects." — real Modified-descending order, exactly 5', { skip: !serverUp }, async () => {
  const j = await ask('Show the latest 5 projects.');
  assert.equal(j.intent, 'date-list');
  const items = (j.sources?.qdrant || []).map((s) => s.payload);
  assert.equal(items.length, 5);
  const dates = items.map((p) => p.timestamp);
  const sorted = [...dates].sort().reverse();
  assert.deepEqual(dates, sorted, 'must be true Modified-descending order, not semantic ranking');
});

test('15. "Which projects were updated this week?" — real deterministic list', { skip: !serverUp }, async () => {
  const j = await ask('Which projects were updated this week?');
  assert.equal(j.intent, 'date-list');
});

test('16. "How many tasks did Ranu Trivedi have due this week?" — person + date both retained', { skip: !serverUp }, async () => {
  const j = await ask('How many tasks did Ranu Trivedi have due this week?');
  assert.match(j.answer, /Ranu Trivedi/);
});

test('17. "How many overdue tasks does Ranu have in Team Management Tools?" — bare first name + project + overdue', { skip: !serverUp }, async () => {
  const j = await ask('How many overdue tasks does Ranu have in Team Management Tools?');
  assert.match(j.answer, /Ranu Trivedi/, 'bare first name must still resolve to the full real owner name');
  assert.match(j.answer, /Team Management Tools/);
});

test('18. explicit real date resolves deterministically (not a container false-match)', { skip: !serverUp }, async () => {
  const j = await ask('How many tasks were due on 02/08/2026?');
  assert.equal(j.intent, 'count');
  assert.doesNotMatch(j.answer, /Annex/, 'must not anchor to an unrelated project via the literal year');
});

test('19. invalid date expression fails closed', { skip: !serverUp }, async () => {
  const j = await ask('Which tasks were due on 45/67/2026?');
  assert.equal(j.intent, 'unresolved-date-filter');
});

test('20. normal global query is unaffected', { skip: !serverUp }, async () => {
  const j = await ask('How many tasks are there?');
  assert.equal(j.intent, 'count');
  assert.ok(numIn(j.answer) > 5000);
});

// Invariant: person/status/overdue fix from the prior phase must still work identically.
test('invariant: the prior person/status fix is unaffected by this phase\'s changes', { skip: !serverUp }, async () => {
  const j1 = await ask('How many tasks does Ranu Trivedi have?');
  assert.match(j1.answer, /Ranu Trivedi/);
  assert.ok(numIn(j1.answer) < 5000);
  const j2 = await ask('How many overdue tasks are there?');
  assert.ok(numIn(j2.answer) > 500, 'genuinely global overdue count must be unaffected by the container guard');
});
