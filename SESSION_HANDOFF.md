# HHHH Agent — Session Handoff (paste this into a new Claude session)

## What this project is

`HHHH Agent` (repo: `HHHHAgent`, path `/Users/smalsus/office/Agent/HHHHAgent`) is a RAG-based
enterprise knowledge assistant over SharePoint project-management data (tasks, projects,
portfolios, meetings, time entries), indexed into Qdrant and served via a Node/Express backend
(`src/index.js`, main query endpoint `POST /api/query` in `src/routes/query.js`). Generation uses
a local Ollama model. There is a chat UI at `/api/query/ui`.

Data lives in the Qdrant collection **`enterprise_knowledge`** (production data, never to be
deleted/recreated/re-ingested without explicit instruction). Real counts as of this session:
task 14,181 unique business records (14,581 raw Qdrant points), project 746 (747), portfolio 2,666
(2,674), meeting 146 (2,463 — meetings are heavily chunked because of long transcripts), timeentry
6,142 (6,143). "Unique" vs "raw" matters a lot — see Phase 14 below.

## Environment quirks (read this before doing anything)

- Infra is fragile in this sandbox: **Docker Desktop crashes periodically**, taking the Qdrant
  container down with it, and sometimes the Node server dies too when that happens.
- Before trusting any live query result, verify:
  ```bash
  docker info >/dev/null 2>&1 && echo OK || echo DOWN
  curl -s -m 5 http://localhost:6333/collections   # Qdrant
  curl -s -m 5 http://localhost:3000/api/ingest/progress   # Node server
  ```
- If Qdrant container is stopped but Docker itself is up: `docker start hhhhagent-qdrant-1`
- If Node server is dead: `cd /Users/smalsus/office/Agent/HHHHAgent && (nohup npm start > /tmp/hhhh-server.log 2>&1 & echo $! > /tmp/hhhh-server.pid)`
- If Docker Desktop itself won't come up after `open -a "Docker Desktop"` and a ~30–60s wait, it
  usually needs the user to intervene manually (GUI click-through) — don't loop forever on it.
- **A query answered during the first few seconds right after Qdrant/server recovery can be
  wrong even for a query that is normally reliable** (confirmed live this session: a correct,
  well-established query failed once immediately post-recovery, then passed cleanly seconds
  later). If you must measure something right after an infra recovery, re-verify it once
  infrastructure has been stable for a bit before trusting the result.
- Run the test suite with `npm test` (168+ tests across `test/*.test.mjs`).

## Architecture map (the pieces that matter)

- `src/routes/query.js` — the main request handler. It's a big if/else chain of **deterministic
  branches checked in a specific order**, each more specific than the general fallback:
  greeting → COUNT (`how many...`) → overdue-only → date-list (latest/updated-when) →
  owned-by-person / who-works-on → task-id → meeting-detail-followup → meeting-date →
  exact-lookup (verbatim comments/feedback) → recent-work ("latest X") → comparison
  ("which is more recent, A or B") → hierarchy ("what's under X") → **general hybrid
  retrieval + LLM summary** (the catch-all, vector+BM25 search then Ollama narrates from
  evidence).
- `src/services/structuredFilters.js` — the shared filter-resolution engine used by every
  deterministic branch: `resolvePersonFilter`, `resolveContainerFilter` (delegates to
  structuralRetrieve.js), `resolveStatusFilter`, `isOverdueRequested`, `resolveDateFilter`, and the
  centralizing trio `resolveStructuredFilters` → `checkStructuredFiltersBlocked` →
  `applyStructuredFilters`. **Invariant: a detected constraint must end RESOLVED+APPLIED or
  EXPLICITLY UNRESOLVED, never silently dropped.**
- `src/services/structuralRetrieve.js` — entity resolution. `resolveContainerAnchor()` does
  keyword-overlap scoring against every real project/portfolio title, with tiebreaks (active
  status > ancestor-preference > ratio-precision > recency > explicit type word) and a
  generic-vocabulary downweighting scheme (`GENERIC_ENTITY_WORDS`, fuzzy-typo-tolerant) so a
  single coincidental word match (e.g. "management") can't win outright. Also owns the
  operator-vs-entity-reference vocabulary stripper (`sanitizeForEntityResolution`,
  `TEMPORAL_VOCAB_RE`/`STATUS_VOCAB_RE`/`ENTITY_TYPE_VOCAB_RE`/`BARE_NUMBER_RE`) — **this list is
  still incomplete** (see Phase 15 findings — "total", "logged", generic status words like "Not
  Started" aren't covered yet).
- `src/services/comparisonQuery.js` — multi-entity comparison ("compare A and B"), added Phase 13.
  Resolves both named entities **independently**, never assumes a parent/child relationship.
- `src/services/meetingQuery.js` — meeting date/detail resolution. Meetings use their real `start`
  field for occurrence date (fixed Phase 13 — never `timestamp`, which is SharePoint's
  record-modified time).
- `src/services/qdrantScroll.js` — `scrollPayloads` (raw fetch), and the **business-entity
  identity/dedup layer** added Phase 14: `getBusinessEntityKey(payload)` (→ `sourceKey`, falling
  back to `type:sharePointItemId`), `dedupeBySource`/`uniqueBusinessEntities` (same function,
  two names), `countBusinessEntities`. **Any deterministic count must go through this** — Qdrant
  points ≠ business records (a long meeting transcript can be 50+ chunk points for ONE real
  meeting).
- `src/services/ownerLookup.js`, `recentWork.js`, `exactLookup.js` — other deterministic branches
  (owned-by-person, "latest work on X", verbatim comment lookup).
- `src/services/hybridSearch.js`, `qdrant.js` — general vector+BM25 fallback retrieval, used when
  nothing more specific matches.

## Phase history this session (chronological, each phase = one user message)

**Phases 8–10** (before this session's transcript, referenced from memory): built the centralized
`structuredFilters.js` pipeline, fixed silent constraint-dropping bugs (person/container/status/
overdue/date all now resolve through one shared, fail-closed path).

**Phase 11**: Rigorous 100-question before/after re-evaluation. **The original 100-question eval
harness (`run100.mjs`, `ground_truth.json`) was permanently lost to a scratchpad reset mid-session**
— this is exactly why Phase 15 (below) exists as a *committed, version-controlled* replacement.

**Phase 12 — Entity Resolution Safety**: Audited every entity resolver (structuredFilters,
structuralRetrieve, exactLookup, recentWork, ownerLookup, meetingQuery, general hybrid). Found and
fixed: (a) `structuralRetrieve()`'s vector-search fallback used to accept a blind top-1 embedding
match with zero disambiguation whenever keyword resolution found nothing — fixed with a dominance
margin + real-word-overlap requirement; (b) generic vocabulary (team/management/system/tool(s)/
development) given full matching weight, letting one coincidental word win — fixed with weighted
downweighting (single generic-word match ≠ confident win, but 2+ together or an exact multi-word
title still can); (c) a real production title contained the SAME typo as a typo'd question
("Leave managment tool" vs "portfoilo managment") — fixed with edit-distance-1 fuzzy matching
against the generic-word list. Philosophy established: **WRONG ENTITY < HONEST AMBIGUITY** — a
"which one did you mean?" is always better than a confident wrong pick.

**Phase 13 — Deterministic Correctness Cleanup**: (1) Meeting temporal field fix — meeting
date/count questions were using `timestamp` (wrong) instead of `start` (right). (2) Comparison-query
architecture built from scratch (`comparisonQuery.js`) — "which is more recently updated, A or B"
used to route through the single-anchor hierarchy resolver and treat one name as if it must be the
other's child; now both resolve independently, fail closed if either doesn't resolve or is
ambiguous.

**Phase 14 — Entity Identity & Count Correctness**: Discovered "how many meetings happened this
week?" returned 32 (raw Qdrant chunk points for ~2 real meetings) — a broader invariant violation:
**chunk count must never determine business-record count**. Audited every entity type's real
identity (`sourceKey`, ingestion-defined as `siteId:listId:itemId:type`), proved via live payload
inspection that duplicates are 100% legitimate transcript/document chunking (never distinct
records colliding — zero anomalies found). Built the `getBusinessEntityKey`/`uniqueBusinessEntities`
layer (hardened the pre-existing `dedupeBySource`) and wired it into every count path
(`applyStructuredFilters` now dedupes as its last step — fixes 4 call sites in one place;
`comparisonQuery.js`, `structuralRetrieve.js`, `ownerLookup.js`, `recentWork.js` fixed individually).
Global meeting count corrected 2,463 → 146; global task count 14,581 → 14,181; "Team Management
Tools" task count 61 → 53 (8 were duplicate chunks); Ranu Trivedi's counts (672 tasks, 29 overdue)
were unaffected (zero chunking among her specific tasks) — confirming the earlier Phase 11/12
numbers for her were already correct.

**Phase 15 — Permanent Eval V2 + Frozen Baseline** (just completed, measurement-only, no code
changed): Built `eval/v2/` — a committed-to-git, version-controlled 185-question benchmark built
from real production entities, with ground truth computed **independently** from raw Qdrant data
(never from the agent's own answers). Ran the frozen baseline, manually reviewed all 111
FAIL/REVIEW_REQUIRED items with live evidence-based verification (not exact-string scoring).
**Overall: 115 PASS / 16 PARTIAL / 54 FAIL (62%/9%/29%)**.

Newly-discovered CRITICAL findings (not previously known, not yet fixed):
1. **Vocabulary collision generalizes beyond what Phase 12 fixed** — not just container-title
   words, but **person names** ("Stefan" from "Stefan Hochhuth" collides with a real portfolio
   "Test Meeting with Stefan") and **generic operator words never added to the stripped list**
   ("total" collides with real project "SmartTime Total", corrupting *global* task/meeting/overdue
   counts; "logged" collides with "Not logged in message"). This is the single most severe finding
   — it's corrupting the most basic, most-trusted queries in the app.
2. **Quoted status values get misdetected as person-name candidates** — `"Not Started"`,
   `"Acknowledged"`, etc. (Title-Case) match the capitalized-phrase person heuristic, fail to
   resolve as a person, and hard-block the whole query before status-filter logic ever runs
   (which also doesn't recognize these literal status strings as triggers anyway).
3. **`in-progress` (hyphenated) bypasses `STATUS_VOCAB_RE`**, which only matches the
   space-separated `"in progress"` phrase — leaving "progress" to collide with a real project
   titled "...Progress Tracking".
4. **Hindi/Hinglish count phrasing (`kitne...hain`) never triggers `COUNT_RE`** — a hard wall, not
   a partial degradation, for an entire class of question in that language.
5. **Conversation context is inconsistent, not absent**: works for meeting participant/pronoun
   follow-ups, but fails completely for project-scoped pronouns ("who owns it?" after "tell me
   about Team Management Tools") and for bare first-name person references in meeting follow-ups
   ("what did Deepak say?"). One conversation (`CONV_C_T2`) hit the exact "global count after
   dropping a person constraint" pattern — asked "how many of those [Ranu's tasks] are overdue?"
   and got the *global* overdue count (1,089) instead of Ranu's (29).
6. **"Hallucination of absence"**: three items confidently denied real, verified transcript content
   existed ("the meeting did not discuss AI" — it did, in its own summary) — inconsistent with a
   4th, near-identical question that correctly retrieved the same fact. Suggests retrieval
   reliability for late/deep transcript regions is question-phrasing-sensitive, not a hard budget
   wall.

**None of these were fixed in Phase 15** — that phase was explicitly measurement-only per the
user's instruction. They are documented as the recommended next-phase priority, ranked:
(1) generalize the vocabulary-collision fix, (2) Hindi/Hinglish structured-query triggers,
(3) conversation-context for project-pronouns/bare-first-names.

## Where things stand right now

- **Eval V2 is built and the baseline is scored, but NOT YET COMMITTED to git.** `gh` isn't
  authenticated in this sandbox so repo visibility (public/private) on `github.com/utkSmalsus/
  HHHHAgent` couldn't be verified — the user was asked to confirm before committing, since the
  eval dataset contains real employee names and task/meeting data. **Check with the user on this
  before running `git add`/`git commit` on `eval/v2/`.**
- No production code (`src/`) has been modified since Phase 11 except the deliberate, tested fixes
  in Phases 12–14 (all committed already — check `git log`).
- Full report text for Phase 15 (all 25 requested sections) exists in this session's transcript;
  key artifacts are `eval/v2/QUESTION_REPORT.md` (every question), `eval/v2/results/baseline-
  failures.json` (every failure, ranked), `eval/v2/results/manual-overrides.json` (every manual
  judgment + justification), `eval/v2/results/baseline-summary.json` (aggregate stats + safety
  metrics).
- User's explicit instruction at the end of Phase 15: **"I want to review the baseline first"** —
  do not start fixing anything (Hindi, embeddings, reranking, conversation memory, LangGraph, the
  LLM, prompts) until they give new direction.

## Working conventions established this session (follow these)

- **Ponytail style**: laziest solution that actually works — reuse existing functions/mechanisms
  before building new ones (e.g., Phase 14's dedup reused/hardened the pre-existing
  `dedupeBySource` instead of writing a parallel mechanism); no speculative abstraction.
- **Fail-closed, never silent**: any detected constraint (person/container/status/date) must
  resolve-and-apply or explicitly say it couldn't — never silently drop to an unscoped/global
  answer.
- **WRONG ENTITY < HONEST AMBIGUITY**: prefer "which one did you mean?" over a confident guess.
- **Ground truth must be independent**: never grade the agent using the agent's own output; use
  raw Qdrant payload data or the app's own already-verified, unit-tested pure functions.
- **Business-entity identity = `sourceKey`** (fallback `type:sharePointItemId` for the rare legacy
  points missing it). Never dedupe by title — two real different records can share a title.
- **Filter first, then dedupe** — chunks of one record share identical filterable metadata, so
  filtering before deduping can't drop a real match; deduping after is the safe order.
- Every phase this session: audit/design before coding when asked, live-verify against real
  production data rather than trusting assumptions, run the full test suite before declaring done,
  and give an honest before/after report — including when something got worse, not just better.

## How to resume

1. Check infra (docker/Qdrant/server) per the commands above.
2. Ask the user what they want next — most likely: review the Phase 15 baseline findings and
   decide whether to start fixing the ranked issues (§ "Phase 15" above), or something else
   entirely.
3. Read `CLAUDE.md` in the repo root if one exists, and skim `src/routes/query.js` +
   `src/services/structuredFilters.js` + `src/services/structuralRetrieve.js` for current-state
   ground truth before making claims about behavior — this handoff summarizes, it doesn't replace
   reading the code.
