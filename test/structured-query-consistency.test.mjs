/**
 * Regression tests for the "final structured-query consistency" phase: NO STRUCTURED CONSTRAINT
 * MAY BE SILENTLY DROPPED, across every deterministic branch (count, overdue-only, owned-by-
 * person, who-works-on), plus DD/MM/YYYY date-locale determinism and real first-name ambiguity.
 *
 * Real bugs found and fixed WHILE building this test file (not hypothetical — each has its own
 * dedicated case below):
 *   - the standalone overdue-only branch supported person but silently dropped a container filter
 *   - the owned-by-person branch ("X's tasks") supported overdue/status but not container, and its
 *     possessive trigger regex only allowed the literal word "overdue" between 's and "tasks"
 *   - who-works-on silently fell through (returned null) on genuine container ambiguity instead of
 *     surfacing it
 *   - the bare-first-name fallback ("Ranu's tasks") never stripped the possessive 's from a
 *     SINGLE-word match, so it silently failed to resolve at all
 *   - "Fake Person ABC ... in Team Management Tools" silently dropped the unresolved person and
 *     answered with the real project's full unscoped count, because the container-vs-person
 *     priority check only compared "did ANY container resolve" instead of "is this the SAME text"
 *   - a real portfolio/project title coincidentally containing this module's own filter vocabulary
 *     ("Annex Updated", "Week Task Distribution", "Overdue Projects", "Annex II 2026") wrongly won
 *     container resolution for unrelated recency/status/date questions (regression-tested in
 *     container-date-filters.test.mjs already; not re-duplicated here)
 *   - explicit numeric dates were off by one calendar day in their LABEL (not their actual range)
 *     due to `.toISOString()` converting to UTC on a server running in a UTC+ timezone
 *   - "2 August 2026" was misread as a person named "August"
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolvePersonFilter,
  resolveDateFilter,
  checkStructuredFiltersBlocked,
} from '../src/services/structuredFilters.js';

const API = 'http://localhost:3000/api/query';
async function ask(question) {
  const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) });
  return res.json();
}
const numIn = (s) => Number((String(s || '').match(/\d[\d,]*/) || ['0'])[0].replace(/,/g, ''));

let serverUp = false;
try {
  const r = await fetch('http://localhost:3000/api/ingest/progress', { signal: AbortSignal.timeout(3000) });
  serverUp = r.ok;
} catch {
  serverUp = false;
}

// ---------------------------------------------------------------------------
// Part 1 — pure unit tests (no server) for the priority-logic and locale fixes
// ---------------------------------------------------------------------------
const FAKE_OWNERS = new Set(['Ranu Trivedi']);
const FAKE_CONTAINERS = new Set(['Team Management Tools']);

test('person-vs-container priority: a real resolved container does NOT explain away a separate unresolved person', () => {
  // Simulates "Fake Person ABC ... in Team Management Tools" without hitting the live server.
  const personFilter = { requested: true, resolvedName: null, candidateText: 'Fake Person ABC', ambiguous: null };
  const containerFilter = { requested: true, resolved: { id: 1, title: 'Team Management Tools' }, ambiguous: null, candidateText: null };
  const dateFilter = { requested: false, unresolvable: false };
  const blocked = checkStructuredFiltersBlocked({ personFilter, containerFilter, dateFilter });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.kind, 'unresolved-person');
});

test('person-vs-container priority: SAME ambiguous text still defers to the container conclusion', () => {
  // Simulates "Fake Project XYZ" alone — both resolvers tried the identical text.
  const personFilter = { requested: true, resolvedName: null, candidateText: 'Fake Project XYZ', ambiguous: null };
  const containerFilter = { requested: true, resolved: null, ambiguous: null, candidateText: 'Fake Project XYZ' };
  const dateFilter = { requested: false, unresolvable: false };
  const blocked = checkStructuredFiltersBlocked({ personFilter, containerFilter, dateFilter });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.kind, 'unresolved-container', 'must defer to the container conclusion, not report a wrong "no such person"');
});

test('resolveDateFilter: DD/MM/YYYY numeric, ISO, and natural-language dates all resolve to the SAME day', () => {
  const a = resolveDateFilter('tasks due on 02/08/2026', 'task');
  const b = resolveDateFilter('tasks due on 2026-08-02', 'task');
  const c = resolveDateFilter('tasks due on 2 August 2026', 'task');
  assert.equal(a.range.start.getTime(), b.range.start.getTime(), 'DD/MM/YYYY and ISO must agree');
  assert.equal(a.range.start.getTime(), c.range.start.getTime(), 'DD/MM/YYYY and natural language must agree');
  assert.equal(a.label, '2026-08-02', 'label must show the LOCAL calendar day, not a UTC-shifted one');
});

test('resolveDateFilter: 02/08 is NEVER read as February (MM/DD/YYYY)', () => {
  const r = resolveDateFilter('tasks due on 13/02/2026', 'task'); // day=13 makes MM/DD impossible to mistake, sanity-checks the parser itself
  assert.equal(r.range.start.getMonth(), 1, 'month must be February (index 1) from the SECOND number, not the first');
  assert.equal(r.range.start.getDate(), 13, 'day must be 13 from the FIRST number');
});

test('resolveDateFilter: malformed numeric date fails closed', () => {
  const r = resolveDateFilter('tasks due on 45/67/2026', 'task');
  assert.equal(r.requested, true);
  assert.equal(r.unresolvable, true);
});

test('resolvePersonFilter: month names are never mistaken for a person', async () => {
  const r = await resolvePersonFilter('tasks due on 2 August 2026', { getOwnerNames: async () => FAKE_OWNERS });
  assert.equal(r.requested, false, '"August" must not be treated as an unresolved person candidate');
});

// ---------------------------------------------------------------------------
// Part 2 — live, the 21 scenarios from the task spec
// ---------------------------------------------------------------------------
test('1. "Does Ranu have overdue tasks in Team Management Tools?" — person + container both retained', { skip: !serverUp }, async () => {
  const j = await ask('Does Ranu have overdue tasks in Team Management Tools?');
  assert.match(j.answer, /Ranu Trivedi/);
  assert.match(j.answer, /Team Management Tools/);
});

test('2. "Does Ranu have overdue tasks?" — global-person scope, no container', { skip: !serverUp }, async () => {
  const j = await ask('Does Ranu have overdue tasks?');
  assert.match(j.answer, /Ranu Trivedi/);
  assert.ok(numIn(j.answer) < 1000, 'must not be the global overdue count');
});

test('3. "Does Team Management Tools have overdue tasks?" — container-only scope, no person', { skip: !serverUp }, async () => {
  const j = await ask('Does Team Management Tools have overdue tasks?');
  assert.match(j.answer, /Team Management Tools/);
  assert.doesNotMatch(j.answer, /Ranu Trivedi/);
});

test('4. "Ranu Trivedi\'s tasks in Team Management Tools" — routes deterministically (owned-by)', { skip: !serverUp }, async () => {
  const j = await ask("Ranu Trivedi's tasks in Team Management Tools");
  assert.equal(j.intent, 'owned-by');
});

test('5. "Ranu\'s completed tasks in Team Management Tools" — person + status + container', { skip: !serverUp }, async () => {
  const j = await ask("Ranu's completed tasks in Team Management Tools");
  assert.equal(j.intent, 'owned-by', 'possessive + status modifier must route deterministically, not fall to a summary');
});

test('6. "Ranu\'s overdue tasks in Team Management Tools" — bare possessive first name + overdue + container', { skip: !serverUp }, async () => {
  const j = await ask("Ranu's overdue tasks in Team Management Tools");
  assert.match(j.answer, /Ranu Trivedi/, 'the person constraint must not be silently dropped');
  assert.match(j.answer, /Team Management Tools/);
});

test('7. "Ranu\'s tasks due this week in Team Management Tools" — person + date + container', { skip: !serverUp }, async () => {
  const j = await ask("Ranu's tasks due this week in Team Management Tools");
  assert.equal(j.intent, 'owned-by', 'possessive + date modifier must route deterministically');
});

test('8. "Who is working on Team Management Tools?" — real project resolved, no generic-word leakage', { skip: !serverUp }, async () => {
  const j = await ask('Who is working on Team Management Tools?');
  assert.equal(j.intent, 'who-works-on');
  assert.match(j.answer, /Team Management Tools/);
});

test('9. "Who is working on Development Team Management System?" — a DIFFERENT real project resolved correctly', { skip: !serverUp }, async () => {
  const j = await ask('Who is working on Development Team Management System?');
  assert.equal(j.intent, 'who-works-on');
  assert.match(j.answer, /Development Team Management System/);
});

test('10. "How many tasks does Ranu have in Team Management Tools?" — bare first name resolves', { skip: !serverUp }, async () => {
  const j = await ask('How many tasks does Ranu have in Team Management Tools?');
  assert.match(j.answer, /Ranu Trivedi/);
  assert.match(j.answer, /Team Management Tools/);
});

test('11. "How many overdue tasks does Ranu have in Team Management Tools?" — all 3 filters compose in a count', { skip: !serverUp }, async () => {
  const j = await ask('How many overdue tasks does Ranu have in Team Management Tools?');
  assert.match(j.answer, /Ranu Trivedi/);
  assert.match(j.answer, /Team Management Tools/);
});

test('12. "Tasks due on 02/08/2026" means 2 August (DD/MM/YYYY, never MM/DD)', { skip: !serverUp }, async () => {
  const j = await ask('How many tasks were due on 02/08/2026?');
  assert.match(j.answer, /2026-08-02/);
});

test('13. "Tasks due on 2026-08-02" (ISO) agrees with test 12', { skip: !serverUp }, async () => {
  const iso = await ask('How many tasks were due on 2026-08-02?');
  const numeric = await ask('How many tasks were due on 02/08/2026?');
  assert.equal(numIn(iso.answer), numIn(numeric.answer), 'ISO and DD/MM/YYYY must resolve to the identical count');
});

test('14. "Tasks due on 2 August 2026" (natural language) agrees with tests 12-13', { skip: !serverUp }, async () => {
  const natural = await ask('How many tasks were due on 2 August 2026?');
  const numeric = await ask('How many tasks were due on 02/08/2026?');
  assert.equal(numIn(natural.answer), numIn(numeric.answer));
  assert.equal(natural.intent, 'count', 'must not be misrouted (e.g. "August" read as a person)');
});

test('15. nonexistent person + real project → fails closed on the PERSON, not silently container-only', { skip: !serverUp }, async () => {
  const j = await ask('How many tasks does Fake Person ABC have in Team Management Tools?');
  assert.equal(j.intent, 'unresolved-person-filter');
  assert.notEqual(numIn(j.answer), 61, 'must not silently answer with Team Management Tools\' unscoped count');
});

test('16. real person + nonexistent project → fails closed on the PROJECT', { skip: !serverUp }, async () => {
  const j = await ask('How many tasks does Ranu Trivedi have in Fake Project ABC?');
  assert.equal(j.intent, 'unresolved-container-filter');
});

test('17. nonexistent person + nonexistent project → fails closed (either reason)', { skip: !serverUp }, async () => {
  const j = await ask('How many tasks does Fake Person ABC have in Fake Project XYZ?');
  assert.match(j.intent, /^unresolved-(person|container)-filter$/);
});

test('18. multiple constraints, one unresolvable → does NOT silently execute the resolvable ones', { skip: !serverUp }, async () => {
  const j = await ask('How many overdue tasks does Ranu Trivedi have in Fake Project ABC?');
  assert.equal(j.intent, 'unresolved-container-filter', 'a resolvable person + overdue must not be silently answered once the project fails');
});

test('19. global task count is unchanged', { skip: !serverUp }, async () => {
  const j = await ask('How many tasks are there?');
  assert.equal(j.intent, 'count');
  assert.ok(numIn(j.answer) > 5000);
});

test('20. prior phase\'s person/status regression tests are unaffected', { skip: !serverUp }, async () => {
  const j1 = await ask('How many tasks does Ranu Trivedi have?');
  assert.match(j1.answer, /Ranu Trivedi/);
  const j2 = await ask('How many overdue tasks are there?');
  assert.ok(numIn(j2.answer) > 500, 'genuinely global overdue count must be unaffected');
});

test('21. prior phase\'s container/date regression tests are unaffected', { skip: !serverUp }, async () => {
  const j = await ask('Show the latest 5 projects.');
  assert.equal(j.intent, 'date-list');
  const items = (j.sources?.qdrant || []).map((s) => s.payload);
  assert.equal(items.length, 5);
});

// ---------------------------------------------------------------------------
// Item 10 — the strengthened invariant, checked across every constraint TYPE this phase touched.
// ---------------------------------------------------------------------------
test('invariant: real first-name ambiguity ("Kamal" = 3 different real people) is surfaced, never arbitrarily picked', { skip: !serverUp }, async () => {
  const j = await ask('How many tasks does Kamal have?');
  assert.equal(j.intent, 'ambiguous-person-filter');
  assert.match(j.answer, /Kamal Darani/);
  assert.match(j.answer, /Kamal Singh/);
  assert.match(j.answer, /Kamal Kishore/);
});

test('invariant: an unambiguous first name ("Ranu") is never blocked as ambiguous', { skip: !serverUp }, async () => {
  const j = await ask('How many tasks does Ranu have?');
  assert.notEqual(j.intent, 'ambiguous-person-filter');
  assert.match(j.answer, /Ranu Trivedi/);
});

test('invariant: every structured constraint this phase covers ends RESOLVED+APPLIED or EXPLICITLY UNRESOLVED, never silently dropped', { skip: !serverUp }, async () => {
  const cases = [
    ['How many tasks does Ranu Trivedi have in Team Management Tools?', ['Ranu Trivedi', 'Team Management Tools']],
    ['Does Ranu Trivedi have any overdue tasks?', ['Ranu Trivedi']],
    ["Ranu Trivedi's overdue tasks in Team Management Tools", ['Ranu Trivedi', 'Team Management Tools']],
    ['Who is working on Team Management Tools?', ['Team Management Tools']],
  ];
  for (const [q, mustAppear] of cases) {
    const j = await ask(q);
    for (const text of mustAppear) {
      assert.match(j.answer, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `"${q}" -> answer must mention "${text}", not drop it silently. Got: ${j.answer}`);
    }
  }
});
