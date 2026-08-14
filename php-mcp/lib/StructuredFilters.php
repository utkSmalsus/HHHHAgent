<?php
declare(strict_types=1);

/**
 * Simplified port of src/services/structuredFilters.js — date/status/overdue/type filters, plus a
 * person-name resolver (added after QA testing showed person-scoped and time-entry questions were
 * being refused entirely). Container/project-NAME resolution (resolveContainerFilter) is still not
 * ported — that one also does keyword-overlap scoring against structuralRetrieve.js's hierarchy
 * walk, a bigger and riskier port than name-matching against a flat list of real owners.
 */
final class StructuredFilters
{
    private const DONE_RE = '/^(task completed|completed|approved|ready to go)/i';
    private const PENDING_STATUSES = ['Not Started', 'Acknowledged', 'For Approval', 'Deployment Pending'];
    private const ACTIVE_STATUSES = ['working on it', 'In Progress'];

    private const NAME_STOPWORDS = [
        'how', 'many', 'does', 'is', 'are', 'has', 'have', 'the', 'this', 'that', 'those', 'these',
        'show', 'tell', 'what', 'who', 'when', 'where', 'which', 'why', 'team', 'management', 'project',
        'projects', 'portfolio', 'portfolios', 'task', 'tasks', 'meeting', 'meetings', 'development',
        'system', 'currently', 'recently', 'time', 'entry', 'entries', 'latest', 'based', 'data', 'today',
        'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
        'october', 'november', 'december',
    ];

    /**
     * A record's date fields differ in FORMAT, not just name: task/meeting/project dates come from
     * Graph as ISO-8601 ("2026-08-11T07:00:00Z"), which strtotime() parses correctly regardless of
     * locale. Time entries store DD/MM/YYYY plain strings ("20/07/2026") — confirmed live that
     * strtotime() on those is actively dangerous: `strtotime("20/07/2026")` returns false (day>12
     * rejected as an invalid month, silently dropping the record), and `strtotime("05/07/2026")`
     * silently returns May 7 instead of the real July 5 (assumes US month-first). Same root cause
     * the original Node app's own custom date parser exists to avoid — never trust strtotime() with
     * a bare slash-separated date from this data.
     */
    private static function parseAppDate(?string $raw): int|false
    {
        if (!$raw) {
            return false;
        }
        if (preg_match('#^(\d{1,2})/(\d{1,2})/(\d{4})$#', trim($raw), $m)) {
            $d = DateTimeImmutable::createFromFormat('!d/m/Y', "{$m[1]}/{$m[2]}/{$m[3]}");
            return $d ? $d->getTimestamp() : false;
        }
        return strtotime($raw);
    }

    /** @return array{requested: bool, label: ?string, statuses: array} */
    public static function resolveStatusFilter(string $question): array
    {
        $q = strtolower($question);
        if (preg_match('/\bcompleted\b|\bdone\b|\bfinished\b/', $q)) {
            return ['requested' => true, 'label' => 'completed', 'mode' => 'done'];
        }
        if (str_contains($q, 'pending')) {
            return ['requested' => true, 'label' => 'pending', 'mode' => 'pending'];
        }
        if (preg_match('/\bin progress\b|\bworking on it\b|\bactive\b/', $q)) {
            return ['requested' => true, 'label' => 'in progress', 'mode' => 'active'];
        }
        return ['requested' => false, 'label' => null, 'mode' => null];
    }

    private static function statusMatches(?string $status, string $mode): bool
    {
        $status ??= '';
        return match ($mode) {
            'done' => (bool) preg_match(self::DONE_RE, $status),
            'pending' => in_array($status, self::PENDING_STATUSES, true),
            'active' => in_array($status, self::ACTIVE_STATUSES, true),
            default => true,
        };
    }

    public static function isOverdueRequested(string $question): bool
    {
        return (bool) preg_match('/\b(overdue|past due|late|behind schedule)\b/i', $question);
    }

    public static function isTaskOverdue(array $task): bool
    {
        if (empty($task['dueDate'])) {
            return false;
        }
        $due = self::parseAppDate($task['dueDate']);
        return $due !== false && $due < time() && !preg_match(self::DONE_RE, $task['status'] ?? '');
    }

    /** The field a person's name actually lives in differs by type — tasks/projects/portfolios use
     *  `owner` (SharePoint's People Picker field), time entries use `authorName` (who logged the
     *  hours) instead. Meetings have no single-owner field (only a `participants` list) — not
     *  supported here. Public so index.php's count_records can tell whether a type supports
     *  person-scoping at all, rather than showing an unrelated unconstrained count for a type that
     *  can't actually be scoped to the requested person. */
    public static function personField(string $entityType): ?string
    {
        return match ($entityType) {
            'task', 'project', 'portfolio' => 'owner',
            'timeentry' => 'authorName',
            default => null,
        };
    }

    private static function trimCandidate(string $raw): string
    {
        $words = preg_split('/\s+/', trim($raw));
        while (count($words) > 1 && in_array(strtolower($words[0]), self::NAME_STOPWORDS, true)) {
            array_shift($words);
        }
        if ($words) {
            $last = count($words) - 1;
            $words[$last] = preg_replace("/'s$/i", '', $words[$last]);
        }
        return implode(' ', $words);
    }

    private static function isAllStopwords(string $phrase): bool
    {
        foreach (explode(' ', $phrase) as $w) {
            if ($w !== '' && !in_array(strtolower($w), self::NAME_STOPWORDS, true)) {
                return false;
            }
        }
        return true;
    }

    /**
     * Ported from resolvePersonFilter() in structuredFilters.js, minus the container-title cross-
     * check (container/project-name resolution isn't ported here at all, so there's nothing to
     * cross-check against yet — a project name mis-tried as a person just fails closed as
     * "unresolved person" instead of correctly falling through, a less precise but still honest
     * failure). Matches ONLY against real names actually present in the data, never a fixed list,
     * so it works for any employee. Fails closed on ambiguity (multiple real people share a first
     * name) rather than silently picking one.
     *
     * @param string[] $realNames Real owner/author names actually present in the scrolled records.
     * @return array{requested: bool, resolvedName: ?string, candidateText: ?string, ambiguous: ?array}
     */
    public static function resolvePersonFilter(string $question, array $realNames): array
    {
        $candidates = [];
        if (preg_match_all('/\b([A-Z][\p{L}\'-]+(?:\s+[A-Z][\p{L}\'-]+){1,2})\b/u', $question, $m)) {
            foreach ($m[1] as $raw) {
                $c = self::trimCandidate($raw);
                if ($c && !self::isAllStopwords($c)) {
                    $candidates[] = $c;
                }
            }
        }
        // Bare single-name fallback ("does Ankush have...") — a lone first name has no adjacent
        // capitalized word for the 2-3-word regex above to include.
        if (preg_match_all('/\b([A-Z][\p{L}\'-]+)\b/u', $question, $m1)) {
            foreach ($m1[1] as $raw) {
                $c = self::trimCandidate($raw);
                if (!$c || in_array(strtolower($c), self::NAME_STOPWORDS, true)) {
                    continue;
                }
                $alreadyCovered = false;
                foreach ($candidates as $existing) {
                    if (stripos($existing, $c) !== false) {
                        $alreadyCovered = true;
                        break;
                    }
                }
                if (!$alreadyCovered) {
                    $candidates[] = $c;
                }
            }
        }

        if (!$candidates) {
            return ['requested' => false, 'resolvedName' => null, 'candidateText' => null, 'ambiguous' => null];
        }

        $lowerToReal = [];
        foreach ($realNames as $n) {
            $lowerToReal[strtolower($n)] = $n;
        }

        foreach ($candidates as $c) {
            if (isset($lowerToReal[strtolower($c)])) {
                return ['requested' => true, 'resolvedName' => $lowerToReal[strtolower($c)], 'candidateText' => $c, 'ambiguous' => null];
            }
        }

        // No exact match — try a looser one (every word of the candidate appears in some real
        // name), e.g. a bare first name. Collect EVERY distinct real person a candidate loosely
        // matches; 2+ is genuine ambiguity, never silently resolved to "the first one".
        foreach ($candidates as $c) {
            $cWords = array_values(array_filter(explode(' ', strtolower($c))));
            $matches = [];
            foreach ($lowerToReal as $lower => $real) {
                $allWordsPresent = true;
                foreach ($cWords as $w) {
                    if (!str_contains($lower, $w)) {
                        $allWordsPresent = false;
                        break;
                    }
                }
                if ($allWordsPresent) {
                    $matches[] = $real;
                }
            }
            $matches = array_values(array_unique($matches));
            if (count($matches) === 1) {
                return ['requested' => true, 'resolvedName' => $matches[0], 'candidateText' => $c, 'ambiguous' => null];
            }
            if (count($matches) > 1) {
                return ['requested' => true, 'resolvedName' => null, 'candidateText' => $c, 'ambiguous' => $matches];
            }
        }

        return ['requested' => true, 'resolvedName' => null, 'candidateText' => $candidates[0], 'ambiguous' => null];
    }

    /** Real names actually present in a set of already-fetched records for one type — reuses data
     *  the caller fetched anyway instead of a separate Qdrant round-trip just to build a name pool. */
    public static function collectRealNames(array $items, string $entityType): array
    {
        $field = self::personField($entityType);
        if (!$field) {
            return [];
        }
        $names = [];
        foreach ($items as $item) {
            $raw = trim((string) ($item[$field] ?? ''));
            if ($raw === '') {
                continue;
            }
            // `owner` can be a comma-joined multi-owner string on co-owned tasks — split into
            // individual real people, same reasoning as the Node version's defaultOwnerNames().
            foreach (explode(',', $raw) as $single) {
                $single = trim($single);
                if ($single !== '') {
                    $names[$single] = true;
                }
            }
        }
        return array_keys($names);
    }

    public static function unresolvedPersonAnswer(string $candidateText): string
    {
        return "I couldn't confidently match \"$candidateText\" to a real person in the indexed " .
            "data, so I can't give a scoped answer. Try the exact name as it appears in the data.";
    }

    public static function ambiguousPersonAnswer(string $candidateText, array $matches): string
    {
        $lines = implode("\n", array_map(fn($m) => "- $m", $matches));
        return "\"$candidateText\" matches " . count($matches) . " different people in your data — " .
            "which one did you mean?\n\n$lines";
    }

    private static function pickDateField(string $entityType, string $question): string
    {
        $q = strtolower($question);
        if ($entityType === 'task' && str_contains($q, 'due')) {
            return 'dueDate';
        }
        if ($entityType === 'timeentry' && str_contains($q, 'logged')) {
            return 'timeDate';
        }
        if ($entityType === 'meeting') {
            return 'start';
        }
        return 'timestamp'; // Modified||Created — the only "when touched" field project/portfolio have.
    }

    /**
     * @return array{requested: bool, field: string, range: ?array{start:int,end:int}, sortDesc: bool, label: ?string}
     */
    public static function resolveDateFilter(string $question, string $entityType): array
    {
        $field = self::pickDateField($entityType, $question);
        $q = strtolower($question);

        if (preg_match('/\b(latest|newest|most recently updated|most recent|last updated)\b/', $q)) {
            return ['requested' => true, 'field' => $field, 'range' => null, 'sortDesc' => true, 'label' => 'most recent'];
        }

        $now = new DateTimeImmutable('today');
        $range = match (true) {
            str_contains($q, 'yesterday') => [
                $now->modify('-1 day')->getTimestamp(),
                $now->modify('-1 day')->setTime(23, 59, 59)->getTimestamp(),
                'yesterday',
            ],
            str_contains($q, 'tomorrow') => [
                $now->modify('+1 day')->getTimestamp(),
                $now->modify('+1 day')->setTime(23, 59, 59)->getTimestamp(),
                'tomorrow',
            ],
            str_contains($q, 'today') => [$now->getTimestamp(), $now->setTime(23, 59, 59)->getTimestamp(), 'today'],
            str_contains($q, 'last week') => self::weekRange($now, -1),
            str_contains($q, 'next week') => self::weekRange($now, 1),
            str_contains($q, 'this week') => self::weekRange($now, 0),
            str_contains($q, 'last month') => self::monthRange($now, -1),
            str_contains($q, 'next month') => self::monthRange($now, 1),
            str_contains($q, 'this month') => self::monthRange($now, 0),
            default => null,
        };

        if ($range === null && preg_match('/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\b/', $question, $m)) {
            // DD/MM/YYYY — this app's locale, never MM/DD (matches the Node version's own explicit
            // non-ambiguous parser; PHP's strtotime defaults to US month-first, which is wrong here).
            $d = DateTimeImmutable::createFromFormat('!d/m/Y', "{$m[1]}/{$m[2]}/{$m[3]}");
            if ($d) {
                $range = [$d->getTimestamp(), $d->setTime(23, 59, 59)->getTimestamp(), $d->format('Y-m-d')];
            }
        }

        if ($range === null) {
            return ['requested' => false, 'field' => $field, 'range' => null, 'sortDesc' => false, 'label' => null];
        }
        return [
            'requested' => true,
            'field' => $field,
            'range' => ['start' => $range[0], 'end' => $range[1]],
            'sortDesc' => false,
            'label' => $range[2],
        ];
    }

    private static function weekRange(DateTimeImmutable $now, int $weekOffset): array
    {
        // Explicit ISO day-of-week arithmetic — PHP's "monday this week" relative-modify string
        // is not reliable for this (confirmed live: it silently produced a far-too-wide range,
        // counting 102 of 152 total meetings as "last week"). N = 1 (Monday) .. 7 (Sunday).
        $isoDay = (int) $now->format('N');
        $monday = $now->modify('-' . ($isoDay - 1) . ' days')->modify($weekOffset * 7 . ' days');
        $sunday = $monday->modify('+6 days')->setTime(23, 59, 59);
        $label = $weekOffset === 0 ? 'this week' : ($weekOffset < 0 ? 'last week' : 'next week');
        return [$monday->getTimestamp(), $sunday->getTimestamp(), $label];
    }

    private static function monthRange(DateTimeImmutable $now, int $monthOffset): array
    {
        $first = $now->modify('first day of this month')->modify($monthOffset . ' month');
        $last = $first->modify('last day of this month')->setTime(23, 59, 59);
        $label = $monthOffset === 0 ? 'this month' : ($monthOffset < 0 ? 'last month' : 'next month');
        return [$first->getTimestamp(), $last->getTimestamp(), $label];
    }

    /**
     * The same business-record identity ingestion itself builds (site+list+item+type) — ported
     * from getBusinessEntityKey() in qdrantScroll.js, reading back the identity already assigned
     * at ingest time, not inventing a new one.
     */
    private static function businessEntityKey(array $payload): ?string
    {
        if (!empty($payload['sourceKey'])) {
            return $payload['sourceKey'];
        }
        if (isset($payload['sharePointItemId']) && !empty($payload['type'])) {
            return $payload['type'] . ':' . $payload['sharePointItemId'];
        }
        return null;
    }

    /**
     * A chunked record (mainly meeting transcripts — confirmed live: one meeting can be 15+ chunk
     * points, all carrying identical title/status/date metadata) must count/list as ONE record,
     * not once per chunk. Ported from dedupeBySource()/uniqueBusinessEntities() in qdrantScroll.js
     * — keeps the lowest chunkIndex per identity. Missing this was confirmed live to inflate a
     * "last week" meeting count from a real ~5 to 102.
     */
    private static function dedupeBySource(array $payloads): array
    {
        $bestByKey = [];
        $noIdentity = [];
        foreach ($payloads as $p) {
            $key = self::businessEntityKey($p);
            if ($key === null) {
                $noIdentity[] = $p;
                continue;
            }
            $existing = $bestByKey[$key] ?? null;
            if (!$existing || ($p['chunkIndex'] ?? 0) < ($existing['chunkIndex'] ?? 0)) {
                $bestByKey[$key] = $p;
            }
        }
        return array_merge($noIdentity, array_values($bestByKey));
    }

    /**
     * Applies person/status/overdue/date filters, THEN dedupes chunks to real records — same order
     * as applyStructuredFilters() in structuredFilters.js ("FILTER FIRST, then DEDUPE"): filtering
     * before deduping can't drop a real match (every chunk of a record carries the same metadata,
     * so any chunk surviving the filter proves the record matches), and deduping after guarantees
     * a record that survives counts exactly once regardless of which chunk happened to match.
     */
    public static function applyFilters(
        array $items,
        string $entityType,
        array $personFilter,
        array $statusFilter,
        bool $overdueRequested,
        array $dateFilter
    ): array {
        $out = $items;
        $personFieldName = self::personField($entityType);
        // A resolved person filter only applies to types that actually HAVE a person field (task/
        // project/portfolio/timeentry) — meeting has none (only a `participants` list). Skipping
        // here (not filtering at all) rather than filtering against a null field name, which would
        // silently compare every record's field to '' and wrongly report a confident "0" instead
        // of "not supported for this type".
        if ($personFilter['resolvedName'] !== null && $personFieldName !== null) {
            $field = $personFieldName;
            $target = $personFilter['resolvedName'];
            $out = array_values(array_filter($out, function ($i) use ($field, $target) {
                $raw = (string) ($i[$field] ?? '');
                foreach (explode(',', $raw) as $single) {
                    if (trim($single) === $target) {
                        return true;
                    }
                }
                return false;
            }));
        }
        if ($statusFilter['requested']) {
            $out = array_values(array_filter($out, fn($i) => self::statusMatches($i['status'] ?? null, $statusFilter['mode'])));
        }
        if ($overdueRequested) {
            $out = array_values(array_filter($out, fn($i) => self::isTaskOverdue($i)));
        }
        if ($dateFilter['requested'] && $dateFilter['range']) {
            $field = $dateFilter['field'];
            $start = $dateFilter['range']['start'];
            $end = $dateFilter['range']['end'];
            $out = array_values(array_filter($out, function ($i) use ($field, $start, $end) {
                $t = self::parseAppDate($i[$field] ?? null);
                return $t !== false && $t >= $start && $t <= $end;
            }));
        }
        return self::dedupeBySource($out);
    }

    public static function applySort(array $items, array $dateFilter): array
    {
        if (!$dateFilter['sortDesc']) {
            return $items;
        }
        $field = $dateFilter['field'];
        usort($items, function ($a, $b) use ($field) {
            $ta = self::parseAppDate($a[$field] ?? null) ?: 0;
            $tb = self::parseAppDate($b[$field] ?? null) ?: 0;
            return $tb - $ta;
        });
        return $items;
    }

    public static function buildScopeText(array $personFilter, array $statusFilter, bool $overdueRequested, array $dateFilter): string
    {
        $parts = [];
        if ($personFilter['resolvedName'] !== null) {
            $parts[] = "for {$personFilter['resolvedName']}";
        }
        if ($statusFilter['requested']) {
            $parts[] = "status: {$statusFilter['label']}";
        }
        if ($overdueRequested) {
            $parts[] = 'overdue';
        }
        if ($dateFilter['requested'] && $dateFilter['range']) {
            $parts[] = "{$dateFilter['field']} {$dateFilter['label']}";
        }
        return $parts ? ' (' . implode(', ', $parts) . ')' : '';
    }
}
