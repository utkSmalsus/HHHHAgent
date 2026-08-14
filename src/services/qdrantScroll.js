import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '../config.js';
import { ensureCollection } from './qdrant.js';

let client;

function getClient() {
  if (!client) {
    client = new QdrantClient({ url: config.qdrant.url, apiKey: config.qdrant.apiKey });
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
 * The stable identity of the real BUSINESS RECORD a Qdrant point represents — the same composite
 * key ingestion itself builds (qdrant.js's sourceKeyFor(): site+list+item+type) for point-ID
 * generation and stale-chunk cleanup, so this isn't a new invented identity, it's reading back the
 * one ingestion already uses. Falls back to type+sharePointItemId for the small number of legacy
 * points ingested before `sourceKey` existed — verified live against production (Phase 14 audit):
 * <0.1% of points per type (1 task, 1 portfolio, 15 timeentries out of ~26,600 points total), every
 * one of them already carrying a valid sharePointItemId. Returns null only when NEITHER identity is
 * available; callers must never merge two null-key points with each other (see dedupeBySource).
 */
export function getBusinessEntityKey(payload) {
  if (payload?.sourceKey) return payload.sourceKey;
  if (payload?.sharePointItemId != null && payload?.type) return `${payload.type}:${payload.sharePointItemId}`;
  return null;
}

/**
 * Long records (mainly meeting transcripts) are split across multiple chunk points sharing one
 * business identity (see getBusinessEntityKey). Most retrieval paths only need ONE representative
 * row per record (e.g. listing meetings by date just needs title/status/date, which every chunk
 * carries identically in its metadata — verified live, Phase 14: zero examples across 5 types of
 * two points sharing an identity with different title/sharePointItemId) — dedupe to the lowest
 * chunkIndex per identity so a chunked record doesn't appear N times in a list OR get counted N
 * times (this is also THE dedup step every deterministic COUNT must apply — see
 * countBusinessEntities below — so there's exactly one dedup implementation, not a second one for
 * counting). A point with no identity at all (neither sourceKey nor sharePointItemId) passes
 * through on its own rather than risk merging two records we can't prove are the same.
 */
export function dedupeBySource(payloads) {
  const bestByKey = new Map();
  const noIdentity = [];
  for (const p of payloads) {
    const key = getBusinessEntityKey(p);
    if (!key) {
      noIdentity.push(p);
      continue;
    }
    const existing = bestByKey.get(key);
    if (!existing || (p.chunkIndex ?? 0) < (existing.chunkIndex ?? 0)) {
      bestByKey.set(key, p);
    }
  }
  return [...noIdentity, ...bestByKey.values()];
}

/** Alias, named for the call sites that care about counting/uniqueness rather than "source" —
 *  same one dedup implementation as dedupeBySource, not a parallel mechanism. */
export const uniqueBusinessEntities = dedupeBySource;

/** Qdrant points != business records (a chunked meeting transcript can be dozens of points for ONE
 *  real meeting). Every deterministic COUNT of real entities must use this instead of raw
 *  `items.length` once items may include multiple points per record. */
export function countBusinessEntities(payloads) {
  return uniqueBusinessEntities(payloads).length;
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

/**
 * Real per-type record counts currently sitting in Qdrant — dedupe applied so a chunked record
 * (several points sharing one sourceKey) counts once, matching what a completed ingest run's own
 * `lists[key].ingested` number means (real records, not chunk points). Used to make the ingest UI
 * show what's actually already stored when idle, instead of looking empty just because no job has
 * run in this particular server process yet (Qdrant itself is a separate, persistent service).
 */
export async function getRecordCounts() {
  const payloads = await scrollPayloads({
    types: ['portfolio', 'project', 'task', 'timeentry', 'meeting'],
    limit: 60000,
  });
  const deduped = dedupeBySource(payloads);
  const counts = {};
  for (const p of deduped) {
    if (!p?.type) continue;
    counts[p.type] = (counts[p.type] || 0) + 1;
  }
  return counts;
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
