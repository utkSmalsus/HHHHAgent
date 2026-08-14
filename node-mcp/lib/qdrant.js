// Standalone scroll-only Qdrant client — mirrors php-mcp/lib/Qdrant.php. Uses @qdrant/js-client-
// rest directly (an installed package, not a link into ../src/services) — no vector search needed
// here at all, so no embedding dependency.
import { QdrantClient } from '@qdrant/js-client-rest';

let client;

function getClient(cfg) {
  if (!client) {
    client = new QdrantClient({ url: cfg.url, apiKey: cfg.apiKey });
  }
  return client;
}

/** @param {string[]} types e.g. ['task'], ['portfolio','project'] */
export async function scrollPayloads(cfg, types, limit = 30000) {
  const qdrant = getClient(cfg);
  const filter = types?.length
    ? types.length === 1
      ? { must: [{ key: 'type', match: { value: types[0] } }] }
      : { should: types.map((t) => ({ key: 'type', match: { value: t } })) }
    : undefined;

  const payloads = [];
  let offset = null;

  do {
    const batch = await qdrant.scroll(cfg.collection, {
      filter,
      limit: Math.min(2000, limit - payloads.length),
      offset,
      with_payload: true,
      with_vector: false,
    });
    payloads.push(...(batch.points || []).map((p) => p.payload).filter(Boolean));
    offset = batch.next_page_offset;
  } while (offset && payloads.length < limit);

  return payloads.slice(0, limit);
}
