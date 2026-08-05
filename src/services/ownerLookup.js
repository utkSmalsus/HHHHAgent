/**
 * Deterministic owner/assignment lookup — "which tasks belong to X" (a person) and "who is working
 * on X" (a project/portfolio).
 *
 * Both were previously answered by the general hybridRetrieve → LLM summarize path, which is
 * instructed to SYNTHESIZE rather than list ("do NOT just list task titles back") — fine for "what's
 * the status of X" but wrong here: tested live, the local 3B model produced vague generalizations
 * ("coordination, preparation, follow-up activities...") instead of naming the real task titles or
 * the real person, even though the data was retrieved correctly. Same principle as exactLookup.js:
 * a full-collection deterministic scan for a genuinely enumerable question beats LLM narration.
 *
 * Reads the `Owner:` value straight out of `.text` (not just the `owner` metadata field) so this
 * works on data ingested before `owner` was added to task/master metadata, not only after a re-ingest.
 */
import { scrollPayloads, uniqueBusinessEntities } from './qdrantScroll.js';
import { structuralRetrieve } from './structuralRetrieve.js';
import {
  resolveStructuredFilters,
  checkStructuredFiltersBlocked,
  applyStructuredFilters,
  resolveContainerFilter,
} from './structuredFilters.js';

// Possessive form ("Ranu Trivedi's tasks", "Ranu's completed tasks", "Ranu's tasks due this week")
// is a generic pattern — ANY capitalized 1-3 word name followed by "'s <=4 words> task(s)" — not
// tied to one person or one modifier. Was originally just "'s (overdue) tasks" (only "overdue"
// allowed in between), so "Ranu's COMPLETED tasks" and "Ranu's tasks DUE THIS WEEK" never matched
// this trigger at all; widened to allow any short modifier run so status/date phrasing composes
// the same way it already does for the "how many" branches.
const OWNED_BY_RE =
  /\b(which |what )?tasks?\s+(belong|belongs)\s+to\b|\btasks?\s+(owned|assigned)\s+(by|to)\b|\bwhose\s+tasks?\b|\b[A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+){0,2}'s\s+(?:\w+\s+){0,4}tasks?\b/u;
const WORKING_ON_RE =
  /\bwho\s+(is|are|'?s)\s+(working|assigned)\s+on\b|\bwho\s+owns\b|\bwho'?s?\s+responsible\s+for\b|\bwho\s+is\s+responsible\s+for\b/i;

export function isOwnedByPersonQuestion(question) {
  return OWNED_BY_RE.test(String(question || ''));
}

export function isWhoWorksOnQuestion(question) {
  return WORKING_ON_RE.test(String(question || ''));
}

function ownerOf(payload) {
  if (payload.owner) return payload.owner;
  const m = String(payload.text || '').match(/Owner:\s*([^.]+?)(?:\.|$)/);
  return m ? m[1].trim() : '';
}

/** Whatever's left of the question after stripping the "who is working on" style trigger. */
function extractTopicPhrase(question) {
  return String(question || '')
    .replace(WORKING_ON_RE, ' ')
    .replace(/^\s*(on|for|in|the)\s+/i, ' ')
    .replace(/[?.!]+$/, '')
    .trim();
}

/**
 * A real, specific TASK title embedded in the question (not just a portfolio/project) — same
 * length>=8/prefer-longest pattern used for meetings and the general exact-match rescue elsewhere.
 * Verified live: "<real task title> who is working on this task" was answering with the owner
 * list for the entire containing PORTFOLIO (75 tasks) instead of that one named task's actual
 * assignee, because structuralRetrieve/resolveContainerAnchor only ever resolves portfolio/project
 * anchors — a task title embedded in the question never had a chance to win. Checked first, before
 * falling back to the portfolio/project tree walk, so a named task always answers about itself.
 */
// Real task titles in this data routinely end with the date they were raised — "Feedback - Asset
// Management System (Hardware/Software and Licenses) 09-07-2025" — which users don't type when
// naming the task. Requiring the FULL stored title to appear in the question therefore never
// matched those tasks, so "who is working on <task name>" fell through to the portfolio/project
// tree walk and answered with the owners of an entire 81-task portfolio instead of that one task.
// Matching the date-stripped title as well keeps the question anchored to the task the user named.
const TITLE_DATE_SUFFIX_RE = /[\s,–-]+\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\s*$/;

async function resolveExactTaskMatch(question) {
  const qLower = String(question || '').toLowerCase();
  const tasks = await scrollPayloads({ types: ['task'], limit: 30000 });

  const matches = [];
  for (const t of tasks) {
    const title = String(t.title || '').trim();
    if (title.length < 8) continue;
    const bare = title.replace(TITLE_DATE_SUFFIX_RE, '').trim();
    let matchedLen = 0;
    if (qLower.includes(title.toLowerCase())) matchedLen = title.length;
    else if (bare.length >= 8 && qLower.includes(bare.toLowerCase())) matchedLen = bare.length;
    if (matchedLen) matches.push({ task: t, matchedLen });
  }
  if (!matches.length) return null;

  // Longest named title wins (most specific). Several real tasks can share one name and differ only
  // by their date suffix — prefer one that actually has an owner recorded, then the most recent, so
  // "who is working on it" reports a real person when any of them names one.
  const maxLen = Math.max(...matches.map((m) => m.matchedLen));
  const longest = matches.filter((m) => m.matchedLen === maxLen);
  const withOwner = longest.filter((m) => ownerOf(m.task));
  const pool = withOwner.length ? withOwner : longest;
  return pool.sort((a, b) =>
    String(b.task.timestamp || '').localeCompare(String(a.task.timestamp || ''))
  )[0].task;
}

/**
 * @returns {Promise<{ name: string, matches: object[] } | { blocked: object } | null>}
 * `null` means this question named no person at all (caller should try other branches).
 * `{ blocked }` means SOME structured constraint (person, project/portfolio, or date) failed to
 * resolve or was genuinely ambiguous — caller must surface it via buildBlockedResponse(), never
 * fall through to an unscoped answer.
 *
 * Routed through the same centralized resolver every other deterministic branch uses (see
 * structuredFilters.js) — this used to run its OWN separate person-extraction and only ever
 * applied overdue/status on top, silently ignoring a container ("Ranu Trivedi's tasks in Team
 * Management Tools" returned ALL of Ranu's tasks, the project qualifier was dropped). A dedicated
 * grammar-based extractor for "belongs to X"/"owned by X" existed here too, but resolvePersonFilter
 * already finds a name ANYWHERE in the question (any 2-3 consecutive capitalized words), so it
 * covers that phrasing on its own — removed as redundant rather than kept as a second, divergent
 * path that could resolve a different (unvalidated, not real-data-checked) name than this module's
 * shared resolver would.
 */
export async function tasksOwnedByPerson(question) {
  const sf = await resolveStructuredFilters(question, 'task');
  if (!sf.personFilter.requested) return null;

  const blocked = checkStructuredFiltersBlocked(sf);
  if (blocked.blocked) return { blocked };

  const tasks = await scrollPayloads({ types: ['task'], limit: 30000 });
  const matches = applyStructuredFilters(tasks, sf);
  return { name: sf.personFilter.resolvedName, matches };
}

/** @returns {Promise<{ anchor: object, owners: string[], taskCount: number, exact?: boolean } | null>} */
/**
 * @returns {Promise<{ anchor, owners, taskCount, exact? } | { blocked: object } | null>}
 * `null` means no real topic was named at all (e.g. an unresolved pronoun like "this project" with
 * no conversation context available here) — this function does NOT resolve conversational pronouns
 * itself; see the doc comment above the call site in query.js for that limitation.
 * `{ blocked }` means the named project/portfolio was genuinely ambiguous — caller must surface it,
 * never silently fall through to an unrelated branch (verified live: this used to happen).
 */
export async function whoWorksOnTopic(question) {
  const exactTask = await resolveExactTaskMatch(question).catch(() => null);
  if (exactTask) {
    const raw = ownerOf(exactTask);
    const owners = raw
      ? [...new Set(raw.split(/,|;|\band\b/i).map((s) => s.trim()).filter(Boolean))]
      : [];
    return { anchor: exactTask, owners, taskCount: 1, exact: true };
  }

  const topic = extractTopicPhrase(question);
  if (!topic || topic.length < 2) return null;

  // Routed through resolveContainerFilter (the same collision-avoided resolver every other
  // deterministic branch uses) instead of calling structuralRetrieve()/resolveContainerAnchor()
  // directly — this used to skip ALL of the temporal/status/bare-number vocabulary stripping and
  // the pure-scaffolding-question guard those fixes added, so "who is working on X" was exposed to
  // the exact "Team"/"Management" generic-word-overlap risk the rest of the app no longer has.
  const containerFilter = await resolveContainerFilter(topic);
  if (containerFilter.ambiguous) {
    // Previously returned null here and silently fell through to whatever branch ran next —
    // verified live as a real instance of "constraint detected, then silently dropped".
    return { blocked: { kind: 'ambiguous-container', containerFilter } };
  }
  if (containerFilter.requested && !containerFilter.resolved) {
    return { blocked: { kind: 'unresolved-container', containerFilter } };
  }
  if (!containerFilter.resolved) return null;

  const allTasks = await scrollPayloads({ types: ['task'], limit: 30000 }).catch(() => []);
  const ids = containerFilter.resolved.descendantIds;
  // FILTER FIRST (hierarchy membership), then DEDUPE (Phase 14) — a chunked task's points share
  // identical projectId/portfolioId/owner, so this can't drop a real task and fixes `taskCount`
  // from counting Qdrant points instead of real tasks.
  const tasks = uniqueBusinessEntities(
    allTasks.filter((t) => ids.has(Number(t.projectId)) || ids.has(Number(t.portfolioId)))
  );

  const owners = new Map();
  for (const t of tasks) {
    const raw = ownerOf(t);
    if (!raw) continue;
    for (const single of raw.split(/,|;|\band\b/i).map((s) => s.trim()).filter(Boolean)) {
      owners.set(single.toLowerCase(), single);
    }
  }
  return {
    anchor: { title: containerFilter.resolved.title, type: containerFilter.resolved.type, sharePointItemId: containerFilter.resolved.id },
    owners: [...owners.values()],
    taskCount: tasks.length,
  };
}

/** Deterministic, no-LLM rendering — real titles/names, not a paraphrase. */
export function buildOwnedByPersonAnswer({ name, matches }) {
  if (!matches.length) {
    // The name itself is a real, resolved owner (checked before this is ever called) — zero
    // matches here means an additional filter (overdue/status) excluded everything, not that the
    // owner doesn't exist. Saying "no owner matching X" in that case would misleadingly imply X
    // has no tasks at all.
    return `${name} has no tasks matching that in the indexed knowledge base.`;
  }
  const MAX = 30;
  const lines = matches
    .slice(0, MAX)
    .map((t) => `- ${t.title || 'Untitled'}${t.hierarchyPath ? ` (${t.hierarchyPath})` : ''}`);
  const more = matches.length > MAX ? `\n…and ${matches.length - MAX} more` : '';
  return `${matches.length} task${matches.length === 1 ? '' : 's'} owned by ${name}:\n\n${lines.join('\n')}${more}`;
}

export function buildWhoWorksOnAnswer({ anchor, owners, taskCount, exact }) {
  const kind = exact ? 'task' : anchor.type || 'item';
  if (!owners.length) {
    return exact
      ? `The task "${anchor.title}" doesn't have an owner recorded.`
      : `I found "${anchor.title}" but none of its ${taskCount} indexed task${taskCount === 1 ? '' : 's'} has an owner recorded.`;
  }
  const list = owners.map((o) => `- ${o}`).join('\n');
  const scopeNote = exact ? '' : ` (from ${taskCount} indexed task${taskCount === 1 ? '' : 's'})`;
  return `${owners.length === 1 ? 'The person' : 'The people'} working on the ${kind} "${anchor.title}"${scopeNote}:\n\n${list}`;
}
