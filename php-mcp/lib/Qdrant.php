<?php
declare(strict_types=1);

require_once __DIR__ . '/Http.php';

/**
 * Plain scroll+filter over Qdrant's REST API — no vector search needed here, so no embedding
 * dependency at all. Mirrors scrollPayloads() in HHHHAgent's src/services/qdrantScroll.js.
 */
final class Qdrant
{
    private string $url;
    private ?string $apiKey;
    private string $collection;

    public function __construct(array $config)
    {
        $this->url = $config['qdrant']['url'];
        $this->apiKey = $config['qdrant']['apiKey'];
        $this->collection = $config['qdrant']['collection'];
    }

    private function headers(): array
    {
        $headers = ['Content-Type' => 'application/json'];
        if ($this->apiKey) {
            $headers['api-key'] = $this->apiKey;
        }
        return $headers;
    }

    /**
     * @param string[] $types e.g. ['task'], ['portfolio','project']
     * @param int $pageSize confirmed live: 2000 is the safe default — count_records' worst case
     *   (all 5 types unfiltered, PLUS the person-name-resolution bookkeeping it layers on top of
     *   the raw scroll) hit PHP's default 128MB limit and crashed at 4000/page in real testing,
     *   even though a bigger page size alone measured safely in isolation. Callers whose own
     *   handler is lighter (no per-type accumulation, e.g. investigate_transcript_context) can
     *   pass a larger override that's been separately confirmed safe for THAT handler — don't
     *   raise this shared default without re-measuring count_records' unfiltered worst case,
     *   not just a raw scroll.
     */
    /**
     * @param ?string[] $payloadFields when set, asks Qdrant to return ONLY these payload fields
     *   (its `with_payload: {include: [...]}` form) instead of the full payload — container
     *   resolution only needs title/parentId/type/status/timestamp, not every record's full `text`
     *   blob, and requesting the full payload for ~3400 portfolio/project records was confirmed
     *   live to push count_records/list_records over PHP's 30s execution limit.
     */
    public function scrollPayloads(array $types, int $limit = 30000, int $pageSize = 2000, ?array $payloadFields = null, int $timeoutSeconds = 30): array
    {
        $filter = $types ? ['must' => [['key' => 'type', 'match' => ['any' => $types]]]] : null;
        return $this->scroll($filter, $limit, $pageSize, $payloadFields, $timeoutSeconds);
    }

    /**
     * Same as scrollPayloads(), but additionally restricted to records under a resolved container's
     * descendant subtree — server-side, via the payload indexes on sharePointItemId/projectId/
     * portfolioId (created once this need was confirmed live: filtering a project/task down to its
     * real ~100s-of-records subtree instead of transferring the WHOLE type's 1000s of records first
     * and filtering client-side cut a "tasks in SPA"-style query from ~24s to low single digits).
     * project/portfolio match by their OWN id; task/timeentry match by the project OR portfolio
     * they're linked under — mirrors belongsToContainer() in index.php exactly, just server-side.
     */
    public function scrollPayloadsInContainer(string $type, array $descendantIds, int $limit = 30000, int $pageSize = 2000, ?array $payloadFields = null): array
    {
        if (!$descendantIds) {
            return [];
        }
        $ids = array_values($descendantIds);
        $must = [['key' => 'type', 'match' => ['value' => $type]]];
        $filter = ($type === 'project' || $type === 'portfolio')
            ? ['must' => [...$must, ['key' => 'sharePointItemId', 'match' => ['any' => $ids]]]]
            : [
                'must' => $must,
                'should' => [
                    ['key' => 'projectId', 'match' => ['any' => $ids]],
                    ['key' => 'portfolioId', 'match' => ['any' => $ids]],
                ],
            ];
        return $this->scroll($filter, $limit, $pageSize, $payloadFields);
    }

    private function scroll(?array $filter, int $limit, int $pageSize, ?array $payloadFields, int $timeoutSeconds = 30): array
    {
        $payloads = [];
        $offset = null;
        $withPayload = $payloadFields !== null ? ['include' => $payloadFields] : true;

        do {
            $body = ['limit' => $pageSize, 'with_payload' => $withPayload, 'with_vector' => false];
            if ($filter) {
                $body['filter'] = $filter;
            }
            if ($offset !== null) {
                $body['offset'] = $offset;
            }
            $res = Http::postJson("{$this->url}/collections/{$this->collection}/points/scroll", $this->headers(), $body, $timeoutSeconds);
            if ($res['status'] !== 200) {
                throw new RuntimeException("Qdrant scroll failed: {$res['status']} " . substr($res['raw'], 0, 300));
            }
            foreach (($res['body']['result']['points'] ?? []) as $point) {
                // Qdrant's OWN point id, carried through under a leading-underscore key so it can
                // never collide with a real SharePoint payload field — used later by
                // fetchPayloadsByPointIds() to hydrate just the shown slice's `text` without a
                // second full scroll. Harmless for every other caller, which only reads named fields.
                $payload = $point['payload'];
                $payload['_qid'] = $point['id'] ?? null;
                $payloads[] = $payload;
            }
            $offset = $res['body']['result']['next_page_offset'] ?? null;
        } while ($offset !== null && count($payloads) < $limit);

        return array_slice($payloads, 0, $limit);
    }

    /**
     * Fetch specific payload fields for a small, known set of records by Qdrant's own point id
     * (the `_qid` scrollPayloads() attaches to every payload) — used to hydrate the `text` field
     * only for the handful of records actually shown to the user, after filtering/sorting/limiting
     * ran on a lighter field-restricted scroll. Deliberately NOT a payload-field filter (e.g. on
     * sharePointItemId): this collection has no payload index on that field, and Qdrant's cloud
     * tier rejects an unindexed filter outright (confirmed live: "Index required but not found") —
     * retrieving by native point id needs no index at all, it's Qdrant's primary key.
     */
    public function fetchPayloadsByPointIds(array $qdrantIds, array $payloadFields): array
    {
        $ids = array_values(array_filter($qdrantIds, fn($id) => $id !== null));
        if (!$ids) {
            return [];
        }
        $body = ['ids' => $ids, 'with_payload' => ['include' => $payloadFields], 'with_vector' => false];
        $res = Http::postJson("{$this->url}/collections/{$this->collection}/points", $this->headers(), $body);
        if ($res['status'] !== 200) {
            throw new RuntimeException("Qdrant points retrieve failed: {$res['status']} " . substr($res['raw'], 0, 300));
        }
        $payloads = [];
        foreach (($res['body']['result'] ?? []) as $point) {
            $payload = $point['payload'];
            $payload['_qid'] = $point['id'] ?? null;
            $payloads[] = $payload;
        }
        return $payloads;
    }
}
