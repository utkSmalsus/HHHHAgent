/**
 * Date-first "latest / recent work on X" retrieval for tasks & projects.
 *
 * Vector retrieval ranks by relevance and only reorders its top-K by date, so the genuinely
 * newest item (e.g. a task named "Team Management System" when the user said "Team Management
 * Tool") is never pulled in. Here we keyword-match ALL tasks/projects on the topic, then sort by
 * their updated date — mirroring a manual "find matching tasks, newest first" search.
 */
import { scrollPayloads } from './qdrantScroll.js';
import { extractKeywords, normalizeText } from '../utils/textMatch.js';
import { groupByEntity, toCandidates } from '../utils/disambiguate.js';

// Words that carry no topic meaning for a "latest work on X" question.
const GENERIC = new Set([
  'latest', 'recent', 'recently', 'current', 'currently', 'now', 'newest', 'show', 'tell', 'give',
  'work', 'working', 'update', 'updates', 'status', 'tool', 'tools', 'portal', 'system', 'this',
  'that', 'these', 'those', 'the', 'new', 'please', 'can', 'you', 'what', 'which', 'about', 'going',
]);

export function isRecentWorkQuestion(question) {
  return /\b(latest|recent|recently|current|currently|newest|last few|up[- ]?to[- ]?date)\b/i.test(String(question || ''));
}

function topicKeywords(text) {
  const combined = [...extractKeywords(text), ...normalizeText(text).split(' ')];
  return [...new Set(combined)].filter((k) => k && k.length > 2 && !GENERIC.has(k));
}

/** @returns {Promise<null | { ambiguous: true, candidates: object[], keywords: string[] } | { items: object[], keywords: string[] }>} */
export async function recentWorkRetrieve(topicText) {
  const keywords = topicKeywords(topicText);
  if (!keywords.length) return null;

  // Adjacent 2-word phrases from the topic (order preserved) — e.g. "team management".
  const topicWords = normalizeText(topicText).split(' ').filter((w) => w.length > 2 && !GENERIC.has(w));
  const phrases = [];
  for (let i = 0; i < topicWords.length - 1; i++) {
    const ph = `${topicWords[i]} ${topicWords[i + 1]}`;
    if (ph.length > 6) phrases.push(ph);
  }

  const items = await scrollPayloads({ types: ['task', 'project'], limit: 30000 });
  const scored = items
    .map((p) => {
      const hay = normalizeText(
        [p.title, p.hierarchyPath, p.projectName, p.portfolioName, p.itemType].filter(Boolean).join(' ')
      );
      const phraseHits = phrases.filter((ph) => hay.includes(ph)).length;
      const hits = keywords.filter((k) => hay.includes(k)).length;
      return { p, phraseHits, hits };
    })
    .filter((x) => x.hits > 0);

  if (!scored.length) return null;

  // Prefer items containing the exact topic phrase ("team management"); this excludes items that
  // merely have both words scattered (e.g. "…for team > Content Management…"). Fall back to
  // keyword-count matching only when no item contains the phrase (e.g. single-word topics).
  let matched = scored.filter((x) => x.phraseHits > 0);
  if (!matched.length) {
    const need = keywords.length === 1 ? 1 : 2;
    matched = scored.filter((x) => x.hits >= need);
    if (!matched.length) matched = scored;
  }

  const groups = groupByEntity(matched.map((x) => x.p));

  // The 2-word phrase check above only needs ONE overlapping fragment, so a title that merely
  // shares a fragment (e.g. "...MS Teams Apps" sharing "teams app" with "AIS Conversion to MS
  // Teams App") counts as a match too. If the user actually named one real title exactly, that
  // should win outright rather than getting crowded out of an ambiguous list by fragment-sharing
  // near-neighbors — mirrors "found the exact file" beating "found files that mention it".
  if (groups.length > 1) {
    // Leading connectors ("update ON X", "status FOR X") aren't part of the entity name, but
    // aren't safe to strip everywhere (GENERIC) since some real titles use "to"/"in" as content
    // words — e.g. "Conversion TO MS Teams". Only strip them here, for this exact-match check.
    const CONNECTORS = new Set(['on', 'in', 'for', 'of']);
    const strippedTopic = normalizeText(topicText)
      .split(' ')
      .filter((w) => !GENERIC.has(w) && !CONNECTORS.has(w))
      .join(' ');
    const exactGroup = groups.find((g) => normalizeText(g.title) === strippedTopic);
    if (exactGroup) {
      const pool = [...exactGroup.items].sort((a, b) => tsMs(b) - tsMs(a));
      return { items: pool.slice(0, 15), keywords };
    }
  }

  // Several distinct real projects/tasks matched the topic (e.g. "team management tool" against
  // real data containing "Team Management Tools", "Team management System", "Development Team
  // Management System", ...). Picking whichever is newest and stating it as THE answer is a
  // confident guess about the wrong thing — surface the real candidates instead.
  if (groups.length > 1) {
    return { ambiguous: true, candidates: toCandidates(groups), keywords };
  }

  const pool = matched.map((x) => x.p);
  pool.sort((a, b) => tsMs(b) - tsMs(a)); // newest first

  return { items: pool.slice(0, 15), keywords };
}

const tsMs = (p) => Date.parse(p?.timestamp || '') || 0;

export function buildRecentWorkPrompt(question, result, now = new Date()) {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const fmt = (p) =>
    `- "${p.title || 'Untitled'}"${p.status ? ` [${p.status}]` : ''} — updated ${String(p.timestamp || '').slice(0, 10)}` +
    `${p.hierarchyPath ? ` (${String(p.hierarchyPath).slice(0, 80)})` : ''}`;
  const list = result.items.map(fmt).join('\n');

  const system =
    'You are HHHH Agent. The items below are sorted NEWEST FIRST by updated date. ' +
    'The single latest item is the FIRST one in the list — when asked for "the latest task", answer ' +
    'with that first item and its date. Do not pick an older item. Use ONLY these items; never invent.';
  const user =
    `Today is ${today}.\n` +
    `USER QUESTION: ${question}\n\n` +
    `MATCHING ITEMS (newest first — item #1 is the latest):\n${list}\n\n` +
    `Answer using only these items. If asked for the latest, lead with item #1 above.`;

  return { system, user };
}
