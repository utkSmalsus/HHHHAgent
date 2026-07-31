/**
 * Date-aware meeting retrieval.
 * Flat vector search has no notion of "today"/"yesterday"/"latest" — it just matches text,
 * so "meetings today" returns whatever is semantically near. Meeting points carry a real
 * `start` date, so for temporal meeting questions we filter/sort by that date instead.
 */
import { scrollPayloads } from './qdrantScroll.js';

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

/** @returns {Promise<{ meetings: object[], range: object|null, now: Date, wantsLatest: boolean }>} */
export async function meetingDateRetrieve(question, now = new Date()) {
  const all = await scrollPayloads({ types: ['meeting'], limit: 5000 });
  const range = parseDateRange(question, now);
  const wantsLatest = /\b(latest|most recent|last)\b/i.test(question);

  let picked = all.filter((m) => m.start && !Number.isNaN(new Date(m.start).getTime()));
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

/** Find the meeting whose title is mentioned in the recent conversation (most specific wins). */
const WORD_RE = /[a-z0-9]+/g;

/** Word-overlap score between the CURRENT question and a candidate title (order-independent). */
function overlapScore(questionWords, title) {
  const titleWords = new Set((title.toLowerCase().match(WORD_RE) || []).filter((w) => w.length > 2));
  if (!titleWords.size) return 0;
  let hits = 0;
  for (const w of questionWords) if (titleWords.has(w)) hits += 1;
  return hits;
}

/**
 * Find the meeting the user is referring to. When SEVERAL meeting titles were mentioned earlier
 * in the conversation (e.g. a "meetings yesterday" list showed two), the current question usually
 * names which one it means ("the scrum one") — prefer that over just grabbing whichever mentioned
 * title happens to be the longest string, which ignores what was actually asked.
 */
export async function resolveReferencedMeeting(convoText, currentQuestion = '') {
  const lc = String(convoText || '').toLowerCase();
  if (!lc.trim()) return null;
  const all = await scrollPayloads({ types: ['meeting'], limit: 5000 });
  const hits = all.filter((m) => m.title && m.title.length > 4 && lc.includes(m.title.toLowerCase()));
  if (!hits.length) return null;

  const qWords = (String(currentQuestion || '').toLowerCase().match(WORD_RE) || []).filter((w) => w.length > 2);
  if (qWords.length) {
    const scored = hits
      .map((m) => ({ m, score: overlapScore(qWords, m.title) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
    if (scored.length && (scored.length === 1 || scored[0].score > scored[1].score)) {
      return scored[0].m;
    }
  }

  hits.sort((a, b) => (b.title.length || 0) - (a.title.length || 0));
  return hits[0] || null;
}

/** Prompt to answer a detail question about ONE specific meeting from its full record. */
export function buildMeetingDetailPrompt(question, meeting) {
  const system =
    'You are HHHH Agent. Answer the question about this specific meeting using ONLY ' +
    'the meeting record below (its summary, participants, transcript). Be specific and concise. ' +
    'If the record does not contain the answer, say so — do not pull in other meetings or tasks.';
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
