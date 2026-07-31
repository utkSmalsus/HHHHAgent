/**
 * Date-aware meeting retrieval.
 * Flat vector search has no notion of "today"/"yesterday"/"latest" — it just matches text,
 * so "meetings today" returns whatever is semantically near. Meeting points carry a real
 * `start` date, so for temporal meeting questions we filter/sort by that date instead.
 */
import { scrollPayloads } from './qdrantScroll.js';
import { normalizeText } from '../utils/textMatch.js';
import { resolveReferencedTopic } from '../utils/referenceResolve.js';

const MEETINGISH = /\b(meeting|meetings|scrum|stand[- ]?up|standup|call|sync|huddle|retro|review|1[- ]?on[- ]?1)\b/i;
const TEMPORAL = /\b(today(?:'?s)?|yesterday(?:'?s)?|tomorrow(?:'?s)?|this week|last week|this month|last month|recent|lately|latest|most recent|last|upcoming|earlier|this morning)\b/i;

export function isMeetingDateQuestion(question) {
  const q = String(question || '');
  return MEETINGISH.test(q) && TEMPORAL.test(q);
}

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const endOfDay = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

/** Resolve a relative date phrase to a concrete [start,end] range, or null if none stated. */
export function parseDateRange(question, now = new Date()) {
  const q = String(question || '').toLowerCase();
  const mk = (start, end, label) => ({ start, end, label });

  if (/\btoday(?:'?s)?\b|\bthis morning\b/.test(q)) return mk(startOfDay(now), endOfDay(now), 'today');
  if (/\byesterday(?:'?s)?\b/.test(q)) return mk(startOfDay(addDays(now, -1)), endOfDay(addDays(now, -1)), 'yesterday');
  if (/\btomorrow(?:'?s)?\b/.test(q)) return mk(startOfDay(addDays(now, 1)), endOfDay(addDays(now, 1)), 'tomorrow');

  if (/\bthis week\b/.test(q)) {
    const dow = (now.getDay() + 6) % 7; // Monday = 0
    return mk(startOfDay(addDays(now, -dow)), endOfDay(addDays(now, 6 - dow)), 'this week');
  }
  if (/\blast week\b/.test(q)) {
    const dow = (now.getDay() + 6) % 7;
    const monThis = addDays(now, -dow);
    return mk(startOfDay(addDays(monThis, -7)), endOfDay(addDays(monThis, -1)), 'last week');
  }
  if (/\bthis month\b/.test(q)) {
    return mk(startOfDay(new Date(now.getFullYear(), now.getMonth(), 1)),
      endOfDay(new Date(now.getFullYear(), now.getMonth() + 1, 0)), 'this month');
  }
  if (/\blast month\b/.test(q)) {
    return mk(startOfDay(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      endOfDay(new Date(now.getFullYear(), now.getMonth(), 0)), 'last month');
  }
  if (/\b(recent|lately|earlier)\b/.test(q)) {
    return mk(startOfDay(addDays(now, -7)), endOfDay(now), 'the last 7 days');
  }
  return null; // "latest"/"last meeting" with no explicit range → handled by sorting
}

/**
 * "Unscheduled" meetings are stored with a fixed far-future placeholder start date (seen: year
 * 2099), not a real one. Naive newest-first sorting puts these at the very top of "latest meeting"
 * (which has no explicit date range to filter them out of), burying every real recent meeting.
 */
function isPlaceholderMeetingDate(meeting, now) {
  if (/unscheduled/i.test(meeting.status || '')) return true;
  const t = new Date(meeting.start).getTime();
  const FIVE_YEARS_MS = 5 * 365 * 24 * 60 * 60 * 1000;
  return t - now.getTime() > FIVE_YEARS_MS;
}

/** @returns {Promise<{ meetings: object[], range: object|null, now: Date, wantsLatest: boolean }>} */
export async function meetingDateRetrieve(question, now = new Date()) {
  const all = await scrollPayloads({ types: ['meeting'], limit: 5000 });
  const range = parseDateRange(question, now);
  const wantsLatest = /\b(latest|most recent|last)\b/i.test(question);

  let picked = all.filter(
    (m) => m.start && !Number.isNaN(new Date(m.start).getTime()) && !isPlaceholderMeetingDate(m, now)
  );
  if (range) {
    picked = picked.filter((m) => {
      const t = new Date(m.start);
      return t >= range.start && t <= range.end;
    });
  }
  picked.sort((a, b) => new Date(b.start) - new Date(a.start)); // newest first
  picked = picked.slice(0, range ? 15 : wantsLatest ? 5 : 12);

  return { meetings: picked, range, now, wantsLatest };
}

/** A follow-up about "that meeting" / its participants, agenda, action items, transcript, etc. */
export function isMeetingDetailFollowup(question) {
  return /\b(that|this|the)\s+(meeting|call|scrum|stand[- ]?up)\b|\bin it\b|\bof it\b|\bparticipants?\b|\battendees?\b|\bwho (was|were|attended|joined)\b|\bdiscussed?\b|\bdiscussion\b|\baction items?\b|\bagenda\b|\btranscript\b|\bmore about it\b/i.test(String(question || ''));
}

/**
 * Find the meeting the user is referring to ("the scrum one", "that meeting", bare "it"). Thin
 * wrapper over the shared resolver (src/utils/referenceResolve.js) — every follow-up path
 * (meetings, tasks, projects, exact-lookup) uses that ONE resolution mechanism, not a per-path copy.
 */
export async function resolveReferencedMeeting(convoText, currentQuestion = '') {
  return resolveReferencedTopic(convoText, currentQuestion, ['meeting']);
}

/**
 * The question IS (exactly, ignoring case/punctuation/spacing) a real meeting's title — e.g. the
 * user pasted/typed a meeting name with no other context. SharePoint sometimes has a meeting and
 * an unrelated task sharing an identical title (seen: two separate "Scrum 30/07/2026" records);
 * the general type-agnostic search has no way to prefer the meeting, so this exact match routes
 * straight to it instead of risking an answer built from the wrong record.
 */
export async function resolveExactMeetingTitle(question) {
  const q = normalizeText(question);
  if (!q || q.length < 4) return null;
  const all = await scrollPayloads({ types: ['meeting'], limit: 5000 });
  return all.find((m) => m.title && normalizeText(m.title) === q) || null;
}

// The meeting's content is free text (a summary/transcript), not a list of records — there's no
// "rows" array to run through the deterministic formatRows() the other branches use. The LLM has
// to do the actual work of breaking it into items, so the format request goes into the prompt.
// A concrete example gets small local models to actually emit real line breaks far more reliably
// than an abstract instruction alone — without it, models like qwen3 tend to write one run-on
// paragraph with no punctuation between items despite being told "use bullets".
const FORMAT_INSTRUCTION = {
  bullets:
    'Format your ENTIRE answer as a markdown bullet list. Put a REAL newline character between ' +
    'every item — never run two items together on one line, and never omit the period at the end ' +
    'of an item. Follow this exact shape:\n- First item goes here.\n- Second item goes here.\n' +
    '- Third item goes here.\nDo not write any prose paragraphs.',
  table:
    'Format your ENTIRE answer as a markdown table with a header row, one real newline between ' +
    'rows. Follow this exact shape:\n| Column A | Column B |\n|---|---|\n| value | value |\n' +
    'Do not write any prose paragraphs.',
  timeline:
    'Format your ENTIRE answer as a markdown bullet list ordered chronologically, oldest first. ' +
    'Put a REAL newline character between every item. Follow this exact shape:\n- First item goes here.\n' +
    '- Second item goes here.\nDo not write any prose paragraphs.',
};

/** Prompt to answer a detail question about ONE specific meeting from its full record. */
export function buildMeetingDetailPrompt(question, meeting, format = null) {
  const formatNote = FORMAT_INSTRUCTION[format] ? `\n${FORMAT_INSTRUCTION[format]}` : '';
  const system =
    'You are HHHH Agent. Answer the question about this specific meeting using ONLY ' +
    'the meeting record below (its summary, participants, transcript). Be specific and concise. ' +
    'If the record does not contain the answer, say so — do not pull in other meetings or tasks.' +
    formatNote;
  const user =
    `USER QUESTION: ${question}\n\n` +
    `MEETING RECORD for "${meeting.title}":\n${String(meeting.text || '').slice(0, 7000)}\n\n` +
    `Answer using only this meeting's record.`;
  return { system, user };
}

const PLAIN_PERIOD = new Set(['today', 'yesterday', 'tomorrow']);

/**
 * Deterministic, no-LLM answer for "meetings on/for X" questions. This exists because the LLM
 * path (buildMeetingDatePrompt) was observed hallucinating "no meetings today" for a "yesterday"
 * question even when handed the correct, unambiguous evidence — a small local model narrating a
 * date range is an unnecessary reliability risk when the range/list is already fully known.
 * Also fixes silently picking one meeting when several matched the same period — list them all.
 */
export function buildMeetingDateAnswer(result) {
  const { meetings, range } = result;
  const label = range?.label;
  const periodPhrase = label ? (PLAIN_PERIOD.has(label) ? label : `for ${label}`) : 'matching that';

  if (!meetings.length) {
    return `There are no meetings ${periodPhrase}.`;
  }

  const fmt = (m) => {
    const d = m.start ? new Date(m.start) : null;
    const when = d ? d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'no date';
    return `- **${m.title || 'Untitled meeting'}** — ${when}${m.status ? ` [${m.status}]` : ''}`;
  };
  const heading =
    meetings.length === 1
      ? `1 meeting ${periodPhrase}:`
      : `${meetings.length} meetings ${periodPhrase} (newest first):`;
  return `${heading}\n\n${meetings.map(fmt).join('\n')}`;
}

/** @deprecated kept for reference; buildMeetingDateAnswer is used instead — see its comment. */
export function buildMeetingDatePrompt(question, result) {
  const { meetings, range, now } = result;
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const fmt = (m) => {
    const d = m.start ? new Date(m.start) : null;
    const when = d ? d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'no date';
    return `- "${m.title || 'Untitled meeting'}" — ${when}${m.status ? ` [${m.status}]` : ''}`;
  };
  const list = meetings.map(fmt).join('\n') || '(no meetings match)';

  const system =
    'You are HHHH Agent. Answer ONLY from the meetings listed, using their REAL dates. ' +
    'Never claim a meeting happened on a date other than its listed date. ' +
    'If the list is empty, clearly say there are no meetings for that period — do not substitute a meeting from another date.';
  const user =
    `Today's date is ${today}.\n` +
    `USER QUESTION: ${question}\n\n` +
    `${range ? `Meetings within ${range.label} (newest first):` : 'Meetings, newest first:'}\n${list}\n\n` +
    `Answer using only these meetings and their real dates.`;

  return { system, user };
}
