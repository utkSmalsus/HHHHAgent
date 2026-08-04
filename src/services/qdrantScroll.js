import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '../config.js';
import { ensureCollection } from './qdrant.js';

let client;

function getClient() {
  if (!client) {
    client = new QdrantClient({ url: config.qdrant.url });
  }
  return client;
}

function typeFilter(types) {
  if (!types?.length) return undefined;
  if (types.length === 1) {
    return { must: [{ key: 'type', match: { value: types[0] } }] };
  }
  return {
    should: types.map((type) => ({ key: 'type', match: { value: type } })),
  };
}

/**
 * Long records (mainly meeting transcripts) are now split across multiple chunk points sharing
 * one `sourceKey`. Most retrieval paths only need ONE representative row per record (e.g. listing
 * meetings by date just needs title/status/date, which every chunk carries identically in its
 * metadata) — dedupe to the lowest chunkIndex per sourceKey so a chunked record doesn't appear
 * N times in a list. Records that were never chunked (chunkIndex/totalChunks absent or 1) pass
 * through unchanged.
 */
export function dedupeBySource(payloads) {
  const bestBySource = new Map();
  const passthrough = [];
  for (const p of payloads) {
    const key = p?.sourceKey;
    if (!key || (p.totalChunks || 1) <= 1) {
      passthrough.push(p);
      continue;
    }
    const existing = bestBySource.get(key);
    if (!existing || (p.chunkIndex ?? 0) < (existing.chunkIndex ?? 0)) {
      bestBySource.set(key, p);
    }
  }
  return [...passthrough, ...bestBySource.values()];
}

/**
 * Reassembles a chunked record's FULL text (all chunks, in order) for the cases that genuinely
 * need the complete content — e.g. answering a detail question about one specific meeting, where
 * reading only its first chunk would silently drop everything past the old ~8000-char cutoff all
 * over again. Chunk overlap means consecutive chunks share a little boundary text; this is joined
 * as-is (a few repeated words at each seam) rather than exactly deduplicated — simpler and safe,
 * since the result only ever feeds an LLM prompt, not a stored value.
 */
export async function getFullRecordText(sourceKey) {
  if (!sourceKey) return null;
  await ensureCollection();
  const qdrant = getClient();
  const points = [];
  let offset = null;
  do {
    const batch = await qdrant.scroll(config.qdrant.collection, {
      filter: { must: [{ key: 'sourceKey', match: { value: sourceKey } }] },
      limit: 100,
      offset,
      with_payload: true,
      with_vector: false,
    });
    points.push(...(batch.points || []));
    offset = batch.next_page_offset;
  } while (offset);

  if (!points.length) return null;
  const sorted = points
    .map((p) => p.payload)
    .filter(Boolean)
    .sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0));
  return sorted.map((p) => p.text || '').join('\n\n');
}

export async function scrollPayloads({ types, limit = 15000 } = {}) {
  await ensureCollection();
  const qdrant = getClient();
  const filter = typeFilter(types);
  const all = [];
  let offset = null;

  while (all.length < limit) {
    const batch = await qdrant.scroll(config.qdrant.collection, {
      filter,
      limit: Math.min(500, limit - all.length),
      offset,
      with_payload: true,
      with_vector: false,
    });

    const points = batch.points || [];
    all.push(...points.map((p) => p.payload).filter(Boolean));
    offset = batch.next_page_offset;
    if (!offset || !points.length) break;
  }

  return all;
}
