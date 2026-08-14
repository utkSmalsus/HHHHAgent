<?php
declare(strict_types=1);

/**
 * Ported from HHHHAgent's src/utils/textMatch.js (queryTokens/scoreRecordMatch/bm25Score) —
 * keyword/BM25-only, no vector search. This is the whole point of this file: dogado (shared PHP
 * hosting) cannot reach Ollama to embed a query, so there is no semantic-similarity path available
 * here at all — every match below is plain text/keyword matching against the transcript. A related
 * meeting or task worded very differently from the transcript can be missed; a true semantic match
 * only exists in the Node MCP server (knowledgeServer.js), which has real Ollama access.
 */
final class TextMatch
{
    private static array $stopWords = [
        'the', 'and', 'for', 'with', 'from', 'this', 'that', 'what', 'when', 'where',
        'give', 'show', 'tell', 'latest', 'update', 'how', 'many', 'much', 'does',
        'have', 'has', 'are', 'was', 'were', 'about', 'please', 'summary', 'related',
        'over', 'under', 'into', 'using', 'been', 'made', 'our', 'your',
    ];

    private static array $typeWords = [
        'portfolio' => 'portfolio', 'portfolios' => 'portfolio',
        'project' => 'project', 'projects' => 'project',
        'task' => 'task', 'tasks' => 'task',
        'timeentry' => 'timeentry', 'timeentries' => 'timeentry',
        'timesheet' => 'timeentry', 'timesheets' => 'timeentry',
        'meeting' => 'meeting', 'meetings' => 'meeting',
    ];

    public static function normalizeText(?string $value): string
    {
        $value = strtolower((string) $value);
        $value = preg_replace('/&[#a-z0-9]+;/i', ' ', $value) ?? $value;
        $value = preg_replace('/[^a-z0-9]+/i', ' ', $value) ?? $value;
        $value = preg_replace('/\s+/', ' ', $value) ?? $value;
        return trim($value);
    }

    /**
     * @return string[] unique tokens, in first-seen order, scanned across the WHOLE text (not just
     *   its start) — a transcript's important topic can be discussed anywhere in it, not only in
     *   its first N characters. $maxTokens caps the UNIQUE vocabulary size (a safety net for a
     *   pathologically long/diverse document), not a position cutoff — natural language redundancy
     *   already keeps real transcripts' unique-word count far below this for any realistic length.
     */
    public static function queryTokens(string $question, int $maxTokens = 300): array
    {
        $words = explode(' ', self::normalizeText($question));
        $seen = [];
        foreach ($words as $word) {
            if (strlen($word) > 2 && !in_array($word, self::$stopWords, true)) {
                $seen[$word] = true;
            }
        }
        return array_slice(array_keys($seen), 0, $maxTokens);
    }

    /** @return string[] */
    public static function extractKeywords(string $question, int $maxTokens = 300): array
    {
        $acronyms = array_values(array_unique(array_map(
            'strtolower',
            array_filter(
                preg_match_all('/\b[A-Z0-9]{2,}\b/', $question, $m) ? $m[0] : [],
                fn($w) => !in_array(strtolower($w), self::$stopWords, true)
            )
        )));
        $tokens = array_filter(self::queryTokens($question, $maxTokens), fn($t) => !isset(self::$typeWords[$t]));
        return array_values(array_unique([...$acronyms, ...$tokens]));
    }

    public static function recordSearchText(array $payload): string
    {
        return self::normalizeText(implode(' ', array_filter([
            $payload['title'] ?? null,
            $payload['projectName'] ?? null,
            $payload['portfolioName'] ?? null,
            $payload['hierarchyPath'] ?? null,
            $payload['itemType'] ?? null,
            $payload['taskId'] ?? null,
            $payload['taskCode'] ?? null,
            $payload['authorName'] ?? null,
            $payload['type'] ?? null,
            $payload['text'] ?? null,
            $payload['sharePointItemId'] ?? null,
        ], fn($v) => $v !== null && $v !== '')));
    }

    /**
     * @param string[] $keywords precomputed via extractKeywords($query) ONCE by the caller — never
     *   re-derived per record. Re-running extractKeywords/queryTokens (which tokenize the whole
     *   query string) inside a loop over thousands of records was confirmed live to turn a ~40k-
     *   char transcript into a 30s+ request — cost that scaled with query-length × record-count
     *   instead of being paid once. rankByRelevance() is the only caller and hoists this already.
     * @return array{score: float, matchReason: string}
     */
    public static function scoreRecordMatch(array $keywords, array $payload): array
    {
        if (!$keywords) {
            return ['score' => 0.1, 'matchReason' => 'broad_query'];
        }

        $text = self::recordSearchText($payload);
        $title = self::normalizeText($payload['projectName'] ?? $payload['title'] ?? '');
        $description = self::normalizeText($payload['text'] ?? '');

        $score = 0.0;
        $reasons = [];

        $titleHits = array_values(array_filter($keywords, fn($k) => str_contains($title, $k)));
        $textHits = array_values(array_filter($keywords, fn($k) => str_contains($description, $k) || str_contains($text, $k)));

        $n = count($keywords);
        if (count($titleHits) === $n) {
            $score += 1.0;
            $reasons[] = 'title_match_all';
        } elseif (count($titleHits) > 0) {
            $score += 0.55 + (count($titleHits) / $n) * 0.35;
            $reasons[] = 'title_partial';
        }

        if (count($textHits) === $n) {
            $score += 0.45;
            $reasons[] = 'text_match_all';
        } elseif (count($textHits) > 0) {
            $score += (count($textHits) / $n) * 0.3;
            $reasons[] = 'text_partial';
        }

        $required = array_values(array_filter($keywords, fn($k) => strlen($k) >= 3));
        if ($required && !array_reduce($required, fn($ok, $k) => $ok && str_contains($text, $k), true)) {
            $score *= 0.35;
            $reasons[] = 'missing_required_keyword';
        }

        return ['score' => $score, 'matchReason' => $reasons ? implode(',', $reasons) : 'weak'];
    }

    /**
     * Simple BM25-style score over a document string, same formula as bm25Score() in textMatch.js.
     * @param string[] $qTerms precomputed via queryTokens($query) ONCE by the caller — see
     *   scoreRecordMatch()'s own comment for why this must not be re-derived per record.
     */
    public static function bm25Score(array $qTerms, string $document, float $avgLen = 200, float $k1 = 1.2, float $b = 0.75): float
    {
        if (!$qTerms) {
            return 0.0;
        }

        $doc = self::normalizeText($document);
        $docLen = max(1, count(array_filter(explode(' ', $doc))));
        $score = 0.0;

        foreach ($qTerms as $term) {
            $pattern = '/\b' . preg_quote($term, '/') . '\b/';
            $tf = preg_match_all($pattern, $doc);
            if (!$tf) {
                continue;
            }
            $idf = log(1 + 1 / (0.5 + $tf));
            $denom = $tf + $k1 * (1 - $b + ($b * $docLen) / $avgLen);
            $score += $idf * (($tf * ($k1 + 1)) / $denom);
        }

        return $score;
    }

    /**
     * Ranks $payloads against $query by combined keyword+BM25 score, descending, top $limit.
     * Tokenizes $query exactly ONCE here, then reuses the result for every record — see
     * scoreRecordMatch()'s comment for why this matters at transcript length.
     */
    public static function rankByRelevance(string $query, array $payloads, int $limit): array
    {
        $keywords = self::extractKeywords($query);
        $qTerms = self::queryTokens($query);

        $scored = [];
        foreach ($payloads as $payload) {
            $match = self::scoreRecordMatch($keywords, $payload);
            $bm25 = self::bm25Score($qTerms, self::recordSearchText($payload));
            $combined = $match['score'] + $bm25 * 0.2;
            if ($combined <= 0.15) {
                continue;
            }
            $scored[] = ['payload' => $payload, 'combinedScore' => $combined];
        }
        usort($scored, fn($a, $b) => $b['combinedScore'] <=> $a['combinedScore']);
        return array_slice(array_map(fn($s) => $s['payload'], $scored), 0, $limit);
    }

    /** One compact evidence line per record, mirroring compactRecord() in uploadedMeetingAnalysis.js */
    public static function compactRecord(array $payload, int $index): string
    {
        $id = $payload['taskId'] ?? $payload['taskCode'] ?? $payload['meetingId'] ?? $payload['sharePointItemId'] ?? '';
        $idLabel = ($payload['type'] ?? '') === 'task' ? 'taskId' : 'id';
        $label = implode(' | ', array_filter([
            sprintf('[%d] %s: %s', $index + 1, $payload['type'] ?? 'record', $payload['title'] ?? $payload['projectName'] ?? 'Untitled'),
            $id !== '' ? "$idLabel=$id" : '',
            isset($payload['projectName']) ? "project={$payload['projectName']}" : '',
            isset($payload['portfolioName']) ? "portfolio={$payload['portfolioName']}" : '',
            isset($payload['hierarchyPath']) ? "path={$payload['hierarchyPath']}" : '',
            isset($payload['status']) ? "status={$payload['status']}" : '',
            isset($payload['timestamp']) ? 'updated=' . substr((string) $payload['timestamp'], 0, 10) : '',
        ], fn($v) => $v !== ''));
        $text = substr(preg_replace('/\s+/', ' ', (string) ($payload['text'] ?? '')) ?? '', 0, 900);
        return "$label\n$text";
    }
}
