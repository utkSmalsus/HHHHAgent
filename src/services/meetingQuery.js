/**
 * Date-aware meeting retrieval.
 * Flat vector search has no notion of "today"/"yesterday"/"latest" — it just matches text,
 * so "meetings today" returns whatever is semantically near. Meeting points carry a real
 * `start` date, so for temporal meeting questions we filter/sort by that date instead.
 */
import * as chrono from 'chrono-node';
import { scrollPayloads, dedupeBySource, getFullRecordText } from './qdrantScroll.js';
import { normalizeText } from '../utils/textMatch.js';
import { resolveReferencedTopic } from '../utils/referenceResolve.js';

const MEETINGISH = /\b(meeting|meetings|scrum|stand[- ]?up|standup|call|sync|huddle|retro|review|1[- ]?on[- ]?1)\b/i;
const TEMPORAL = /\b(today(?:'?s)?|yesterday(?:'?s)?|tomorrow(?:'?s)?|this week|last week|this month|last month|recent|lately|latest|most recent|last|upcoming|earlier|this morning)\b/i;

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const endOfDay = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

/**
 * Any date/date-range mentioned in the question, in ANY phrasing a user would actually type —
 * "31 july", "July 31st", "31/07/2026", "next monday" — via chrono-node (a purpose-built
 * natural-language date parser), instead of hand-rolling a regex per phrasing. Was originally just
 * a numeric DD/MM/YYYY regex; verified live that "what meeting happened on 31 july" fell through
 * it entirely (no numeric separators) and landed in an irrelevant general keyword search. The data
 * FILTERING stays fully deterministic either way (below) — only the free-form PARSING step uses a
 * library built for exactly this, not the local LLM: the LLM path was already shown unreliable at
 * date reasoning earlier in this project (hallucinated "no meetings today" for a "yesterday"
 * question with correct data in hand), so filtering never goes through it.
 */
function extractDateMention(question, now) {
  const results = chrono.parse(String(question || ''), now, { forwardDate: false });
  if (!results.length) return null;
  const r = results[0];
  const start = r.start?.date();
  if (!start || Number.isNaN(start.getTime())) return null;
  const end = r.end?.date();
  return { start: startOfDay(start), end: endOfDay(end || start), label: r.text };
}

export function isMeetingDateQuestion(question, now = new Date()) {
  const q = String(question || '');
  if (!MEETINGISH.test(q)) return false;
  return TEMPORAL.test(q) || Boolean(extractDateMention(q, now));
}

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
  // "latest"/"last meeting" alone (no date) → null, handled by sorting. A genuine calendar date in
  // any phrasing ("31 july", "July 31st", "31/07/2026") falls here since none of the fixed phrases
  // above matched it.
  const mention = extractDateMention(question, now);
  return mention ? mk(mention.start, mention.end, mention.label) : null;
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
  // A long transcript is now split across several chunk-points sharing one meeting — dedupe to
  // one row per real meeting (every chunk carries the same title/status/date metadata) so a
  // chunked meeting doesn't get listed N times.
  const all = dedupeBySource(await scrollPayloads({ types: ['meeting'], limit: 5000 }));
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
 * A calendar date embedded in prose, in ANY phrasing ("summarize the scrum 25/06/2026 meeting",
 * "what meeting happened on 31 july", "the meeting on July 31st") names a real meeting
 * unambiguously, but neither of the other resolvers catches all of that: isMeetingDateQuestion only
 * recognizes RELATIVE temporal words (today/yesterday/this week) unless a date mention is also
 * present, and the embedded-title resolver requires the real title as a verbatim substring — real
 * titles are formatted "SCRUM - 25/06/2026" (with a dash), which never appears verbatim in casual
 * phrasing. Resolve by the date itself instead, via the same general natural-language date
 * extractor used everywhere else in this file: find meetings whose real `start` falls on that exact
 * day, then break ties with title-keyword overlap (e.g. "scrum").
 */
// A week/month-scale phrase names a PERIOD, not one meeting — "what meetings happened last week"
// is a list question. The natural-language date extractor collapses such a phrase to a single
// representative day ("last week" -> the date exactly one week ago), so without this guard the
// resolver looked up that one day, found the single meeting that happened to fall on it, and
// answered as if it were the only meeting of the whole week — verified live: 6 real meetings
// existed that week and the answer named one and claimed there were no others. parseDateRange
// already expands these phrases into true ranges, so they belong to the date-range branch.
const PERIOD_PHRASE_RE =
  /\b(this|last|past|previous)\s+(week|month|fortnight|quarter|year)\b|\b(recent(ly)?|lately|earlier)\b/i;

export async function resolveMeetingByExplicitDate(question, now = new Date()) {
  if (!MEETINGISH.test(question) && !/\bscrum\b/i.test(question)) return null;
  if (PERIOD_PHRASE_RE.test(question)) return null;
  const mention = extractDateMention(question, now);
  if (!mention) return null;

  const all = dedupeBySource(await scrollPayloads({ types: ['meeting'], limit: 5000 }));
  const matches = all.filter((mt) => {
    if (!mt.start) return false;
    const dt = new Date(mt.start);
    return !Number.isNaN(dt.getTime()) && dt >= mention.start && dt <= mention.end;
  });
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const qWords = normalizeText(question).split(' ').filter((w) => w.length > 2);
    const scored = matches
      .map((mt) => ({
        mt,
        score: qWords.reduce((s, w) => s + (normalizeText(mt.title || '').includes(w) ? 1 : 0), 0),
      }))
      .sort((a, b) => b.score - a.score);
    if (scored.length && (scored.length === 1 || scored[0].score > scored[1].score)) return scored[0].mt;
  }
  return null;
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
  const all = dedupeBySource(await scrollPayloads({ types: ['meeting'], limit: 5000 }));
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

/**
 * Prompt to answer a detail question about ONE specific meeting from its full record. Reassembles
 * text from every chunk when the meeting was long enough to be chunked — `meeting.text` alone is
 * only ONE chunk's worth (the resolved point's own payload), which for a long transcript would
 * silently reintroduce the exact "can't see past ~8000 chars" problem this fix addresses.
 */
// The prompt-size safety limit downstream (config.ollama.maxPromptChars, default 8000) silently
// truncates whatever this builds — reassembling and sending a whole long transcript would just
// get cut off again before the LLM ever saw the part being asked about, live-verified on a real
// 149k-char meeting where a question about its final minutes got "no such discussion" back
// because the reassembled text's relevant part sat past char 8000. Budget generously under that
// ceiling so the rest of the prompt (system message, question, instructions) always has room too.
const MEETING_DETAIL_TEXT_BUDGET = 6000;

export async function buildMeetingDetailPrompt(question, meeting, format = null, temporalFact = null) {
  const formatNote = FORMAT_INSTRUCTION[format] ? `\n${FORMAT_INSTRUCTION[format]}` : '';
  const system =
    'You are HHHH Agent. Answer the question about this specific meeting using ONLY ' +
    'the meeting record below (its summary, participants, transcript). Be specific and concise. ' +
    'If the record does not contain the answer, say so — do not pull in other meetings or tasks.' +
    formatNote;

  const isChunked = (meeting.totalChunks || 1) > 1;
  let recordText = meeting.text || '';

  if (isChunked && meeting.sourceKey) {
    // Semantically search WITHIN this one meeting's own chunks for the actual question, instead
    // of reassembling and blindly concatenating every chunk — the same "search, don't dump"
    // principle the rest of this app already uses, just scoped to one resolved entity's chunks
    // rather than the whole collection.
    const { searchKnowledge } = await import('./qdrant.js');
    // Ask for up to this meeting's own chunk count (capped by searchKnowledge's internal limit),
    // not an arbitrary fixed K — a small fixed K can rank the actual best-matching chunk just
    // outside the cutoff when a source has many chunks scoring similarly (chunking overlap makes
    // neighbors look alike). The text budget below still controls what actually reaches the LLM.
    const relevant = await searchKnowledge(question, meeting.totalChunks || 8, {
      must: [{ key: 'sourceKey', match: { value: meeting.sourceKey } }],
    }).catch(() => []);

    // relevant is already sorted by relevance (combinedScore desc) — spend the budget on the
    // best-matching chunks first, THEN reorder just the picked subset by chunkIndex so the excerpt
    // reads chronologically. Sorting by chunkIndex before picking (the old order) would spend the
    // whole budget on the earliest chunks regardless of relevance, since it reads front-to-back.
    const byRelevance = relevant.map((r) => r.payload).filter(Boolean);

    let budget = MEETING_DETAIL_TEXT_BUDGET;
    const pickedPayloads = [];
    for (const p of byRelevance) {
      if (budget <= 0) break;
      pickedPayloads.push(p);
      budget -= (p.text || '').length;
    }
    pickedPayloads.sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0));
    const picked = pickedPayloads.map(
      (p) => `[part ${(p.chunkIndex ?? 0) + 1}/${p.totalChunks || 1}] ${p.text || ''}`
    );
    recordText = picked.length
      ? picked.join('\n\n---\n\n')
      : (await getFullRecordText(meeting.sourceKey))?.slice(0, MEETING_DETAIL_TEXT_BUDGET) || meeting.text || '';
  }

  // A relative-date phrase in the question ("yesterday") was already deterministically resolved to
  // this exact meeting by the caller — stated as an established fact so the model doesn't
  // separately try to work out "is this meeting's date actually yesterday" from the raw record
  // (verified live: it sometimes got that arithmetic wrong even with the correct record in hand).
  const temporalNote = temporalFact
    ? `\n\nRESOLVED FACT (already determined, do not recompute or contradict this): this meeting's ` +
      `date is ${temporalFact.meetingDate}, which IS "${temporalFact.label}" relative to today. Treat this as settled.`
    : '';

  const user =
    `USER QUESTION: ${question}\n\n` +
    `MEETING RECORD for "${meeting.title}" (most relevant parts to this question):\n${recordText}\n\n` +
    `Answer using only this meeting's record. If these excerpts don't cover the question, say so ` +
    `rather than guessing.` +
    temporalNote;
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
