import { extractKeywords, normalizeText } from './textMatch.js';

export function extractSearchPhrases(question) {
  const tokens = normalizeText(question).split(' ').filter((w) => w.length > 2);
  const phrases = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    phrases.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return [...new Set(phrases)].filter((p) => p.length > 5);
}

function recordHaystack(record) {
  const p = record.payload || record;
  return normalizeText(
    [
      record.text,
      record.title,
      record.projectName,
      record.portfolioName,
      record.hierarchyPath,
      p.text,
      p.title,
      p.projectName,
      p.hierarchyPath,
    ]
      .filter(Boolean)
      .join(' ')
  );
}

/**
 * True when retrieved records actually mention the user's topic (avoids LLM hallucination).
 */
export function evidenceMatchesQuestion(question, results = []) {
  if (!results.length) return false;

  const haystacks = results.map(recordHaystack);
  const keywords = extractKeywords(question);
  const phrases = extractSearchPhrases(question);
  const q = normalizeText(question);

  if (phrases.length) {
    const phraseHit = results.some((r, i) =>
      phrases.some((phrase) => haystacks[i].includes(normalizeText(phrase)))
    );
    if (phraseHit) return true;
  }

  if (q.includes('meeting tool')) {
    return results.some((_, i) => haystacks[i].includes('meeting') && haystacks[i].includes('tool'));
  }

  if (!keywords.length) {
    return results.length > 0;
  }

  const matchedRecords = results.filter((_, i) => {
    const hits = keywords.filter((k) => haystacks[i].includes(k));
    if (keywords.length === 1) return hits.length === 1;
    if (keywords.length === 2) return hits.length >= 2;
    return hits.length >= Math.ceil(keywords.length * 0.6);
  });

  return matchedRecords.length > 0;
}

export function filterResultsByQuestion(question, results = []) {
  const keywords = extractKeywords(question);
  const phrases = extractSearchPhrases(question);
  const q = normalizeText(question);

  if (!keywords.length && !phrases.length) return results;

  return results.filter((r, i) => {
    const hay = recordHaystack(r);
    if (phrases.some((p) => hay.includes(normalizeText(p)))) return true;
    if (q.includes('meeting tool') && hay.includes('meeting') && hay.includes('tool')) return true;
    const hits = keywords.filter((k) => hay.includes(k));
    if (keywords.length <= 2) return hits.length >= keywords.length;
    return hits.length >= Math.ceil(keywords.length * 0.6);
  });
}
