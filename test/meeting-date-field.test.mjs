/**
 * Regression tests for Phase 13 issue #1: meeting temporal questions must filter by the real
 * `start` field (when the meeting occurred), never `timestamp` (SharePoint's record Modified||
 * Created — unrelated to occurrence time).
 *
 * Confirmed live before this fix: "how many meetings happened this week?" resolved its date field
 * to `timestamp` (via pickDateField's default, since meeting was previously excluded entirely and
 * the COUNT branch in query.js hardcoded entityType='task' regardless of what was actually being
 * counted) and answered from the wrong field. Also caught live WHILE building this fix: "how many
 * meetings happened LAST week" anchored to a real project literally titled "Last Modified Views
 * MIgration SPA" — "last" wasn't in the operator-vocabulary stripped before container resolution,
 * so a single stray word won a confident (wrong) match; fixed by adding last/next to that list.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveDateFilter, applyStructuredFilters, resolveStructuredFilters } from '../src/services/structuredFilters.js';

// ---------------------------------------------------------------------------
// Part 1 — pure unit tests, no server/Qdrant required.
// ---------------------------------------------------------------------------

test('date-field mapping by entity type: task due-date question -> dueDate', () => {
  assert.equal(resolveDateFilter('Which tasks are due this week?', 'task').field, 'dueDate');
});
test('date-field mapping by entity type: task non-due question -> timestamp', () => {
  assert.equal(resolveDateFilter('Which tasks were updated this week?', 'task').field, 'timestamp');
});
test('date-field mapping by entity type: time entry "logged" question -> timeDate', () => {
  assert.equal(resolveDateFilter('What time entries were logged this week?', 'timeentry').field, 'timeDate');
});
test('date-field mapping by entity type: project updated -> timestamp', () => {
  assert.equal(resolveDateFilter('Which projects were updated this week?', 'project').field, 'timestamp');
});
test('date-field mapping by entity type: portfolio updated -> timestamp', () => {
  assert.equal(resolveDateFilter('Which portfolios were updated this week?', 'portfolio').field, 'timestamp');
});
test('date-field mapping by entity type: meeting happened -> start (never timestamp)', () => {
  const f = resolveDateFilter('How many meetings happened this week?', 'meeting');
  assert.equal(f.field, 'start');
  assert.notEqual(f.field, 'timestamp');
});
test('date-field mapping by entity type: meeting held -> start', () => {
  assert.equal(resolveDateFilter('How many meetings were held today?', 'meeting').field, 'start');
});

// Fake meeting points where `timestamp` (record last-modified) and `start` (real occurrence date)
// deliberately point to DIFFERENT weeks — proves filtering actually reads `start`, not just that
// the field NAME says "start" while something else still drives the result.
const now = new Date();
const dow = (now.getDay() + 6) % 7;
const mondayThisWeek = new Date(now); mondayThisWeek.setDate(now.getDate() - dow); mondayThisWeek.setHours(10, 0, 0, 0);
const mondayLastWeek = new Date(mondayThisWeek); mondayLastWeek.setDate(mondayThisWeek.getDate() - 7);
const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1); yesterday.setHours(10, 0, 0, 0);
const iso = (d) => d.toISOString();

const FAKE_MEETINGS = [
  // Happened this week, but its SharePoint record was last touched ages ago — must still count as
  // "this week" by start, must NOT be excluded by a wrong timestamp-based filter.
  { type: 'meeting', title: 'Scrum A', start: iso(mondayThisWeek), timestamp: '2020-01-01T00:00:00.000Z' },
  // The inverse trap: its record was modified THIS week (e.g. transcript uploaded late), but it
  // actually happened last week — a timestamp-based filter would wrongly INCLUDE this one.
  { type: 'meeting', title: 'Scrum B', start: iso(mondayLastWeek), timestamp: iso(now) },
  { type: 'meeting', title: 'Scrum C', start: iso(yesterday), timestamp: '2020-01-01T00:00:00.000Z' },
];

test('"this week" filtering by start excludes a meeting whose record timestamp is stale but really happened this week (includes it) and excludes one whose timestamp is fresh but happened last week', () => {
  const sf = {
    personFilter: { requested: false }, containerFilter: { requested: false },
    statusFilter: { requested: false }, overdueRequested: false,
    dateFilter: resolveDateFilter('meetings this week', 'meeting'),
  };
  const out = applyStructuredFilters(FAKE_MEETINGS, sf);
  const titles = out.map((m) => m.title);
  // Scrum C ("yesterday") legitimately falls inside "this week" too unless today is Monday — the
  // thing actually under test is the stale-timestamp-but-real-this-week (Scrum A, must be IN) vs
  // fresh-timestamp-but-really-last-week (Scrum B, must be OUT) divergence, not Scrum C's exact
  // membership.
  assert.ok(titles.includes('Scrum A'), 'a meeting that really happened this week must be included even with a stale record timestamp');
  assert.ok(!titles.includes('Scrum B'), 'a meeting that really happened LAST week must be excluded even with a fresh record timestamp');
});

test('"yesterday" filtering by start finds the meeting that happened yesterday regardless of its record timestamp', () => {
  const sf = {
    personFilter: { requested: false }, containerFilter: { requested: false },
    statusFilter: { requested: false }, overdueRequested: false,
    dateFilter: resolveDateFilter('meetings yesterday', 'meeting'),
  };
  const out = applyStructuredFilters(FAKE_MEETINGS, sf);
  assert.deepEqual(out.map((m) => m.title), ['Scrum C']);
});

test('"last week" filtering by start finds the meeting that happened last week even though its record was modified today', () => {
  const sf = {
    personFilter: { requested: false }, containerFilter: { requested: false },
    statusFilter: { requested: false }, overdueRequested: false,
    dateFilter: resolveDateFilter('meetings last week', 'meeting'),
  };
  const out = applyStructuredFilters(FAKE_MEETINGS, sf);
  assert.deepEqual(out.map((m) => m.title), ['Scrum B']);
});

test('"today" filtering by start finds nothing when no meeting happened today (independent of timestamp)', () => {
  const sf = {
    personFilter: { requested: false }, containerFilter: { requested: false },
    statusFilter: { requested: false }, overdueRequested: false,
    dateFilter: resolveDateFilter('meetings today', 'meeting'),
  };
  const out = applyStructuredFilters(FAKE_MEETINGS, sf);
  assert.deepEqual(out, []);
});

test('meetings on an explicit DD/MM/YYYY date filter by start', () => {
  const explicit = new Date(2026, 5, 25, 14, 0, 0); // 25 June 2026
  const meetings = [
    { type: 'meeting', title: 'SCRUM - 25/06/2026', start: explicit.toISOString(), timestamp: '2020-01-01T00:00:00.000Z' },
    { type: 'meeting', title: 'Unrelated scrum', start: '2026-07-01T10:00:00.000Z', timestamp: explicit.toISOString() },
  ];
  const dateFilter = resolveDateFilter('meetings on 25/06/2026', 'meeting');
  assert.equal(dateFilter.field, 'start');
  const sf = {
    personFilter: { requested: false }, containerFilter: { requested: false },
    statusFilter: { requested: false }, overdueRequested: false, dateFilter,
  };
  const out = applyStructuredFilters(meetings, sf);
  assert.deepEqual(out.map((m) => m.title), ['SCRUM - 25/06/2026']);
});

test('global meeting count (no date phrase at all) requests no date filter — unchanged behavior', () => {
  const dateFilter = resolveDateFilter('How many meetings are there?', 'meeting');
  assert.equal(dateFilter.requested, false);
  const sf = {
    personFilter: { requested: false }, containerFilter: { requested: false },
    statusFilter: { requested: false }, overdueRequested: false, dateFilter,
  };
  // With no date requested, applyStructuredFilters must not drop anything on date grounds.
  const out = applyStructuredFilters(FAKE_MEETINGS, sf);
  assert.equal(out.length, FAKE_MEETINGS.length);
});

test('a real title containing "last"/"next" does not falsely anchor a meeting date-count question (vocabulary collision)', async () => {
  const { resolveContainerFilter } = await import('../src/services/structuredFilters.js');
  const getContainerItems = async () => [
    { type: 'project', title: 'Last Modified Views MIgration SPA', sharePointItemId: 1, parentId: null, status: 'In Progress', timestamp: '2026-01-01' },
  ];
  const r = await resolveContainerFilter('How many meetings happened last week?', { getContainerItems });
  assert.equal(r.requested, false);
  assert.equal(r.resolved, null);
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

test('live: "how many meetings happened this week" answer discloses the start field, not timestamp', { skip: !serverUp && 'dev server not running' }, async () => {
  const r = await ask('How many meetings happened this week?');
  assert.match(r.answer, /start this week/);
  assert.doesNotMatch(r.answer, /Modified-or-Created/);
});

test('live: "how many meetings happened last week" resolves no false container and discloses start', { skip: !serverUp && 'dev server not running' }, async () => {
  const r = await ask('How many meetings happened last week?');
  assert.match(r.answer, /start last week/);
  assert.doesNotMatch(r.answer, /\bin [A-Z]/, 'must not show a "in <ContainerTitle>" scope suffix — no container was named');
});

test('live: global meeting count (no date) is unchanged in shape', { skip: !serverUp && 'dev server not running' }, async () => {
  const r = await ask('How many meetings are there?');
  assert.match(r.answer, /\d+ meetings/);
  assert.doesNotMatch(r.answer, /start|timestamp/, 'an unscoped count should carry no date-field caveat at all');
});
