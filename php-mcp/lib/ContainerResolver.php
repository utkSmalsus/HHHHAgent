<?php
declare(strict_types=1);

/**
 * Ported from src/services/structuralRetrieve.js's resolveContainerAnchor()/descendantContainerIds()
 * plus the container-fallback branch of resolveContainerFilter() in structuredFilters.js. This is
 * the piece StructuredFilters.php's own header comment flagged as "not ported — a bigger and riskier
 * port than name-matching against a flat list of real owners." Ported now because a real gap was
 * confirmed live: an external AI client connected to this server answered "what's happening in SPA"
 * from generic recent-activity guessing instead of a real project-scoped lookup, because this server
 * had no way to resolve "SPA" to a real project/portfolio and its descendant tree.
 *
 * No vector/semantic fallback here (unlike the Node app's structuralRetrieve()) — this server has no
 * embedding-model access (see TextMatch.php's own comment), so only the keyword-overlap resolver is
 * ported. That covers the common case (the user names the project/portfolio close to its real title)
 * and simply resolves to nothing for a purely-described-not-named reference, same as the Node app's
 * own fallback when its semantic search also fails to dominate.
 */
final class ContainerResolver
{
    // Same operator-vocabulary sanitization as structuralRetrieve.js's sanitizeForEntityResolution —
    // "logged"/"total" included per the same live-caught collision class (real container titles
    // "Not logged in message" and "SmartTime Total" were being anchored on by those bare words).
    private const TEMPORAL_VOCAB_RE = '/\b(updated|modified|created|latest|newest|recent|recently|due|logged|today|yesterday|tomorrow|last|next|week|weeks|month|months|day|days|year|years|quarter|quarters)\b/i';
    private const STATUS_VOCAB_RE = '/\b(overdue|past due|late|behind schedule|completed|done|finished|pending|in progress|working on it|active)\b/i';
    private const ENTITY_TYPE_VOCAB_RE = '/\b(portfolios?|projects?|tasks?|meetings?|time ?entr(?:y|ies)|timesheets?)\b/i';
    private const QUANTIFIER_VOCAB_RE = '/\b(total|count|number of)\b/i';
    private const BARE_NUMBER_RE = '/\b\d{3,}\b/';

    private const GENERIC_ENTITY_WORDS = [
        'team', 'management', 'system', 'systems', 'tool', 'tools', 'development', 'module', 'modules',
        'app', 'apps', 'application', 'applications', 'platform', 'component', 'components',
    ];
    private const GENERIC_WORD_WEIGHT = 0.3;

    private const GENERIC_SCAFFOLD_WORDS = [
        'what', 'is', 'are', 'was', 'were', 'the', 'a', 'an', 'most', 'any', 'all', 'some', 'new', 'top',
        'which', 'who', 'how', 'many', 'much', 'of', 'in', 'on', 'for', 'to', 'with', 'show', 'me', 'list',
        'does', 'have', 'has', 'had', 'happening', 'happened', 'happen', 'going', 'this', 'that', 'these',
        'those', 'there', 'been', 'and', 'did',
    ];

    private const CONTAINER_INDICATOR_RE = '/\b(project|projects|portfolio|portfolios|tool|tools|system|systems|module|component|components|app|application|dashboard|platform|suite|service|program)\b/i';

    private const TEMPORAL_INTENT_RE = '/\b(latest|newest|new|recent(?:ly)?|current(?:ly)?|today|yesterday|this week|last week|this month|last month|last updated|last modified|modified|updated|up[- ]?to[- ]?date|last few)\b/i';

    /** Strips operator vocabulary (temporal/status/entity-type/quantifier/bare-number) that names
     *  WHAT KIND of question this is, not WHICH real entity it's about. */
    public static function sanitizeForEntityResolution(string $question): string
    {
        $out = preg_replace(self::TEMPORAL_VOCAB_RE, ' ', $question) ?? $question;
        $out = preg_replace(self::STATUS_VOCAB_RE, ' ', $out) ?? $out;
        $out = preg_replace(self::ENTITY_TYPE_VOCAB_RE, ' ', $out) ?? $out;
        $out = preg_replace(self::QUANTIFIER_VOCAB_RE, ' ', $out) ?? $out;
        $out = preg_replace(self::BARE_NUMBER_RE, ' ', $out) ?? $out;
        return $out;
    }

    /** True once ANY non-scaffolding word remains — a purely operator/filler question has nothing
     *  real to entity-resolve at all. */
    public static function hasRealContentWords(string $sanitized): bool
    {
        preg_match_all('/[a-z]{3,}/', strtolower($sanitized), $m);
        foreach ($m[0] as $w) {
            if (!in_array($w, self::GENERIC_SCAFFOLD_WORDS, true)) {
                return true;
            }
        }
        return false;
    }

    /** True edit distance <= 1 — cheap enough not to need a library. */
    private static function withinOneEdit(string $a, string $b): bool
    {
        if ($a === $b) {
            return true;
        }
        $la = strlen($a);
        $lb = strlen($b);
        if (abs($la - $lb) > 1) {
            return false;
        }
        $i = 0;
        $j = 0;
        $edits = 0;
        while ($i < $la && $j < $lb) {
            if ($a[$i] === $b[$j]) {
                $i++;
                $j++;
                continue;
            }
            if (++$edits > 1) {
                return false;
            }
            if ($la === $lb) {
                $i++;
                $j++;
            } elseif ($la > $lb) {
                $i++;
            } else {
                $j++;
            }
        }
        return $edits + ($la - $i) + ($lb - $j) <= 1;
    }

    /** Generic words are downweighted so ONE coincidental overlap can't win a match — fuzzy-matched
     *  (edit distance <= 1) too, so a misspelling of generic vocabulary still counts as generic. */
    private static function isGenericWord(string $w): bool
    {
        if (in_array($w, self::GENERIC_ENTITY_WORDS, true)) {
            return true;
        }
        if (strlen($w) < 6) {
            return false;
        }
        foreach (self::GENERIC_ENTITY_WORDS as $g) {
            if (strlen($g) >= 6 && self::withinOneEdit($w, $g)) {
                return true;
            }
        }
        return false;
    }

    public static function hasNonGenericTitleOverlap(string $sanitizedQuestion, string $title): bool
    {
        $qWords = TextMatch::extractKeywords($sanitizedQuestion);
        $titleWords = TextMatch::queryTokens($title);
        $matched = array_values(array_intersect($qWords, $titleWords));
        if (count($matched) >= 2) {
            return true;
        }
        foreach ($matched as $w) {
            if (!self::isGenericWord($w)) {
                return true;
            }
        }
        return false;
    }

    public static function hasTemporalIntent(string $question): bool
    {
        return (bool) preg_match(self::TEMPORAL_INTENT_RE, $question);
    }

    /** Timestamp field differs by record: containers use `timestamp`, meetings use `start` — never
     *  relevant for containers here, but kept generic to mirror tsOf() in disambiguate.js exactly. */
    private static function tsOf(array $p): int
    {
        $raw = $p['timestamp'] ?? $p['start'] ?? null;
        if (!$raw) {
            return 0;
        }
        $t = strtotime((string) $raw);
        return $t !== false ? $t : 0;
    }

    /** Group items into "the same real thing" buckets by normalized display title. */
    private static function groupByEntity(array $items): array
    {
        $groups = [];
        $order = [];
        foreach ($items as $item) {
            $key = TextMatch::normalizeText($item['title'] ?? '');
            if ($key === '') {
                continue;
            }
            if (!isset($groups[$key])) {
                $groups[$key] = ['title' => $item['title'] ?? '', 'items' => []];
                $order[] = $key;
            }
            $groups[$key]['items'][] = $item;
        }
        return array_map(fn($k) => $groups[$k], $order);
    }

    /** One representative candidate per group (its most recently updated item), newest first. */
    private static function toCandidates(array $groups, int $limit = 8): array
    {
        $candidates = array_map(function ($g) {
            $items = $g['items'];
            usort($items, fn($a, $b) => self::tsOf($b) <=> self::tsOf($a));
            $latest = $items[0];
            return [
                'title' => $g['title'],
                'type' => $latest['type'] ?? null,
                'hierarchyPath' => $latest['hierarchyPath'] ?? null,
                'timestamp' => $latest['timestamp'] ?? $latest['start'] ?? null,
                'count' => count($g['items']),
            ];
        }, $groups);
        usort($candidates, fn($a, $b) => self::tsOf($b) <=> self::tsOf($a));
        return array_slice($candidates, 0, $limit);
    }

    /** BFS descendant portfolio/project ids from $anchorId (inclusive). */
    public static function descendantContainerIds(int $anchorId, array $containerItems): array
    {
        $childrenOf = [];
        foreach ($containerItems as $p) {
            $par = (int) ($p['parentId'] ?? 0);
            if ($par <= 0) {
                continue;
            }
            $childrenOf[$par][] = $p;
        }
        $descendantIds = [$anchorId => true];
        $queue = [$anchorId];
        while ($queue) {
            $cur = array_shift($queue);
            foreach ($childrenOf[$cur] ?? [] as $child) {
                $cid = (int) ($child['sharePointItemId'] ?? 0);
                if ($cid > 0 && !isset($descendantIds[$cid])) {
                    $descendantIds[$cid] = true;
                    $queue[] = $cid;
                }
            }
        }
        return array_keys($descendantIds);
    }

    /**
     * Recency-aware resolution for temporal-intent questions ("latest X", "X updated yesterday").
     * $tied are candidates already tied on raw keyword-overlap score — real Modified/start
     * timestamps decide the winner among those still reasonably close on title precision (ratio).
     */
    private static function resolveByRecency(array $tied): array
    {
        $topRatio = max(array_column($tied, 'ratio'));
        $relevanceFloor = 0.65; // ponytail: same relative floor as structuralRetrieve.js, not tuned to one question.
        $qualified = array_values(array_filter($tied, fn($s) => $s['ratio'] >= $topRatio * $relevanceFloor));
        $pool = $qualified ?: $tied;

        $ranked = array_map(function ($s) {
            $items = $s['group']['items'];
            usort($items, fn($a, $b) => self::tsOf($b) <=> self::tsOf($a));
            $s['newest'] = $items[0];
            $s['ts'] = self::tsOf($items[0]);
            return $s;
        }, $pool);
        usort($ranked, fn($a, $b) => $b['ts'] <=> $a['ts']);

        return ['anchor' => $ranked[0]['newest']];
    }

    /**
     * Pick the real portfolio/project the question names, from the FULL real dataset — refuse to
     * guess when several genuinely distinct real entities tie for the best match.
     * @return array{anchor: ?array, ambiguous: ?bool, candidates: ?array}
     */
    public static function resolveContainerAnchor(string $question, array $containerItems): array
    {
        $sanitized = self::sanitizeForEntityResolution($question);
        if (!self::hasRealContentWords($sanitized)) {
            return ['anchor' => null];
        }
        $qWords = TextMatch::extractKeywords($sanitized);
        if (!$qWords) {
            return ['anchor' => null];
        }

        $weight = fn($w) => self::isGenericWord($w) ? self::GENERIC_WORD_WEIGHT : 1;
        $groups = self::groupByEntity($containerItems);

        $scored = [];
        foreach ($groups as $g) {
            $titleTokens = TextMatch::queryTokens($g['title']);
            $matched = array_values(array_intersect($qWords, $titleTokens));
            $score = array_sum(array_map($weight, $matched));
            $ratio = $titleTokens ? $score / count($titleTokens) : 0.0;
            $hasNonGenericMatch = count($matched) >= 2;
            if (!$hasNonGenericMatch) {
                foreach ($matched as $w) {
                    if (!self::isGenericWord($w)) {
                        $hasNonGenericMatch = true;
                        break;
                    }
                }
            }
            if ($score > 0) {
                $scored[] = ['group' => $g, 'score' => $score, 'ratio' => $ratio, 'hasNonGenericMatch' => $hasNonGenericMatch];
            }
        }
        if (!$scored) {
            return ['anchor' => null];
        }
        usort($scored, fn($a, $b) => $b['score'] <=> $a['score']);

        $topScore = $scored[0]['score'];
        $tied = array_values(array_filter($scored, fn($s) => abs($s['score'] - $topScore) < 1e-9));

        $anyNonGeneric = false;
        foreach ($tied as $s) {
            if ($s['hasNonGenericMatch']) {
                $anyNonGeneric = true;
                break;
            }
        }
        if (!$anyNonGeneric) {
            return ['anchor' => null];
        }

        if (count($tied) === 1) {
            $nearTieMargin = 0.8; // ponytail: runner-up within 80% of the winner's score counts as close; not tuned to one question.
            foreach ($scored as $s) {
                if ($s !== $tied[0] && $s['hasNonGenericMatch'] && $s['score'] >= $topScore * $nearTieMargin) {
                    $tied = [$tied[0], $s];
                    break;
                }
            }
        }

        if (count($tied) > 1) {
            $active = array_values(array_filter($tied, function ($s) {
                foreach ($s['group']['items'] as $i) {
                    if (!empty($i['status']) && $i['status'] !== 'Not Started') {
                        return true;
                    }
                }
                return false;
            }));
            if ($active && count($active) < count($tied)) {
                $tied = $active;
            }
        }

        if (count($tied) > 1) {
            $byId = [];
            foreach ($containerItems as $item) {
                $id = (int) ($item['sharePointItemId'] ?? 0);
                if ($id > 0 && !isset($byId[$id])) {
                    $byId[$id] = $item;
                }
            }
            $tiedIds = [];
            foreach ($tied as $s) {
                $id = (int) ($s['group']['items'][0]['sharePointItemId'] ?? 0);
                if ($id > 0) {
                    $tiedIds[$id] = true;
                }
            }
            $descendsFromAnotherTied = function (array $item) use ($byId, $tiedIds): bool {
                $seen = [];
                $parent = (int) ($item['parentId'] ?? 0);
                while ($parent > 0 && !isset($seen[$parent])) {
                    if (isset($tiedIds[$parent])) {
                        return true;
                    }
                    $seen[$parent] = true;
                    $parent = (int) ($byId[$parent]['parentId'] ?? 0);
                }
                return false;
            };
            $ancestors = array_values(array_filter($tied, fn($s) => !$descendsFromAnotherTied($s['group']['items'][0])));
            if ($ancestors && count($ancestors) < count($tied)) {
                $tied = $ancestors;
            }
        }

        if (count($tied) === 1) {
            return ['anchor' => $tied[0]['group']['items'][0]];
        }

        if (self::hasTemporalIntent($question)) {
            return self::resolveByRecency($tied);
        }

        $topRatio = max(array_column($tied, 'ratio'));
        $precise = array_values(array_filter($tied, fn($s) => $s['ratio'] === $topRatio));
        // A single top-ratio winner is only trustworthy as a silent, no-questions-asked resolution
        // when the match is a LARGE fraction of that title (a near-exact/short-title match, ratio
        // close to 1.0) — not merely "relatively better than the other tied candidate". Verified
        // live: bare "SPA" tied a real "...SPA (Sandbox) Environment" (ratio 0.25, a genuinely
        // different client's project) against the real "...Single Page Application (SPA)" (ratio
        // 0.143) — both ratios are low, so the higher of two weak ratios isn't decisive; silently
        // picking the shorter title hid that a second, equally real, differently-scoped entity
        // exists. Below this floor, fall through to the wantsType/ambiguous handling below.
        $preciseRatioFloor = 0.5;
        if (count($precise) === 1 && $topRatio >= $preciseRatioFloor) {
            return ['anchor' => $precise[0]['group']['items'][0]];
        }
        if (count($precise) > 1) {
            $tied = $precise;
        }

        $qNorm = TextMatch::normalizeText($question);
        $wantsType = null;
        if (str_contains($qNorm, ' portfolio') || str_ends_with($qNorm, 'portfolio')) {
            $wantsType = 'portfolio';
        } elseif (str_contains($qNorm, ' project') || str_ends_with($qNorm, 'project')) {
            $wantsType = 'project';
        }
        if ($wantsType) {
            $typeMatches = array_values(array_filter($tied, function ($s) use ($wantsType) {
                foreach ($s['group']['items'] as $i) {
                    if (($i['type'] ?? null) === $wantsType) {
                        return true;
                    }
                }
                return false;
            }));
            if (count($typeMatches) === 1) {
                return ['anchor' => $typeMatches[0]['group']['items'][0]];
            }
        }

        return ['anchor' => null, 'ambiguous' => true, 'candidates' => self::toCandidates(array_column($tied, 'group'))];
    }

    /**
     * @param string[] $candidateTexts capitalized 2-3-word phrases already found in the question
     *   (from StructuredFilters::matchNameCandidates) — reused rather than re-scanning, so container
     *   and person resolution never disagree on what counts as a "name-shaped phrase".
     * @return array{requested: bool, resolved: ?array, ambiguous: ?array, candidateText: ?string}
     */
    public static function resolveContainerFilter(
        string $question,
        array $containerItems,
        array $candidateTexts,
        ?string $personCandidateText = null
    ): array {
        if (!self::hasRealContentWords(self::sanitizeForEntityResolution($question))) {
            return ['requested' => false, 'resolved' => null, 'ambiguous' => null, 'candidateText' => null];
        }

        $primary = self::resolveContainerAnchor($question, $containerItems);

        if (!empty($primary['ambiguous'])) {
            return ['requested' => true, 'resolved' => null, 'ambiguous' => $primary['candidates'], 'candidateText' => null];
        }
        if ($primary['anchor']) {
            $anchorId = (int) ($primary['anchor']['sharePointItemId'] ?? 0);
            $descendantIds = $anchorId > 0 ? self::descendantContainerIds($anchorId, $containerItems) : [];
            return [
                'requested' => true,
                'resolved' => [
                    'id' => $anchorId ?: null,
                    'title' => $primary['anchor']['title'] ?? null,
                    'type' => $primary['anchor']['type'] ?? null,
                    'descendantIds' => $descendantIds,
                ],
                'ambiguous' => null,
                'candidateText' => null,
            ];
        }

        // Nothing with any real keyword overlap — distinguish "no container was referenced at all"
        // (proceed unscoped) from "a bogus/unknown project name WAS referenced" (fail closed), same
        // invariant as an unresolved person. Require a generic container/product noun in the
        // candidate phrase so a made-up PERSON name doesn't get claimed here instead.
        $candidates = array_values(array_filter(
            $candidateTexts,
            fn($c) => $c !== ''
                && strtolower($c) !== strtolower((string) $personCandidateText)
                && preg_match(self::CONTAINER_INDICATOR_RE, $c) === 1
        ));

        if (!$candidates) {
            return ['requested' => false, 'resolved' => null, 'ambiguous' => null, 'candidateText' => null];
        }
        return ['requested' => true, 'resolved' => null, 'ambiguous' => null, 'candidateText' => $candidates[0]];
    }

    public static function unresolvedContainerAnswer(string $candidateText): string
    {
        return "I couldn't confidently match \"$candidateText\" to a real project or portfolio in " .
            'the indexed data, so I can\'t give a scoped answer. Try the exact title as it appears in the data.';
    }

    public static function ambiguousContainerAnswer(array $candidates): string
    {
        $lines = implode("\n", array_map(function ($c) {
            $type = $c['type'] ? " ({$c['type']})" : '';
            $date = $c['timestamp'] ? ' — updated ' . substr((string) $c['timestamp'], 0, 10) : '';
            return "- **{$c['title']}**{$type}{$date}";
        }, $candidates));
        return 'That matches ' . count($candidates) . " different items in your data — which one did you mean?\n\n$lines";
    }
}
