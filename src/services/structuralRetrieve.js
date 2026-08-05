/**
 * Structural (hierarchy-aware) retrieval.
 *
 * Flat vector search can't reliably answer "what's under X" / "structure of X".
 * The ingested points already carry the tree links (portfolio/project via parentId,
 * tasks via projectId/portfolioId), so we resolve an anchor by vector search, then
 * walk descendants by ID and hand the real subtree to the LLM. No re-ingest needed.
 */
import { scrollPayloads } from './qdrantScroll.js';
import { searchKnowledge } from './qdrant.js';
import { queryTokens, extractKeywords, normalizeText, hasTemporalIntent } from '../utils/textMatch.js';
import { groupByEntity, toCandidates, tsOf } from '../utils/disambiguate.js';

const DEBUG_RAG = process.env.DEBUG_RAG !== 'false';

// ---------------------------------------------------------------------------
// Operator-vocabulary vs. entity-reference text (Phase 12). A question's OPERATOR words (what to
// count/list, which date range, which type) routinely collide with a real title's own words in a
// 750+-item corpus ("Overdue Projects", "Annex Updated", "Week Task Distribution", a portfolio
// with "Meetings" in its name) — resolveContainerAnchor's keyword-overlap scoring can't otherwise
// tell "the question is ABOUT this operator" from "the question NAMES this real entity". Centralized
// here (not duplicated per caller) because that's exactly how this collided before: structuredFilters
// .js's resolveContainerFilter sanitized before calling resolveContainerAnchor, but structuralRetrieve()
// below called it directly on the raw question — the hierarchy/recent-work branches never got the
// same protection the count/overdue/date-list branches did.
// "last"/"next" added (Phase 13): live-caught the same collision class on "how many meetings
// happened LAST week" anchoring to a real project literally titled "Last Modified Views MIgration
// SPA" — "last" alone, unweighted and unstripped, won a confident single-word match. Same pattern
// as every other entry in this list: a common relative-time word that happens to also be someone's
// real title.
const TEMPORAL_VOCAB_RE = /\b(updated|modified|created|latest|newest|recent|recently|due|today|yesterday|tomorrow|last|next|week|weeks|month|months|day|days|year|years|quarter|quarters)\b/gi;
const STATUS_VOCAB_RE = /\b(overdue|past due|late|behind schedule|completed|done|finished|pending|in progress|working on it|active)\b/gi;
const ENTITY_TYPE_VOCAB_RE = /\b(portfolios?|projects?|tasks?|meetings?|time ?entr(?:y|ies)|timesheets?)\b/gi;
const BARE_NUMBER_RE = /\b\d{3,}\b/g;

/** Strips OPERATOR vocabulary (temporal/status/entity-type/bare-number) that names WHAT KIND of
 *  question this is, not WHICH real entity it's about — the same collision class as "Overdue
 *  Projects" being a real title while "overdue" is also this app's own filter-trigger word. */
export function sanitizeForEntityResolution(question) {
  return String(question || '')
    .replace(TEMPORAL_VOCAB_RE, ' ')
    .replace(STATUS_VOCAB_RE, ' ')
    .replace(ENTITY_TYPE_VOCAB_RE, ' ')
    .replace(BARE_NUMBER_RE, ' ');
}

// Words that carry essentially no identifying signal ON THEIR OWN — they're either question
// scaffolding or generic product vocabulary that happens to appear inside MANY unrelated real
// titles ("Leave Management Tool", "Team Management Tools", "Development Team Management System"
// all share "management"/"team"/"system"/"tool"/"development"). A single overlapping token from
// this set must never be enough to win a match by itself (Phase 12 step 4) — but several of them
// together, or one alongside a real distinguishing word, still legitimately identify a real title
// that's actually named using this vocabulary (many real titles genuinely are "Team Management...").
// So these are DOWNWEIGHTED in scoring, not stripped outright, unlike the operator vocabulary above.
const GENERIC_SCAFFOLD_WORDS = new Set([
  'what', 'is', 'are', 'was', 'were', 'the', 'a', 'an', 'most', 'any', 'all', 'some', 'new', 'top',
  'which', 'who', 'how', 'many', 'much', 'of', 'in', 'on', 'for', 'to', 'with', 'show', 'me', 'list',
  'does', 'have', 'has', 'had', 'happening', 'happened', 'happen', 'going', 'this', 'that', 'these',
  'those', 'there', 'been', 'and', 'did',
]);
export const GENERIC_ENTITY_WORDS = new Set([
  'team', 'management', 'system', 'systems', 'tool', 'tools', 'development', 'module', 'modules',
  'app', 'apps', 'application', 'applications', 'platform', 'component', 'components',
]);
const GENERIC_WORD_WEIGHT = 0.3; // ponytail: empirically-picked downweight, not tuned to any one question — revisit with real click-through data if it under/over-triggers ambiguity.

// True edit distance <= 1 (insertion/deletion/substitution) — cheap enough not to need a library.
function withinOneEdit(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (la === lb) { i++; j++; } else if (la > lb) { i++; } else { j++; }
  }
  return edits + (la - i) + (lb - j) <= 1;
}

// Generic words are downweighted so ONE coincidental overlap can't win a match — but that
// protection silently evaporated for a misspelled generic word, since exact Set membership can't
// tell "managment" from "management". Verified live: a real portfolio is itself titled "Leave
// managment tool" (the SAME typo as a typo'd real question, "portfoilo managment") — matching
// exactly on the misspelling, weight=1 (full, non-generic), won outright with no other candidate
// close behind. A misspelling of generic vocabulary is if anything LESS reliable as a signal than
// the correctly-spelled word, not more — fuzzy-match (edit distance <= 1) against the generic list
// too, not just literal words that happen to still be spelled correctly. Length-gated (>=6) so
// short real words don't accidentally fuzzy-collide with an unrelated short generic word.
function isGenericWord(w) {
  if (GENERIC_ENTITY_WORDS.has(w)) return true;
  if (w.length < 6) return false;
  for (const g of GENERIC_ENTITY_WORDS) {
    if (g.length >= 6 && withinOneEdit(w, g)) return true;
  }
  return false;
}

/** True once ANY non-scaffolding, non-purely-generic word remains — i.e. the question actually
 *  names something, as opposed to being pure operator/filler text with nothing to entity-resolve
 *  at all ("how many meetings happened this week" sanitizes down to nothing; "team management
 *  tools" survives because content remains even though every word is individually generic). */
export function hasRealContentWords(sanitizedQuestion) {
  const words = sanitizedQuestion.toLowerCase().match(/[a-z]{3,}/g) || [];
  return words.some((w) => !GENERIC_SCAFFOLD_WORDS.has(w));
}

// "belongs? to" was previously a trigger here too, but it's genuinely ambiguous — "which tasks
// belong to Deepak Trivedi" means OWNERSHIP (a person), not CONTAINMENT (a project/portfolio),
// and this regex only knows the latter. Tested live: it walked the descendant tree of an unrelated
// project called "Tasks View Page" and presented those tasks as "belonging to" the named person.
// Removed — "part of"/"contained in"/"under"/"within" already cover genuine container questions
// unambiguously, without swallowing ownership questions that happen to share the phrase.
// "tasks/projects for X" (no "under"/"all"/"list" prefix) was a real, verified gap: "show tasks
// for Team Management Tools project" (56 real tasks) fell through to the generic vector-search
// path capped at ~10 results instead of this deterministic tree walk. Safe to add unconditionally
// — "tasks for <person>" (ownership, not containment) is caught by isOwnedByPersonQuestion earlier
// in query.js's branch order, so it never reaches this check; and if a container question here
// somehow names something that isn't a real project/portfolio, structuralRetrieve's anchor
// resolution just comes back empty and the caller falls through to general retrieval as before.
// "what is going on in X" / "what's happening in X" / "status of X" / "update on X" were a real,
// verified gap: they name ONE specific container but matched none of the patterns above, so they
// fell through to the generic capped hybrid path (8000 candidates squeezed to ~10 by similarity).
// Live check on "what is going on in Development Team Management System": the answer was a vague
// thematic summary that never mentioned the project's own actively-worked task, updated that same
// day, while the deterministic walk below returns the real subtree with no top-K cap. Safe to add:
// ownership phrasings ("tasks owned by <person>") are caught by isOwnedByPersonQuestion earlier in
// query.js's branch order, "feedback/comments/description of X" by isExactLookupQuestion, and if
// the named thing isn't a real project/portfolio the anchor resolution just comes back empty and
// the caller falls through to general retrieval exactly as before.
const HIERARCHY_RE =
  /\b(under|within|inside|structure of|break\s?down|hierarchy|children of|child items|sub[- ]?(items|components|tasks|features)|all (tasks|projects|items|features|components|sub ?components)\b.*\b(in|under|of|for|below)|part of|contained in|what'?s (in|under)|list (the )?(tasks|projects|items|features|components)\b.*\b(in|under|for|of)|(tasks?|projects?|items?|features?|components?)\s+(for|of)\s|what(?:'?s| is)?\s+(?:going\s+on|happening)\s+(?:in|on|with|for)\s|status\s+of\s|update\s+on\s)\b/i;

export function isHierarchyQuestion(question) {
  return HIERARCHY_RE.test(String(question || ''));
}

/**
 * Pick the real portfolio/project the question names, from the FULL real dataset (not just the
 * vector top-5) — and refuse to guess when several genuinely distinct real entities tie for the
 * best match. Verified live: "what are the latest task under team management tool project" was
 * silently answered from "Team Task Management" when the real data also has "Team Management
 * Tools", "HHHH Team Management", "Development Team Management System", and 4 more distinctly
 * real projects/portfolios sharing the same words — the old code (plain vector top-1) just picked
 * whichever one embedded closest, with no signal to the user that 7 other real candidates existed.
 * Scored by real keyword overlap against every real title, not vector similarity, because vector
 * closeness for near-duplicate names is exactly the thing that was picking arbitrarily here.
 */
// extractKeywords() already strips exactly this class of word (portfolio/project/task/etc. — see
// its own comment in textMatch.js) for the same reason disambiguate.js's plausibleGroups() uses
// it: these words are too generic on their own and, critically, appear LITERALLY inside many real
// title strings that have nothing to do with the question's real topic (a real project literally
// titled "Portfolio Tool - SPFx Issues and Bug fixing" is not what "SmartFilters portfolio" is
// asking about; "task" inside "what's the latest TASK under X" is asking ABOUT tasks, not naming
// an entity called "Task X"). Found via two direct regression checks — the first version of this
// function only excluded portfolio/project and NOT task, which let "task" in a question like
// "what are the latest task under team management tool project" pull "Team Task Management" and
// "Task Management Tool" into a false top-scoring tie ahead of the plain "Team Management" match.
/** BFS descendant portfolio/project ids from `anchorId` (inclusive) — shared by structuralRetrieve()
 *  and the structured-filter container resolver so both walk the exact same tree the exact same way. */
export function descendantContainerIds(anchorId, containerItems) {
  const childrenOf = new Map();
  for (const p of containerItems) {
    const par = num(p.parentId);
    if (!par) continue;
    if (!childrenOf.has(par)) childrenOf.set(par, []);
    childrenOf.get(par).push(p);
  }
  const descendantIds = new Set([anchorId]);
  const queue = [anchorId];
  while (queue.length) {
    const cur = queue.shift();
    for (const child of childrenOf.get(cur) || []) {
      const cid = num(child.sharePointItemId);
      if (cid && !descendantIds.has(cid)) {
        descendantIds.add(cid);
        queue.push(cid);
      }
    }
  }
  return descendantIds;
}

/** True when the question/title overlap is more than a single coincidental generic-word hit — see
 *  the matching `hasNonGenericMatch` logic in resolveContainerAnchor below for why 2+ generic
 *  words matching together still counts (a real multi-word title, unlike one stray token). */
export function hasNonGenericTitleOverlap(sanitizedQuestion, title) {
  const qWords = extractKeywords(sanitizedQuestion);
  const titleWords = new Set(queryTokens(title));
  const matched = qWords.filter((w) => titleWords.has(w));
  return matched.length >= 2 || matched.some((w) => !isGenericWord(w));
}

export function resolveContainerAnchor(question, containerItems) {
  const sanitized = sanitizeForEntityResolution(question);
  if (!hasRealContentWords(sanitized)) return { anchor: null };

  const qWords = extractKeywords(sanitized);
  if (!qWords.length) return { anchor: null };

  const weight = (w) => (isGenericWord(w) ? GENERIC_WORD_WEIGHT : 1);

  const groups = groupByEntity(containerItems);
  const scored = groups
    .map((g) => {
      const titleTokens = queryTokens(g.title);
      const titleWords = new Set(titleTokens);
      const matched = qWords.filter((w) => titleWords.has(w));
      // Precision matters as much as raw overlap count: "SmartFilters" (1 word, 1 match — a
      // near-exact name match) must beat "Share SmartFilters" or "Full Dynamic SmartFilters
      // Approach" (also 1 match each, but buried among 1-3 OTHER words the question never asked
      // about) — otherwise a bare, exact real title loses a tie to unrelated longer titles that
      // merely happen to contain the same one word. Found via a direct regression check on
      // "what's under SmartFilters portfolio", which real data has 6 different real titles
      // containing the word "smartfilters".
      // Matches are WEIGHTED, not counted 1-for-1: a purely-generic word ("management") counts for
      // much less than a distinguishing one, so one coincidental generic overlap can't outscore (or
      // tie) a title that shares zero real content with the question (Phase 12 step 4).
      const score = matched.reduce((s, w) => s + weight(w), 0);
      const ratio = titleTokens.length ? score / titleTokens.length : 0;
      // "Real signal" means either a genuinely distinguishing word matched, OR several generic
      // words matched TOGETHER as a phrase (e.g. "Team Management Tools" — every word is
      // individually generic, but a real, unique, multi-word title made entirely of them is still
      // a legitimate match). What must never win is a SINGLE stray generic word overlapping an
      // otherwise-unrelated title — that's the "one generic token" case Phase 12 step 4 targets.
      const hasNonGenericMatch = matched.length >= 2 || matched.some((w) => !isGenericWord(w));
      return { group: g, score, ratio, hasNonGenericMatch };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return { anchor: null };

  const topScore = scored[0].score;
  let tied = scored.filter((s) => Math.abs(s.score - topScore) < 1e-9);

  // The top tier matched ONLY on generic vocabulary — every candidate that scored at all did so
  // purely via words like "team"/"management"/"system"/"tools", which are exactly as likely to
  // coincidentally appear in an unrelated title as in the one actually meant. Refuse rather than
  // confidently pick one; the caller falls back to general retrieval instead of a wrong entity.
  if (!tied.some((s) => s.hasNonGenericMatch)) return { anchor: null };

  // Near-ties, not just exact ties, are genuine ambiguity: a runner-up within ~20% of the winner's
  // weighted score (and itself backed by real, non-generic content — not just noise) is a real
  // second candidate a human would also plausibly mean, even though the deterministic tiebreaks
  // below would otherwise silently pick the top one. (Phase 12 step 5 — margin, not exact-tie-only.)
  if (tied.length === 1) {
    const NEAR_TIE_MARGIN = 0.8; // ponytail: runner-up within 80% of the winner's score counts as close; not tuned to one question.
    const closeSecond = scored.find(
      (s) => s !== tied[0] && s.hasNonGenericMatch && s.score >= topScore * NEAR_TIE_MARGIN
    );
    if (closeSecond) tied = [tied[0], closeSecond];
  }

  // Among candidates tied on raw keyword overlap, a dormant placeholder ("Not Started", never
  // touched) shouldn't silently outrank one that's actually being worked on just because its
  // title is shorter/more "exact" — the ratio tiebreak below can't tell "the real thing everyone
  // means" from "a barely-started stub that happens to share the same two words". Verified live:
  // "Team Management Tool" tied "Team Management" (Not Started, dormant since 2023) against
  // "Team Management System (Hardware/Software and Licenses)" (In Progress, touched today) —
  // ratio picked the dormant one purely for having a shorter, exact-looking title.
  if (tied.length > 1) {
    const active = tied.filter((s) => s.group.items.some((i) => i.status && i.status !== 'Not Started'));
    if (active.length && active.length < tied.length) tied = active;
  }

  // Real data nests near-identically named containers — e.g. project "Development Team Management
  // System" (3 tasks) is a direct CHILD of "Development Team Management System (Assets Accounts
  // Permissions)" (68 tasks). Both tie on keyword overlap, and the ratio tiebreak below then picks
  // the child purely for having the shorter, exact-looking title — answering about 3 tasks while
  // silently hiding the other 65. When one tied candidate is an ancestor of another, the ancestor's
  // tree walk already CONTAINS the descendant's, so preferring the ancestor is a strict superset:
  // it cannot lose information, only add the rest of the subtree the user asked about.
  if (tied.length > 1) {
    const byId = new Map();
    for (const item of containerItems) {
      const id = Number(item.sharePointItemId);
      if (Number.isFinite(id) && !byId.has(id)) byId.set(id, item);
    }
    const tiedIds = new Set(
      tied.map((s) => Number(s.group.items[0]?.sharePointItemId)).filter(Number.isFinite)
    );
    const descendsFromAnotherTied = (item) => {
      const seen = new Set();
      let parent = Number(item?.parentId);
      while (Number.isFinite(parent) && parent > 0 && !seen.has(parent)) {
        if (tiedIds.has(parent)) return true;
        seen.add(parent);
        parent = Number(byId.get(parent)?.parentId);
      }
      return false;
    };
    const ancestors = tied.filter((s) => !descendsFromAnotherTied(s.group.items[0]));
    if (ancestors.length && ancestors.length < tied.length) tied = ancestors;
  }

  if (tied.length === 1) {
    return { anchor: tied[0].group.items[0] };
  }

  // "latest/newest/updated yesterday/..." — the question is explicitly asking about recency, so
  // the strict title-ratio tier below (which exists to prefer exact-looking names for ordinary
  // questions) is the wrong tiebreak here: it would silently drop a longer-titled but genuinely
  // current record (e.g. "Development Team Management System", updated yesterday) in favor of a
  // shorter-titled but stale one, purely because its title has one extra word. Only takes this
  // branch when the query itself signals recency — ordinary questions ("Team Management") are
  // completely unaffected and keep the exact ratio-tiebreak behavior below.
  if (hasTemporalIntent(question)) {
    return resolveByRecency(tied, question);
  }

  const topRatio = Math.max(...tied.map((s) => s.ratio));
  const precise = tied.filter((s) => s.ratio === topRatio);
  if (precise.length === 1) {
    return { anchor: precise[0].group.items[0] };
  }
  tied = precise;

  // Tie among distinct real entities — the question explicitly saying "portfolio" or "project"
  // is a real disambiguating signal that plain keyword-overlap scoring throws away (both words are
  // themselves too generic to raise one title's score over another's). Use it before giving up.
  const qNorm = normalizeText(question);
  const wantsType = qNorm.includes(' portfolio') || qNorm.endsWith('portfolio')
    ? 'portfolio'
    : qNorm.includes(' project') || qNorm.endsWith('project')
      ? 'project'
      : null;
  if (wantsType) {
    const typeMatches = tied.filter((s) => s.group.items.some((i) => i.type === wantsType));
    if (typeMatches.length === 1) return { anchor: typeMatches[0].group.items[0] };
  }

  return { ambiguous: true, candidates: toCandidates(tied.map((s) => s.group)) };
}

/**
 * Adapts a resolveContainerAnchor()-shaped result ({anchor}|{ambiguous,candidates}|{anchor:null})
 * into the canonical entity-resolution contract (Phase 12): {queryText, expectedType, candidates,
 * resolution}. Existing call sites keep reading anchor/ambiguous directly (no behavior change) —
 * this is for callers/tests that want the explicit resolution-state shape instead of re-deriving
 * "confident vs ambiguous vs not_found" from which fields happen to be set.
 */
export function toEntityResolution(question, expectedType, result) {
  if (result.anchor) {
    return {
      queryText: question,
      expectedType,
      candidates: [{
        id: result.anchor.sharePointItemId ?? null,
        title: result.anchor.title,
        type: result.anchor.type,
        score: 1,
        matchReason: 'resolved',
      }],
      resolution: 'confident',
    };
  }
  if (result.ambiguous) {
    return {
      queryText: question,
      expectedType,
      candidates: result.candidates.map((c) => ({
        id: c.sharePointItemId ?? null,
        title: c.title,
        type: c.type,
        score: c.count || 1,
        matchReason: 'ambiguous',
      })),
      resolution: 'ambiguous',
    };
  }
  return { queryText: question, expectedType, candidates: [], resolution: 'not_found' };
}

/**
 * Recency-aware resolution for temporal-intent questions ("latest X", "X updated yesterday").
 * `tied` are candidates that already tied on raw keyword-overlap SCORE (equally relevant by that
 * measure) — the only thing separating them here is title length/precision (ratio). Rather than
 * keep only the single tightest-ratio tier (which is what silently drops a real, currently-active
 * record just for having one extra word in its title), keep every candidate whose ratio is still
 * reasonably close to the best one in this tie group, then let real Modified/Updated timestamps —
 * not vector similarity — decide the winner. A candidate that never matched the topic at all was
 * already excluded upstream (score > 0 filter), so an unrelated-but-newer record can't win here.
 */
function resolveByRecency(tied, question) {
  const topRatio = Math.max(...tied.map((s) => s.ratio));
  // ponytail: relative floor (not an absolute number) so this scales with title length instead of
  // being tuned to one topic; revisit if a real case needs a stricter/looser cutoff than 65%.
  const RELEVANCE_FLOOR = 0.65;
  const qualified = tied.filter((s) => s.ratio >= topRatio * RELEVANCE_FLOOR);
  const pool = qualified.length ? qualified : tied;

  const ranked = pool
    .map((s) => {
      const newest = [...s.group.items].sort((a, b) => tsOf(b) - tsOf(a))[0];
      return { ...s, newest, ts: tsOf(newest) };
    })
    .sort((a, b) => b.ts - a.ts);

  if (DEBUG_RAG) {
    console.log(
      `[RETRIEVAL] anchor-resolution (temporal) query="${String(question).slice(0, 80)}" ` +
        `tied=${tied.length} qualified=${qualified.length}/${tied.length} (ratio>=${(topRatio * RELEVANCE_FLOOR).toFixed(3)}) ` +
        `winner="${ranked[0].newest.title}" (${ranked[0].newest.type}, ratio=${ranked[0].ratio.toFixed(3)}, ` +
        `updated=${String(ranked[0].newest.timestamp || ranked[0].newest.start || '').slice(0, 10)})`
    );
    ranked.forEach((r, i) => {
      console.log(
        `  #${i + 1} ${r.newest.title} ratio=${r.ratio.toFixed(3)} ` +
          `updated=${String(r.newest.timestamp || r.newest.start || '').slice(0, 10)}`
      );
    });
  }

  return { anchor: ranked[0].newest };
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * @param {object} [options]
 * @param {object} [options.anchorOverride] - already-resolved anchor payload (e.g. from
 *   resolveReferencedTopic for a pronoun follow-up like "under it") — skips the vector search
 *   entirely, since a follow-up's own words ("it", "latest", "under") carry no real topic to
 *   search for and can otherwise resolve to a completely unrelated container.
 * @returns {Promise<null | { anchor: object, masters: object[], tasks: object[], descendantIds: Set<number> }>}
 */
export async function structuralRetrieve(question, { anchorOverride } = {}) {
  const all = await scrollPayloads({ types: ['portfolio', 'project', 'task'], limit: 20000 });
  if (!all.length) return null;

  const byId = new Map();
  for (const p of all) {
    const id = num(p.sharePointItemId);
    if (id && !byId.has(id)) byId.set(id, p);
  }

  let anchor = anchorOverride;
  if (!anchor) {
    // Keyword-overlap resolution against the FULL real dataset first — catches genuine ambiguity
    // (several distinct real entities tied for best match) that vector top-1 silently papers over.
    // Only when it finds nothing at all (no real title shares a keyword with the question) does
    // this fall back to the old vector-search behavior, which is still the better tool for
    // "described but not named" questions where no title literally overlaps the question's words.
    const containerItems = all.filter((p) => p.type === 'portfolio' || p.type === 'project');
    const resolved = resolveContainerAnchor(question, containerItems);
    if (resolved.ambiguous) return { ambiguous: true, candidates: resolved.candidates };
    anchor = resolved.anchor;

    if (!anchor) {
      // The keyword resolver above found ZERO real-title overlap — before trusting embedding
      // similarity (which tolerates typos/paraphrase but has NO disambiguation of its own and no
      // way to say "I'm not sure"), require the question to actually name something distinguishing
      // at all. A pure operator/scaffolding question, or one whose only "content" is itself generic
      // vocabulary, has nothing to entity-resolve — semantic search on it just returns whatever the
      // embedding happens to sit closest to, confidently and wrongly. Verified live: a typo'd
      // "what is happening with portfoilo managment" resolved to an unrelated "Leave management
      // tool" this way — the keyword resolver correctly found nothing, but the fallback below used
      // to trust vector top-1 unconditionally regardless. Falling through to `anchor: null` here
      // defers to the caller's general-retrieval path instead (the same behavior this question got
      // before the hierarchy branch was widened to catch "what's happening with X" questions).
      const sanitized = sanitizeForEntityResolution(question);
      if (hasRealContentWords(sanitized)) {
        // Anchor = the container the user named. Restrict the vector search to portfolio/project types
        // first: real data can have dozens of near-identically-worded TASKS (e.g. many "Team Management
        // Tool ..." tasks), which can outrank the one actual project/portfolio in an unrestricted top-8
        // search, leaving the "anchor" as a task with no real descendants. Only fall back to an
        // unrestricted search if nothing scores as a portfolio/project at all.
        const containerFilter = { should: [{ key: 'type', match: { value: 'portfolio' } }, { key: 'type', match: { value: 'project' } }] };
        const containerHits = (await searchKnowledge(question, 5, containerFilter).catch(() => [])).filter((h) => h.payload);
        const hits = containerHits.length ? containerHits : (await searchKnowledge(question, 8).catch(() => [])).filter((h) => h.payload);
        const isContainer = (h) => h.payload.type === 'portfolio' || h.payload.type === 'project';
        const top = hits.find(isContainer) || hits[0];
        const runnerUp = hits.find((h) => h !== top && isContainer(h));

        // A semantic top-1 is only trustworthy when it clearly beats the runner-up (several close
        // scores mean several plausible real entities, not one obvious answer — same principle as
        // the keyword resolver's near-tie ambiguity check above) AND it actually shares a real,
        // non-generic word with the question rather than winning on embedding-space proximity to
        // generic vocabulary alone ("management"/"team"/"tool"/"system" are common to dozens of
        // unrelated real titles, so semantic closeness on those words alone proves nothing).
        const SEMANTIC_MARGIN = 1.15; // ponytail: top must beat the runner-up by >=15%, empirically picked, not tuned to one question.
        const dominant = !runnerUp || (top?.score || 0) >= (runnerUp?.score || 0) * SEMANTIC_MARGIN;
        const titleShares = top && hasNonGenericTitleOverlap(sanitized, top.payload.title);
        if (top && dominant && titleShares) {
          anchor = top.payload;
        }
      }
    }
  }
  const anchorId = num(anchor?.sharePointItemId);
  if (!anchor || !anchorId) return null;

  const containersOnly = all.filter((p) => p.type === 'portfolio' || p.type === 'project');
  const descendantIds = descendantContainerIds(anchorId, containersOnly);

  const masters = [...descendantIds].map((id) => byId.get(id)).filter(Boolean);
  const tasks = all.filter(
    (p) => p.type === 'task' && (descendantIds.has(num(p.projectId)) || descendantIds.has(num(p.portfolioId)))
  );

  if (process.env.DEBUG_RAG !== 'false') {
    console.log(
      `[RETRIEVAL] entity-question query="${String(question).slice(0, 80)}" ` +
        `anchor="${anchor.title}" (${anchor.type}, id=${anchorId}) ` +
        `descendantContainers=${masters.length} tasks=${tasks.length} — deterministic tree walk, no top-K limit`
    );
  }

  return { anchor, masters, tasks, descendantIds };
}

/** Compact, deterministic rendering of the subtree for the LLM prompt. */
export function buildStructuralPrompt(question, structural) {
  const { anchor, masters, tasks } = structural;
  const line = (p) => {
    const status = p.status || (String(p.text || '').match(/Status:\s*([^.,]+)/i)?.[1] || '').trim();
    const kind = p.itemType || p.type;
    return `- ${p.title || 'Untitled'}${kind ? ` [${kind}]` : ''}${status ? ` (status: ${status})` : ''}`;
  };

  // anchor is first in masters; list the rest as its descendants.
  const descMasters = masters.filter((m) => num(m.sharePointItemId) !== num(anchor.sharePointItemId));
  const MAX = 80;
  const mastersText = descMasters.slice(0, MAX).map(line).join('\n') || '(none)';
  const tasksText = tasks.slice(0, MAX).map(line).join('\n') || '(none)';
  const more = (n, cap) => (n > cap ? `\n…and ${n - cap} more` : '');

  const system =
    'You are HHHH Agent. You are given the EXACT structure of one item from the ' +
    'knowledge base (its sub-components/projects and tasks). Answer the user\'s question using ONLY ' +
    'this structure. When listing, use the real titles verbatim. State counts when asked. ' +
    'Do NOT invent items, statuses, or owners. Keep it clear and concise.';

  const user = `USER QUESTION:
${question}

ANCHOR ITEM: "${anchor.title}" (type: ${anchor.type}${anchor.hierarchyPath ? `, path: ${anchor.hierarchyPath}` : ''})

SUB-COMPONENTS / PROJECTS UNDER IT (${descMasters.length} total):
${mastersText}${more(descMasters.length, MAX)}

TASKS UNDER IT (${tasks.length} total):
${tasksText}${more(tasks.length, MAX)}

Answer the question about "${anchor.title}" using only the structure above.`;

  return { system, user };
}
