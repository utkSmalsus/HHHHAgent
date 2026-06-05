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
