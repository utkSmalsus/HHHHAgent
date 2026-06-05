import { searchKnowledge } from './qdrant.js';
import { scrollPayloads } from './qdrantScroll.js';
import { parseQueryIntent } from './queryIntent.js';
import {
  bm25Score,
  dedupeKey,
  dedupeByTitleKey,
  extractKeywords,
  payloadToResult,
  reciprocalRankFusion,
  scoreRecordMatch,
} from '../utils/textMatch.js';

function passesKeywordGate(query, payload, intent) {
  const keywords = extractKeywords(query);
  if (!keywords.length) return true;
  if (intent.intent === 'summary') return true;

  const { score, matchedKeywords } = scoreRecordMatch(query, payload);
  if (intent.intent === 'count' || intent.intent === 'list') {
    return matchedKeywords.length > 0 && score >= 0.25;
  }
  return score >= 0.2;
}

function rankBm25Candidates(query, payloads, intent) {
  const keywords = extractKeywords(query);
  if (!keywords.length && (intent.intent === 'count' || intent.intent === 'list')) {
    return payloads.map((payload) => ({
      payload,
      bm25Score: 0,
      match: { score: 1, confidence: 0.75, matchReason: 'all_in_type', matchedKeywords: [] },
    }));
  }

  return payloads
    .map((payload) => {
      const doc = [
        payload.title,
        payload.projectName,
        payload.portfolioName,
        payload.hierarchyPath,
        payload.itemType,
        payload.taskCode,
        payload.authorName,
        payload.text,
        payload.projectId,
        payload.portfolioId,
      ]
        .filter(Boolean)
        .join(' ');
      const bm25 = bm25Score(query, doc);
      const match = scoreRecordMatch(query, payload);
      return {
        payload,
        bm25Score: bm25,
        match,
      };
    })
    .filter((r) => r.bm25 > 0 || r.match.score > 0.2)
    .sort((a, b) => b.bm25 + b.match.score - (a.bm25 + a.match.score));
}

function fuseResults(vectorResults, bm25Ranked, limit) {
  const vecIds = vectorResults.map((r) => dedupeKey(r.payload));
  const bm25Ids = bm25Ranked.map((r) => dedupeKey(r.payload));
  const fused = reciprocalRankFusion([vecIds, bm25Ids]);

  const byId = new Map();
  for (const r of vectorResults) {
    byId.set(dedupeKey(r.payload), { payload: r.payload, vector: r });
  }
  for (const r of bm25Ranked) {
    const id = dedupeKey(r.payload);
    if (!byId.has(id)) byId.set(id, { payload: r.payload, bm25: r });
    else byId.get(id).bm25 = r;
  }

  const merged = [...byId.entries()]
    .map(([id, entry]) => {
      const payload = entry.payload;
      const vectorScore = entry.vector?.score ?? 0;
      const bm25 = entry.bm25?.bm25Score ?? 0;
      const match = entry.bm25?.match || scoreRecordMatch('', payload);
      const rrf = fused.get(id) || 0;
      const combinedScore = rrf * 2 + vectorScore * 0.4 + bm25 * 0.15 + match.score * 0.25;
      const confidence = Math.min(
        0.99,
        rrf * 3 + match.confidence * 0.5 + (vectorScore > 0.5 ? 0.15 : 0)
      );

      return payloadToResult(payload, {
        vectorScore,
        keywordScore: match.score,
        bm25Score: bm25,
        combinedScore,
        confidence,
        matchReason: match.matchReason,
      });
    })
    .sort((a, b) => b.combinedScore - a.combinedScore);

  return merged.slice(0, limit);
}

function expandHierarchy(intent, anchorResults) {
  const keywords = intent.keywords;
  const anchorTitles = new Set(
    anchorResults
      .filter((r) => r.type === 'project' || r.type === 'portfolio')
      .flatMap((r) => {
        const p = r.payload || r;
        return [
          r.projectName,
          r.title,
          p.title,
          p.hierarchyPath,
        ]
          .filter(Boolean)
          .map((t) => String(t).toLowerCase());
      })
  );
  const anchorPaths = new Set(
    anchorResults
      .map((r) => (r.hierarchyPath || r.payload?.hierarchyPath || '').toLowerCase())
      .filter((p) => p.length > 3)
  );
  const anchorProjectIds = new Set();
  const anchorPortfolioIds = new Set();
  const anchorTaskIds = new Set();

  for (const r of anchorResults) {
    const p = r.payload || r;
    if (p.projectId) anchorProjectIds.add(Number(p.projectId));
    if (p.portfolioId) anchorPortfolioIds.add(Number(p.portfolioId));
    if (p.taskId) anchorTaskIds.add(Number(p.taskId));
    if (p.type === 'portfolio' && p.sharePointItemId) {
      anchorPortfolioIds.add(Number(p.sharePointItemId));
    }
    if (p.type === 'project' && p.sharePointItemId) {
      anchorProjectIds.add(Number(p.sharePointItemId));
    }
  }

  return (payload) => {
    if (
      !keywords.length &&
      anchorTitles.size === 0 &&
      anchorProjectIds.size === 0 &&
      anchorPortfolioIds.size === 0
    ) {
      return true;
    }
    if (payload.type === 'project' || payload.type === 'portfolio') {
      return passesKeywordGate(intent.rawQuestion, payload, intent);
    }
    if (payload.projectId && anchorProjectIds.has(Number(payload.projectId))) return true;
    if (payload.portfolioId && anchorPortfolioIds.has(Number(payload.portfolioId))) return true;
    if (payload.taskId && anchorTaskIds.has(Number(payload.taskId))) return true;
    const title = (payload.projectName || payload.title || payload.text || '').toLowerCase();
    if (
      anchorTitles.size &&
      [...anchorTitles].some((t) => title.includes(t) || t.includes(title.slice(0, 20)))
    ) {
      return true;
    }
    if (payload.hierarchyPath) {
      const path = payload.hierarchyPath.toLowerCase();
      if ([...anchorTitles].some((t) => path.includes(t))) return true;
      if ([...anchorPaths].some((ap) => path.startsWith(ap) || ap.startsWith(path.slice(0, 20)))) {
        return true;
      }
    }
    return passesKeywordGate(intent.rawQuestion, payload, intent);
  };
}

export async function hybridRetrieve(question, { limit = 12 } = {}) {
  const intent = parseQueryIntent(question);
  const typesForScroll =
    intent.intent === 'count' || intent.intent === 'list'
      ? intent.entityTypes
      : intent.hierarchy;

  const scrollTypes =
    intent.keywords.length > 0 || intent.intent !== 'summary'
      ? typesForScroll
      : ['project', 'task', 'portfolio', 'timeentry'];

  const scrollLimit = intent.intent === 'count' ? 20000 : 8000;
  const [vectorResults, scrolled] = await Promise.all([
    searchKnowledge(question, Math.max(limit, 15)).catch(() => []),
    scrollPayloads({ types: scrollTypes, limit: scrollLimit }),
  ]);

  const gated = scrolled.filter((p) => passesKeywordGate(question, p, intent));
  const bm25Ranked = rankBm25Candidates(
    question,
    gated.length ? gated : scrolled,
    intent
  );

  let fused = fuseResults(
    vectorResults.map((r) => ({ ...r, payload: r.payload || r })),
    bm25Ranked,
    limit * 2
  );

  if (intent.intent === 'count' || intent.intent === 'list') {
    const dedupeFn =
      intent.entityTypes.includes('project') || intent.entityTypes.includes('portfolio')
        ? dedupeByTitleKey
        : dedupeKey;
    const seen = new Set();
    fused = fused.filter((r) => {
      const key = dedupeFn(r.payload);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const anchors = fused.filter((r) => r.type === 'project' || r.type === 'portfolio').slice(0, 5);
  if (anchors.length && (intent.intent === 'summary' || intent.intent === 'who' || intent.intent === 'status')) {
    const relatedTypes = ['task', 'timeentry'];
    const relatedScroll = await scrollPayloads({ types: relatedTypes, limit: 6000 });
    const matchFn = expandHierarchy(intent, anchors);
    const related = relatedScroll
      .filter(matchFn)
      .map((payload) => {
        const match = scoreRecordMatch(question, payload);
        return payloadToResult(payload, {
          combinedScore: match.score * 0.8,
          confidence: match.confidence,
          matchReason: `related_${match.matchReason}`,
        });
      })
      .slice(0, 20);

    const seen = new Set(fused.map((r) => dedupeKey(r.payload)));
    for (const r of related) {
      const id = dedupeKey(r.payload);
      if (!seen.has(id)) {
        fused.push(r);
        seen.add(id);
      }
    }
    fused.sort((a, b) => b.combinedScore - a.combinedScore);
  }

  const top = fused.slice(0, limit);
  const avgConfidence =
    top.length > 0
      ? top.reduce((s, r) => s + (r.confidence || 0), 0) / top.length
      : 0;

  return {
    intent,
    results: top,
    confidence: Math.round(avgConfidence * 100) / 100,
    meta: {
      vectorHits: vectorResults.length,
      scrollHits: scrolled.length,
      bm25Candidates: bm25Ranked.length,
      fusedCount: fused.length,
    },
  };
}
