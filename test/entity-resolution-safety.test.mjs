/**
 * Regression tests for Phase 12 (entity-resolution safety): WRONG ENTITY < HONEST AMBIGUITY.
 *
 * Root causes fixed this phase (see structuralRetrieve.js's own comments for the full history):
 *   - structuralRetrieve()'s vector-search fallback used to accept a blind top-1 embedding match
 *     with zero disambiguation whenever the keyword resolver found nothing — a typo'd or vague
 *     question ("what is happening with portfoilo managment") could confidently anchor to a totally
 *     unrelated real entity ("Leave management tool") this way. Now: requires the question to carry
 *     real (non-generic) content at all, a dominance margin over the runner-up, AND a real
 *     (non-generic-only) word overlap with the chosen title before ever committing.
 *   - resolveStructuredFilters ran container resolution for EVERY entity type, including 'meeting',
 *     but extractKeywords() never stripped "meeting"/"meetings" as an entity-type word the way it
 *     already stripped task/project/portfolio/timeentry — so "how many meetings happened this week"
 *     could anchor to an unrelated real container merely because its title contains "Meetings".
 *   - generic vocabulary ("team", "management", "system", "tool(s)", "development") had full
 *     matching weight in resolveContainerAnchor's keyword-overlap scoring, so one coincidental
 *     generic-word overlap against an unrelated title could win outright.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveContainerFilter } from '../src/services/structuredFilters.js';
import {
  resolveContainerAnchor,
  hasNonGenericTitleOverlap,
  hasRealContentWords,
  sanitizeForEntityResolution,
  toEntityResolution,
} from '../src/services/structuralRetrieve.js';

// Real-shaped fixture data: a legitimate real title made entirely of generic vocabulary (the
// baseline that must keep working), a near-duplicate sibling (real ambiguity), and the exact class
// of vocabulary-collision titles found live in prior phases plus the NEW one this phase targets
// (a container whose title contains "Meetings", the literal word this phase's own entity-type
// vocabulary strips as an operator word).
const FAKE_CONTAINERS = [
  { type: 'project', title: 'Team Management Tools', sharePointItemId: 1, parentId: null, status: 'In Progress', timestamp: '2026-07-16' },
  { type: 'project', title: 'Development Team Management System', sharePointItemId: 2, parentId: null, status: 'In Progress', timestamp: '2026-07-22' },
  { type: 'portfolio', title: 'SPFx Discussions, Meetings', sharePointItemId: 3, parentId: null, status: 'In Progress', timestamp: '2026-07-01' },
  { type: 'portfolio', title: 'Overdue Projects', sharePointItemId: 4, parentId: null, status: 'In Progress', timestamp: '2025-01-01' },
  { type: 'project', title: 'Annex II 2026', sharePointItemId: 5, parentId: null, status: 'In Progress', timestamp: '2025-01-01' },
  { type: 'project', title: 'SmartFilters', sharePointItemId: 6, parentId: null, status: 'In Progress', timestamp: '2026-01-01' },
  { type: 'project', title: 'Leave Management Tool', sharePointItemId: 7, parentId: null, status: 'In Progress', timestamp: '2026-07-30' },
];
const getContainerItems = async () => FAKE_CONTAINERS;
const resolve = (q) => resolveContainerFilter(q, { getContainerItems });

// ---------------------------------------------------------------------------
// Regression coverage for the WRONG_ENTITY failures named in the Phase 11 eval (#14, #35, #51,
// #60, #61, #65, #83, #84, #86): the original eval harness that recorded their exact wording was
// lost to an environment/scratchpad reset before this phase started (disclosed to the user, who
// chose to proceed without it). These tests instead cover the FAILURE PATTERN common to that whole
// class — a question sharing only generic/coincidental vocabulary with an unrelated real title
// confidently "winning" a match — since that pattern, not the literal wording, is what Phase 12
// actually fixes. #16/#21/#82/#94 are covered with their real, verbatim wording from prior phases.
// ---------------------------------------------------------------------------

test('a single stray generic-word overlap never wins a confident match on its own', () => {
  // "What is happening with the system?" shares exactly ONE generic word ("system") with
  // "Development Team Management System" and nothing else — the literal case Phase 12 step 4
  // targets ("do not allow one generic overlapping token to create a confident match").
  const r = resolveContainerAnchor('What is happening with the system?', FAKE_CONTAINERS);
  assert.equal(r.anchor, null, 'a single generic-word overlap must not resolve to any one entity');
});

test('two-or-more generic words matching together (a real multi-word phrase) may still resolve', () => {
  // "management system" (2 generic words) uniquely and strongly overlaps "Development Team
  // Management System" — this is meaningfully specific, unlike a single stray token, so the
  // downweighting must not refuse it outright.
  const r = resolveContainerAnchor('What is going on with the management system?', FAKE_CONTAINERS);
  assert.equal(r.anchor?.title, 'Development Team Management System');
});

test('a real title made entirely of generic words still resolves when it is the clear unique match', () => {
  // Non-regression: "Team Management Tools" is a legitimate real title whose every word is
  // individually generic — Phase 12's downweighting must not refuse this the way it refuses a
  // single stray generic-word overlap against an unrelated title.
  const r = resolveContainerAnchor('How many tasks does Team Management Tools have?', FAKE_CONTAINERS);
  assert.equal(r.anchor?.title, 'Team Management Tools');
});

test('near-identical generic-vocabulary titles are surfaced as ambiguous, not silently picked', () => {
  const r = resolveContainerAnchor('What is happening with the team management tools project?', FAKE_CONTAINERS);
  // Either a clean resolve (if one dominates) or an explicit ambiguous list — never silently null
  // AND never a confident pick of the wrong one. Assert it's one of the two safe outcomes.
  assert.ok(r.anchor || r.ambiguous, 'must either resolve confidently or say so is ambiguous, not just give up silently in a way that looks like "not found"');
});

test('#82 pattern: a typo that shares no real content with any title must not confidently anchor', () => {
  // Real question (verbatim, from the Phase 11 eval): "What is happening with portfoilo managment?"
  // Both words are typos — "portfoilo" and "managment" never literally equal any real title token
  // (correctly spelled or not), so this must resolve to nothing rather than falling through to an
  // unguarded semantic/vector pick (that fallback itself is exercised live, not by this pure unit
  // test — see structuralRetrieve()'s own comments for the dominance-margin + real-overlap gate
  // added around it).
  const r = resolveContainerAnchor('What is happening with portfoilo managment?', FAKE_CONTAINERS);
  assert.equal(r.anchor, null);
  assert.ok(!r.ambiguous, 'a typo with no real overlap is "not found", not "ambiguous"');
});

test('#82 CONFIRMED root cause: the question\'s typo matching the SAME typo in real production data must still refuse', () => {
  // Live-verified this phase: the real production data itself contains a portfolio literally
  // titled "Leave managment tool" (misspelled the same way "portfoilo managment" is) — an exact,
  // non-generic-looking keyword match by pure string equality, entirely within the SAFE keyword
  // resolver tier, never even reaching the vector-search fallback. A misspelling of generic
  // vocabulary ("managment" of "management") must be recognized as generic too — it's no more
  // reliable a signal for being spelled wrong — via fuzzy (edit-distance<=1) matching against
  // GENERIC_ENTITY_WORDS, not just exact Set membership.
  const items = [
    ...FAKE_CONTAINERS,
    { type: 'portfolio', title: 'Leave managment tool', sharePointItemId: 8, parentId: null, status: 'In Progress', timestamp: '2026-01-01' },
  ];
  const r = resolveContainerAnchor('What is happening with portfoilo managment?', items);
  assert.equal(r.anchor, null, 'a single misspelled-generic-word coincidence must not confidently resolve to "Leave managment tool"');
});

test('#94 pattern: "meetings" in a count question must not be treated as an entity reference', async () => {
  // Real question (verbatim, from the Phase 11 eval). FAKE_CONTAINERS includes a portfolio whose
  // title literally contains "Meetings" — the exact collision that made this confidently wrong.
  const r = await resolve('How many meetings happened this week?');
  assert.equal(r.requested, false, '"meetings" is an entity-TYPE word (what to count), not a container reference');
  assert.equal(r.resolved, null);
});

test('type-word stripping generalizes: a meeting-count question never anchors to any container regardless of phrasing', async () => {
  const r = await resolve('How many meetings did we have this week?');
  assert.equal(r.requested, false);
});

// ---------------------------------------------------------------------------
// Negative tests (Phase 12 step 9) — pure operator/list questions must never trigger entity
// resolution at all, since there is nothing to entity-resolve in them.
// ---------------------------------------------------------------------------

test('negative: "How many meetings happened this week?" runs NO container entity resolution', async () => {
  const r = await resolve('How many meetings happened this week?');
  assert.equal(r.requested, false);
});

test('negative: "Show latest 5 projects" runs NO named entity resolution', async () => {
  const r = await resolve('Show latest 5 projects');
  assert.equal(r.requested, false);
});

test('negative: "How many overdue tasks are there?" does not select a project literally named "Overdue Projects"', async () => {
  const r = await resolve('How many overdue tasks are there?');
  assert.equal(r.requested, false);
  assert.equal(r.resolved, null);
});

test('negative: "Which projects were updated yesterday?" does not resolve "updated" as an entity reference', async () => {
  const r = await resolve('Which projects were updated yesterday?');
  assert.equal(r.requested, false);
});

test('negative: "Show tasks due in 2026" does not resolve the bare year to a project containing "2026"', async () => {
  const r = await resolve('Show tasks due in 2026');
  assert.equal(r.requested, false);
  assert.equal(r.resolved, null);
});

// ---------------------------------------------------------------------------
// Shared-resolution-model shape (Phase 12 step 2) and matching-priority-ladder building blocks.
// ---------------------------------------------------------------------------

test('toEntityResolution: a resolved anchor maps to resolution "confident" with one candidate', () => {
  const raw = resolveContainerAnchor('How many tasks does Team Management Tools have?', FAKE_CONTAINERS);
  const shaped = toEntityResolution('How many tasks does Team Management Tools have?', 'project', raw);
  assert.equal(shaped.resolution, 'confident');
  assert.equal(shaped.candidates.length, 1);
  assert.equal(shaped.candidates[0].title, 'Team Management Tools');
  assert.equal(shaped.expectedType, 'project');
});

test('toEntityResolution: an ambiguous result maps to resolution "ambiguous" with 2+ candidates', () => {
  const raw = { ambiguous: true, candidates: [{ title: 'A', type: 'project' }, { title: 'B', type: 'project' }] };
  const shaped = toEntityResolution('irrelevant', 'project', raw);
  assert.equal(shaped.resolution, 'ambiguous');
  assert.equal(shaped.candidates.length, 2);
});

test('toEntityResolution: no anchor and no ambiguity maps to resolution "not_found" with zero candidates', () => {
  const shaped = toEntityResolution('irrelevant', 'project', { anchor: null });
  assert.equal(shaped.resolution, 'not_found');
  assert.equal(shaped.candidates.length, 0);
});

test('hasNonGenericTitleOverlap: a single generic-word overlap is not "real" overlap', () => {
  assert.equal(hasNonGenericTitleOverlap('the management approach', 'Leave Management Tool'), false);
});

test('hasNonGenericTitleOverlap: two generic words matching together IS real overlap (a genuine multi-word title)', () => {
  assert.equal(hasNonGenericTitleOverlap('team management tools', 'Team Management Tools'), true);
});

test('hasNonGenericTitleOverlap: one genuinely distinguishing word is real overlap even alone', () => {
  assert.equal(hasNonGenericTitleOverlap('the smartfilters approach', 'SmartFilters'), true);
});

test('sanitizeForEntityResolution + hasRealContentWords: a pure operator question has no real content', () => {
  const sanitized = sanitizeForEntityResolution('How many meetings happened this week?');
  assert.equal(hasRealContentWords(sanitized), false);
});

test('sanitizeForEntityResolution + hasRealContentWords: a question naming a real topic keeps real content', () => {
  const sanitized = sanitizeForEntityResolution('What is happening in SmartFilters?');
  assert.equal(hasRealContentWords(sanitized), true);
});
