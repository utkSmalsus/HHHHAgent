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

function pointIdFor(metadata) {
  const stableKey = [
    metadata.sharePointSiteId,
    metadata.sharePointListId,
    metadata.sharePointItemId,
    metadata.type,
  ]
    .filter(Boolean)
    .join(':');

  return stableKey ? uuidFromHash(stableKey) : randomUUID();
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

export async function upsertKnowledge({ text, metadata }) {
  const { embedText } = await import('./ai.js');
  await ensureCollection();

  const safeText = String(text || '').slice(0, 8000);
  const safeMeta = sanitizeMetadata(metadata);
  const vector = await embedText(safeText);
  const pointId = pointIdFor(safeMeta);
  const payload = {
    type: safeMeta.type,
    projectId: safeMeta.projectId || null,
    projectName: safeMeta.projectName || null,
    text: safeText,
    timestamp: safeMeta.timestamp || new Date().toISOString().slice(0, 10),
    ...safeMeta,
  };

  await getClient().upsert(config.qdrant.collection, {
    wait: true,
    points: [{ id: pointId, vector, payload }],
  });

  return { id: pointId, payload };
}

export async function searchKnowledge(query, limit = 5, filter = null) {
  const { embedText } = await import('./ai.js');
  await ensureCollection();

  const vector = await embedText(query, { isQuery: true });
  const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 25));
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
    const text = normalizeText(`${item.projectName || ''} ${item.text || ''}`);
    return requiredTokens.every((token) => text.includes(token));
  };

  const acronymMatches = reranked.filter(hasRequiredAcronym);
  const source = requiredTokens.length ? acronymMatches : reranked;

  return source.slice(0, safeLimit);
}
