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
function resolveContainerAnchor(question, containerItems) {
  const qWords = extractKeywords(question);
  if (!qWords.length) return { anchor: null };

  const groups = groupByEntity(containerItems);
  const scored = groups
    .map((g) => {
      const titleTokens = queryTokens(g.title);
      const titleWords = new Set(titleTokens);
      const score = qWords.reduce((s, w) => s + (titleWords.has(w) ? 1 : 0), 0);
      // Precision matters as much as raw overlap count: "SmartFilters" (1 word, 1 match — a
      // near-exact name match) must beat "Share SmartFilters" or "Full Dynamic SmartFilters
      // Approach" (also 1 match each, but buried among 1-3 OTHER words the question never asked
      // about) — otherwise a bare, exact real title loses a tie to unrelated longer titles that
      // merely happen to contain the same one word. Found via a direct regression check on
      // "what's under SmartFilters portfolio", which real data has 6 different real titles
      // containing the word "smartfilters".
      const ratio = titleTokens.length ? score / titleTokens.length : 0;
      return { group: g, score, ratio };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return { anchor: null };

  const topScore = scored[0].score;
  let tied = scored.filter((s) => s.score === topScore);

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
      // Anchor = the container the user named. Restrict the vector search to portfolio/project types
      // first: real data can have dozens of near-identically-worded TASKS (e.g. many "Team Management
      // Tool ..." tasks), which can outrank the one actual project/portfolio in an unrestricted top-8
      // search, leaving the "anchor" as a task with no real descendants. Only fall back to an
      // unrestricted search if nothing scores as a portfolio/project at all.
      const containerFilter = { should: [{ key: 'type', match: { value: 'portfolio' } }, { key: 'type', match: { value: 'project' } }] };
      const containerHits = await searchKnowledge(question, 5, containerFilter).catch(() => []);
      const hits = containerHits.length ? containerHits : await searchKnowledge(question, 8);
      anchor =
        (hits.find((h) => h.payload && (h.payload.type === 'portfolio' || h.payload.type === 'project'))
          || hits[0])?.payload;
    }
  }
  const anchorId = num(anchor?.sharePointItemId);
  if (!anchor || !anchorId) return null;

  // Master tree: children keyed by parentId.
  const childrenOf = new Map();
  for (const p of all) {
    if (p.type !== 'portfolio' && p.type !== 'project') continue;
    const par = num(p.parentId);
    if (!par) continue;
    if (!childrenOf.has(par)) childrenOf.set(par, []);
    childrenOf.get(par).push(p);
  }

  // BFS descendant master ids (anchor included).
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
