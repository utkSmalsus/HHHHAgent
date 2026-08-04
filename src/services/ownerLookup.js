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
import { scrollPayloads } from './qdrantScroll.js';
import { structuralRetrieve } from './structuralRetrieve.js';

const OWNED_BY_RE =
  /\b(which |what )?tasks?\s+(belong|belongs)\s+to\b|\btasks?\s+(owned|assigned)\s+(by|to)\b|\bwhose\s+tasks?\b/i;
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

/** Extract a capitalized 1-3 word name following the trigger phrase. */
function extractPersonName(question) {
  const m = String(question || '').match(
    /(?:belongs?\s+to|owned\s+by|assigned\s+to|whose)\s+([A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+){0,2})/u
  );
  return m ? m[1].trim() : null;
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

/** @returns {Promise<{ name: string, matches: object[] } | null>} */
export async function tasksOwnedByPerson(question) {
  const name = extractPersonName(question);
  if (!name) return null;
  const nameWords = name.toLowerCase().split(/\s+/).filter(Boolean);
  const tasks = await scrollPayloads({ types: ['task'], limit: 30000 });
  const matches = tasks.filter((t) => {
    const owner = ownerOf(t).toLowerCase();
    return owner && nameWords.every((w) => owner.includes(w));
  });
  return { name, matches };
}

/** @returns {Promise<{ anchor: object, owners: string[], taskCount: number, exact?: boolean } | null>} */
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
  const structural = await structuralRetrieve(topic).catch(() => null);
  if (!structural || structural.ambiguous) return null;

  const owners = new Map();
  for (const t of structural.tasks) {
    const raw = ownerOf(t);
    if (!raw) continue;
    for (const single of raw.split(/,|;|\band\b/i).map((s) => s.trim()).filter(Boolean)) {
      owners.set(single.toLowerCase(), single);
    }
  }
  return { anchor: structural.anchor, owners: [...owners.values()], taskCount: structural.tasks.length };
}

/** Deterministic, no-LLM rendering — real titles/names, not a paraphrase. */
export function buildOwnedByPersonAnswer({ name, matches }) {
  if (!matches.length) {
    return `I couldn't find any tasks with an owner matching "${name}" in the indexed knowledge base.`;
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
