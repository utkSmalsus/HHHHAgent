/**
 * Exact/verbatim lookup — for "comments on X", "feedback for X", "what does X say" questions.
 *
 * The normal path (hybridRetrieve → LLM) is deliberately a *summarizer*: it synthesizes a few
 * sentences from the top-K semantically-similar records (see enterpriseQuery.js's "do NOT just
 * list task titles back"). That's right for "what's the status of X" but wrong for "what did
 * they say" — paraphrasing loses/changes the actual wording, and top-K vector search can miss
 * the one record with the exact name.
 *
 * This does the opposite: a deterministic substring match over EVERY record of the matching
 * type, sorted newest-first, returning the RAW stored text with no LLM in the loop at all — so
 * the answer is byte-for-byte what's in the record, every time.
 */
import { scrollPayloads } from './qdrantScroll.js';
import { normalizeText, rawDescription } from '../utils/textMatch.js';
import { resolveReferencedTopic } from '../utils/referenceResolve.js';

const LOOKUP_TYPES = ['portfolio', 'project', 'task', 'timeentry', 'meeting'];

const LOOKUP_RE =
  /\b(comments?|feedback|verbatim|raw (data|text)|word for word|exact(ly)?\s+(text|words|wording)|quote|what does (it|this|that|he|she|they) say|full text|description of|details? (of|on|for)|show me (the )?(comments?|feedback|details?|description))\b/i;

export function isExactLookupQuestion(question) {
  return LOOKUP_RE.test(String(question || ''));
}

// Trigger phrases + generic connector words stripped out, leaving (hopefully) just the entity name.
const STRIP_RE =
  /\b(show|me|the|a|an|comments?|feedback|verbatim|raw|data|text|word|for|exact(ly)?|words|wording|quote|what|does|is|are|was|were|did|say|says|said|full|description|of|details?|on|in|for|list|give|please|and|about|to)\b/gi;

// Words that refer to "the thing we were just discussing" rather than naming an entity. If the
// WHOLE extracted phrase is made of these ("this task", "that", "it"), there's no real name to
// search for — return null so the caller's resolveReferencedEntity(convo) fallback runs instead
// of literally searching for the words "this"/"task" (which match almost anything).
const PURE_REFERENCE_WORDS = new Set([
  'this', 'that', 'these', 'those', 'it', 'one',
  'task', 'tasks', 'item', 'items', 'thing', 'things',
  'meeting', 'meetings', 'project', 'projects', 'portfolio', 'entry', 'entries',
]);

/** Pull the entity name out of the question — quoted text wins, else strip trigger/stop words. */
export function extractLookupPhrase(question) {
  const quoted = String(question || '').match(/["']([^"']{3,80})["']/);
  if (quoted) return quoted[1].trim();

  const stripped = String(question || '')
    .replace(STRIP_RE, ' ')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!stripped) return null;

  const words = stripped.toLowerCase().split(' ');
  if (words.every((w) => PURE_REFERENCE_WORDS.has(w))) return null;

  return stripped.length >= 3 ? stripped : null;
}

/**
 * Follow-up with no named entity ("what did it say?") → resolve from the prior conversation.
 * Thin wrapper over the shared resolver (src/utils/referenceResolve.js) — same ONE resolution
 * mechanism used by meeting follow-ups and structural/recent-work follow-ups.
 */
export async function resolveReferencedEntity(convoText, currentQuestion = '', types = LOOKUP_TYPES) {
  const hit = await resolveReferencedTopic(convoText, currentQuestion, types);
  return hit?.title || null;
}

const tsMs = (p) => Date.parse(p?.timestamp || p?.start || '') || 0;

/** Deterministic substring match over ALL records — no fuzzy ranking, no top-K cutoff. */
export async function exactLookup({ phrase, types = LOOKUP_TYPES, limit = 20 }) {
  const q = normalizeText(phrase);
  if (!q) return [];
  // Word-set match, not literal substring: extractLookupPhrase strips connector words ("and",
  // "feedback") that the real title still has (e.g. "Hardware/Software AND Licenses"), so a
  // strict hay.includes(q) misses the exact record the trigger phrase names. Requiring every
  // query word to be present (any order) tolerates that while staying precise.
  const qWords = q.split(' ').filter(Boolean);

  const all = await scrollPayloads({ types, limit: 30000 });
  const hits = all.filter((p) => {
    const hay = normalizeText(
      [p.title, p.hierarchyPath, p.projectName, p.portfolioName].filter(Boolean).join(' ')
    );
    return hay.includes(q) || qWords.every((w) => hay.includes(w));
  });

  hits.sort((a, b) => tsMs(b) - tsMs(a));
  return hits.slice(0, limit);
}

/** Render matched records verbatim — title + date + the raw description/comment text. No LLM. */
export function buildRawAnswer(rows) {
  return rows
    .map((p) => {
      const when = p.timestamp || p.start;
      const date = when ? ` — ${String(when).slice(0, 10)}` : '';
      const desc = rawDescription(p.text) || '(no description on this record)';
      return `• ${p.title || 'Untitled'}${date}\n  ${desc}`;
    })
    .join('\n\n');
}
