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
    public function scrollPayloads(array $types, int $limit = 30000, int $pageSize = 2000): array
    {
        $filter = $types ? ['must' => [['key' => 'type', 'match' => ['any' => $types]]]] : null;
        $payloads = [];
        $offset = null;

        do {
            $body = ['limit' => $pageSize, 'with_payload' => true, 'with_vector' => false];
            if ($filter) {
                $body['filter'] = $filter;
            }
            if ($offset !== null) {
                $body['offset'] = $offset;
            }
            $res = Http::postJson("{$this->url}/collections/{$this->collection}/points/scroll", $this->headers(), $body);
            if ($res['status'] !== 200) {
                throw new RuntimeException("Qdrant scroll failed: {$res['status']} " . substr($res['raw'], 0, 300));
            }
            foreach (($res['body']['result']['points'] ?? []) as $point) {
                $payloads[] = $point['payload'];
            }
            $offset = $res['body']['result']['next_page_offset'] ?? null;
        } while ($offset !== null && count($payloads) < $limit);

        return array_slice($payloads, 0, $limit);
    }
}
