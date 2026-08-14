// Node.js mirror of php-mcp/lib/TextMatch.php — same keyword/BM25-only matching, no embeddings,
// so this reads exactly like what the remote PHP server actually does. Deliberately NOT the same
// module as src/utils/textMatch.js (which backs real semantic search via Ollama+Qdrant on the
// local knowledgeServer.js) — that one is real local behavior; this one exists purely so the PHP
// logic is readable in a language its author already knows. Keep the two in sync by hand when
// TextMatch.php changes, the same way remoteToolsServer.js already mirrors the PHP tool set.

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'what', 'when', 'where',
  'give', 'show', 'tell', 'latest', 'update', 'how', 'many', 'much', 'does',
  'have', 'has', 'are', 'was', 'were', 'about', 'please', 'summary', 'related',
  'over', 'under', 'into', 'using', 'been', 'made', 'our', 'your',
]);

const TYPE_WORDS = new Set([
  'portfolio', 'portfolios', 'project', 'projects', 'task', 'tasks',
  'timeentry', 'timeentries', 'timesheet', 'timesheets', 'meeting', 'meetings',
]);

export function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&[#a-z0-9]+;/gi, ' ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Unique tokens, in first-seen order, scanned across the WHOLE text (not just its start) — a
 * transcript's important topic can be discussed anywhere in it. maxTokens caps the UNIQUE
 * vocabulary size (a safety net), not a position cutoff.
 */
export function queryTokens(question, maxTokens = 300) {
  const words = normalizeText(question).split(' ');
  const seen = new Set();
  for (const word of words) {
    if (word.length > 2 && !STOP_WORDS.has(word)) {
      seen.add(word);
    }
  }
  return Array.from(seen).slice(0, maxTokens);
}

export function extractKeywords(question, maxTokens = 300) {
  const acronyms = Array.from(new Set(String(question || '').match(/\b[A-Z0-9]{2,}\b/g) || []))
    .map((w) => w.toLowerCase())
    .filter((w) => !STOP_WORDS.has(w));
  const tokens = queryTokens(question, maxTokens).filter((t) => !TYPE_WORDS.has(t));
  return Array.from(new Set([...acronyms, ...tokens]));
}

export function recordSearchText(payload) {
  return normalizeText(
    [
      payload?.title,
      payload?.projectName,
      payload?.portfolioName,
      payload?.hierarchyPath,
      payload?.itemType,
      payload?.taskId,
      payload?.taskCode,
      payload?.authorName,
      payload?.type,
      payload?.text,
      payload?.sharePointItemId,
    ]
      .filter((v) => v !== null && v !== undefined && v !== '')
      .join(' ')
  );
}

/** @param {string[]} keywords precomputed via extractKeywords ONCE by the caller — never per record. */
export function scoreRecordMatch(keywords, payload) {
  if (!keywords.length) {
    return { score: 0.1, matchReason: 'broad_query' };
  }

  const text = recordSearchText(payload);
  const title = normalizeText(payload?.projectName || payload?.title || '');
  const description = normalizeText(payload?.text || '');

  let score = 0;
  const reasons = [];

  const titleHits = keywords.filter((k) => title.includes(k));
  const textHits = keywords.filter((k) => description.includes(k) || text.includes(k));

  const n = keywords.length;
  if (titleHits.length === n) {
    score += 1.0;
    reasons.push('title_match_all');
  } else if (titleHits.length > 0) {
    score += 0.55 + (titleHits.length / n) * 0.35;
    reasons.push('title_partial');
  }

  if (textHits.length === n) {
    score += 0.45;
    reasons.push('text_match_all');
  } else if (textHits.length > 0) {
    score += (textHits.length / n) * 0.3;
    reasons.push('text_partial');
  }

  const required = keywords.filter((k) => k.length >= 3);
  if (required.length && !required.every((k) => text.includes(k))) {
    score *= 0.35;
    reasons.push('missing_required_keyword');
  }

  return { score, matchReason: reasons.join(',') || 'weak' };
}

/** @param {string[]} qTerms precomputed via queryTokens ONCE by the caller — never per record. */
export function bm25Score(qTerms, document, { avgLen = 200, k1 = 1.2, b = 0.75 } = {}) {
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

/** Ranks payloads against query by combined keyword+BM25 score, descending, top `limit`.
 *  Tokenizes query exactly ONCE, then reuses it for every record. */
export function rankByRelevance(query, payloads, limit) {
  const keywords = extractKeywords(query);
  const qTerms = queryTokens(query);

  const scored = [];
  for (const payload of payloads) {
    const match = scoreRecordMatch(keywords, payload);
    const bm25 = bm25Score(qTerms, recordSearchText(payload));
    const combined = match.score + bm25 * 0.2;
    if (combined <= 0.15) continue;
    scored.push({ payload, combinedScore: combined });
  }
  scored.sort((a, b) => b.combinedScore - a.combinedScore);
  return scored.slice(0, limit).map((s) => s.payload);
}

/** One compact evidence line per record, mirroring compactRecord() in TextMatch.php */
export function compactRecord(payload, index) {
  const id = payload.taskId || payload.taskCode || payload.meetingId || payload.sharePointItemId || '';
  const idLabel = payload.type === 'task' ? 'taskId' : 'id';
  const label = [
    `[${index + 1}] ${payload.type || 'record'}: ${payload.title || payload.projectName || 'Untitled'}`,
    id ? `${idLabel}=${id}` : '',
    payload.projectName ? `project=${payload.projectName}` : '',
    payload.portfolioName ? `portfolio=${payload.portfolioName}` : '',
    payload.hierarchyPath ? `path=${payload.hierarchyPath}` : '',
    payload.status ? `status=${payload.status}` : '',
    payload.timestamp ? `updated=${String(payload.timestamp).slice(0, 10)}` : '',
  ]
    .filter(Boolean)
    .join(' | ');
  const text = String(payload.text || '').replace(/\s+/g, ' ').slice(0, 900);
  return `${label}\n${text}`;
}
