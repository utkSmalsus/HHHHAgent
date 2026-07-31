/**
 * General-purpose conversational reference resolution — "under it", "for that project", "in this
 * meeting", "what about it" all point at whatever entity was actually named earlier in the
 * conversation, not the literal pronoun. Every retrieval path (meetings, tasks, projects,
 * portfolios) hit this same problem independently; this is the ONE shared fix all of them use.
 */
import { scrollPayloads } from '../services/qdrantScroll.js';
import { normalizeText } from './textMatch.js';

const WORD_RE = /[a-z0-9]+/g;

// Words so generic they appear in nearly every follow-up question BY DEFINITION (pronouns,
// container-type nouns, recency/status filler) — excluding them from title-overlap scoring means
// only genuinely distinguishing words can make a candidate "win", and a bare pronoun-only question
// (nothing left after exclusion) is recognized as naming no new topic at all.
export const GENERIC_REFERENCE_WORDS = new Set([
  // pronouns / references
  'it', 'that', 'this', 'these', 'those', 'one',
  // container-type nouns (meeting-ish)
  'meeting', 'meetings', 'call', 'calls', 'sync', 'scrum', 'standup', 'stand', 'up',
  'discussion', 'discussions', 'review', 'session', 'huddle', 'retro', 'retrospective',
  // container-type nouns (project/task-ish)
  'project', 'projects', 'task', 'tasks', 'portfolio', 'portfolios', 'tool', 'tools',
  'portal', 'system', 'component', 'components',
  // recency / status / generic filler
  'latest', 'recent', 'recently', 'current', 'currently', 'now', 'newest', 'show', 'tell', 'give',
  'work', 'working', 'update', 'updates', 'updated', 'status', 'new', 'please', 'can', 'you',
  'what', 'which', 'about', 'going', 'under', 'for', 'of', 'in', 'on', 'the', 'is', 'are',
]);

/** Word-overlap score between the CURRENT question and a candidate title (order-independent). */
function overlapScore(questionWords, title) {
  const titleWords = new Set(
    (title.toLowerCase().match(WORD_RE) || []).filter((w) => w.length > 2 && !GENERIC_REFERENCE_WORDS.has(w))
  );
  if (!titleWords.size) return 0;
  let hits = 0;
  for (const w of questionWords) if (titleWords.has(w)) hits += 1;
  return hits;
}

/**
 * A specific date (e.g. "30/07/2026") in the question is highly distinguishing — but day/month
 * numbers are only 2 digits, too short to survive the length>2 word filter used everywhere else,
 * so plain word-overlap can't tell "Scrum 29/07/2026" from "Scrum 30/07/2026" apart (both only
 * share the year). Extracted as one whole date signature instead of split into digit-words.
 */
function extractDateSignature(text) {
  const m = String(text || '').match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
  if (!m) return null;
  const [, a, b, yearRaw] = m;
  const year = yearRaw.length === 2 ? `20${yearRaw}` : yearRaw;
  return `${a.padStart(2, '0')}${b.padStart(2, '0')}${year}`;
}

/**
 * Find the entity (of the given types) that the CURRENT question is referring back to, using the
 * conversation so far. Prefers whichever mentioned title shares a genuinely distinguishing word
 * with the current question; falls back to the longest mentioned title when nothing distinguishes
 * (mirrors "the most specific thing you were just talking about" over "some other loose match").
 * @returns {Promise<object|null>} the full payload of the resolved entity, or null.
 */
export async function resolveReferencedTopic(convoText, currentQuestion, types) {
  const lc = String(convoText || '').toLowerCase();
  if (!lc.trim()) return null;
  const all = await scrollPayloads({ types, limit: 30000 });
  const hits = all.filter((p) => p.title && p.title.length > 4 && lc.includes(p.title.toLowerCase()));
  if (!hits.length) return null;

  // An exact named date beats everything else — "Scrum 30/07/2026" naming that literal date
  // should never lose to a same-year sibling just because both only share "2026".
  const qDate = extractDateSignature(currentQuestion);
  if (qDate) {
    const dateMatches = hits.filter((m) => extractDateSignature(m.title) === qDate);
    if (dateMatches.length === 1) return dateMatches[0];
  }

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

/**
 * True when the question has no real topic of its own — just a pronoun/reference plus generic
 * filler ("what's under it", "latest task for that", "who attended it"). Retrieval for a question
 * like this can only find the wrong thing by accident; the caller should resolve the actual
 * referenced entity from conversation instead of searching the literal words.
 */
export function isPronounFollowup(question) {
  const words = normalizeText(question).split(' ').filter((w) => w.length > 2);
  if (!words.length) return true;
  return words.every((w) => GENERIC_REFERENCE_WORDS.has(w));
}
