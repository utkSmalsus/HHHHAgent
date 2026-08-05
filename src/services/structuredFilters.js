/**
 * Generic structured-filter extraction, shared by every deterministic count/list branch in
 * query.js (count, overdue, owned-by-person, ...).
 *
 * Root cause this exists to fix: "how many tasks does Ranu Trivedi have" and "does Ranu Trivedi
 * have overdue tasks" both silently answered with the GLOBAL task count/overdue list. Tracing it
 * end to end showed the person constraint was never lost in transit — it was never extracted at
 * all. The count and overdue branches in query.js only ever parsed the entity-TYPE keyword
 * ("task") out of the question; neither attempted to find a person name, so there was no filter
 * to apply or propagate. This module is the ONE place that extraction now happens, so every
 * consumer shares the same resolution (and the same fail-closed behavior) instead of each branch
 * re-implementing (or forgetting) it.
 *
 * Person resolution is deliberately NOT a fixed grammar pattern ("assigned to X") — it scans the
 * whole question for a capitalized name-shaped phrase and cross-checks it against REAL owner
 * values already in the data. That makes it work for any employee (not hardcoded to one person)
 * and lets it fail closed: a name-shaped phrase that matches no real owner is reported as
 * "requested but unresolved", which callers must surface explicitly rather than silently drop.
 */
import * as chrono from 'chrono-node';
import { scrollPayloads, uniqueBusinessEntities } from './qdrantScroll.js';
import {
  resolveContainerAnchor,
  descendantContainerIds,
  sanitizeForEntityResolution,
  hasRealContentWords,
} from './structuralRetrieve.js';
import { parseDateRange } from './meetingQuery.js';
import { buildDisambiguationAnswer, buildDisambiguationSuggestions } from '../utils/disambiguate.js';

const NAME_CANDIDATE_RE = /\b([A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+){1,2})\b/gu;
const SINGLE_NAME_CANDIDATE_RE = /\b([A-Z][\p{L}'-]+)\b/gu;

// Capitalized words that show up mid-sentence in real questions but are never a person's name —
// filtering these out of candidates avoids e.g. "Team Management" being tried as a name.
const NAME_STOPWORDS = new Set([
  'how', 'many', 'does', 'is', 'are', 'has', 'have', 'the', 'this', 'that', 'those', 'these',
  'show', 'tell', 'what', 'who', 'when', 'where', 'which', 'why', 'team', 'management', 'project',
  'projects', 'portfolio', 'portfolios', 'task', 'tasks', 'meeting', 'meetings', 'development',
  'system', 'management', 'currently', 'recently',
  // Found live: "2 August 2026" was misread as a person name ("August"), which then blocked date
  // resolution entirely (the person-unresolved fail-closed check runs before date resolution).
  // Capitalized month names are exactly as content-free as the question-scaffolding words above.
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december',
]);

// A raw regex match can over-capture: a sentence-leading capitalized word ("Does Ranu Trivedi",
// "Show Ranu Trivedi's") is itself capitalized (English sentence-initial capitalization), so it
// gets glued onto the real name as one match, and a trailing possessive ("Trivedi's") is captured
// as part of the last word. Neither would then match any real owner as-is. Trim both generically —
// this isn't specific to "does"/"show", any leading stopword or trailing "'s" is stripped the same
// way regardless of which question phrasing produced the match.
function trimCandidate(raw) {
  const words = raw.split(/\s+/);
  while (words.length > 1 && NAME_STOPWORDS.has(words[0].toLowerCase())) words.shift();
  if (words.length) words[words.length - 1] = words[words.length - 1].replace(/'s$/i, '');
  return words.join(' ');
}

async function defaultOwnerNames() {
  const tasks = await scrollPayloads({ types: ['task'], limit: 30000 }).catch(() => []);
  const names = new Set();
  for (const t of tasks) {
    const raw = String(t.owner || '').trim();
    if (!raw) continue;
    // `owner` is a comma-joined multi-owner string on co-owned tasks ("Prashant Kumar, Ranu
    // Trivedi") — split into INDIVIDUAL real people. Treating each raw string as one atomic name
    // made first-name collision detection wrong: "Ranu" looked ambiguous (several different raw
    // strings contain it) even though only ONE real person, "Ranu Trivedi", is actually involved —
    // while a genuine collision like "Kamal" (3 different real people: Darani/Singh/Kishore) was
    // indistinguishable from that false pattern. Splitting first makes both cases resolve correctly.
    for (const single of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
      names.add(single);
    }
  }
  return names;
}

async function defaultContainerTitles() {
  const items = await scrollPayloads({ types: ['project', 'portfolio'], limit: 20000 }).catch(() => []);
  return new Set(items.map((p) => String(p.title || '').trim()).filter(Boolean));
}

/**
 * @param {string} question
 * @param {{ getOwnerNames?: () => Promise<Set<string>> }} [opts] - injectable for tests; defaults
 *   to the real owner values in Qdrant.
 * @returns {Promise<{ requested: boolean, resolvedName: string|null, candidateText: string|null }>}
 */
export async function resolvePersonFilter(
  question,
  { getOwnerNames = defaultOwnerNames, getContainerTitles = defaultContainerTitles } = {}
) {
  const q = String(question || '');
  const candidates = [...q.matchAll(NAME_CANDIDATE_RE)]
    .map((m) => trimCandidate(m[1]))
    .filter((c) => c && !c.split(/\s+/).every((w) => NAME_STOPWORDS.has(w.toLowerCase())));

  // Additive fallback: "does RANU have overdue tasks in Team Management Tools" — a bare first
  // name has no adjacent capitalized word for the 2-3-word regex above to include, so it never
  // became a candidate. Gating this on "primary candidates is EMPTY" (as first tried) doesn't
  // work: the SAME question's "Team Management Tools" already fills that array, so the fallback
  // never ran and "Ranu" was silently never tried at all. Appending unconditionally is safe —
  // resolution below still requires an exact or loose match against REAL owner data, so an extra
  // candidate that resolves to nothing just gets skipped, same as any other failed candidate.
  const singleWord = [...q.matchAll(SINGLE_NAME_CANDIDATE_RE)]
    // trimCandidate strips a trailing possessive "'s" — needed here too: the character class this
    // regex matches on includes "'", so "Ranu's" (as in "Ranu's overdue tasks") is captured as ONE
    // token with the possessive still attached, which then matches no real owner at all until it's
    // stripped, same bug this function already fixed for the 2-3 word candidates above.
    .map((m) => trimCandidate(m[1]))
    .filter((c) => c && !NAME_STOPWORDS.has(c.toLowerCase()))
    .filter((c) => !candidates.some((existing) => existing.toLowerCase().includes(c.toLowerCase())));
  candidates.push(...singleWord);

  if (!candidates.length) return { requested: false, resolvedName: null, candidateText: null, ambiguous: null };

  const owners = await getOwnerNames();
  const ownersLower = new Map([...owners].map((o) => [o.toLowerCase(), o]));

  for (const c of candidates) {
    const exact = ownersLower.get(c.toLowerCase());
    if (exact) return { requested: true, resolvedName: exact, candidateText: c, ambiguous: null };
  }
  // No exact full-name match — try a looser one (candidate's words all present in some real
  // person's name), e.g. a bare first name ("Kamal") or the capitalization regex grabbing one word
  // too few/many. Real data has genuine first-name collisions (3 different real people named
  // "Kamal") that a "pick the first match" policy would silently and arbitrarily resolve to the
  // wrong person — collect EVERY distinct real person a candidate loosely matches, and only
  // auto-resolve when there's exactly one. 2+ is a real ambiguity, not a resolution.
  for (const c of candidates) {
    const cWords = c.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = [];
    for (const [lower, real] of ownersLower) {
      if (cWords.every((w) => lower.includes(w))) matches.push(real);
    }
    if (matches.length === 1) {
      return { requested: true, resolvedName: matches[0], candidateText: c, ambiguous: null };
    }
    if (matches.length > 1) {
      return { requested: true, resolvedName: null, candidateText: c, ambiguous: matches };
    }
  }

  // Before concluding "a person was named but unresolved", rule out candidates that are actually a
  // real project/portfolio's title ("how many tasks does TEAM MANAGEMENT TOOLS have") — a real
  // project name, not a failed person reference. Checked PER-CANDIDATE, not "if ANY candidate
  // anywhere in the question matches a real container, treat the WHOLE result as no-person-at-
  // all" — that broader form wrongly suppressed a genuinely separate, unrelated, unresolved person
  // candidate just because the SAME question also names a real, different project. Found live:
  // "How many tasks does Fake Person ABC have in Team Management Tools?" silently answered with
  // Team Management Tools' full UNSCOPED count — "Fake Person ABC" matches no real container
  // title, but the OLD .some()-across-all-candidates check still discarded it because the OTHER
  // candidate ("Team Management Tools") did.
  const containers = await getContainerTitles();
  const containersLower = [...containers].map((t) => t.toLowerCase());
  const nonContainerCandidates = candidates.filter(
    (c) => !containersLower.some((title) => title.includes(c.toLowerCase()))
  );
  if (!nonContainerCandidates.length) {
    // Every candidate was itself a real container title — this question isn't about a person at
    // all. Project/portfolio-scoped counting isn't implemented by this module (that's
    // resolveContainerFilter's job), so this must NOT fail closed as an unresolved person — that
    // would be a worse regression than the original bug (a wrong "no such person" answer to a
    // perfectly valid project question).
    return { requested: false, resolvedName: null, candidateText: null, ambiguous: null };
  }

  // A name-shaped phrase was present, resolves to no real owner, and isn't a real project/
  // portfolio title either — genuinely unresolved. Callers must fail closed on this, never
  // silently proceed unscoped.
  return { requested: true, resolvedName: null, candidateText: nonContainerCandidates[0], ambiguous: null };
}

/** Deterministic disambiguation message for a first-name (or similar) match spanning multiple
 *  real people — never silently pick one. */
export function ambiguousPersonAnswer(candidateText, matches) {
  const lines = matches.map((m) => `- ${m}`).join('\n');
  return `"${candidateText}" matches ${matches.length} different people in your data — which one did you mean?\n\n${lines}`;
}

const DONE_RE = /^(task completed|completed|approved|ready to go)/i;
const PENDING_STATUSES = new Set(['Not Started', 'Acknowledged', 'For Approval', 'Deployment Pending']);
const ACTIVE_STATUSES = new Set(['working on it', 'In Progress']);

/** @returns {{ requested: boolean, label: string|null, match: ((status: string) => boolean)|null }} */
export function resolveStatusFilter(question) {
  const q = String(question || '').toLowerCase();
  if (/\bcompleted\b|\bdone\b|\bfinished\b/.test(q)) {
    return { requested: true, label: 'completed', match: (s) => DONE_RE.test(s || '') };
  }
  if (/\bpending\b/.test(q)) {
    return { requested: true, label: 'pending', match: (s) => PENDING_STATUSES.has(s) };
  }
  if (/\bin progress\b|\bworking on it\b|\bactive\b/.test(q)) {
    return { requested: true, label: 'in progress', match: (s) => ACTIVE_STATUSES.has(s) };
  }
  return { requested: false, label: null, match: null };
}

export function isOverdueRequested(question) {
  return /\b(overdue|past due|late|behind schedule)\b/i.test(String(question || ''));
}

export function taskIsOverdue(t, now = new Date()) {
  return Boolean(t.dueDate) && new Date(t.dueDate) < now && !DONE_RE.test(t.status || '');
}

/** Standard, deterministic refusal when a named person doesn't resolve — never fall back to a
 *  global result instead of this. */
export function unresolvedPersonAnswer(candidateText) {
  return (
    `I couldn't confidently match "${candidateText}" to a real person in the indexed data, so I ` +
    "can't give a scoped answer. Try the exact name as it appears in a task's Owner field."
  );
}

// ---------------------------------------------------------------------------
// Container (project/portfolio) filtering — same silent-global bug class as the person filter,
// now for "how many tasks does TEAM MANAGEMENT TOOLS have" (answered 14,581, the whole collection,
// same as the unscoped person case). Resolution is delegated to resolveContainerAnchor() in
// structuralRetrieve.js rather than reimplemented here: that function already does real-title
// keyword-overlap scoring with an active-status tiebreak, an ancestor-preference tiebreak, and a
// precision/ratio tiebreak that prefers an exact-looking title over one merely sharing generic
// words ("Team"/"Management"/"Tools") — exactly the disambiguation this fix also needs, already
// proven against this same real data (verified live earlier this session against "SmartFilters"
// and "Team Management" naming collisions). Reusing it means container questions get the SAME
// disambiguation quality as the existing "tasks for X project" hierarchy path, not a second,
// weaker implementation.
// ---------------------------------------------------------------------------

async function defaultContainerItems() {
  return scrollPayloads({ types: ['portfolio', 'project'], limit: 20000 }).catch(() => []);
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * @param {string} question
 * @param {{ getContainerItems?: () => Promise<object[]>, personCandidateText?: string|null }} [opts]
 *   `personCandidateText` — the already-resolved person filter's own candidate text (if any), so a
 *   person's name alone doesn't get double-counted as an ALSO-attempted-but-failed container ref.
 * @returns {Promise<{ requested: boolean, resolved: {id:number,title:string,type:string,taskIds:Set<number>}|null,
 *   ambiguous: object[]|null, candidateText: string|null }>}
 */
// Operator-vs-entity-reference sanitization (temporal/status/entity-type/bare-number vocabulary,
// e.g. "Annex Updated"/"Week Task Distribution"/"Overdue Projects"/"Annex II 2026" all being real
// titles that coincidentally collide with this app's own filter-trigger words) and the "nothing
// but scaffolding left" gate now live centrally in structuralRetrieve.js's resolveContainerAnchor —
// it sanitizes internally, so every caller (this one, and structuralRetrieve() itself calling it
// directly) gets the same protection instead of each caller needing its own copy. See that
// module's own comments for the full history of collisions this fixes.
export async function resolveContainerFilter(question, { getContainerItems = defaultContainerItems, personCandidateText = null } = {}) {
  const items = await getContainerItems();

  if (!hasRealContentWords(sanitizeForEntityResolution(question))) {
    return { requested: false, resolved: null, ambiguous: null, candidateText: null };
  }

  const primary = resolveContainerAnchor(question, items);

  if (primary.ambiguous) {
    return { requested: true, resolved: null, ambiguous: primary.candidates, candidateText: null };
  }
  if (primary.anchor) {
    const anchorId = num(primary.anchor.sharePointItemId);
    const descendantIds = anchorId ? descendantContainerIds(anchorId, items) : new Set();
    return {
      requested: true,
      resolved: { id: anchorId, title: primary.anchor.title, type: primary.anchor.type, descendantIds },
      ambiguous: null,
      candidateText: null,
    };
  }

  // resolveContainerAnchor found NOTHING with any real keyword overlap — but that alone doesn't
  // distinguish "no project/portfolio was referenced at all" (proceed unscoped, correct) from "a
  // bogus/unknown project name WAS referenced" (must fail closed, per the same invariant as an
  // unresolved person). A bare capitalized-phrase heuristic isn't enough here, though: it can't
  // tell a made-up PROJECT ("Fake Project XYZ") from a made-up PERSON ("Zzyx Qplonk") — both are
  // just 2-3 capitalized words. Require the candidate to also contain a generic container/product
  // noun (found live: "Fake Project XYZ" contains "Project"; real titles routinely contain words
  // like this — "Tools", "System", "Portal" — while person names essentially never do). Without
  // this gate, EVERY unresolved-person case was also being claimed here, always overriding the
  // (correct) "no such person" message with a misleading "no such project" one.
  const CONTAINER_INDICATOR_RE = /\b(project|projects|portfolio|portfolios|tool|tools|system|systems|module|component|components|app|application|dashboard|platform|suite|service|program)\b/i;
  const candidates = [...String(question || '').matchAll(NAME_CANDIDATE_RE)]
    .map((m) => trimCandidate(m[1]))
    .filter((c) => c && !c.split(/\s+/).every((w) => NAME_STOPWORDS.has(w.toLowerCase())))
    .filter((c) => c.toLowerCase() !== String(personCandidateText || '').toLowerCase())
    .filter((c) => CONTAINER_INDICATOR_RE.test(c));

  if (!candidates.length) return { requested: false, resolved: null, ambiguous: null, candidateText: null };
  return { requested: true, resolved: null, ambiguous: null, candidateText: candidates[0] };
}

export function unresolvedContainerAnswer(candidateText) {
  return (
    `I couldn't confidently match "${candidateText}" to a real project or portfolio in the ` +
    'indexed data, so I can\'t give a scoped answer. Try the exact title as it appears in the data.'
  );
}

// ---------------------------------------------------------------------------
// Temporal filtering — real date fields differ by entity type and by what's actually being asked:
//   task:       dueDate (when "due" is asked about) vs timestamp (Modified||Created — everything else)
//   project:    timestamp only (no separate created/due field exists in the ingested schema)
//   portfolio:  timestamp only (same)
//   timeentry:  timeDate (the date the time was logged for) vs timestamp
//   meeting:    start — when the meeting actually happened, never `timestamp` (SharePoint's record
//               Modified||Created, unrelated to the meeting's occurrence date). Confirmed live
//               (Phase 13): "how many meetings happened this week" was filtering by `timestamp`
//               instead, silently substituting record-modification time for occurrence time.
//               The RANGE parsing for fixed phrases (today/yesterday/this week/...) still comes
//               from meetingQuery.js's own parseDateRange() (imported below) — the ONE tested
//               implementation of "what does 'yesterday' mean", shared rather than reimplemented.
//               Only the FIELD NAME was ever meeting-unaware; that's what's fixed here.
// "created" has no distinct field in this schema (ingestion sets timestamp = Modified||Created) —
// mapped to `timestamp` rather than invented, and the field name is disclosed so no false precision
// is implied.
// ---------------------------------------------------------------------------

const RECENCY_RE = /\b(latest|newest|most recently updated|most recent|last updated)\b/i;
const DUE_RE = /\bdue\b/i;
const LOGGED_RE = /\blogged\b/i;
// A question mentioning a temporal word AND something date-shaped (digits with separators, an
// ordinal day, or an explicit "on <date>") that still fails to parse is very likely a genuine
// (if malformed) date attempt — e.g. "tasks due on 45/67/2026" — not a coincidental number in an
// unrelated question. Used only to decide whether to fail closed after real parsing has already
// failed, not to detect dates itself.
const DATE_ATTEMPT_RE = /\b\d{1,2}[/\-.]\d{1,2}([/\-.]\d{2,4})?\b|\b\d{1,2}(st|nd|rd|th)\s+of\b|\bon\s+\d/i;
const BEFORE_RE = /\bbefore\s+(.+?)[?.!]*$/i;
const AFTER_RE = /\bafter\s+(.+?)[?.!]*$/i;

function pickDateField(entityType, question) {
  const q = String(question || '').toLowerCase();
  if (entityType === 'task' && DUE_RE.test(q)) return 'dueDate';
  if (entityType === 'timeentry' && LOGGED_RE.test(q)) return 'timeDate';
  // Unlike task ("due" vs "modified"), a meeting has no rival everyday sense of "timestamp" a real
  // user would mean — any temporal question about a meeting (happened/held/on a date) is asking
  // about when it occurred, so this is unconditional, not phrasing-gated like DUE_RE/LOGGED_RE above.
  if (entityType === 'meeting') return 'start';
  return 'timestamp'; // Modified||Created — the only "when was this touched" field project/portfolio have.
}

/**
 * @returns {Promise<{ requested: boolean, field: string|null,
 *   range: {start: Date|null, end: Date|null}|null, sort: {field:string, direction:'desc'}|null,
 *   unresolvable: boolean, label: string|null }>}
 */
const dayStart = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const dayEnd = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };

function isValidYMD(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

// `.toISOString()` always converts to UTC, which silently shifts the displayed date by a day in
// any timezone ahead of UTC (found live, server in IST/UTC+5:30: asking about "02/08/2026" showed
// the label "2026-08-01" — the Date object itself was the correct local Aug-2 midnight, only its
// UTC-formatted label was wrong). Format from the LOCAL date components instead, since that's the
// calendar day the explicit-date parser above was actually asked to construct.
const fmtLocalDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Deterministic DD/MM/YYYY (this app's locale) and ISO YYYY-MM-DD parsing for bare numeric dates —
 * deliberately NOT delegated to chrono or `new Date(string)`, both of which default an ambiguous
 * numeric string to US month-first (MM/DD/YYYY), which is simply wrong for this user base: "tasks
 * due on 02/08/2026" must mean 2 August, not February 8. Natural-language dates ("2 August 2026",
 * "Aug 2 2026") are NOT ambiguous in the first place — chrono already parses those correctly by
 * month name, so they're left to parseDateRange() below rather than reimplemented here.
 * @returns {Date|'invalid'|null} a Date for a valid explicit numeric/ISO date, 'invalid' for a
 *   numeric-date-shaped string with an out-of-range day/month (fail-closed signal), or null if no
 *   numeric/ISO date pattern is present at all.
 */
function parseExplicitNumericDate(text) {
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    return isValidYMD(y, m, d) ? new Date(y, m - 1, d) : 'invalid';
  }
  const numeric = text.match(/\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})\b/);
  if (numeric) {
    const [dd, mm, yyyy] = [Number(numeric[1]), Number(numeric[2]), Number(numeric[3])]; // DD/MM/YYYY, never MM/DD
    return isValidYMD(yyyy, mm, dd) ? new Date(yyyy, mm - 1, dd) : 'invalid';
  }
  return null;
}

export function resolveDateFilter(question, entityType, { now = new Date() } = {}) {
  const q = String(question || '');
  const field = pickDateField(entityType, q);

  if (RECENCY_RE.test(q)) {
    return { requested: true, field, range: null, sort: { field, direction: 'desc' }, unresolvable: false, label: 'most recent' };
  }

  const beforeMatch = q.match(BEFORE_RE);
  const afterMatch = q.match(AFTER_RE);
  if (beforeMatch || afterMatch) {
    const raw = (beforeMatch || afterMatch)[1];
    const explicit = parseExplicitNumericDate(raw);
    const d = explicit === 'invalid' ? null : explicit || chrono.parse(raw, now, { forwardDate: false })[0]?.start?.date();
    if (explicit === 'invalid' || !d || Number.isNaN(d.getTime())) {
      return { requested: true, field, range: null, sort: null, unresolvable: true, label: null };
    }
    const range = beforeMatch ? { start: null, end: d } : { start: d, end: null };
    return { requested: true, field, range, sort: null, unresolvable: false, label: beforeMatch ? `before ${raw.trim()}` : `after ${raw.trim()}` };
  }

  // Explicit numeric/ISO date FIRST (our own deterministic DD/MM/YYYY parser) — tried before any
  // chrono call so a bare numeric date can never reach chrono's ambiguous month-first default.
  const explicitDate = parseExplicitNumericDate(q);
  if (explicitDate === 'invalid') {
    return { requested: true, field, range: null, sort: null, unresolvable: true, label: null };
  }
  if (explicitDate) {
    return {
      requested: true, field, range: { start: dayStart(explicitDate), end: dayEnd(explicitDate) },
      sort: null, unresolvable: false, label: fmtLocalDate(explicitDate),
    };
  }

  // Fixed-phrase (today/yesterday/this week/last week/this month/last month/recent) and natural-
  // language date mentions ("2 August 2026", "Aug 2 2026") — reuses the same tested parser
  // meetingQuery.js already relies on, so "yesterday" means the same calendar day everywhere in
  // the app. Month-NAME dates aren't ambiguous, so chrono's parse is trustworthy here.
  const parsed = parseDateRange(q, now);
  if (parsed) {
    return { requested: true, field, range: { start: parsed.start, end: parsed.end }, sort: null, unresolvable: false, label: parsed.label };
  }

  // Nothing parsed — if the question still looks like it was attempting a date, fail closed rather
  // than silently proceeding as if no date constraint existed.
  if (DATE_ATTEMPT_RE.test(q) && /\b(due|updated|modified|created|logged)\b/i.test(q)) {
    return { requested: true, field, range: null, sort: null, unresolvable: true, label: null };
  }

  return { requested: false, field: null, range: null, sort: null, unresolvable: false, label: null };
}

export function unresolvedDateAnswer(field) {
  return (
    "I couldn't reliably resolve the date in that question, so I can't give a scoped answer " +
    `(would have filtered by ${field}). Try an explicit date like "31/07/2026", or "today"/` +
    '"yesterday"/"this week"/"last week"/"this month".'
  );
}

function inRange(dateStr, range) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return false;
  if (range.start && d < range.start) return false;
  if (range.end && d > range.end) return false;
  return true;
}

/** Applies a resolved date filter's range (not its sort) to a list of payloads. No-op if no range. */
export function applyDateRange(items, dateFilter) {
  if (!dateFilter?.requested || !dateFilter.range) return items;
  return items.filter((i) => inRange(i[dateFilter.field], dateFilter.range));
}

/** Applies a resolved date filter's sort (not its range) to a list of payloads, in place-safe copy. */
export function applyDateSort(items, dateFilter) {
  if (!dateFilter?.sort) return items;
  const { field, direction } = dateFilter.sort;
  const sorted = [...items].sort((a, b) => new Date(a[field] || 0) - new Date(b[field] || 0));
  return direction === 'desc' ? sorted.reverse() : sorted;
}

// ---------------------------------------------------------------------------
// Debug-mode plan inspection — assembles what was resolved into one plain, loggable object, so a
// wrong answer can be diagnosed from "what did the resolver think the question meant" without
// re-deriving it by hand. Read-only: building the plan never performs retrieval itself.
// ---------------------------------------------------------------------------
export function buildQueryPlan({ operation, entityType, personFilter, containerFilter, statusFilter, overdueRequested, dateFilter }) {
  const filters = {};
  if (personFilter?.resolvedName) filters.assignee = personFilter.resolvedName;
  else if (personFilter?.requested) filters.assignee = { unresolved: personFilter.candidateText };
  if (containerFilter?.resolved) filters.project = { id: containerFilter.resolved.id, title: containerFilter.resolved.title, type: containerFilter.resolved.type };
  else if (containerFilter?.ambiguous) filters.project = { ambiguous: containerFilter.ambiguous.map((c) => c.title) };
  else if (containerFilter?.requested) filters.project = { unresolved: containerFilter.candidateText };
  if (statusFilter?.requested) filters.status = statusFilter.label;
  if (overdueRequested) filters.overdue = true;
  if (dateFilter?.requested) {
    if (dateFilter.unresolvable) filters.date = { field: dateFilter.field, unresolved: true };
    else if (dateFilter.range) filters.date = { field: dateFilter.field, range: dateFilter.label || dateFilter.range };
  }
  return {
    operation,
    entityType,
    filters,
    sort: dateFilter?.sort || null,
  };
}

export function logQueryPlan(question, plan) {
  if (process.env.DEBUG_RAG === 'false') return;
  console.log(`[RETRIEVAL] structured-query-plan query="${String(question).slice(0, 80)}" plan=${JSON.stringify(plan)}`);
}

// ---------------------------------------------------------------------------
// Centralized resolution/blocking/application — the invariant this whole module exists for is
// "a resolved structured constraint must be RESOLVED-AND-APPLIED or EXPLICITLY-UNRESOLVED, never
// silently dropped because a different deterministic branch happened to handle the question."
// Four branches in query.js (count, standalone overdue, owned-by-person, date-list) previously
// each resolved/applied filters independently — found live, TWICE: the standalone overdue branch
// supported person but not container ("does Ranu have overdue tasks in Team Management Tools"
// silently ignored the project), and the owned-by-person branch supported overdue/status but not
// container either. Routing every branch through these four functions means a filter that's
// supported in ONE place is automatically supported everywhere, rather than requiring the same fix
// to be repeated (and possibly forgotten) per branch.
// ---------------------------------------------------------------------------
/** Resolves every structured constraint a question might carry, in the priority order that keeps
 *  the person/container fail-closed decisions consistent (see resolveContainerFilter's own doc). */
export async function resolveStructuredFilters(question, entityType = 'task') {
  const personFilter = await resolvePersonFilter(question);
  const statusFilter = resolveStatusFilter(question);
  const overdueRequested = isOverdueRequested(question);
  const containerFilter = await resolveContainerFilter(question, {
    personCandidateText: personFilter.resolvedName ? personFilter.candidateText : null,
  });
  const dateFilter = resolveDateFilter(question, entityType);
  return { personFilter, statusFilter, overdueRequested, containerFilter, dateFilter };
}

/**
 * Decides whether resolved filters require an early "I can't scope this" response instead of
 * proceeding to retrieval. Centralizes the priority ordering (an ambiguous/unresolved person only
 * blocks when the container resolver ALSO found nothing referenced — see resolveContainerFilter's
 * own comment for why) so every caller applies the identical decision.
 * @returns {{blocked:false}|{blocked:true, kind:string, personFilter?, containerFilter?, dateFilter?}}
 */
export function checkStructuredFiltersBlocked({ personFilter, containerFilter, dateFilter }) {
  if (personFilter.ambiguous) return { blocked: true, kind: 'ambiguous-person', personFilter };
  if (personFilter.requested && !personFilter.resolvedName) {
    // Only defer to the container check when it's reasoning about the SAME text ("Fake Project
    // XYZ" tried as both a failed person and a failed container) — not merely because the question
    // ALSO happens to contain some other, unrelated, successfully-resolved container. Found live:
    // "How many tasks does Fake Person ABC have in Team Management Tools?" was silently answering
    // with Team Management Tools' full unscoped count — the resolved (but totally unrelated)
    // container was wrongly treated as if it explained away the separate unresolved person.
    const sameTextExplainsIt =
      containerFilter.candidateText &&
      containerFilter.candidateText.toLowerCase() === personFilter.candidateText.toLowerCase();
    if (!sameTextExplainsIt) {
      return { blocked: true, kind: 'unresolved-person', personFilter };
    }
  }
  if (containerFilter.ambiguous) return { blocked: true, kind: 'ambiguous-container', containerFilter };
  if (containerFilter.requested && !containerFilter.resolved) {
    return { blocked: true, kind: 'unresolved-container', containerFilter };
  }
  if (dateFilter.requested && dateFilter.unresolvable) return { blocked: true, kind: 'unresolved-date', dateFilter };
  return { blocked: false };
}

/** Builds the full res.json()-shaped body (minus `success`) for a blocked structured-filter
 *  result — one canonical response per blocking reason, shared by every deterministic branch. */
export function buildBlockedResponse(blocked) {
  switch (blocked.kind) {
    case 'ambiguous-person':
      return {
        answer: ambiguousPersonAnswer(blocked.personFilter.candidateText, blocked.personFilter.ambiguous),
        format: 'bullets', confidence: 0, intent: 'ambiguous-person-filter',
        sources: { qdrant: [], sharepoint: {} },
      };
    case 'unresolved-person':
      return {
        answer: unresolvedPersonAnswer(blocked.personFilter.candidateText),
        format: 'prose', confidence: 0.2, intent: 'unresolved-person-filter',
        sources: { qdrant: [], sharepoint: {} },
      };
    case 'ambiguous-container':
      return {
        answer: buildDisambiguationAnswer(blocked.containerFilter.ambiguous),
        format: 'bullets', confidence: 0, intent: 'disambiguation',
        suggestions: buildDisambiguationSuggestions(blocked.containerFilter.ambiguous),
        sources: { qdrant: blocked.containerFilter.ambiguous.map((payload) => ({ payload })), sharepoint: {} },
      };
    case 'unresolved-container':
      return {
        answer: unresolvedContainerAnswer(blocked.containerFilter.candidateText),
        format: 'prose', confidence: 0.2, intent: 'unresolved-container-filter',
        sources: { qdrant: [], sharepoint: {} },
      };
    case 'unresolved-date':
      return {
        answer: unresolvedDateAnswer(blocked.dateFilter.field),
        format: 'prose', confidence: 0.2, intent: 'unresolved-date-filter',
        sources: { qdrant: [], sharepoint: {} },
      };
    default:
      throw new Error(`buildBlockedResponse: unknown kind "${blocked.kind}"`);
  }
}

/** Applies every resolved filter (person/container/status/overdue/date range) to a payload list —
 *  the one place filtering logic lives, so it can't diverge between branches.
 *
 * FILTER FIRST, then DEDUPE (Phase 14): a chunked record's points all carry identical metadata
 * (status/owner/dates/container — verified live against production, zero counter-examples across
 * all 5 types), so filtering before deduping can never drop a real match. Deduping AFTER guarantees
 * "if ANY of a record's points survives the filters, the record counts once" instead of betting on
 * which single (possibly filtered-out) point a dedupe-first pass would have kept. This is also the
 * ONE place every caller's count/list ultimately flows through (count branch, overdue branch,
 * date-list branch, owned-by-person), so a chunked record can no longer be counted N times OR shown
 * N times as separate rows by any of them — see qdrantScroll.js's getBusinessEntityKey/
 * uniqueBusinessEntities for why Qdrant points aren't business records. */
export function applyStructuredFilters(items, { personFilter, containerFilter, statusFilter, overdueRequested, dateFilter }) {
  let out = items;
  if (personFilter.resolvedName) out = out.filter((i) => (i.owner || '') === personFilter.resolvedName);
  if (containerFilter.resolved) {
    const ids = containerFilter.resolved.descendantIds;
    out = out.filter((i) => ids.has(Number(i.projectId)) || ids.has(Number(i.portfolioId)));
  }
  if (statusFilter.requested) out = out.filter((i) => statusFilter.match(i.status));
  if (overdueRequested) out = out.filter((i) => taskIsOverdue(i));
  if (dateFilter.requested && dateFilter.range) out = applyDateRange(out, dateFilter);
  return uniqueBusinessEntities(out);
}

/** Human-readable "for X in Y (dueDate Z)" scope suffix built from the SAME resolved filters used
 *  to apply them — text and behavior can't drift apart since both read the one resolved object.
 *  `timestamp` is flagged as Modified-or-Created (never asserted as true creation date — the
 *  ingested schema has no separate Created field; see resolveDateFilter's own doc). */
export function buildScopeText({ personFilter, containerFilter, dateFilter }) {
  const dateLabel = dateFilter.range
    ? dateFilter.field === 'timestamp'
      ? `(Modified-or-Created ${dateFilter.label || 'in range'} — no separate "created" field is tracked)`
      : `(${dateFilter.field} ${dateFilter.label || 'in range'})`
    : null;
  const parts = [
    personFilter.resolvedName ? `for ${personFilter.resolvedName}` : null,
    containerFilter.resolved ? `in ${containerFilter.resolved.title}` : null,
    dateLabel,
  ].filter(Boolean);
  return parts.length ? ` ${parts.join(' ')}` : '';
}
