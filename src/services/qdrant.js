import { createHash, randomUUID } from 'crypto';
import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '../config.js';

let client;

import {
  acronymTokens,
  extractKeywords,
  normalizeText,
  queryTokens,
  scoreRecordMatch,
} from '../utils/textMatch.js';
import { chunkText, estimateTokens } from '../utils/chunking.js';

// Set DEBUG_RAG=false to silence the per-chunk/per-query diagnostic logging added for the
// chunking fix — left on by default since it's cheap (one line per event) and is exactly what's
// needed to verify retrieval vs. LLM issues without re-instrumenting later.
const DEBUG_RAG = process.env.DEBUG_RAG !== 'false';
function debugLog(...args) {
  if (DEBUG_RAG) console.log(...args);
}

function requiredExactTokens(query) {
  return Array.from(
    new Set([
      ...acronymTokens(query),
      ...queryTokens(query).filter((word) => word.length >= 4 && !/[aeiou]/.test(word)),
    ])
  );
}

function lexicalScore(query, payload) {
  return scoreRecordMatch(query, payload).score;
}

function getClient() {
  if (!client) {
    client = new QdrantClient({
      url: config.qdrant.url,
      checkCompatibility: false,
    });
  }
  return client;
}

function uuidFromHash(input) {
  const hex = createHash('sha256').update(input).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20
  )}-${hex.slice(20)}`;
}

/** The stable identity of a source record — same key used for the legacy (pre-chunking) point ID,
 *  the new per-chunk point IDs, and the `sourceKey` payload field used to clean up stale chunks. */
function sourceKeyFor(metadata) {
  return [
    metadata.sharePointSiteId,
    metadata.sharePointListId,
    metadata.sharePointItemId,
    metadata.type,
  ]
    .filter(Boolean)
    .join(':');
}

/** Legacy point ID scheme (pre-chunking): one point per record, no chunk suffix. */
function legacyPointIdFor(sourceKey) {
  return sourceKey ? uuidFromHash(sourceKey) : null;
}

function chunkPointIdFor(sourceKey, chunkIndex) {
  return sourceKey ? uuidFromHash(`${sourceKey}:chunk:${chunkIndex}`) : randomUUID();
}

export async function ensureCollection() {
  const qdrant = getClient();
  const { collection, vectorSize } = config.qdrant;
  const collections = await qdrant.getCollections();
  const existing = collections.collections.find((c) => c.name === collection);

  if (!existing) {
    await qdrant.createCollection(collection, {
      vectors: { size: vectorSize, distance: 'Cosine' },
    });
    return;
  }

  const info = await qdrant.getCollection(collection);
  const currentSize = info.config?.params?.vectors?.size;
  if (currentSize && currentSize !== vectorSize) {
    console.warn(
      `Qdrant collection "${collection}" has size ${currentSize}, expected ${vectorSize}. Recreating…`
    );
    await qdrant.deleteCollection(collection);
    await qdrant.createCollection(collection, {
      vectors: { size: vectorSize, distance: 'Cosine' },
    });
  }
}

function sanitizePayloadValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return String(value);
}

function sanitizeMetadata(metadata = {}) {
  const out = {};
  for (const [key, value] of Object.entries(metadata)) {
    out[key] = sanitizePayloadValue(value);
  }
  return out;
}

/**
 * Embeds and stores one source record. Long text is split into overlapping chunks first (see
 * ../utils/chunking.js) — each chunk gets its own embedding and its own point, instead of the old
 * behavior of silently truncating anything past ~8000 chars before it ever reached the embedding
 * model. Short records (the vast majority — tasks, timeentries, most portfolio/project rows) are
 * under the chunk-size threshold and still produce exactly one point, unchanged.
 *
 * Re-ingesting the same record is safe and non-duplicating: chunk point IDs are deterministic
 * (hash of sourceKey + chunk index), so re-upserting with the same chunk boundaries overwrites the
 * same points. Two cleanup deletes handle the cases a pure upsert can't:
 *   1. The pre-chunking legacy point (one ID, no chunk suffix) — deleted so old truncated data
 *      left over from before this fix doesn't linger alongside the new chunked points.
 *   2. Any stale higher-index chunks from a previous ingest of this same record that chunked into
 *      MORE pieces than this run does (e.g. content shrank) — deleted by a ranged filter so they
 *      don't stay searchable after they're no longer part of the source.
 */
export async function upsertKnowledge({ text, metadata }) {
  const { embedText } = await import('./ai.js');
  await ensureCollection();

  const fullText = String(text || '').trim();
  const safeMeta = sanitizeMetadata(metadata);
  const sourceKey = sourceKeyFor(safeMeta);
  const chunks = chunkText(fullText);
  const usedChunks = chunks.length ? chunks : [''];
  const totalChunks = usedChunks.length;
  const chunked = totalChunks > 1;

  if (sourceKey) {
    const cleanupFilter = {
      should: [
        ...(legacyPointIdFor(sourceKey) ? [{ has_id: [legacyPointIdFor(sourceKey)] }] : []),
        { must: [{ key: 'sourceKey', match: { value: sourceKey } }, { key: 'chunkIndex', range: { gte: totalChunks } }] },
      ],
    };
    try {
      await getClient().delete(config.qdrant.collection, { wait: true, filter: cleanupFilter });
    } catch (err) {
      debugLog(`[INGEST] cleanup-delete warning sourceKey=${sourceKey}:`, err.message);
    }
  }

  const points = [];
  let embedFailures = 0;
  for (let i = 0; i < usedChunks.length; i++) {
    const chunkBody = usedChunks[i];
    const pointId = chunkPointIdFor(sourceKey, i);
    try {
      const vector = await embedText(chunkBody);
      const payload = {
        type: safeMeta.type,
        projectId: safeMeta.projectId || null,
        projectName: safeMeta.projectName || null,
        text: chunkBody,
        timestamp: safeMeta.timestamp || new Date().toISOString().slice(0, 10),
        ...safeMeta,
        sourceKey: sourceKey || null,
        chunkIndex: i,
        totalChunks,
        sourceLength: fullText.length,
      };
      await getClient().upsert(config.qdrant.collection, { wait: true, points: [{ id: pointId, vector, payload }] });
      points.push({ id: pointId, payload });
    } catch (err) {
      embedFailures += 1;
      console.warn(`[INGEST] chunk failed sourceKey=${sourceKey || '(none)'} chunk=${i + 1}/${totalChunks}:`, err.message);
    }
  }

  const status = embedFailures === 0 ? 'SUCCESS' : points.length > 0 ? 'PARTIAL' : 'FAILED';
  debugLog(
    `[INGEST] type=${safeMeta.type} id=${safeMeta.sharePointItemId ?? '(none)'} ` +
      `origLen=${fullText.length} chunked=${chunked ? 'YES' : 'NO'} chunks=${totalChunks} ` +
      `embeddings=${points.length}/${totalChunks} status=${status}`
  );

  return {
    id: points[0]?.id,
    payload: points[0]?.payload,
    points,
    stats: {
      sourceKey,
      originalLength: fullText.length,
      estimatedTokens: estimateTokens(fullText),
      chunked,
      totalChunks,
      embeddingsOk: points.length,
      embeddingsFailed: embedFailures,
      status,
    },
  };
}

export async function searchKnowledge(query, limit = 5, filter = null) {
  const { embedText } = await import('./ai.js');
  await ensureCollection();

  const vector = await embedText(query, { isQuery: true });
  // The 25-result cap protects the general (whole-collection) retrieval path from flooding
  // context — it doesn't apply when the caller already scoped the search to one record's own
  // chunks via a sourceKey filter, since that candidate pool is inherently small and bounded
  // (one meeting's chunk count), and callers there (e.g. buildMeetingDetailPrompt) rely on
  // getting every chunk that could plausibly match, not just the top 25 by raw vector score.
  const isSingleSourceFilter = Boolean(
    filter?.must?.some((c) => c?.key === 'sourceKey' && c?.match?.value)
  );
  const safeLimit = isSingleSourceFilter
    ? Math.max(1, Number(limit) || 5)
    : Math.max(1, Math.min(Number(limit) || 5, 25));
  const candidateLimit = Math.max(safeLimit * 8, 50);
  const results = await getClient().search(config.qdrant.collection, {
    vector,
    limit: candidateLimit,
    with_payload: true,
    filter: filter || undefined,
  });

  const requiredTokens = requiredExactTokens(query);
  const reranked = results
    .map((r) => {
      const keywordScore = lexicalScore(query, r.payload);
      return {
        // Qdrant point id — lets a caller re-fetch this exact chunk's FULL text later (see the
        // qdrant_get_chunk tool), instead of being stuck with whatever preview it was handed.
        id: r.id,
        score: r.score,
        keywordScore,
        combinedScore: r.score + keywordScore * 0.25,
        text: r.payload?.text,
        type: r.payload?.type,
        projectId: r.payload?.projectId,
        projectName: r.payload?.projectName,
        timestamp: r.payload?.timestamp,
        payload: r.payload,
      };
    })
    .sort((a, b) => b.combinedScore - a.combinedScore);

  const hasRequiredAcronym = (item) => {
    if (!requiredTokens.length) return true;
    // Every chunk of a source carries the same replicated title/projectName metadata (see
    // upsertKnowledge), but only chunk 0's own TEXT includes the "Title. Type: X..." preamble —
    // checking title too means a required acronym in the record's NAME (e.g. searching "SCRUM"
    // within one specific "SCRUM - 25/06/2026" meeting's own chunks) doesn't wrongly filter out
    // every chunk past the first just because later chunks are raw continuation text.
    const text = normalizeText(`${item.payload?.title || ''} ${item.projectName || ''} ${item.text || ''}`);
    return requiredTokens.every((token) => text.includes(token));
  };

  // Like the per-source cap below: the acronym gate exists to disambiguate between DIFFERENT
  // records (e.g. don't let "SCRUM" match a chunk from an unrelated meeting) — meaningless once
  // the candidate pool is already scoped to one record's own chunks via an incoming filter, where
  // it would otherwise wrongly reject chunks that don't happen to repeat every acronym literally.
  const rerankedSources = new Set(
    reranked.map((item) => item.payload?.sourceKey || item.payload?.sharePointItemId).filter(Boolean)
  );
  const singleSource = reranked.length > 0 && rerankedSources.size <= 1;
  const acronymMatches = reranked.filter(hasRequiredAcronym);
  const source = requiredTokens.length && !singleSource ? acronymMatches : reranked;

  // Chunking means one long source can contribute several high-scoring, near-adjacent chunks
  // (overlap makes neighbors look similar) — cap how many of the returned slots one source can
  // take so it can't crowd out other genuinely different sources, while still allowing more than
  // one chunk through when a source is legitimately the best match repeatedly. Skipped when the
  // candidate pool only ever contained ONE source to begin with (e.g. a caller already filtered
  // the search to one specific record's chunks, precisely to pull several of them) — there's
  // nothing else for that source to crowd out in that case.
  const uniqueSources = new Set(source.map((item) => item.payload?.sourceKey || item.payload?.sharePointItemId).filter(Boolean));
  const MAX_PER_SOURCE = 3;
  const perSourceCount = new Map();
  const deduped = [];
  for (const item of source) {
    const key = item.payload?.sourceKey || item.payload?.sharePointItemId || null;
    const count = key ? perSourceCount.get(key) || 0 : 0;
    if (key && uniqueSources.size > 1 && count >= MAX_PER_SOURCE) continue;
    if (key) perSourceCount.set(key, count + 1);
    deduped.push(item);
    if (deduped.length >= safeLimit) break;
  }

  debugLog(`[RETRIEVAL] query="${String(query).slice(0, 80)}" candidates=${results.length} returned=${deduped.length}`);
  deduped.forEach((item, i) => {
    debugLog(
      `  #${i + 1} score=${item.score.toFixed(3)} kw=${item.keywordScore.toFixed(2)} ` +
        `source=${item.payload?.title || item.payload?.projectName || item.payload?.sharePointItemId || '?'} ` +
        `chunk=${(item.payload?.chunkIndex ?? 0) + 1}/${item.payload?.totalChunks || 1} ` +
        `preview="${String(item.text || '').slice(0, 100).replace(/\s+/g, ' ')}"`
    );
  });

  return deduped;
}
