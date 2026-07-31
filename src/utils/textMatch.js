export const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'this',
  'that',
  'what',
  'when',
  'where',
  'give',
  'show',
  'tell',
  'latest',
  'update',
  'how',
  'many',
  'much',
  'does',
  'have',
  'has',
  'are',
  'was',
  'were',
  'about',
  'please',
  'summary',
  'related',
  'over',
  'under',
  'into',
  'using',
  'been',
  'made',
  'have',
  'our',
  'your',
  'this',
  'that',
]);

const TYPE_WORDS = {
  portfolio: 'portfolio',
  portfolios: 'portfolio',
  project: 'project',
  projects: 'project',
  task: 'task',
  tasks: 'task',
  timeentry: 'timeentry',
  timeentries: 'timeentry',
  timesheet: 'timeentry',
  timesheets: 'timeentry',
};

export function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&[#a-z0-9]+;/gi, ' ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function queryTokens(question, { includeStopWords = false } = {}) {
  return normalizeText(question)
    .split(' ')
    .filter((word) => word.length > 2 && (includeStopWords || !STOP_WORDS.has(word)));
}

export function acronymTokens(query) {
  return Array.from(new Set(String(query || '').match(/\b[A-Z0-9]{2,}\b/g) || []))
    .map((word) => word.toLowerCase())
    .filter((word) => !STOP_WORDS.has(word));
}

export function extractKeywords(question) {
  const tokens = queryTokens(question);
  const acronyms = acronymTokens(question);
  const typeWords = new Set([
    ...Object.keys(TYPE_WORDS),
    'portfolio',
    'portfolios',
    'project',
    'projects',
    'task',
    'tasks',
    'timeentry',
    'timeentries',
    'timesheet',
    'timesheets',
  ]);
  const filtered = tokens.filter((t) => !typeWords.has(t));
  return Array.from(new Set([...acronyms, ...filtered]));
}

export function recordSearchText(payload) {
  return normalizeText(
    [
      payload?.title,
      payload?.projectName,
      payload?.portfolioName,
      payload?.hierarchyPath,
      payload?.itemType,
      payload?.projectId,
      payload?.portfolioId,
      payload?.taskId,
      payload?.taskCode,
      payload?.siteType,
      payload?.authorName,
      payload?.type,
      payload?.text,
      payload?.sharePointItemId,
    ].join(' ')
  );
}

export function scoreRecordMatch(query, payload) {
  const keywords = extractKeywords(query);
  const text = recordSearchText(payload);
  const title = normalizeText(payload?.projectName || '');
  const description = normalizeText(payload?.text || '');

  if (!keywords.length) {
    return { score: 0.1, confidence: 0.2, matchReason: 'broad_query' };
  }

  let score = 0;
  const reasons = [];

  const titleHits = keywords.filter((k) => title.includes(k));
  const textHits = keywords.filter((k) => description.includes(k) || text.includes(k));
  const allHits = new Set([...titleHits, ...textHits]);

  if (titleHits.length === keywords.length) {
    score += 1.0;
    reasons.push('title_match_all');
  } else if (titleHits.length > 0) {
    score += 0.55 + (titleHits.length / keywords.length) * 0.35;
    reasons.push('title_partial');
  }

  if (textHits.length === keywords.length) {
    score += 0.45;
    reasons.push('text_match_all');
  } else if (textHits.length > 0) {
    score += (textHits.length / keywords.length) * 0.3;
    reasons.push('text_partial');
  }

  const phrase = normalizeText(query);
  if (phrase.length > 5 && title.includes(phrase)) {
    score += 0.5;
    reasons.push('title_phrase');
  }

  const required = keywords.filter((k) => k.length >= 3);
  if (required.length && !required.every((k) => text.includes(k))) {
    score *= 0.35;
    reasons.push('missing_required_keyword');
  }

  const confidence = Math.min(0.98, Math.max(0.15, score / 1.8));
  return {
    score,
    confidence,
    matchReason: reasons.join(',') || 'weak',
    matchedKeywords: [...allHits],
  };
}

/** Simple BM25-style score over a document string */
export function bm25Score(query, document, { avgLen = 200, k1 = 1.2, b = 0.75 } = {}) {
  const qTerms = queryTokens(query);
  if (!qTerms.length) return 0;

  const doc = normalizeText(document);
  const docLen = doc.split(' ').filter(Boolean).length || 1;
  let score = 0;

  for (const term of qTerms) {
    const regex = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    const tf = (doc.match(regex) || []).length;
    if (!tf) continue;
    const idf = Math.log(1 + 1 / (0.5 + tf));
    const denom = tf + k1 * (1 - b + (b * docLen) / avgLen);
    score += idf * ((tf * (k1 + 1)) / denom);
  }

  return score;
}

export function reciprocalRankFusion(rankLists, k = 60) {
  const scores = new Map();
  for (const list of rankLists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) || 0) + 1 / (k + rank + 1));
    });
  }
  return scores;
}

export function dedupeKey(payload) {
  return `${payload?.type || ''}:${payload?.sharePointListId || ''}:${payload?.sharePointItemId || ''}`;
}

export function dedupeByTitleKey(payload) {
  const title = normalizeText(payload?.projectName || payload?.text?.slice(0, 80));
  const type = payload?.type || '';
  return `${type}:${title}`;
}

export function extractOwnersFromText(text) {
  const owners = new Set();
  const ownerMatch = String(text || '').match(/Owner:\s*([^.\n]+)/gi);
  if (ownerMatch) {
    for (const m of ownerMatch) {
      const name = m.replace(/^Owner:\s*/i, '').trim();
      if (name && !name.includes('[object Object]') && name.length < 80) {
        owners.add(name);
      }
    }
  }
  return [...owners];
}

// Ingest text is built as "Label: value. Label: value. ...actual description/comments". Strip the
// leading labeled fields so only the free-text description/feedback/comments portion remains.
const KNOWN_FIELD_RE = /^(Type|Path|Status|Completion|Owner|Structure|TaskID|Project|Portfolio|Site):/i;

export function rawDescription(text) {
  const chunks = String(text || '').split(/\.\s+/);
  const rest = [];
  let pastPrefix = false;
  for (const chunk of chunks) {
    if (!pastPrefix && KNOWN_FIELD_RE.test(chunk.trim())) continue;
    pastPrefix = true;
    rest.push(chunk);
  }
  return rest.join('. ').trim();
}

export function itemDate(payload) {
  return payload?.timestamp || payload?.start || payload?.timeDate || '';
}

export function itemStatus(payload) {
  return (
    payload?.status ||
    (String(payload?.text || '').match(/Status:\s*([^.,]+)/i)?.[1] || '').trim()
  );
}

export function payloadToResult(payload, scores = {}) {
  return {
    score: scores.vectorScore ?? scores.combinedScore ?? 0,
    vectorScore: scores.vectorScore ?? 0,
    keywordScore: scores.keywordScore ?? 0,
    bm25Score: scores.bm25Score ?? 0,
    combinedScore: scores.combinedScore ?? 0,
    confidence: scores.confidence ?? 0,
    matchReason: scores.matchReason ?? '',
    text: payload?.text,
    type: payload?.type,
    title: payload?.title,
    itemType: payload?.itemType,
    hierarchyPath: payload?.hierarchyPath,
    projectId: payload?.projectId,
    portfolioId: payload?.portfolioId,
    taskId: payload?.taskId,
    taskCode: payload?.taskCode,
    siteType: payload?.siteType,
    projectName: payload?.projectName,
    portfolioName: payload?.portfolioName,
    timeHours: payload?.timeHours,
    authorName: payload?.authorName,
    timeDate: payload?.timeDate,
    timestamp: payload?.timestamp,
    payload,
  };
}
