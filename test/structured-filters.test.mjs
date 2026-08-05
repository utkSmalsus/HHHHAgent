/**
 * Regression tests for the structured-filter propagation bug (#93/#24 in the 100-question test):
 * "how many tasks does RANU TRIVEDI have" and "does RANU TRIVEDI have overdue tasks" were both
 * silently answering with the GLOBAL count, because the count/overdue branches only ever parsed
 * the entity-TYPE keyword ("task") and never attempted to extract a person at all.
 *
 * Part 1 (pure, no server): unit tests for the shared resolver in structuredFilters.js, with an
 * injected fake owner list so these run offline and generically (not hardcoded to one person).
 * Part 2 (live, requires `npm start` + real Qdrant data): end-to-end checks against the actual
 * app for the 10 scenarios the user specified, run only if the server is reachable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolvePersonFilter, resolveStatusFilter, isOverdueRequested, taskIsOverdue } from '../src/services/structuredFilters.js';

const FAKE_OWNERS = new Set(['Ranu Trivedi', 'Stefan Hochhuth', 'Deepak Trivedi']);
const getOwnerNames = async () => FAKE_OWNERS;
const FAKE_CONTAINERS = new Set(['Team Management Tools', 'Development Team Management System']);
const getContainerTitles = async () => FAKE_CONTAINERS;
const resolve = (q, extra = {}) => resolvePersonFilter(q, { getOwnerNames, getContainerTitles, ...extra });

// ---------------------------------------------------------------------------
// Part 1 — resolvePersonFilter must work for ANY real employee (generic, not
// hardcoded to Ranu), and must fail closed for a name-shaped-but-unreal name.
// ---------------------------------------------------------------------------
test('resolvePersonFilter resolves a real person named in "how many X does Y have" phrasing', async () => {
  const r = await resolve('How many tasks does Ranu Trivedi have?');
  assert.equal(r.requested, true);
  assert.equal(r.resolvedName, 'Ranu Trivedi');
});

test('resolvePersonFilter resolves a DIFFERENT real employee, not just Ranu', async () => {
  const r = await resolve('How many tasks does Stefan Hochhuth have?');
  assert.equal(r.requested, true);
  assert.equal(r.resolvedName, 'Stefan Hochhuth');
});

test('resolvePersonFilter resolves possessive phrasing ("does X have overdue tasks")', async () => {
  const r = await resolve('Does Ranu Trivedi have any overdue tasks?');
  assert.equal(r.requested, true);
  assert.equal(r.resolvedName, 'Ranu Trivedi');
});

test('resolvePersonFilter fails CLOSED for a name-shaped phrase matching no real owner or project', async () => {
  const r = await resolve('How many tasks does Zzyx Qplonk have?');
  assert.equal(r.requested, true, 'a name-shaped phrase was present');
  assert.equal(r.resolvedName, null, 'must NOT resolve to any real owner');
});

// Regression: found live while verifying this fix — "How many tasks does Team Management Tools
// have?" (a real PROJECT name in the exact same grammatical slot as a person) was incorrectly
// failing closed as an "unresolved person", a worse regression than the original silent-global
// bug (a plain wrong "no such person" answer to a valid project question).
test('a real project/portfolio name in the same slot is NOT treated as an unresolved person', async () => {
  const r = await resolve('How many tasks does Team Management Tools have?');
  assert.equal(r.requested, false, 'a real container name must not be misread as a failed person reference');
  assert.equal(r.resolvedName, null);
});

test('resolvePersonFilter finds nothing requested for a question naming no person', async () => {
  const r = await resolvePersonFilter('How many tasks are there?', { getOwnerNames });
  assert.equal(r.requested, false);
  assert.equal(r.resolvedName, null);
});

test('resolveStatusFilter / isOverdueRequested detect their respective constraints generically', () => {
  assert.equal(resolveStatusFilter('How many completed tasks does Ranu Trivedi have?').requested, true);
  assert.equal(resolveStatusFilter('How many tasks are there?').requested, false);
  assert.equal(isOverdueRequested('Does Ranu Trivedi have any overdue tasks?'), true);
  assert.equal(isOverdueRequested('How many tasks does Ranu Trivedi have?'), false);
});

test('taskIsOverdue: past due date + not-done status = overdue; completed = never overdue', () => {
  const past = new Date('2020-01-01');
  assert.equal(taskIsOverdue({ dueDate: '2020-01-01', status: 'In Progress' }, new Date('2026-01-01')), true);
  assert.equal(taskIsOverdue({ dueDate: '2020-01-01', status: 'Task completed' }, new Date('2026-01-01')), false);
  assert.equal(taskIsOverdue({ dueDate: '2099-01-01', status: 'In Progress' }, new Date('2026-01-01')), false);
  assert.equal(taskIsOverdue({ status: 'In Progress' }, new Date('2026-01-01')), false, 'no due date = not overdue');
  void past;
});

// ---------------------------------------------------------------------------
// Part 2 — live end-to-end, the 10 scenarios from the task spec. Skips (does not
// fail the suite) if the app isn't running, since these need real Qdrant data.
// ---------------------------------------------------------------------------
const API = 'http://localhost:3000/api/query';
async function ask(question) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  return res.json();
}

let serverUp = false;
try {
  const r = await fetch('http://localhost:3000/api/ingest/progress', { signal: AbortSignal.timeout(2000) });
  serverUp = r.ok;
} catch {
  serverUp = false;
}

test('1. "How many tasks does Ranu Trivedi have?" — scoped, not global', { skip: !serverUp }, async () => {
  const j = await ask('How many tasks does Ranu Trivedi have?');
  assert.match(j.answer, /\d+/);
  const n = Number(j.answer.match(/\d[\d,]*/)[0].replace(/,/g, ''));
  assert.ok(n < 5000, `answer must be person-scoped, not the ~14k global count (got ${n})`);
  assert.match(j.answer, /Ranu Trivedi/);
});

test('2. same question for a DIFFERENT real employee gives a different, scoped count', { skip: !serverUp }, async () => {
  const j = await ask('How many tasks does Stefan Hochhuth have?');
  const n = Number((j.answer.match(/\d[\d,]*/) || ['0'])[0].replace(/,/g, ''));
  assert.ok(n < 5000, `must be scoped to Stefan Hochhuth, not global (got ${n})`);
  assert.match(j.answer, /Stefan Hochhuth/);
});

test('3. "Does Ranu Trivedi have any overdue tasks?" — assignee + overdue both retained', { skip: !serverUp }, async () => {
  const j = await ask('Does Ranu Trivedi have any overdue tasks?');
  assert.match(j.answer, /Ranu Trivedi/);
  const n = Number((j.answer.match(/\d[\d,]*/) || ['0'])[0].replace(/,/g, ''));
  assert.ok(n < 1000, `must be scoped, not the ~1100 global overdue count (got ${n})`);
});

test('4. overdue question for a different employee also stays scoped', { skip: !serverUp }, async () => {
  const j = await ask('Does Stefan Hochhuth have any overdue tasks?');
  const n = Number((j.answer.match(/\d[\d,]*/) || ['0'])[0].replace(/,/g, ''));
  assert.ok(n < 1000, `must be scoped (got ${n})`);
});

test('5. "How many tasks are there?" — global count still works unscoped', { skip: !serverUp }, async () => {
  const j = await ask('How many tasks are there?');
  const n = Number((j.answer.match(/\d[\d,]*/) || ['0'])[0].replace(/,/g, ''));
  assert.ok(n > 5000, `a genuinely global question must still return the global count (got ${n})`);
});

test('6. "How many overdue tasks are there?" — global overdue count still works unscoped', { skip: !serverUp }, async () => {
  const j = await ask('How many overdue tasks are there?');
  const n = Number((j.answer.match(/\d[\d,]*/) || ['0'])[0].replace(/,/g, ''));
  assert.ok(n > 500, `a genuinely global overdue question must return the global count (got ${n})`);
});

test('7. "Show Ranu Trivedi\'s tasks." — every returned record belongs to Ranu', { skip: !serverUp }, async () => {
  const j = await ask("Show Ranu Trivedi's tasks.");
  assert.notEqual(j.intent, 'disambiguation', 'must resolve directly, not offer unrelated candidates');
  const payloads = (j.sources?.qdrant || []).map((s) => s.payload).filter(Boolean);
  assert.ok(payloads.length > 0, 'must return real records');
  for (const p of payloads) {
    // owner is a real comma-joined field for multi-owner tasks ("Prashant Kumar, Ranu Trivedi") —
    // Ranu being ONE of the owners is a correct match, not just an exact single-owner equality.
    assert.match(p.owner || '', /Ranu Trivedi/, `record "${p.title}" has owner="${p.owner}", not Ranu Trivedi`);
  }
});

test('8. "Show Ranu Trivedi\'s overdue tasks." — every record belongs to Ranu AND is overdue', { skip: !serverUp }, async () => {
  const j = await ask("Show Ranu Trivedi's overdue tasks.");
  const payloads = (j.sources?.qdrant || []).map((s) => s.payload).filter(Boolean);
  for (const p of payloads) {
    assert.match(p.owner || '', /Ranu Trivedi/, `record "${p.title}" owner="${p.owner}"`);
    assert.ok(taskIsOverdue(p), `record "${p.title}" (due ${p.dueDate}, status ${p.status}) is not actually overdue`);
  }
});

test('9. "How many completed tasks does Ranu Trivedi have?" — person + status filters both retained', { skip: !serverUp }, async () => {
  const j = await ask('How many completed tasks does Ranu Trivedi have?');
  assert.match(j.answer, /Ranu Trivedi/);
  const n = Number((j.answer.match(/\d[\d,]*/) || ['0'])[0].replace(/,/g, ''));
  assert.ok(n < 1000, `must be scoped to Ranu's completed tasks, not a global figure (got ${n})`);
});

test('10. nonexistent person — must NOT silently return the global count', { skip: !serverUp }, async () => {
  const j = await ask('How many tasks does Zzyx Qplonk have?');
  const n = Number((j.answer.match(/\d[\d,]*/) || ['0'])[0].replace(/,/g, ''));
  assert.ok(
    j.intent === 'unresolved-person-filter' || n === 0,
    `must fail closed (unresolved-person-filter or 0), not answer with a real global-sized number — got intent=${j.intent}, answer="${j.answer}"`
  );
  assert.notEqual(n > 5000, true, 'must never be the ~14k global task count');
});

// Invariant: a resolved structured constraint (person here) must be visible in the answer text,
// or the response must be an explicit unresolved-filter response — never silently dropped.
test('invariant: a resolved person constraint is never silently dropped from the final answer', { skip: !serverUp }, async () => {
  for (const q of ['How many tasks does Ranu Trivedi have?', 'Does Ranu Trivedi have any overdue tasks?']) {
    const j = await ask(q);
    const constraintVisible = /Ranu Trivedi/.test(j.answer) || j.intent === 'unresolved-person-filter';
    assert.ok(constraintVisible, `"${q}" -> constraint must appear in the answer or be explicitly unresolved. Got: ${j.answer}`);
  }
});

// Regression (found live during this fix): a real PROJECT name in the "does X have" slot must
// not be misdiagnosed as an unresolved person.
test('a project-scoped count question is not blocked by the person-filter fail-closed path', { skip: !serverUp }, async () => {
  const j = await ask('How many tasks does Team Management Tools have?');
  assert.notEqual(j.intent, 'unresolved-person-filter', 'a real project name must not trigger the person fail-closed path');
});

// A status filter with NO person named must still work as a plain global-but-status-scoped count.
test('a status-only count (no person) still works and is not scoped to a person', { skip: !serverUp }, async () => {
  const j = await ask('How many completed tasks are there?');
  assert.equal(j.intent, 'count');
  assert.doesNotMatch(j.answer, /\bfor\s+[A-Z][\p{L}'-]+/u, 'must not spuriously attribute the count to a person');
});
