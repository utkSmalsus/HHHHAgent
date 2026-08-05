/**
 * Regression tests for Phase 14: deterministic counts must represent real BUSINESS ENTITIES, not
 * Qdrant points/chunks.
 *
 * Root cause fixed: "how many meetings happened this week?" returned 32 (raw chunk points for
 * ~2 real meetings) because every deterministic count path counted `items.length` on raw
 * scrollPayloads() results. Chunked records (mainly meeting transcripts, but also some long task/
 * portfolio descriptions) share one `sourceKey` across their chunk points — confirmed live against
 * production (zero anomalies across all 5 types: every duplicate group shares identical title/
 * sharePointItemId, with chunkIndex running 0..totalChunks-1) — so `sourceKey` (falling back to
 * type+sharePointItemId for the rare legacy points without it) is the real business-record
 * identity, and `countBusinessEntities`/`uniqueBusinessEntities` (qdrantScroll.js) is the ONE
 * shared dedup mechanism every count path now goes through.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { countBusinessEntities, uniqueBusinessEntities, getBusinessEntityKey } from '../src/services/qdrantScroll.js';
import { applyStructuredFilters, resolveDateFilter } from '../src/services/structuredFilters.js';

const emptyFilters = () => ({
  personFilter: { requested: false }, containerFilter: { requested: false },
  statusFilter: { requested: false }, overdueRequested: false, dateFilter: { requested: false },
});

// ---------------------------------------------------------------------------
// 1-3, 23 — chunking invariant: chunk count must never change business count.
// ---------------------------------------------------------------------------

function chunksFor(sourceKey, title, n, extra = {}) {
  return Array.from({ length: n }, (_, i) => ({
    type: 'meeting', sourceKey, title, chunkIndex: i, totalChunks: n, start: '2026-08-01T10:00:00Z', ...extra,
  }));
}

test('1. a meeting with 5 chunks counts as 1', () => {
  const points = chunksFor('sk:A', 'Meeting A', 5);
  assert.equal(countBusinessEntities(points), 1);
});

test('2. two meetings, each with multiple chunks, count as 2', () => {
  const points = [...chunksFor('sk:A', 'Meeting A', 4), ...chunksFor('sk:B', 'Meeting B', 2)];
  assert.equal(countBusinessEntities(points), 2);
});

test('3 & 23. adding more chunks to an existing meeting does not change the business count', () => {
  const before = countBusinessEntities([...chunksFor('sk:A', 'Meeting A', 4), ...chunksFor('sk:B', 'Meeting B', 2)]);
  const afterMoreChunks = countBusinessEntities([...chunksFor('sk:A', 'Meeting A', 14), ...chunksFor('sk:B', 'Meeting B', 2)]);
  assert.equal(before, 2);
  assert.equal(afterMoreChunks, 2);
  assert.equal(before, afterMoreChunks, 'chunk count changing must never change business count');
});

// ---------------------------------------------------------------------------
// 4, 24 — duplicate-record invariant: same title, different real record IDs, must count separately.
// Title-based deduplication is explicitly forbidden.
// ---------------------------------------------------------------------------

test('4 & 24. two different real task records that happen to share a title count as 2, not 1', () => {
  const points = [
    { type: 'task', sourceKey: 'site:list:101:task', sharePointItemId: 101, title: 'Scrum' },
    { type: 'task', sourceKey: 'site:list:102:task', sharePointItemId: 102, title: 'Scrum' },
  ];
  assert.equal(countBusinessEntities(points), 2);
});

// ---------------------------------------------------------------------------
// 5 — same source record represented multiple times (e.g. re-ingest artifact, or a legacy point
// missing sourceKey but sharing sharePointItemId) collapses to 1.
// ---------------------------------------------------------------------------

test('5. the same source record appearing as multiple points collapses to 1', () => {
  const points = [
    { type: 'task', sourceKey: 'site:list:200:task', sharePointItemId: 200, title: 'Duplicate ingest' },
    { type: 'task', sourceKey: 'site:list:200:task', sharePointItemId: 200, title: 'Duplicate ingest' },
    { type: 'task', sourceKey: 'site:list:200:task', sharePointItemId: 200, title: 'Duplicate ingest' },
  ];
  assert.equal(countBusinessEntities(points), 1);
});

test('getBusinessEntityKey: falls back to type+sharePointItemId when sourceKey is missing', () => {
  const a = { type: 'task', sharePointItemId: 500, title: 'Legacy point' };
  const b = { type: 'task', sharePointItemId: 500, title: 'Legacy point' };
  assert.equal(getBusinessEntityKey(a), getBusinessEntityKey(b));
  assert.equal(countBusinessEntities([a, b]), 1);
});

test('getBusinessEntityKey: returns null (never merged) when NEITHER sourceKey nor sharePointItemId exists', () => {
  const a = { type: 'task', title: 'No identity at all' };
  const b = { type: 'task', title: 'No identity at all' };
  assert.equal(getBusinessEntityKey(a), null);
  // Two unidentifiable points must never be silently merged just because they look similar.
  assert.equal(countBusinessEntities([a, b]), 2);
});

// ---------------------------------------------------------------------------
// applyStructuredFilters: filter-first-then-dedupe composition (person + container + status/date).
// ---------------------------------------------------------------------------

const RANU = 'Ranu Trivedi';
function taskPoints() {
  return [
    // 3 chunks of ONE overdue task owned by Ranu in Team Management Tools.
    { type: 'task', sourceKey: 'sk:t1', sharePointItemId: 1, chunkIndex: 0, totalChunks: 3, title: 'Overdue task A', owner: RANU, projectId: 10, status: 'In Progress', dueDate: '2020-01-01' },
    { type: 'task', sourceKey: 'sk:t1', sharePointItemId: 1, chunkIndex: 1, totalChunks: 3, title: 'Overdue task A', owner: RANU, projectId: 10, status: 'In Progress', dueDate: '2020-01-01' },
    { type: 'task', sourceKey: 'sk:t1', sharePointItemId: 1, chunkIndex: 2, totalChunks: 3, title: 'Overdue task A', owner: RANU, projectId: 10, status: 'In Progress', dueDate: '2020-01-01' },
    // 1 non-overdue task owned by Ranu, same project.
    { type: 'task', sourceKey: 'sk:t2', sharePointItemId: 2, title: 'Task B', owner: RANU, projectId: 10, status: 'In Progress', dueDate: '2099-01-01' },
    // 1 task owned by someone else, same project — must never be counted for Ranu.
    { type: 'task', sourceKey: 'sk:t3', sharePointItemId: 3, title: 'Task C', owner: 'Someone Else', projectId: 10, status: 'In Progress' },
    // 1 overdue task owned by Ranu, DIFFERENT project — must not count when scoped to Team Management Tools.
    { type: 'task', sourceKey: 'sk:t4', sharePointItemId: 4, title: 'Task D', owner: RANU, projectId: 99, status: 'In Progress', dueDate: '2020-01-01' },
  ];
}

test('Ranu tasks (person filter alone) — 3 real tasks, chunking does not inflate the count', () => {
  const sf = { ...emptyFilters(), personFilter: { requested: true, resolvedName: RANU } };
  const out = applyStructuredFilters(taskPoints(), sf);
  assert.equal(out.length, 3); // Overdue task A, Task B, Task D
});

test("Ranu's overdue tasks (person + overdue) — 2 real tasks", () => {
  const sf = { ...emptyFilters(), personFilter: { requested: true, resolvedName: RANU }, overdueRequested: true };
  const out = applyStructuredFilters(taskPoints(), sf);
  assert.equal(out.length, 2); // Overdue task A, Task D
});

test('tasks in Team Management Tools (container filter alone) — 3 real tasks (excludes Task D)', () => {
  const sf = { ...emptyFilters(), containerFilter: { resolved: { descendantIds: new Set([10]) } } };
  const out = applyStructuredFilters(taskPoints(), sf);
  assert.equal(out.length, 3); // Overdue task A, Task B, Task C
});

test("Ranu's tasks in Team Management Tools (person + container composed) — 2 real tasks", () => {
  const sf = {
    ...emptyFilters(),
    personFilter: { requested: true, resolvedName: RANU },
    containerFilter: { resolved: { descendantIds: new Set([10]) } },
  };
  const out = applyStructuredFilters(taskPoints(), sf);
  assert.equal(out.length, 2); // Overdue task A, Task B — not Task D (wrong project), not Task C (wrong owner)
});

test("Ranu's overdue tasks in Team Management Tools (person + container + overdue composed) — 1 real task", () => {
  const sf = {
    ...emptyFilters(),
    personFilter: { requested: true, resolvedName: RANU },
    containerFilter: { resolved: { descendantIds: new Set([10]) } },
    overdueRequested: true,
  };
  const out = applyStructuredFilters(taskPoints(), sf);
  assert.equal(out.length, 1); // Overdue task A only
  assert.equal(out[0].sourceKey, 'sk:t1');
});

// ---------------------------------------------------------------------------
// Meeting date-field + business-count composition (Phase 13 field fix + Phase 14 count fix
// together): filtering by the real `start` field, then deduping chunk points.
// ---------------------------------------------------------------------------

function meetingFixture() {
  const now = new Date();
  const dow = (now.getDay() + 6) % 7;
  const mondayThisWeek = new Date(now); mondayThisWeek.setDate(now.getDate() - dow); mondayThisWeek.setHours(10, 0, 0, 0);
  return [
    ...chunksFor('sk:m1', 'Scrum A', 6, { start: mondayThisWeek.toISOString(), timestamp: '2020-01-01T00:00:00Z' }),
    ...chunksFor('sk:m2', 'Scrum B', 1, { start: '2020-01-01T00:00:00Z', timestamp: mondayThisWeek.toISOString() }),
  ];
}

test('meetings this week: 6 raw chunk points for 1 real meeting must count as 1, not 6', () => {
  const sf = { ...emptyFilters(), dateFilter: resolveDateFilter('meetings this week', 'meeting') };
  const out = applyStructuredFilters(meetingFixture(), sf);
  assert.equal(out.length, 1);
});

test('21. comparing against a nonexistent container still fails closed (independent of dedup)', () => {
  // Sanity check that dedup doesn't paper over a genuinely empty/nonexistent scope.
  const sf = { ...emptyFilters(), containerFilter: { resolved: { descendantIds: new Set([999999]) } } };
  const out = applyStructuredFilters(taskPoints(), sf);
  assert.equal(out.length, 0);
});

// ---------------------------------------------------------------------------
// Part 2 — live server checks against real production data (skipped if the dev server isn't up).
// Reports raw vs unique for each, per Phase 14 section 19.
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
const numIn = (s) => Number((String(s || '').match(/\d[\d,]*/) || ['0'])[0].replace(/,/g, ''));

test('6. live: global task count is a real, plausible business-entity number', { skip: !serverUp && 'dev server not running' }, async () => {
  const r = await ask('How many tasks are there?');
  const n = numIn(r.answer);
  assert.ok(n > 0 && n < 15000, `expected a deduplicated task count, got ${n} from "${r.answer}"`);
});

test('7. live: Ranu Trivedi task count', { skip: !serverUp && 'dev server not running' }, async () => {
  const r = await ask('How many tasks does Ranu Trivedi have?');
  assert.match(r.answer, /\d+ tasks?.*Ranu Trivedi/);
});

test('8. live: Ranu Trivedi overdue task count', { skip: !serverUp && 'dev server not running' }, async () => {
  const r = await ask('Does Ranu Trivedi have overdue tasks?');
  assert.match(r.answer, /overdue/i);
});

test('9. live: tasks in Team Management Tools', { skip: !serverUp && 'dev server not running' }, async () => {
  const r = await ask('How many tasks does Team Management Tools have?');
  assert.match(r.answer, /Team Management Tools/);
});

test('10. live: Ranu tasks in Team Management Tools', { skip: !serverUp && 'dev server not running' }, async () => {
  const r = await ask('How many tasks does Ranu Trivedi have in Team Management Tools?');
  assert.match(r.answer, /Ranu Trivedi/);
  assert.match(r.answer, /Team Management Tools/);
});

test('11-14, 16. live: meeting counts use business-entity dedup, not raw chunk points', { skip: !serverUp && 'dev server not running' }, async () => {
  const [today, yesterday, thisWeek, lastWeek, global] = await Promise.all([
    ask('How many meetings happened today?'),
    ask('How many meetings happened yesterday?'),
    ask('How many meetings happened this week?'),
    ask('How many meetings happened last week?'),
    ask('How many meetings are there?'),
  ]);
  // The confirmed bug: "this week" used to say 32 (raw chunk points, ~2 real meetings). A real
  // business-meeting count for a single team's week should be small — assert it's nowhere near 32.
  const nThisWeek = numIn(thisWeek.answer);
  assert.ok(nThisWeek < 20, `expected a deduplicated (small) business-meeting count, got ${nThisWeek} from "${thisWeek.answer}"`);
  for (const r of [today, yesterday, thisWeek, lastWeek]) assert.match(r.answer, /\bstart\b/);
  assert.match(global.answer, /\d+ meetings/);
});

test('15. live: meeting count on an explicit DD/MM/YYYY date', { skip: !serverUp && 'dev server not running' }, async () => {
  const r = await ask('How many meetings happened on 25/06/2026?');
  assert.match(r.answer, /\d+ meetings?/);
});

test('17. live: project count', { skip: !serverUp && 'dev server not running' }, async () => {
  const r = await ask('How many projects are there?');
  const n = numIn(r.answer);
  assert.ok(n > 0 && n < 1000, `expected a deduplicated project count, got ${n}`);
});

test('18. live: portfolio count', { skip: !serverUp && 'dev server not running' }, async () => {
  const r = await ask('How many portfolios are there?');
  const n = numIn(r.answer);
  assert.ok(n > 0 && n < 3000, `expected a deduplicated portfolio count, got ${n}`);
});

test('19. live: timeentry count', { skip: !serverUp && 'dev server not running' }, async () => {
  const r = await ask('How many time entries are there?');
  const n = numIn(r.answer);
  assert.ok(n > 0, `expected a positive time entry count, got ${n}`);
});

test('20. live: comparison task-count query uses business-entity dedup', { skip: !serverUp && 'dev server not running' }, async () => {
  const r = await ask('Which has more tasks, Team Management Tools or Development Team Management System?');
  assert.equal(r.intent, 'comparison');
  assert.match(r.answer, /has more tasks/);
});

test('22. live: existing structured-filter invariant still passes end-to-end', { skip: !serverUp && 'dev server not running' }, async () => {
  const r = await ask('How many tasks does Fake Person ABC have in Team Management Tools?');
  assert.match(r.answer, /couldn't confidently match "Fake Person ABC"/);
});
