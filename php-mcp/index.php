<?php
declare(strict_types=1);

// PHP's date.timezone defaults to UTC when unset — confirmed live that dogado's shared hosting
// (and this Mac's local PHP CLI) both silently do exactly that. Every "today"/"yesterday"/"this
// week" filter in StructuredFilters.php uses DateTimeImmutable('today'), which is UTC midnight,
// not this organization's actual IST work day — for roughly 5.5 hours after real IST midnight
// (00:00-05:30 IST), "today" would still resolve to yesterday's UTC date. Set explicitly rather
// than relying on the host's default, which is not guaranteed and already proven wrong once.
date_default_timezone_set('Asia/Kolkata');

require_once __DIR__ . '/lib/Mcp.php';
require_once __DIR__ . '/lib/Qdrant.php';
require_once __DIR__ . '/lib/SharePoint.php';
require_once __DIR__ . '/lib/StructuredFilters.php';
require_once __DIR__ . '/lib/TextMatch.php';
require_once __DIR__ . '/lib/Prompts.php';

$config = require __DIR__ . '/config.php';
$qdrant = new Qdrant($config);
$sharepoint = new SharePoint($config);

const RECORD_TYPES = ['portfolio', 'project', 'task', 'meeting', 'timeentry'];
const LISTABLE_TYPES = ['portfolio', 'project', 'task', 'timeentry'];

/** Resolves the person filter and returns a blocked-response array if it's ambiguous/unresolved —
 *  same fail-closed principle as the Node app: a named person who doesn't resolve must never
 *  silently fall through to an unscoped answer. */
function resolveOrBlockPerson(string $question, array $items, string $entityType): array
{
    $realNames = StructuredFilters::collectRealNames($items, $entityType);
    $personFilter = StructuredFilters::resolvePersonFilter($question, $realNames);
    if ($personFilter['ambiguous']) {
        return [null, StructuredFilters::ambiguousPersonAnswer($personFilter['candidateText'], $personFilter['ambiguous'])];
    }
    if ($personFilter['requested'] && !$personFilter['resolvedName']) {
        return [null, StructuredFilters::unresolvedPersonAnswer($personFilter['candidateText'])];
    }
    return [$personFilter, null];
}

$mcp = new Mcp();

$mcp->registerTool(
    'count_records',
    [
        'description' =>
            'Use for EXACT counting questions scoped by type/person/status/overdue/date — e.g. ' .
            '"how many meetings happened last week", "how many tasks does Ankush Das have", "how ' .
            'many overdue tasks". Does NOT support scoping by a project/portfolio NAME (e.g. "tasks ' .
            'in Team Management Tools") — say so rather than silently answering unscoped for that. ' .
            'Never use semantic/vector search for counting.',
        'inputSchema' => [
            'type' => 'object',
            'properties' => [
                'question' => ['type' => 'string', 'description' => 'e.g. "how many meetings happened last week"'],
                'type' => ['type' => 'string', 'enum' => RECORD_TYPES, 'description' => 'Optional: restrict to one record type. Omit to count every type.'],
            ],
            'required' => ['question'],
        ],
    ],
    function (array $args) use ($qdrant): string {
        $question = $args['question'] ?? '';
        if (!$question) {
            throw new RuntimeException('question is required');
        }
        $type = $args['type'] ?? null;
        if ($type && !in_array($type, RECORD_TYPES, true)) {
            throw new RuntimeException('type must be one of: ' . implode(', ', RECORD_TYPES));
        }
        $typesToCount = $type ? [$type] : RECORD_TYPES;

        $statusFilter = StructuredFilters::resolveStatusFilter($question);
        $overdueRequested = StructuredFilters::isOverdueRequested($question);

        // Fetch every type's items once, and resolve the person filter ONCE against the combined
        // name pool across all of them — resolving per-type independently was confirmed live to
        // wrongly BLOCK a whole multi-type count just because the person owns no portfolios/
        // projects (a normal, valid state, not "unresolved"): e.g. "how many things does Ankush
        // Das have" failed closed even though he clearly resolves fine for task/timeentry alone.
        $itemsByType = [];
        $combinedNames = [];
        foreach ($typesToCount as $t) {
            $itemsByType[$t] = $qdrant->scrollPayloads([$t]);
            foreach (StructuredFilters::collectRealNames($itemsByType[$t], $t) as $n) {
                $combinedNames[$n] = true;
            }
        }
        $personFilter = StructuredFilters::resolvePersonFilter($question, array_keys($combinedNames));
        if ($personFilter['ambiguous']) {
            return json_encode(['blocked' => true, 'message' => StructuredFilters::ambiguousPersonAnswer($personFilter['candidateText'], $personFilter['ambiguous'])], JSON_PRETTY_PRINT);
        }
        if ($personFilter['requested'] && !$personFilter['resolvedName']) {
            return json_encode(['blocked' => true, 'message' => StructuredFilters::unresolvedPersonAnswer($personFilter['candidateText'])], JSON_PRETTY_PRINT);
        }

        // A type with no person field at all (meeting) can't be scoped to the requested person —
        // showing its unconstrained total next to the correctly-scoped types would misread as if
        // it were also about that person. Omit it from a person-scoped multi-type count rather
        // than showing a number that has nothing to do with the question asked.
        $relevantTypes = $personFilter['resolvedName'] !== null
            ? array_values(array_filter($typesToCount, fn($t) => StructuredFilters::personField($t) !== null))
            : $typesToCount;

        $counts = [];
        foreach ($relevantTypes as $t) {
            $dateFilter = StructuredFilters::resolveDateFilter($question, $t);
            $filtered = StructuredFilters::applyFilters($itemsByType[$t], $t, $personFilter, $statusFilter, $overdueRequested, $dateFilter);
            $counts[] = ['type' => $t, 'count' => count($filtered)];
        }
        $scope = count($typesToCount) === 1
            ? StructuredFilters::buildScopeText($personFilter, $statusFilter, $overdueRequested, StructuredFilters::resolveDateFilter($question, $typesToCount[0]))
            : StructuredFilters::buildScopeText($personFilter, $statusFilter, $overdueRequested, ['requested' => false, 'range' => null]);

        return json_encode(['counts' => $counts, 'scope' => $scope ?: null], JSON_PRETTY_PRINT);
    }
);

$mcp->registerTool(
    'list_records',
    [
        'description' =>
            'Use for filtered/date-scoped LIST questions by type/person/status/overdue/date — e.g. ' .
            '"which tasks are due this week", "time entries logged by Ankush Das today", "latest 5 ' .
            'projects". Does NOT support scoping by a project/portfolio NAME, and does NOT do ' .
            'keyword/topic search on title or content (e.g. "tasks about SPA") — never claim a topic ' .
            'match this tool did not actually filter on. Never use semantic/vector search for this.',
        'inputSchema' => [
            'type' => 'object',
            'properties' => [
                'type' => ['type' => 'string', 'enum' => LISTABLE_TYPES],
                'question' => ['type' => 'string'],
                'limit' => ['type' => 'number', 'description' => 'Max records to return (default 30, or 1 for a "latest" query)'],
            ],
            'required' => ['type', 'question'],
        ],
    ],
    function (array $args) use ($qdrant): string {
        $type = $args['type'] ?? null;
        if (!$type || !in_array($type, LISTABLE_TYPES, true)) {
            throw new RuntimeException('type must be one of: ' . implode(', ', LISTABLE_TYPES));
        }
        $question = $args['question'] ?? '';
        if (!$question) {
            throw new RuntimeException('question is required');
        }

        $statusFilter = StructuredFilters::resolveStatusFilter($question);
        $overdueRequested = StructuredFilters::isOverdueRequested($question);
        $dateFilter = StructuredFilters::resolveDateFilter($question, $type);

        $items = $qdrant->scrollPayloads([$type]);
        [$personFilter, $blocked] = resolveOrBlockPerson($question, $items, $type);
        if ($blocked !== null) {
            return json_encode(['blocked' => true, 'message' => $blocked], JSON_PRETTY_PRINT);
        }

        $items = StructuredFilters::applyFilters($items, $type, $personFilter, $statusFilter, $overdueRequested, $dateFilter);
        $items = StructuredFilters::applySort($items, $dateFilter);

        $limit = (int) ($args['limit'] ?? ($dateFilter['sortDesc'] ? 1 : 30));
        $shown = array_slice($items, 0, $limit);

        $result = [
            'totalMatched' => count($items),
            'shown' => array_map(fn($p) => [
                'title' => $p['title'] ?? null,
                'status' => $p['status'] ?? null,
                'owner' => $p['owner'] ?? null,
                'authorName' => $p['authorName'] ?? null,
                'timeHours' => $p['timeHours'] ?? null,
                'timeDate' => $p['timeDate'] ?? null,
                'projectName' => $p['projectName'] ?? null,
                'portfolioName' => $p['portfolioName'] ?? null,
                'hierarchyPath' => $p['hierarchyPath'] ?? null,
                'dueDate' => $p['dueDate'] ?? null,
                'timestamp' => $p['timestamp'] ?? null,
                'text' => $p['text'] ?? null,
            ], $shown),
            'scope' => StructuredFilters::buildScopeText($personFilter, $statusFilter, $overdueRequested, $dateFilter) ?: null,
        ];
        return json_encode($result, JSON_PRETTY_PRINT);
    }
);

$mcp->registerTool(
    'find_recent_meetings',
    [
        'description' =>
            'Use this to find the REAL SharePoint meeting item id before writing any AI report back ' .
            'to it — e.g. when the user says "the latest meeting". Queries SharePoint LIVE, so it ' .
            'sees a meeting created moments ago.',
        'inputSchema' => [
            'type' => 'object',
            'properties' => [
                'limit' => ['type' => 'number', 'description' => 'How many recent meetings to return (default 10)'],
            ],
        ],
    ],
    function (array $args) use ($sharepoint): string {
        $result = $sharepoint->fetchRecentMeetings((int) ($args['limit'] ?? 10));
        if (!$result['configured']) {
            return json_encode(['error' => 'SharePoint credentials not configured'], JSON_PRETTY_PRINT);
        }
        return json_encode($result['items'], JSON_PRETTY_PRINT);
    }
);

$mcp->registerTool(
    'save_report_to_meeting',
    [
        'description' =>
            'Writes a Project Intelligence Report back onto a REAL SharePoint meeting item, ' .
            'confirmed by the user or found via find_recent_meetings — never guess the meetingId. ' .
            'summary sets AISummary; newActionItems appends entries with status "Pending Review" ' .
            '(a human must still approve them); existingTaskMatches appends entries with status ' .
            '"Task Created" and the real omtTaskId. Does NOT touch the meeting\'s Tasks lookup ' .
            'column (owned by an existing Power Automate flow). This performs a REAL, VISIBLE write ' .
            'to production SharePoint data — confirm with the user before calling this.',
        'inputSchema' => [
            'type' => 'object',
            'properties' => [
                'meetingId' => ['type' => 'string'],
                'summary' => ['type' => 'string'],
                'newActionItems' => ['type' => 'array', 'items' => ['type' => 'object']],
                'existingTaskMatches' => ['type' => 'array', 'items' => ['type' => 'object']],
            ],
            'required' => ['meetingId'],
        ],
    ],
    function (array $args) use ($sharepoint): string {
        $meetingId = $args['meetingId'] ?? '';
        if (!$meetingId) {
            throw new RuntimeException('meetingId is required');
        }
        $result = $sharepoint->saveReportToMeeting(
            $meetingId,
            $args['summary'] ?? null,
            $args['newActionItems'] ?? [],
            $args['existingTaskMatches'] ?? []
        );
        return json_encode($result, JSON_PRETTY_PRINT);
    }
);

$mcp->registerTool(
    'investigate_transcript_context',
    [
        'description' =>
            'Call this ONCE, right after start_project_intelligence_report, to gather investigation ' .
            'evidence: related past meetings, related existing tasks, and related projects/portfolios. ' .
            'IMPORTANT: this server has no embedding-model access (dogado cannot reach Ollama), so this ' .
            'is KEYWORD/TEXT matching only, not semantic search — it scans every record and ranks by ' .
            'keyword/BM25 overlap with the transcript. A related record worded very differently from the ' .
            'transcript (different words, same meaning) may not surface here. There is only one mode — ' .
            'unlike the local Node MCP server, there is no faster "quick" option to trade off against, ' .
            'since every call here is already an exhaustive scan (no vector shortcut exists to skip).',
        'inputSchema' => [
            'type' => 'object',
            'properties' => [
                'transcript' => ['type' => 'string', 'description' => 'Full plain-text content of the meeting transcript'],
            ],
            'required' => ['transcript'],
        ],
    ],
    function (array $args) use ($qdrant): string {
        $transcript = $args['transcript'] ?? '';
        if (!$transcript) {
            throw new RuntimeException('transcript is required');
        }
        // No character truncation — a transcript's relevant topic can be discussed anywhere in
        // it, not just its start. Cost is bounded instead by TextMatch::queryTokens' unique-
        // vocabulary cap (see its own comment), which stays small even for a long transcript.
        $query = $transcript;

        // pageSize=4000 (vs. the shared 2000 default) — confirmed safe specifically for THIS
        // handler's own memory profile (no per-type accumulation like count_records has); see
        // Qdrant::scrollPayloads' own comment before changing this.
        $meetings = TextMatch::rankByRelevance($query, $qdrant->scrollPayloads(['meeting'], 30000, 4000), 15);
        $tasks = TextMatch::rankByRelevance($query, $qdrant->scrollPayloads(['task'], 30000, 4000), 14);
        $containers = TextMatch::rankByRelevance($query, $qdrant->scrollPayloads(['portfolio', 'project'], 30000, 4000), 12);

        $format = fn(array $records) => $records
            ? implode("\n\n", array_map(fn($r, $i) => TextMatch::compactRecord($r, $i), $records, array_keys($records)))
            : 'None found.';

        $payload = [
            'relatedPastMeetings' => $format($meetings),
            'relatedExistingTasks' => $format($tasks),
            'relatedProjectsPortfolios' => $format($containers),
            'counts' => [
                'meetings' => count($meetings),
                'tasks' => count($tasks),
                'containers' => count($containers),
            ],
        ];
        return json_encode($payload, JSON_PRETTY_PRINT);
    }
);

$mcp->registerTool(
    'start_project_intelligence_report',
    [
        'description' =>
            'DEFAULT tool for any meeting transcript. Call this FIRST, before anything else, whenever ' .
            'the user shares, pastes, or uploads a meeting transcript with ANY request to look at it. ' .
            'It does not call an LLM itself — it returns your own investigation instructions: call ' .
            'investigate_transcript_context ONCE, then write a 7-section Project Intelligence Report — ' .
            'never a plain transcript summary.',
        'inputSchema' => [
            'type' => 'object',
            'properties' => [
                'transcript' => ['type' => 'string', 'description' => 'Full plain-text content of the meeting transcript'],
            ],
            'required' => ['transcript'],
        ],
    ],
    function (array $args): string {
        $transcript = $args['transcript'] ?? '';
        if (!$transcript) {
            throw new RuntimeException('transcript is required');
        }
        return Prompts::projectIntelligenceReport($transcript);
    }
);

$mcp->handleRequest();
