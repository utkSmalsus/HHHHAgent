/**
 * Multi-entity comparison queries ("which is more recently updated, A or B", "compare A and B",
 * "is A newer than B", "which has more tasks, A or B").
 *
 * Root cause this fixes (confirmed live, Phase 13): these questions were previously caught by
 * isRecentWorkQuestion ("recently" triggers it) and handed to structuralRetrieve(), whose resolver
 * assumes ONE named entity plus its descendant subtree. It picked ONE of the two names as "the
 * anchor" and treated the OTHER name as if it must be that anchor's own child, then correctly (but
 * uselessly) reported the other name "isn't a sub-component" of it — a query-SHAPE mismatch, not a
 * vocabulary-collision or confidence problem (the entity-resolution safety work from the prior
 * phase doesn't help here; this needs the query shape recognized at all).
 *
 * A comparison question names TWO independent entities with no parent/child relationship assumed.
 * Each is resolved on its own, through the SAME safe resolver (resolveContainerAnchor) used
 * everywhere else — never a confident wrong pick; unresolved or ambiguous fails closed.
 */
import { scrollPayloads, countBusinessEntities } from './qdrantScroll.js';
import { resolveContainerAnchor, descendantContainerIds } from './structuralRetrieve.js';

const COMPARE_RE = /\bcompare\b/i;
const THAN_RE = /\b(?:is|are)\b.+\b(?:newer|older|more\s+recent(?:ly)?)\s+than\b/i;
const WHICH_COMPARATIVE_RE =
  /\bwhich\b[^?.!]*\b(more\s+recently\s+updated|updated\s+(?:later|earlier|sooner)|newer|older|more\s+tasks|fewer\s+tasks|has\s+more|has\s+fewer)\b/i;

export function isComparisonQuestion(question) {
  const q = String(question || '');
  return COMPARE_RE.test(q) || THAN_RE.test(q) || (WHICH_COMPARATIVE_RE.test(q) && /\bor\b/i.test(q));
}

/**
 * Splits a comparison question into its two entity-reference TEXT SEGMENTS — deliberately NOT
 * fully cleaned entity names. Each segment is handed to resolveContainerAnchor as-is, which already
 * downweights/ignores scaffold and operator words on its own (Phase 12), so a fragile trigger-
 * phrase-stripping regex isn't needed here: leftover words like "which is more recently updated"
 * just score 0 against every real title and contribute nothing.
 * @returns {[string,string]|null}
 */
export function splitComparisonSegments(question) {
  const q = String(question || '').trim().replace(/[?.!]+$/, '');

  let m = q.match(/^(?:is|are)\s+(.+?)\s+(?:newer|older|more\s+recent(?:ly)?)\s+than\s+(.+)$/i);
  if (m) return [m[1].trim(), m[2].trim()];

  m = q.match(/^compare\s+(.+?)\s+(?:and|with|vs\.?|versus)\s+(.+)$/i);
  if (m) return [m[1].trim(), m[2].trim()];

  const orParts = q.split(/\s+\bor\b\s+/i);
  if (orParts.length === 2 && orParts[0].trim() && orParts[1].trim()) {
    // "Which is more recently updated, A or B" — the real entity name on the left is very likely
    // after the trigger phrase's own comma, if it has one.
    const left = orParts[0].includes(',') ? orParts[0].split(',').pop().trim() : orParts[0].trim();
    return [left, orParts[1].trim()];
  }
  return null;
}

function detectAspect(question) {
  const q = String(question || '').toLowerCase();
  if (/\btasks?\b/.test(q) && /\b(more|fewer|most|least)\b/.test(q)) return 'taskCount';
  if (/\b(recently updated|updated later|updated earlier|newer|older|more recent)\b/.test(q)) return 'recency';
  return null; // plain "compare A and B" — no specific aspect named, show real facts side by side.
}

// FILTER FIRST (hierarchy membership), then DEDUPE (Phase 14) — same ordering and reasoning as
// applyStructuredFilters in structuredFilters.js: a chunked task's points share identical
// projectId/portfolioId, so membership-filtering before deduping can't drop a real task.
async function countTasksUnder(anchor, containerItems) {
  const anchorId = Number(anchor.sharePointItemId);
  if (!Number.isFinite(anchorId)) return 0;
  const ids = descendantContainerIds(anchorId, containerItems);
  const tasks = await scrollPayloads({ types: ['task'], limit: 30000 }).catch(() => []);
  const underAnchor = tasks.filter((t) => ids.has(Number(t.projectId)) || ids.has(Number(t.portfolioId)));
  return countBusinessEntities(underAnchor);
}

/**
 * Resolves BOTH named entities independently — never assumes either is a parent/child of the
 * other, and never substitutes one for the other.
 * @returns {Promise<null | { blocked: object } | { entities: object[], aspect: string|null, taskCounts?: number[] }>}
 *   `null` means this didn't actually parse into two distinct entity-reference segments (caller
 *   should fall through to general retrieval, not block the question).
 */
export async function resolveComparison(question, { getContainerItems } = {}) {
  const segments = splitComparisonSegments(question);
  if (!segments) return null;

  const containerItems = getContainerItems
    ? await getContainerItems()
    : await scrollPayloads({ types: ['portfolio', 'project'], limit: 20000 }).catch(() => []);

  const which = ['first', 'second'];
  const resolved = [];
  for (let i = 0; i < 2; i++) {
    const r = resolveContainerAnchor(segments[i], containerItems);
    if (r.ambiguous) {
      return { blocked: { kind: 'ambiguous-entity', which: which[i], segment: segments[i], candidates: r.candidates } };
    }
    if (!r.anchor) {
      return { blocked: { kind: 'unresolved-entity', which: which[i], segment: segments[i] } };
    }
    resolved.push({ anchor: r.anchor, segment: segments[i] });
  }

  // Two different segments resolving to the exact same real entity is itself a signal something's
  // off — safer to say so than silently "compare" an item with itself.
  if (Number(resolved[0].anchor.sharePointItemId) === Number(resolved[1].anchor.sharePointItemId)) {
    return { blocked: { kind: 'same-entity', title: resolved[0].anchor.title } };
  }

  const aspect = detectAspect(question);
  if (aspect === 'taskCount') {
    const taskCounts = await Promise.all(resolved.map((r) => countTasksUnder(r.anchor, containerItems)));
    return { entities: resolved, aspect, taskCounts };
  }
  return { entities: resolved, aspect };
}

const fmtDate = (ts) => (ts ? String(ts).slice(0, 10) : 'no date on record');

/** Deterministic, no-LLM rendering — same principle as the count/date-list/owned-by branches:
 *  a real, already-known fact doesn't need an LLM to restate it, and restating it removes any risk
 *  of the model second-guessing or contradicting the resolved facts. */
export function buildComparisonAnswer(result) {
  const { entities, aspect, taskCounts } = result;
  const [a, b] = entities;

  if (aspect === 'taskCount') {
    const [na, nb] = taskCounts;
    if (na === nb) {
      return `Both "${a.anchor.title}" and "${b.anchor.title}" have the same number of indexed tasks (${na}).`;
    }
    const [winner, wCount, loser, lCount] = na > nb ? [a, na, b, nb] : [b, nb, a, na];
    return `"${winner.anchor.title}" has more tasks (${wCount}) than "${loser.anchor.title}" (${lCount}).`;
  }

  if (aspect === 'recency') {
    const ta = Date.parse(a.anchor.timestamp || '') || 0;
    const tb = Date.parse(b.anchor.timestamp || '') || 0;
    if (!ta && !tb) {
      return `Neither "${a.anchor.title}" nor "${b.anchor.title}" has a recorded update date.`;
    }
    const [winner, loser] = ta >= tb ? [a, b] : [b, a];
    return `"${winner.anchor.title}" was updated more recently (${fmtDate(winner.anchor.timestamp)}, Modified-or-Created) than "${loser.anchor.title}" (${fmtDate(loser.anchor.timestamp)}).`;
  }

  const line = (e) => `- **${e.anchor.title}** (${e.anchor.type}) — status: ${e.anchor.status || 'unknown'}, updated: ${fmtDate(e.anchor.timestamp)}`;
  return `Here's what's on record for each:\n\n${line(a)}\n${line(b)}`;
}

export function buildComparisonBlockedAnswer(blocked) {
  if (blocked.kind === 'unresolved-entity') {
    return `I couldn't confidently match "${blocked.segment}" to a real project or portfolio in the indexed data, so I can't compare it. Try the exact title as it appears in the data.`;
  }
  if (blocked.kind === 'ambiguous-entity') {
    const lines = blocked.candidates.map((c) => `- **${c.title}**${c.type ? ` (${c.type})` : ''}`).join('\n');
    return `"${blocked.segment}" matches ${blocked.candidates.length} different items in your data — which one did you mean?\n\n${lines}`;
  }
  if (blocked.kind === 'same-entity') {
    return `Both parts of that question resolved to the same real item ("${blocked.title}") — there's nothing to compare.`;
  }
  return "I couldn't parse that as a comparison between two named items.";
}
