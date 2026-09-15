<?php
declare(strict_types=1);

require_once __DIR__ . '/Http.php';

/**
 * Ported from HHHHAgent's src/services/sharepoint.js (fetchRecentMeetings, saveReportToMeeting) —
 * same Graph endpoints, same field shapes, same "Tasks lookup is Power-Automate-owned, never
 * write it" and "new items are Pending Review, not Approved" rules confirmed against real data.
 * No in-memory token cache — each PHP request is its own process on typical shared hosting, so a
 * cache would never survive between requests anyway. One fresh client-credentials token per
 * request is a few hundred ms; fine for this tool's traffic. Add a filesystem/APCu token cache
 * later only if that overhead is ever actually a measured problem.
 */
final class SharePoint
{
    private array $config;

    public function __construct(array $config)
    {
        $this->config = $config['sharepoint'];
    }

    public function getAccessToken(): ?string
    {
        $tenantId = $this->config['tenantId'];
        $clientId = $this->config['clientId'];
        $clientSecret = $this->config['clientSecret'];
        if (!$tenantId || !$clientId || !$clientSecret) {
            return null;
        }

        $url = "https://login.microsoftonline.com/$tenantId/oauth2/v2.0/token";
        $res = Http::postForm($url, [], [
            'client_id' => $clientId,
            'client_secret' => $clientSecret,
            'scope' => 'https://graph.microsoft.com/.default',
            'grant_type' => 'client_credentials',
        ]);
        if ($res['status'] !== 200) {
            throw new RuntimeException("SharePoint auth failed: {$res['status']}");
        }
        return $res['body']['access_token'];
    }

    /** @return array{items: array<int, array>, configured: bool} */
    public function fetchRecentMeetings(int $limit = 10): array
    {
        $token = $this->getAccessToken();
        if (!$token) {
            return ['items' => [], 'configured' => false];
        }

        $siteId = $this->config['siteId'];
        $listId = $this->config['meetingsListId'];
        $url = "https://graph.microsoft.com/v1.0/sites/$siteId/lists/$listId/items?"
            . http_build_query(['$expand' => 'fields', '$top' => '200']);

        $res = Http::getJson($url, [
            'Authorization' => "Bearer $token",
            'Prefer' => 'HonorNonIndexedQueriesWarningMayFailRandomly',
        ]);
        if ($res['status'] !== 200) {
            throw new RuntimeException("Graph meetings list failed: {$res['status']} " . substr($res['raw'], 0, 200));
        }

        $oneYearOut = time() + 365 * 24 * 60 * 60;
        $items = [];
        foreach (($res['body']['value'] ?? []) as $item) {
            $fields = $item['fields'] ?? [];
            $status = $fields['Status'] ?? null;
            $start = $fields['Start'] ?? null;
            // Unscheduled "Follow-up: ..." placeholder stubs carry a sentinel far-future Start
            // (2099-12-31) — same real-data quirk confirmed against the live Meetings list.
            $isPlaceholder = ($status && stripos($status, 'unscheduled') !== false)
                || ($start && strtotime($start) > $oneYearOut);
            if ($isPlaceholder) {
                continue;
            }
            $items[] = [
                'id' => $item['id'],
                'title' => $fields['Title'] ?? 'Untitled',
                'start' => $start,
                'end' => $fields['End'] ?? null,
                'status' => $status,
                'meetingType' => $fields['MeetingType'] ?? null,
            ];
        }
        usort($items, fn($a, $b) => strtotime($b['start'] ?? '1970-01-01') - strtotime($a['start'] ?? '1970-01-01'));
        return ['items' => array_slice($items, 0, $limit), 'configured' => true];
    }

    private function getMeetingItemFields(string $meetingId, array $selectFields): array
    {
        $token = $this->getAccessToken();
        if (!$token) {
            throw new RuntimeException('SharePoint credentials not configured');
        }
        $siteId = $this->config['siteId'];
        $listId = $this->config['meetingsListId'];
        $select = $selectFields ? '?' . http_build_query(['$select' => implode(',', $selectFields)]) : '';
        $url = "https://graph.microsoft.com/v1.0/sites/$siteId/lists/$listId/items/$meetingId/fields$select";
        $res = Http::getJson($url, ['Authorization' => "Bearer $token"]);
        if ($res['status'] !== 200) {
            throw new RuntimeException("Graph get meeting fields failed: {$res['status']} " . substr($res['raw'], 0, 300));
        }
        return $res['body'];
    }

    private function patchMeetingItemFields(string $meetingId, array $fields): array
    {
        $token = $this->getAccessToken();
        if (!$token) {
            throw new RuntimeException('SharePoint credentials not configured');
        }
        $siteId = $this->config['siteId'];
        $listId = $this->config['meetingsListId'];
        $url = "https://graph.microsoft.com/v1.0/sites/$siteId/lists/$listId/items/$meetingId/fields";
        $res = Http::patchJson($url, ['Authorization' => "Bearer $token"], $fields);
        if ($res['status'] >= 300) {
            throw new RuntimeException("Graph update meeting failed: {$res['status']} " . substr($res['raw'], 0, 300));
        }
        return $res['body'];
    }

    /**
     * Deliberately does NOT touch the `Tasks` lookup column — that's owned by an existing Power
     * Automate flow that auto-links a "meeting task" on creation; overwriting it was confirmed
     * live (against the Node version) to destroy that flow's own linkage. "Already exists" is
     * represented as an ActionItemJSON entry with status "Task Created" + real omtTaskId instead,
     * same mechanism the sibling Meeting Tool app already uses for "From action item" rows.
     */
    public function saveReportToMeeting(string $meetingId, ?string $summary, array $newActionItems, array $existingTaskMatches): array
    {
        $results = [];

        if ($summary) {
            $this->patchMeetingItemFields($meetingId, ['AISummary' => $summary]);
            $results['summary'] = 'updated';
        }

        // Fail loudly on a malformed item instead of silently writing blank data to a real
        // SharePoint record. Confirmed live (meeting 211): a caller's tool call omitted/misnamed
        // these fields, and the old code's `?? ''` fallbacks let it "succeed" with 17 real
        // ActionItemJSON entries that all had empty description/assignedTo/omtTaskId — a much
        // worse outcome than a clear rejection the caller could immediately fix and retry.
        $requireField = function (array $item, string $field, int $index, string $listLabel) {
            if (empty($item[$field])) {
                // Deliberately concatenated, not "$listLabel[$index]" — that syntax means STRING
                // OFFSET ACCESS in a double-quoted PHP string (returns one character of
                // $listLabel), not "label" + "[index]"; confirmed live, it silently produced
                // "n is missing..." instead of "newActionItems[0] is missing...".
                throw new RuntimeException(
                    $listLabel . '[' . $index . '] is missing required field "' . $field . '" — ' .
                    'refusing to save a blank action item. Re-check the exact argument shape against the tool schema.'
                );
            }
        };
        foreach ($newActionItems as $i => $item) {
            $requireField($item, 'description', $i, 'newActionItems');
        }
        foreach ($existingTaskMatches as $i => $item) {
            $requireField($item, 'description', $i, 'existingTaskMatches');
            $requireField($item, 'omtTaskId', $i, 'existingTaskMatches');
        }

        // A model can literally write "undetermined" (or similar) as the suggested project/
        // portfolio NAME when no real match was found — confirmed live in a real generated report.
        // Correct as report TEXT, but must never land in a real SharePoint field as if it were an
        // actual project reference — strip it back to null rather than trust the caller followed
        // the "omit it instead" instruction in the tool description.
        $placeholderProjectNames = ['undetermined', 'unknown', 'unclear', 'n/a', 'na', 'none', 'tbd', 'not determined', 'not applicable', 'not found'];
        $sanitizeLinkedProject = function (?array $linkedProject) use ($placeholderProjectNames): ?array {
            if (!$linkedProject) {
                return null;
            }
            $name = strtolower(trim((string) ($linkedProject['name'] ?? '')));
            if ($name === '' || in_array($name, $placeholderProjectNames, true) || str_starts_with($name, 'undetermined')) {
                return null;
            }
            return $linkedProject;
        };

        $buildEntry = function (array $item, string $status, string $omtTaskId) use ($meetingId, $sanitizeLinkedProject) {
            return [
                'meetingId' => (string) $meetingId,
                'description' => $item['description'] ?? '',
                'taskDescription' => $item['taskDescription'] ?? '',
                'sectionId' => '',
                'sectionTopic' => $item['sectionTopic'] ?? '',
                'sectionSummary' => '',
                'owningTool' => $item['owningTool'] ?? '',
                'mentionedTools' => [],
                'discussionIntent' => '',
                'discussionContext' => $item['discussionContext'] ?? '',
                'projectHints' => $item['projectHints'] ?? [],
                'assignedTo' => $item['assignedTo'] ?? null,
                'linkedProject' => $sanitizeLinkedProject($item['linkedProject'] ?? null),
                'siteType' => 'HHHH',
                'taskType' => $item['taskType'] ?? 'Implementation',
                'priorityRank' => (string) ($item['priorityRank'] ?? '5'),
                'source' => 'AI-Extracted',
                'status' => $status,
                'id' => 'mcp-' . (int) (microtime(true) * 1000) . '-' . substr(bin2hex(random_bytes(4)), 0, 6),
                'dueDate' => $item['dueDate'] ?? '',
                'omtTaskId' => $omtTaskId,
            ];
        };

        if ($newActionItems || $existingTaskMatches) {
            $current = $this->getMeetingItemFields($meetingId, ['ActionItemJSON']);
            $existing = json_decode($current['ActionItemJSON'] ?? '[]', true) ?: [];

            // "Pending Review" (not "Approved") is the real app's own default for a fresh entry —
            // an AI suggestion isn't the same as a human approving it; this must not silently skip
            // that review gate.
            $builtNew = array_map(fn($item) => $buildEntry($item, 'Pending Review', ''), $newActionItems);
            $builtExisting = array_map(
                fn($item) => $buildEntry($item, 'Task Created', (string) $item['omtTaskId']),
                $existingTaskMatches
            );

            $this->patchMeetingItemFields($meetingId, [
                'ActionItemJSON' => json_encode(array_merge($existing, $builtNew, $builtExisting)),
            ]);
            $results['newActionItems'] = count($builtNew);
            $results['linkedExistingTasks'] = count($builtExisting);
        }

        return $results;
    }
}
