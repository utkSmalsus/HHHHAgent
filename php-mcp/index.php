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
require_once __DIR__ . '/lib/ContainerResolver.php';
require_once __DIR__ . '/lib/Prompts.php';

/**
 * Every tool handler here is declared `: string` and returns json_encode(...) directly — PHP's
 * strict_types then requires that call to actually produce a string. json_encode() returns `false`
 * instead when ANY string anywhere in the data isn't valid UTF-8, which throws a raw TypeError
 * ("Return value must be of type string, false returned") that aborts the whole request with no
 * useful error message. Confirmed live: a real meeting record ingested with a corrupted/invalid
 * UTF-8 byte sequence (likely from a Hindi/Devanagari transcript import) crashed
 * investigate_transcript_context outright whenever it ranked into that call's top matches — not a
 * rare edge case, roughly 2 of 3 real targeted lookups hit it in one live test. JSON_INVALID_UTF8_
 * SUBSTITUTE replaces the bad bytes with the standard U+FFFD replacement character instead of
 * failing the whole encode — the affected field reads slightly garbled instead of crashing the tool.
 * The real fix (re-ingesting that record with clean text) is a separate, later cleanup; this is the
 * safety net so one bad record can never take down every query that happens to match it.
 */
function jsonEncode($data): string
{
    return json_encode($data, JSON_PRETTY_PRINT | JSON_INVALID_UTF8_SUBSTITUTE);
}

// Only the fields ContainerResolver actually needs — requesting the full payload (including every
// portfolio/project's `text` blob) for ~3400 records was confirmed live to add several seconds on
// top of an already near-30s-limit request.
const CONTAINER_RESOLUTION_FIELDS = ['title', 'type', 'parentId', 'sharePointItemId', 'status', 'timestamp'];

// Every field StructuredFilters/ContainerResolver's filtering, sorting, deduping, and person/
// container matching actually reads — deliberately excludes `title`/`text`/display-only fields.
// Qdrant is a CLOUD instance (not local) here — confirmed live that fetching the FULL payload
// (with `text`) for count_records' worst case (14,833 tasks, no type filter) took 35s+ and
// regularly exceeded PHP's 30s execution limit; without `text` alone it dropped to ~17s. count_records
// never displays a record, so it never needs `title`/`text`/`projectName`/etc. at all.
const FILTER_FIELDS = [
    'type', 'sharePointItemId', 'sourceKey', 'chunkIndex', 'owner', 'authorName', 'status',
    'dueDate', 'timeDate', 'timestamp', 'start', 'projectId', 'portfolioId',
];
// list_records additionally needs to DISPLAY a record — every field its own output includes,
// except `text` (hydrated separately, see hydrateShownText(), only for the few rows actually shown).
const LIST_DISPLAY_FIELDS = ['title', 'projectName', 'portfolioName', 'hierarchyPath', 'timeHours'];

// Exactly the fields TextMatch::recordSearchText()/scoreRecordMatch()/compactRecord() read — unlike
// count_records/list_records this genuinely needs `text` (that's the whole evidence a report gets
// written from), so this can't be trimmed the same way; it only drops the OTHER, unused metadata
// (site/list ids, structureId, chunk bookkeeping, dueDate/timeDate/timeHours, etc.), which still
// meaningfully shrinks the transfer for a type like "meeting" where those extra fields multiply
// across thousands of records.
const INVESTIGATE_FIELDS = [
    'type', 'title', 'projectName', 'portfolioName', 'hierarchyPath', 'itemType',
    'taskId', 'taskCode', 'meetingId', 'authorName', 'status', 'timestamp', 'text', 'sharePointItemId',
];
// Confirmed live: a full-payload "meeting" scroll (real transcripts included) can be ~19MB and
// exceed both cURL's and PHP's default 30s limits — this handler is inherently heavier than a
// count/list call (it exists to read whole transcripts), so it gets a longer budget rather than
// being squeezed into the same window as a fast lookup.
const INVESTIGATE_TIMEOUT_SECONDS = 60;

/** Fetches `text` only for the small slice of records actually being returned to the caller —
 *  the expensive part of a full scroll is transferring every record's `text` blob over the network
 *  to a cloud Qdrant instance, which is wasted work for the thousands of rows filtered out before
 *  ever being shown. Merges by Qdrant's own point id (`_qid`, attached by scrollPayloads/
 *  fetchPayloadsByPointIds) rather than sharePointItemId, which has no payload index on this
 *  collection. */
function hydrateShownText(Qdrant $qdrant, array $shown): array
{
    if (!$shown) {
        return $shown;
    }
    $qids = array_column($shown, '_qid');
    $textByQid = [];
    foreach ($qdrant->fetchPayloadsByPointIds($qids, ['text']) as $p) {
        $textByQid[$p['_qid']] = $p['text'] ?? null;
    }
    return array_map(function ($item) use ($textByQid) {
        $item['text'] = $textByQid[$item['_qid'] ?? null] ?? null;
        return $item;
    }, $shown);
}

/** Fetched ONCE per request and shared by both resolvePersonFilterWithFallback() (to rule out a
 *  project name being mis-tried as a person) and the inline container resolution in each handler
 *  below — avoids a second ~2-5s scroll for the same data. Skipped entirely (empty array) when the
 *  question has no real content to name a container with — the vast majority of plain date/status/
 *  person questions ("how many meetings last week") reference no project at all, so paying for this
 *  scroll on every single count/list call was pure waste on top of an already tight time budget. */
function fetchContainerItems(Qdrant $qdrant, string $question): array
{
    if (!ContainerResolver::hasRealContentWords(ContainerResolver::sanitizeForEntityResolution($question))) {
        return [];
    }
    return $qdrant->scrollPayloads(['portfolio', 'project'], 30000, 2000, CONTAINER_RESOLUTION_FIELDS);
}

$config = require __DIR__ . '/config.php';

/**
 * This URL had no authentication at all until now — confirmed live that a plain curl request with
 * no credentials returned full task/meeting/project data. Checked BEFORE any tool is registered or
 * any request is dispatched, so a missing/wrong token never reaches real logic.
 *
 * Per the MCP spec's own Authorization Server Requests section, an access token SHOULD travel in
 * the `Authorization: Bearer <token>` header, never the URL query string (a URL is exactly what
 * gets pasted into connector configs, screenshotted, and shared — a token embedded in it leaks
 * right along with it) — used for every client that lets you set a custom header (Claude Code,
 * Codex). getallheaders()/apache_request_headers() is the fallback because some PHP-on-Apache
 * setups (confirmed a real risk on shared hosting like dogado) don't populate
 * $_SERVER['HTTP_AUTHORIZATION'] unless mod_rewrite is configured to pass it through explicitly.
 *
 * `?key=` query-param fallback exists ONLY because ChatGPT's custom-connector UI (confirmed live)
 * offers no way to attach a static header at all — its Authentication dropdown is OAuth / Mixed /
 * No Auth, nothing else. Accepted as a deliberate, narrower exception for that one client (with
 * "No Auth" selected there) rather than the primary method — still strictly better than the
 * no-auth-at-all state this replaces.
 *
 * Fails closed on a missing config['authToken'] (rejects every request) rather than silently
 * running open — a forgotten/misconfigured config.local.php on a fresh deploy must never be the
 * difference between "protected" and "wide open" without at least a clear, loud 401 (visible
 * immediately in any client's first request) as the signal something's missing.
 */
function checkAuth(array $config): void
{
    $expected = $config['authToken'] ?? null;

    $header = $_SERVER['HTTP_AUTHORIZATION']
        ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION']
        ?? null;
    if ($header === null && function_exists('getallheaders')) {
        foreach (getallheaders() as $name => $value) {
            if (strcasecmp($name, 'Authorization') === 0) {
                $header = $value;
                break;
            }
        }
    }

    $provided = null;
    if ($header !== null && preg_match('/^Bearer\s+(.+)$/i', trim($header), $m)) {
        $provided = $m[1];
    } elseif (isset($_GET['key'])) {
        $provided = $_GET['key'];
    }

    if ($expected === null || $provided === null || !hash_equals($expected, $provided)) {
        http_response_code(401);
        header('WWW-Authenticate: Bearer realm="hhhh-mcp"');
        header('Content-Type: application/json');
        echo json_encode(['error' => ['code' => -32001, 'message' => 'Unauthorized — missing or invalid Authorization: Bearer token']]);
        exit;
    }
}

checkAuth($config);

$qdrant = new Qdrant($config);
$sharepoint = new SharePoint($config);

const RECORD_TYPES = ['portfolio', 'project', 'task', 'meeting', 'timeentry'];
const LISTABLE_TYPES = ['portfolio', 'project', 'task', 'timeentry'];

/** Real owner/author names across one or more types, for person-filter validation. */
function collectRealNamesAcrossTypes(array $itemsByType, array $types): array
{
    $names = [];
    foreach ($types as $t) {
        foreach (StructuredFilters::collectRealNames($itemsByType[$t] ?? [], $t) as $n) {
            $names[$n] = true;
        }
    }
    return array_keys($names);
}

/**
 * Resolves the person filter against the (possibly container-narrowed) $itemsByType first — the
 * fast path, since that data was already fetched for counting/listing anyway. If that comes back
 * "unresolved" AND a container filter narrowed what was fetched, a REAL person can still fail this
 * incorrectly just because they happen to own nothing in that specific project/portfolio (confirmed
 * live: "how many tasks does Deepak Trivedi have in SPA" — a real, active person — wrongly blocked
 * as an unknown person, because the SPA-scoped task set alone didn't happen to include his name).
 * Falls back to a full, unscoped scroll of the same types ONLY in that specific case, to correctly
 * distinguish "real person, zero matches in this project" (should count as 0) from "not a real
 * person at all" (must fail closed) — the container-scoped $itemsByType stays authoritative for the
 * actual count either way, only the name-validation pool widens.
 * @return array{0: array, 1: ?string} [personFilter, blockedMessage-or-null]
 */
function resolvePersonFilterWithFallback(
    string $question,
    array $itemsByType,
    array $types,
    array $containerTitles,
    ?array $container,
    Qdrant $qdrant
): array {
    $names = collectRealNamesAcrossTypes($itemsByType, $types);
    $personFilter = StructuredFilters::resolvePersonFilter($question, $names, $containerTitles);
    if ($personFilter['ambiguous']) {
        return [$personFilter, StructuredFilters::ambiguousPersonAnswer($personFilter['candidateText'], $personFilter['ambiguous'])];
    }
    if ($personFilter['requested'] && !$personFilter['resolvedName'] && $container !== null) {
        $fullItemsByType = [];
        foreach ($types as $t) {
            $fullItemsByType[$t] = $qdrant->scrollPayloads([$t], 30000, 2000, FILTER_FIELDS);
        }
        $fullNames = collectRealNamesAcrossTypes($fullItemsByType, $types);
        $retry = StructuredFilters::resolvePersonFilter($question, $fullNames, $containerTitles);
        if (!$retry['ambiguous'] && ($retry['resolvedName'] || !$retry['requested'])) {
            return [$retry, null];
        }
    }
    if ($personFilter['requested'] && !$personFilter['resolvedName']) {
        return [$personFilter, StructuredFilters::unresolvedPersonAnswer($personFilter['candidateText'])];
    }
    return [$personFilter, null];
}

$mcp = new Mcp();

$mcp->registerTool(
    'count_records',
    [
        'description' =>
            'Use for EXACT counting questions scoped by type/person/status/overdue/date/project-or-' .
            'portfolio-NAME — e.g. "how many meetings happened last week", "how many tasks does ' .
            'Ankush Das have", "how many overdue tasks", "how many tasks in SPA". A named project/ ' .
            'portfolio is matched against real titles and its FULL descendant subtree (not just ' .
            'exact-title items) — this does NOT apply to "meeting" (a meeting can span multiple ' .
            'projects, so it is silently excluded from a container-scoped multi-type count rather ' .
            'than shown unscoped). Never use semantic/vector search for counting. The returned ' .
            '"count" is exact — report it verbatim. Never recompute, round, or substitute a ' .
            'different number from memory or a separate estimate — a wrong reported count when the ' .
            'tool itself returned the right one is a reporting failure, not a data problem.',
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

        // Resolve the container BEFORE scrolling any type's items — a resolved container lets every
        // subsequent scroll go straight to the server-side-filtered (indexed) subtree instead of
        // transferring the WHOLE type's records over the network just to filter them out client-
        // side. Confirmed live: this cut "how many things are in SPA" (all 5 types, no container
        // filtering) from a guaranteed 30s+ timeout to a few seconds.
        $containerItems = fetchContainerItems($qdrant, $question);
        $containerTitles = array_column($containerItems, 'title');
        $candidateTexts = StructuredFilters::matchNameCandidates($question);
        $containerFilter = $containerItems
            ? ContainerResolver::resolveContainerFilter($question, $containerItems, $candidateTexts, null)
            : ['requested' => false, 'resolved' => null, 'ambiguous' => null, 'candidateText' => null];
        if ($containerFilter['ambiguous']) {
            return jsonEncode(['blocked' => true, 'message' => ContainerResolver::ambiguousContainerAnswer($containerFilter['ambiguous'])]);
        }
        $container = $containerFilter['resolved'];

        // A type with no single-project link (meeting) can't be scoped to a requested container —
        // showing its unconstrained total next to the correctly-scoped types would misread as if it
        // were also about that project. Omit it from a container-scoped multi-type count rather than
        // showing a number that has nothing to do with the question asked.
        $relevantTypes = $container
            ? array_values(array_filter($typesToCount, fn($t) => $t !== 'meeting'))
            : $typesToCount;

        // Fetch every relevant type's items once — resolving the person filter per-type
        // independently was confirmed live to wrongly BLOCK a whole multi-type count just because
        // the person owns no portfolios/projects (a normal, valid state, not "unresolved"): e.g.
        // "how many things does Ankush Das have" failed closed even though he clearly resolves fine
        // for task/timeentry alone. resolvePersonFilterWithFallback() below resolves ONCE against
        // the combined pool across all of them.
        $itemsByType = [];
        foreach ($relevantTypes as $t) {
            $itemsByType[$t] = $container
                ? $qdrant->scrollPayloadsInContainer($t, $container['descendantIds'], 30000, 2000, FILTER_FIELDS)
                : $qdrant->scrollPayloads([$t], 30000, 2000, FILTER_FIELDS);
        }

        [$personFilter, $personBlocked] = resolvePersonFilterWithFallback($question, $itemsByType, $relevantTypes, $containerTitles, $container, $qdrant);
        if ($personBlocked !== null) {
            return jsonEncode(['blocked' => true, 'message' => $personBlocked]);
        }
        if ($containerFilter['requested'] && !$container) {
            return jsonEncode(['blocked' => true, 'message' => ContainerResolver::unresolvedContainerAnswer($containerFilter['candidateText'])]);
        }

        // A type with no person field (meeting) can't be scoped to the requested person either —
        // same reasoning as the container exclusion above, narrowing further.
        if ($personFilter['resolvedName'] !== null) {
            $relevantTypes = array_values(array_filter($relevantTypes, fn($t) => StructuredFilters::personField($t) !== null));
        }

        $counts = [];
        foreach ($relevantTypes as $t) {
            $dateFilter = StructuredFilters::resolveDateFilter($question, $t);
            $filtered = StructuredFilters::applyFilters($itemsByType[$t], $t, $personFilter, $statusFilter, $overdueRequested, $dateFilter);
            $counts[] = ['type' => $t, 'count' => count($filtered)];
        }
        $scope = count($typesToCount) === 1
            ? StructuredFilters::buildScopeText($personFilter, $statusFilter, $overdueRequested, StructuredFilters::resolveDateFilter($question, $typesToCount[0]))
            : StructuredFilters::buildScopeText($personFilter, $statusFilter, $overdueRequested, ['requested' => false, 'range' => null]);
        if ($container) {
            $scope = " in {$container['title']}" . $scope;
        }

        return jsonEncode(['counts' => $counts, 'scope' => $scope ?: null]);
    }
);

$mcp->registerTool(
    'list_records',
    [
        'description' =>
            'Use for filtered/date-scoped LIST questions by type/person/status/overdue/date/project-' .
            'or-portfolio-NAME — e.g. "which tasks are due this week", "time entries logged by ' .
            'Ankush Das today", "latest 5 projects", "tasks in SPA". A named project/portfolio is ' .
            'matched against real titles and its full descendant subtree; for timeentry this only ' .
            'catches entries whose linked task itself resolved to a project/portfolio at ingest time ' .
            '(not guaranteed for every entry). This does NOT do keyword/topic search on title or ' .
            'content (e.g. "tasks about the login bug") — never claim a topic match this tool did ' .
            'not actually filter on; a named PROJECT is a real structural filter, a described TOPIC ' .
            'is not the same thing. Never use semantic/vector search for this. Every field in the ' .
            'result (owner, projectName, portfolioName, status, dates) is the real value from ' .
            'SharePoint — quote it EXACTLY in your answer. Never paraphrase, shorten, or substitute a ' .
            'different-sounding project/portfolio/owner name.',
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

        // Resolve the container BEFORE scrolling $type's items — a resolved container lets the
        // scroll go straight to the server-side-filtered (indexed) subtree instead of transferring
        // the WHOLE type's records over the network just to filter them out client-side. Confirmed
        // live: this cut "what tasks are in SPA" (14,833 tasks, unfiltered) from ~24s to low single
        // digits.
        $containerItems = fetchContainerItems($qdrant, $question);
        $candidateTexts = StructuredFilters::matchNameCandidates($question);
        $containerFilter = $containerItems
            ? ContainerResolver::resolveContainerFilter($question, $containerItems, $candidateTexts, null)
            : ['requested' => false, 'resolved' => null, 'ambiguous' => null, 'candidateText' => null];
        if ($containerFilter['ambiguous']) {
            return jsonEncode(['blocked' => true, 'message' => ContainerResolver::ambiguousContainerAnswer($containerFilter['ambiguous'])]);
        }
        $container = $containerFilter['resolved'];

        $fields = [...FILTER_FIELDS, ...LIST_DISPLAY_FIELDS];
        $items = $container
            ? $qdrant->scrollPayloadsInContainer($type, $container['descendantIds'], 30000, 2000, $fields)
            : $qdrant->scrollPayloads([$type], 30000, 2000, $fields);

        [$personFilter, $personBlocked] = resolvePersonFilterWithFallback($question, [$type => $items], [$type], array_column($containerItems, 'title'), $container, $qdrant);
        if ($personBlocked !== null) {
            return jsonEncode(['blocked' => true, 'message' => $personBlocked]);
        }
        if ($containerFilter['requested'] && !$container) {
            return jsonEncode(['blocked' => true, 'message' => ContainerResolver::unresolvedContainerAnswer($containerFilter['candidateText'])]);
        }

        $items = StructuredFilters::applyFilters($items, $type, $personFilter, $statusFilter, $overdueRequested, $dateFilter);
        $items = StructuredFilters::applySort($items, $dateFilter);

        $limit = (int) ($args['limit'] ?? ($dateFilter['sortDesc'] ? 1 : 30));
        $shown = hydrateShownText($qdrant, array_slice($items, 0, $limit));

        $scope = StructuredFilters::buildScopeText($personFilter, $statusFilter, $overdueRequested, $dateFilter);
        if ($container) {
            $scope = " in {$container['title']}" . $scope;
        }

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
            'scope' => $scope ?: null,
        ];
        return jsonEncode($result);
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
            return jsonEncode(['error' => 'SharePoint credentials not configured']);
        }
        return jsonEncode($result['items']);
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
            'to production SharePoint data — confirm with the user before calling this. If a new ' .
            'action item has no real project/portfolio suggestion (the report says "undetermined" ' .
            'for it), omit linkedProject entirely for that item — never pass {name: "undetermined"} ' .
            'or any other placeholder into a real SharePoint field.',
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
        return jsonEncode($result);
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
            'since every call here is already an exhaustive scan (no vector shortcut exists to skip). ' .
            'Every field in the returned evidence (owner, projectName, portfolioName, taskId) is the ' .
            'real value — quote it EXACTLY, never paraphrase or substitute a different-sounding name.',
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

        // This request gets more time than the shared 30s default — see INVESTIGATE_TIMEOUT_
        // SECONDS' own comment for why. Sized for THREE sequential scrolls (meeting, task,
        // portfolio+project) each up to INVESTIGATE_TIMEOUT_SECONDS, not just one — confirmed live
        // that budgeting for a single call's timeout here let the cumulative 3-scroll total blow
        // through it even though no single call actually failed. Harmless to other tools:
        // set_time_limit() only affects THIS request's remaining budget, not a global setting.
        set_time_limit(INVESTIGATE_TIMEOUT_SECONDS * 3 + 15);

        // pageSize=2000, not 4000 — confirmed live against this same cloud Qdrant instance, for an
        // equivalent full-payload scroll of a different large type, that a BIGGER page size
        // measured SLOWER (2000: ~15s, 5000: ~22s, 10000: ~23s), the opposite of what "fewer round
        // trips" would suggest — this collection's bottleneck is total transfer volume, not
        // per-request overhead, so 2000 is the shared safe default (see Qdrant.php's own comment).
        $meetings = TextMatch::rankByRelevance($query, $qdrant->scrollPayloads(['meeting'], 30000, 2000, INVESTIGATE_FIELDS, INVESTIGATE_TIMEOUT_SECONDS), 15);
        $tasks = TextMatch::rankByRelevance($query, $qdrant->scrollPayloads(['task'], 30000, 2000, INVESTIGATE_FIELDS, INVESTIGATE_TIMEOUT_SECONDS), 14);
        $containers = TextMatch::rankByRelevance($query, $qdrant->scrollPayloads(['portfolio', 'project'], 30000, 2000, INVESTIGATE_FIELDS, INVESTIGATE_TIMEOUT_SECONDS), 12);

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
        return jsonEncode($payload);
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
