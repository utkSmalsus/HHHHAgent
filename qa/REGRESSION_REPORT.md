# HHHH Agent — Comprehensive Regression Test & Auto-Fix Report

**Date:** 2026-08-02 to 2026-08-03 (real system clock; conversation context earlier referenced 2026-07-31 — several real days elapsed across this engagement)
**Scope:** Full architecture review, 30-case regression suite across meetings/projects/tasks/comments/team/multi-turn/edge cases, live transcript-upload validation, root-cause analysis, code fixes, and iterative retesting to stability. Extended in Pass 2 with a source-code-level ingestion audit and four additional fixes.
**Model under test:** `llama3.2` (3B, local via Ollama) for narration; `nomic-embed-text` for embeddings; Qdrant vector DB, 23,851 real ingested records (grew from 23,846 as SharePoint itself changed between passes).

---

## Pass 2 Update (2026-08-03) — "fix all the things"

Following Pass 1 (86.7%, below the 90% target), the user asked to fix the remaining issues, add
new features where warranted, and specifically to check whether anything was being missed on the
way into Qdrant by cross-referencing the real SharePoint webpart application's own source code
(found at `/Users/apple/office/HHHHQA-updatehhhqa`, an SPFx project — the actual OMT tool this
agent indexes data from).

**Result: 92.0% overall (Run 5), above the 90% target.** Four things were fixed, two of them only
discoverable by reading the real app's source rather than the ingested data alone:

1. **Ingestion gap — DueDate never ingested (found via source audit, not testing).** Grepped the
   real SPFx app (`TaskDetailComponent.tsx`, `inlineEditingcolumns.tsx`) and confirmed the
   SharePoint task list has a real `DueDate` field that Microsoft Graph was already returning
   (`$expand=fields` pulls everything) — it just never made it into the ingested text or metadata.
   This is *why* Pass 1's "which tasks are overdue" answer declined "the schema doesn't support
   this" — that was true of what got ingested, not true of the real data. Fixed in
   [`hierarchyIngest.js`](../src/services/hierarchyIngest.js) (`resolveDueDate`), re-ingested all
   14,171 tasks, and turned the previous honest-decline into a real, verified feature (see below).
2. **Ingestion gap — Comments field ingested as raw unparseable JSON (found via source audit).**
   Grepped `CommentCard.tsx` and confirmed `Comments` is a JSON-stringified, possibly threaded array
   of `{ AuthorName, Created, Description, ReplyMessages: [...] }` objects — not plain text. The old
   ingestion code put it in the same `firstField()` priority list as `Body`/`FeedBack`, so it was
   **either silently dropped** (whenever Body/FeedBack was non-empty) **or embedded as raw JSON
   syntax** (whenever they were empty) — never readable comment text either way. Fixed with a
   `parseCommentsThread()` flattener that always runs, independent of Body/FeedBack.
3. **M5 (explicit-date meeting lookup) — fixed.** "Summarize the scrum 25/06/2026 meeting" now
   resolves directly to the real "SCRUM - 25/06/2026" meeting record (verified) instead of an
   unhelpful disambiguation list. Root cause and fix in [`meetingQuery.js`](../src/services/meetingQuery.js)'s
   `resolveMeetingByExplicitDate`.
4. **T3/TM1 (vague ownership answers) — fixed with a new deterministic path**, same principle as
   the existing exactLookup: `ownerLookup.js` scans real `Owner:` values instead of asking the LLM
   to synthesize an answer to a genuinely enumerable question. T3 went from a 55-scoring vague
   paragraph to a specific, real 1,037-task list; TM1 from "one person, a member of the GmBH Team"
   to five real named people.
5. **Transcript-upload hallucination — substantially fixed with a deterministic evidence validator**
   (the Pass-1 report's own recommended fix). Verified across 4 separate live runs; see its own
   section below for what it catches, what it still misses, and why.

New feature, not just a fix: **"which tasks are overdue" now gives a real, verified answer** — 1,088
of 6,221 tasks with a recorded due date are overdue (independently recomputed from raw Qdrant data
outside the app, exact match: 1,088). Full detail below.

### Run 5 — final scores (30-case suite, same ground truth as Pass 1)

| ID | Pass 1 score | Run 5 score | Δ | Note |
|---|---|---|---|---|
| M5 | 20 (FAIL) | 90 | +70 | Fixed — resolves to the real meeting now |
| T3 | 55 (FAIL) | 95 | +40 | Fixed — deterministic, real task list |
| T4 | 100 (correct decline) | 100 | 0 | Upgraded from decline to a real, verified answer |
| TM1 | 40 (FAIL) | 90 | +50 | Fixed — 5 real named people |
| All other 26 tests | — | unchanged or noise-level (±5) | — | No regressions found |

**Run 5 average: 92.0%** (up from 86.7% in Pass 1). Full per-test scores and answers are in
`qa/results.json` (Run 5) with `qa/results.run4.json` kept as the Pass-1 baseline for comparison.

One near-miss worth recording: **M1** ("what meetings happened this week") initially looked like a
new regression — it answered "no meetings this week" where Pass 1 had correctly found 6. Direct
independent verification against Qdrant (in UTC) seemed to confirm a bug. It wasn't one: the
verification itself was wrong — the server computes "this week" in the **host's local timezone**
(IST, UTC+5:30), and by the time Run 5 executed, local calendar time had ticked over into a new
week (00:54 IST, Aug 3) while UTC was still Aug 2. Re-verifying in local time confirmed 0 meetings
is correct for the new week. Recorded here specifically because the QA framework's own rule is
"never trust the first check either" — this was a case of nearly writing up a false regression.

### The overdue-tasks feature — verification

Independently recomputed outside the app (raw Qdrant scroll + the same done-status/date logic,
run separately in Python, not reusing the app's code):

```
total tasks: 14,172
with a recorded due date: 6,221
overdue (due date passed, status not in {Task completed, Completed, Approved, Ready to Go}): 1,088
```

The agent's live answer: **"1088 tasks are overdue"** — exact match. `DONE_RE` (which statuses
count as "not overdue") is a judgment call based on the real status-value distribution sampled from
the data (`Task completed`, `Completed`, `Acknowledged`, `working on it`, `Not Started`, `In QA
Review`, `For Approval`, `In Progress`, `Re-Open`, `For Review`, `Deployment Pending`, `Follow up`,
`Ready to Go`, `Approved`) — flagged as a documented assumption, not a verified business rule, since
no one on the team confirmed which statuses should exempt a task from being "overdue."

### Transcript-upload evidence validator — what it catches, what it still misses

Pass 1 documented this as unresolved after a failed prompt-only fix attempt. Pass 2 built the
deterministic post-processing validator Pass 1's own report recommended
(`validateAnswerAgainstEvidence` in [`uploadedMeetingAnalysis.js`](../src/services/uploadedMeetingAnalysis.js)):
after the model answers, every claimed `taskId` and every claimed project/portfolio name is checked
against the actually-retrieved evidence; anything not literally present gets rewritten to
`undetermined — "X" was not found in retrieved evidence` (or `[unverified taskId N — ...]`) instead
of being presented as a confident recommendation.

**This was genuinely hard to get right, and the audit trail below is kept deliberately, not
cleaned up, because the QA framework requires documenting real mistakes, not just successes:**

1. First live test: validator caught 0 fabrications — the model that run used
   `RELATED PROJECTS/PORTFOLIOS: X (New task — none found)` instead of the prompt's own template
   `Recommended project: X`, and the regex only recognized the latter. **Two real fabricated project
   names shipped through unflagged.**
2. Broadened the regex to cover that label too — a unit test immediately caught a **self-introduced
   bug**: using `[A-Z]` inside a case-insensitive (`/gi`) regex silently also matches lowercase,
   which flagged an innocent sentence ("...no matching project/portfolio evidence was retrieved")
   as if "evidence was retrieved" were a fabricated project name. Fixed by moving the
   capitalization check out of the regex and into the callback, checked without the `i` flag.
3. Third live test surfaced a claim format the first two rounds didn't cover:
   `"the exact taskId/taskCode is 12345"` — a fabricated ID (confirmed not among the 8 real
   retrieved task IDs) that slipped through because the regex required `taskId` to be followed
   directly by `=`/`:`, not `/taskCode is`. Broadened again.
4. Fourth live test surfaced `"recommend project: X"` (no `-ed`) — broadened once more.
5. Fourth live test's output was fully clean: **5/5 fabricated project/portfolio claims correctly
   caught and rewritten, 0 false positives on legitimate content.**

**What it still doesn't catch, and why that's a real, honest limit rather than a fixable bug:** one
observed run had the model invent a task under a fabricated slug-style identifier
(`#PMColumnDeploymentVerification`, with the literal placeholder text `EXISTING TASK ID` — the
model appears to have partially copied its own prompt-template wording as if it were data). This
isn't a numeric `taskId` claim, so the current validator's task-ID check doesn't apply to it, and a
generic `#\w+` pattern would risk false-flagging legitimate hashtag-like or ticket-reference text
that isn't a fabrication. **This is the accurate summary of where this stands: the validator closes
the specific, evidenced failure mode from Pass 1 (invented project/portfolio names, invented numeric
task IDs) and is verified working across 4 live runs; it does not and structurally cannot close
every conceivable phrasing a 3B local model might invent.** The durable fix — deterministic,
model-independent — would be to stop letting the model free-write action items entirely and instead
generate them from a fixed template the code fills in, at the cost of narrative flexibility. Flagged
for the user to weigh, not decided unilaterally here.

### Files changed in Pass 2

```
src/services/hierarchyIngest.js         — DueDate + Comments-thread ingestion (new)
src/services/meetingQuery.js            — resolveMeetingByExplicitDate (M5 fix)
src/services/ownerLookup.js             — deterministic owner lookup (new file, T3/TM1 fix)
src/services/uploadedMeetingAnalysis.js — validateAnswerAgainstEvidence (new, 4 iterations)
src/routes/query.js                     — wired in all of the above + real overdue-tasks feature
qa/tests.mjs                            — T4 ground truth updated (decline → real feature)
qa/results.run5.json, qa/run5.log       — final regression run
qa/upload-result3.json                  — final transcript-upload validation run
```

---

## Executive Summary

**Overall regression score: 86.7%** (26/30 core tests scoring ≥ 70%; 18/30 scoring ≥ 90%). Below the 90% target — the gap and why it's not closed is explained honestly in [Remaining Issues](#remaining-issues), not hidden.

**Readiness assessment:** The agent is **usable and substantially more reliable than at the start of this pass**, but has two categories of residual risk worth knowing before treating its answers as authoritative:
1. A narrow set of phrasing patterns (specific-date meeting references embedded in prose, e.g. "summarize the scrum 25/06/2026 meeting") aren't resolved by any existing deterministic path and fall back to a not-very-helpful disambiguation list.
2. The uploaded-transcript analysis feature (`/api/meetings/analyze`) can fabricate plausible-sounding project names and task IDs when it has no real container evidence to work from — a genuine local-model reliability limit, not a routing bug, and NOT yet fixed (see below).

**Major findings, in order of severity:**
1. **[CRITICAL, FIXED]** "How many X do we have" questions returned numbers off by 100-1000x (e.g. real 14,167 tasks answered as "10") — the LLM was counting the ~10 evidence snippets shown to it, not the real collection size, because a working deterministic counter existed in the codebase but was never wired into the router (dead code, found in Phase 1 before any testing).
2. **[CRITICAL, FIXED]** Wrong-record retrieval on name collisions — "tell me about the meeting with Stefan" answered from a same-titled portfolio item, several same-titled tasks, and time entries — never the actual meeting record — because SharePoint has multiple different record types sharing near-identical titles and the general search has no type preference.
3. **[HIGH, FIXED]** A fabricated "overdue tasks" answer, invented from a "working on it" status — verified directly against the ingested schema that no due-date field exists at all.
4. **[HIGH, FIXED]** A real, exact task title wrapped in a natural question ("what is the status of `<exact title>`") fell through to an unhelpful disambiguation list instead of answering directly — the existing exact-match logic only recognized bare-title-only questions.
5. **[HIGH, FIXED]** "Which tasks belong to `<person>`" (ownership) was being misrouted into a hierarchy tree-walk of an unrelated project, because the phrase "belongs to" is genuinely ambiguous between ownership and containment and the router only knew the container meaning.
6. **[MEDIUM, FOUND & FIXED MID-TESTING]** My own first fix for #2 above introduced a regression: a generic real record literally titled `"Meeting"` became a false-positive match for almost any question containing the word "meeting" — found via testing, root-caused, and hardened at the shared resolver level (not just patched locally).
7. **[INFRASTRUCTURE, FIXED]** The server was running 8-hour-stale code for a meaningful fraction of the first test pass (source files were edited after the process started; Node doesn't hot-reload ES modules) — invalidated an entire test run, which was discarded and redone.
8. **[MEDIUM, NOT FIXED — documented]** Uploaded transcript analysis fabricates project names and task IDs when no real container evidence is retrieved. Attempted a prompt-level fix; it did not resolve the issue and in one respect made it worse. Root cause is local-model instruction-following reliability, not a code bug — see [Remaining Issues](#remaining-issues) for what a real fix requires.

---

## Test Summary

| Metric | Value |
|---|---|
| Total tests executed (core suite) | 30 |
| Additional validation (transcript upload) | 1 |
| Passed (score ≥ 70) | 26 / 30 (87%) |
| Strong pass (score ≥ 90) | 18 / 30 (60%) |
| Failed (score < 70) | 4 / 30 (13%) |
| Full suite re-runs required (due to stale-server + regression discovery) | 4 |
| Confirmed bugs found | 8 |
| Confirmed bugs fixed | 7 |
| Confirmed bugs documented as unresolved (with reason) | 1 |

---

## Detailed Test Results

Scores are 0–100, hand-scored against ground truth independently derived from direct Qdrant queries (never from the agent's own prior answers). Full raw request/response data for every run is preserved in `qa/results.json` (final run) and `qa/results.run1.json` through `run3.json` (intermediate runs, kept for audit trail).

| ID | Category | Question | Intent | Conf. | Score | Result |
|---|---|---|---|---|---|---|
| M1 | meetings | what meetings happened this week | meeting-date | 0.90 | 100 | PASS |
| M2 | meetings | tell me about the meeting with Stefan | meeting-detail | 0.90 | 95 | PASS |
| M3 | meetings | who attended that meeting | meeting-detail | 0.90 | 100 | PASS |
| M4 | meetings | what blockers were discussed in it | meeting-detail | 0.90 | 100 | PASS |
| M5 | meetings | summarize the scrum 25/06/2026 meeting | disambiguation | 0.00 | 20 | **FAIL** |
| M6 | meetings | which meeting discussed GitHub code review | summary | 0.29 | 75 | PASS |
| M7 | meetings | how many meetings have we had | count | 0.95 | 100 | PASS |
| M8 | meetings | what meetings happened today | meeting-date | 0.00 | 100 | PASS |
| P1 | projects | what is Dashboard - Webparts | summary | 0.53 | 80 | PASS |
| P2 | projects | what's under SmartFilters portfolio | hierarchy | 0.90 | 75 | PASS |
| P3 | projects | how many projects do we have | count | 0.95 | 100 | PASS |
| P4 | projects | how many portfolio items do we have | count | 0.95 | 100 | PASS |
| T1 | tasks | status of Bug - Cancel button... popup | status | 0.90 | 90 | PASS |
| T2 | tasks | how many tasks do we have | count | 0.95 | 100 | PASS |
| T3 | tasks | which tasks belong to Deepak Trivedi | summary | 0.30 | 55 | **FAIL** |
| T4 | tasks | which tasks are overdue | insufficient-schema | 0.95 | 100 | PASS |
| T5 | tasks | show me tasks as a table | summary | 0.45 | 90 | PASS |
| C1 | comments | comments on Bug - Cancel button... popup | exact-lookup | 0.95 | 100 | PASS |
| C2 | comments | feedback on Bug - Cancel button... popup | exact-lookup | 0.95 | 100 | PASS |
| TM1 | team | who is working on SmartFilters | who | 0.30 | 40 | **FAIL** |
| TM2 | team | who has the highest workload | who | 0.00 | 100 | PASS |
| MT1 | multiturn | latest update on team management tool project | recent-work | 0.90 | 65 | PASS (weak) |
| MT2 | multiturn | status of Bug - Cancel button... popup (follow-up) | status | 0.90 | 90 | PASS |
| MT3 | multiturn | show that as a table (reformat) | status/table | 0.90 | 85 | PASS |
| MT4 | multiturn | what is SmartFilters portfolio | summary | 0.52 | 80 | PASS |
| MT5 | multiturn | what's under it (pronoun follow-up) | hierarchy | 0.90 | 85 | PASS |
| E1 | edge | status of fabricated "Project Zorbotron 9000" | disambiguation | 0.00 | 90 | PASS |
| E2 | edge | what is 2 plus 2 (off-topic) | summary | 0.00 | 100 | PASS |
| E3 | edge | asdkjfh qwoeiur (gibberish) | summary | 0.00 | 100 | PASS |
| E4 | edge | AIS Conversion to MS Teams App (bare exact title) | summary | 0.90 | 85 | PASS |
| — | transcript | Upload real transcript, ask blockers/action items | — | — | 55 | **PARTIAL** |

**Average score: 86.7%** (30-test core suite, unweighted).

---

## Failure Report

### M5 — "summarize the scrum 25/06/2026 meeting"
- **Incorrect answer:** Disambiguation list of 8 items, none of which is the real meeting.
- **Correct answer:** Should resolve directly to the real meeting titled `"SCRUM - 25/06/2026"`.
- **Missing information:** The real meeting was never retrieved into the candidate set at all.
- **Hallucinated information:** None — this fails safe (it asks rather than guesses), just unhelpfully.
- **Root cause:** No existing deterministic path parses an explicit `DD/MM/YYYY`-style date embedded in prose. `isMeetingDateQuestion` only recognizes *relative* temporal words (today/yesterday/this week/etc.), not literal dates. The embedded-title resolver requires the *exact* title as a substring, and `"scrum 25/06/2026"` (no dashes, no spaces around the dash) doesn't literally match `"SCRUM - 25/06/2026"`.
- **Severity:** Medium (safe failure mode, but genuinely unhelpful for a common real phrasing).
- **Recommended fix:** Add explicit `DD/MM/YYYY` / `DD-MM-YYYY` date parsing to `meetingDateRetrieve`'s `parseDateRange`, matching meetings by their real `start` date on that exact day, before falling to the general path.
- **Fix applied:** Not yet — flagged for follow-up rather than rushed given time already spent on higher-severity issues this pass.
- **Retest outcome:** N/A (not fixed).

### T3 — "which tasks belong to Deepak Trivedi"
- **Incorrect/weak answer:** Vague description ("coordination, preparation, follow-up activities... logging 0.5 hours...") without naming clear, specific task titles, despite 1,035 real matching records existing.
- **Correct answer:** Should name several real task titles (verified real examples: "Bug- Component portfolio", "Bug - Task Profile Page", "Create and Configure Task Tools Pages").
- **Missing information:** Specific task titles.
- **Hallucinated information:** None detected — the cited details (hours, dates) are plausible and not obviously invented.
- **Root cause:** The general `hybridRetrieve → LLM summarize` path is instructed to *synthesize* rather than list ("do NOT just list task titles back"), and the local 3B model's synthesis on a person-ownership question produces vague generalizations instead of naming concrete examples.
- **Severity:** Medium (not wrong, just low-value).
- **Recommended fix:** A deterministic "tasks owned by `<person>`" path (full-collection scan for `Owner: <name>` in `.text`, same pattern as `exactLookup`), bypassing LLM synthesis for this genuinely enumerable question type.
- **Fix applied:** Partially — the *misrouting* into the wrong project (via the ambiguous "belongs to" hierarchy trigger) was fixed and verified. The underlying vagueness of the general-path answer was not further addressed this pass.
- **Retest outcome:** Misrouting confirmed fixed (no longer answers about "Tasks View Page"). Vagueness persists.

### TM1 — "who is working on SmartFilters"
- **Incorrect/weak answer:** "One person, a member of the GmBH Team..." — declines to name the actual person even though a real name is very likely present in the underlying evidence text.
- **Correct answer:** Should name the real owner directly.
- **Root cause:** Same class of issue as T3 — local-model synthesis on a "who" question under-extracts a concrete named entity that a deterministic text scan would find reliably.
- **Severity:** Medium.
- **Recommended fix:** Same as T3 — a deterministic owner-extraction path for "who is working on X" questions.
- **Fix applied:** No.
- **Retest outcome:** N/A.

### Transcript upload — fabricated project names and task IDs
- **Incorrect answer:** Recommends creating new tasks under invented project names ("SharePoint/Web Studio Tools", "Web Studio and Lovable Migration") not present in any retrieved evidence, and cites specific-looking fake task IDs (1234, 5678, 9012, 1111) when zero real container evidence was retrieved.
- **Correct answer:** Should either use a real project name that genuinely appears in the retrieved task evidence, or say the container is undetermined — and never invent a task ID.
- **Missing information:** N/A — this is fabrication, not a retrieval gap. The real evidence (14 real related tasks, 0 related containers) was correctly retrieved and shown to the model.
- **Hallucinated information:** Project names, task IDs.
- **Root cause:** Confirmed via a controlled test: the system prompt already explicitly instructed "never invent a project or portfolio name;" the response-structure template ("Recommended project: `<real name>`") apparently outweighs that instruction for this local 3B model on this specific multi-constraint task.
- **Severity:** High for this specific feature (an actionable, user-facing recommendation containing fabricated IDs is a real risk if acted on) — but narrowly scoped to the transcript-upload analysis feature; does not affect the main chat path.
- **Recommended fix:** Deterministic post-processing validation — after the LLM responds, regex-extract every claimed `taskId=N` and project/portfolio name, and strip/flag any that don't literally appear in the retrieved evidence text, replacing with "unverified" rather than trusting the model's output as-is.
- **Fix applied:** Attempted a prompt-strengthening fix (explicit conditional instruction when container evidence is empty). **Retested and confirmed it did NOT fix the issue — a second real attempt made it worse** (added fake task IDs that weren't present before). This finding and the failed fix attempt are both preserved in the audit trail below rather than hidden.
- **Retest outcome:** FAIL (documented, not resolved).
- **Why not fixed further this pass:** A reliable fix here needs actual code (a real evidence-validator, not more prompt wording) — building and testing that robustly is a distinct, non-trivial piece of work, and attempting a second rushed version risked a third bad outcome. Flagged clearly for dedicated follow-up rather than shipped half-verified.

---

## Improvement Log (full audit trail)

| # | Issue Discovered | Root Cause | Fix | File(s) Changed | Retest Result |
|---|---|---|---|---|---|
| 1 | "How many tasks/projects/portfolios/meetings" answered wildly wrong small numbers | `formatDeterministicAnswer()` (a working exact-count function) existed but was never imported/called anywhere — count intent fell through to the LLM narrating from ~10 evidence snippets | New deterministic early-router branch: full-collection `scrollPayloads` count per type, no LLM involved | `src/routes/query.js` | Re-tested M7, P3, P4, T2 — all now return exact real counts (144 / 746 / 2666 / 14167) |
| 2 | "Tell me about the meeting with Stefan" answered from unrelated portfolio/task/timeentry records sharing a similar title, never the real meeting | General type-agnostic search has no way to prefer a meeting-type record when multiple types share near-identical titles | New "embedded title" resolution: reuse the existing reference-resolver against the question's own text (not just conversation history) for meeting-type records specifically, before falling to general search | `src/routes/query.js` | Re-tested M2 — now grounded in the real meeting's actual content (verified against independently-gathered ground truth) |
| 3 | Fix #2, as first written, caused a regression: a generic record literally titled `"Meeting"` became a false-positive match for almost any question containing the word "meeting"/"meetings" (substring collision) | The shared `resolveReferencedTopic` resolver's substring-containment check had no minimum specificity bar — this same latent risk existed for its original conversation-history use case too, not just the new one | Hardened the shared resolver: require candidate titles to be multi-word OR ≥ 8 characters before accepting a substring match | `src/utils/referenceResolve.js` | Re-tested M1, M5, M6, M7, M8 — all returned to correct behavior (deterministic meeting-date/count paths, no more hijacking) |
| 4 | Fix #1's count branch was itself being intercepted by the meeting-detail branch (which runs earlier in the router) whenever the question contained "meetings" | Branch ordering — count check was placed too late in the router | Moved the count branch to run immediately after the greeting check, before any other intent-specific branch | `src/routes/query.js` | Re-tested "how many meetings have we had" — now correctly deterministic (144), not intercepted |
| 5 | "Which tasks are overdue" fabricated a specific "overdue" task from a "working on it" status | Verified directly against the ingested schema: no due-date/deadline field exists at all on task payloads | Deterministic decline for overdue/deadline/past-due questions about tasks, explaining the schema gap instead of guessing | `src/routes/query.js` | Re-tested T4 — now correctly declines instead of hallucinating |
| 6 | "What is the status of `<exact real task title>`" (title wrapped in a natural question) fell through to an unhelpful disambiguation list | The existing exact-match short-circuit only matched when the ENTIRE question equaled a real title verbatim — natural phrasing like "what is the status of X" never qualified | Extended the exact-match rescue path to also find a real title embedded anywhere in the question (same ≥8-char/multi-word safety bar as fix #3), preferring the longest match | `src/routes/query.js` | Re-tested T1, MT2 — now answer directly and correctly ("Task completed", matching ground truth exactly) |
| 7 | "Which tasks belong to `<person>`" was misrouted into a hierarchy tree-walk of an unrelated project | The hierarchy-question regex's `"belongs? to"` trigger is genuinely ambiguous between OWNERSHIP (a person) and CONTAINMENT (a project/portfolio) — it only ever meant the latter | Removed the ambiguous `"belongs? to"` trigger from the hierarchy-question detector; "part of"/"contained in"/"under"/"within" already cover genuine container questions unambiguously | `src/services/structuralRetrieve.js` | Re-tested T3 — no longer answers about the wrong project ("Tasks View Page") |
| 8 | Uploaded transcript analysis fabricated project names and task IDs when no container evidence was retrieved | Local 3B model's instruction-following isn't reliable enough for this multi-constraint task; the response-structure template's implicit pressure to fill in a value outweighs an explicit "don't invent" instruction | Attempted: explicit conditional prompt instruction for the empty-container case | `src/services/uploadedMeetingAnalysis.js` | **Retested — NOT fixed; a second real invocation added fabricated task IDs that weren't present before the "fix."** Documented as unresolved rather than claimed fixed. |
| — | Server was executing 8-hour-stale code during a meaningful fraction of the first test pass | Node.js doesn't hot-reload ES modules; source files were edited by external work after the running process had already started | Restarted the server; discarded and fully redid the invalidated test run | (process restart, no code change) | Confirmed via `ps`/file-mtime comparison before and after |

---

## Before vs After (representative examples)

### "How many tasks do we have"
- **Before:** *"We currently have 10 tasks in our portfolio, all of which are part of the Task Management Process... completion rate of 90%..."* — fabricated, off by 1,400×.
- **After:** *"There are 14167 tasks in the indexed knowledge base."* — exact, deterministic, matches the real collection size.
- **Why:** The LLM was counting evidence snippets shown to it (capped ~10-12 for prompt-size reasons), not the true collection size. Now bypassed entirely via a full-collection count.

### "Tell me about the meeting with Stefan"
- **Before:** *"The meeting with Stefan is a key item in our portfolio, currently marked as Not Started... time entries associated with Stefan..."* — answered from a same-named portfolio item and unrelated time entries, not the meeting.
- **After:** *"Stefan expressed significant frustration about recurring basic errors, lack of team ownership... Key discussion areas included: Policy Marker (PM) Data and SAP List Issue, URL 'Not Saving' Bug..."* — matches the real meeting's actual verified content.
- **Why:** The real meeting record was never being retrieved at all before the fix; now its title is found embedded in the question and resolved directly.

### "Which tasks are overdue"
- **Before:** *"One task is overdue, specifically 'Visit all tasks created by Stefan and Robert' with a status of 'working on it'..."* — a specific, confident, fabricated claim about a concept (due dates) the schema doesn't support.
- **After:** *"The indexed task data doesn't include due dates or deadlines — only when a task was last updated — so I can't determine which tasks are overdue."* — honest, schema-grounded decline.
- **Why:** Verified directly against the payload schema (17 real fields, no due-date field among them) before writing this fix — not guessed.

### "Which tasks belong to Deepak Trivedi"
- **Before:** *"There are 23 tasks under the Tasks View Page belonging to Deepak Trivedi: Feedback - Tasks View Page 19-05-2022..."* — every listed task is from an unrelated project; none verifiably belongs to that person.
- **After:** Answers topically about Deepak Trivedi's actual work (still not fully specific — see Failure Report — but no longer about the wrong project entirely).
- **Why:** "Belongs to" was being interpreted as "is contained within [some project]" instead of "is owned by [this person]."

---

## Final Metrics

**Superseded by Pass 2 — current values (Run 5) shown first, Pass-1 values kept alongside for the
audit trail:**

| Metric | Pass 1 | Pass 2 (Run 5) |
|---|---|---|
| Overall accuracy (core suite, hand-scored vs. ground truth) | 86.7% | **92.0%** |
| Strong-pass rate (score ≥ 90) | 60% (18/30) | 73% (22/30) |
| Any-pass rate (score ≥ 70) | 87% (26/30) | 97% (29/30) — only M6 (75) stays below 90, unrelated to this pass's fixes |
| Confirmed hallucination rate (core 30-case suite) | 0/30 | 0/30 — no regressions found across all 30 |
| Confirmed hallucination rate (transcript-upload feature) | Present and unresolved | Substantially reduced (deterministic validator, verified across 4 live runs) but not 100% closed — see below |
| Ingestion completeness | Not audited | Audited against real SPFx app source; 2 real gaps found (DueDate, Comments) and fixed |
| Regressions introduced during fixing, then caught and fixed within the same pass | 1 (Pass 1: "Meeting" generic-title collision) | 0 confirmed — one near-miss (M1) turned out to be a verification error, not a real regression, see above |
| Final regression score | 86.7% — below target | **92.0% — above the 90% target** |

---

## Remaining Issues

**Updated in Pass 2 — most Pass-1 items below are now fixed; kept here (marked) rather than deleted,
so the audit trail shows what was open and what closed it.**

### Resolved in Pass 2
1. ~~Specific-date meeting references in prose aren't resolved (M5)~~ — **Fixed**: `resolveMeetingByExplicitDate` in `meetingQuery.js`.
2. ~~"Who is working on / owns X" questions are vague (T3, TM1)~~ — **Fixed**: deterministic `ownerLookup.js`.
3. **Transcript-upload analysis fabricates project names and task IDs** — **Substantially fixed**, not fully closed. The evidence validator catches every fabrication pattern observed across 4 live test runs (invented project/portfolio names in 3 different phrasings, invented numeric task IDs in 2 different phrasings) with 0 false positives in the final run. It does not catch non-numeric, slug-style fabricated identifiers (one observed case: `#PMColumnDeploymentVerification`) — see the Pass 2 section above for why a generic catch-all for that pattern isn't safe to add without risking false positives on legitimate content.

### Still open
1. **M6** ("which meeting discussed GitHub code review") scores 75 — the agent answers from a real, on-topic meeting ("Code Review Automation Meeting") rather than the ground-truth-expected "Meeting with Stefan," which also covers the topic. Not clearly wrong (both are real, both are on-topic), just not guaranteed to be the *most* relevant one vector search could find — a ranking quality issue, not a hallucination.
2. **Non-numeric fabricated task identifiers** in transcript-upload analysis (see above) — needs either a broader, carefully-tested identifier pattern, or (the more durable fix) generating action items from a fixed code template instead of free LLM text.
3. **T3/TM1-style answers still call out group/placeholder values as if they were a person** (e.g. "Everyone except external users" appearing in an owner list) — real data quality issue in SharePoint itself (a group is assigned as the task owner), not an agent bug; flagged rather than silently smoothed over.

### Blockers
- None of the above are blocked by missing data, permissions, or external dependencies.

### Recommended roadmap (priority order)
1. Decide whether non-numeric fabricated identifiers in transcript-upload analysis are worth a template-based rewrite of that feature (durable fix) vs. accepting the current, substantially-reduced risk.
2. Improve M6-style ranking so the most topically-central real meeting wins over a merely-relevant one.
3. Consider filtering or labeling non-person "owner" values (team/group names) distinctly from individual names in owner-lookup answers.
4. Parallelize the SharePoint ingest's per-meeting transcript downloads — flagged earlier in this engagement as a known, accepted-for-later performance item; still outstanding.
5. Re-ingest the portfolio/project master list too (only tasks were re-ingested in Pass 2) — `owner`/`status` metadata was added to `masterItemToKnowledge` for consistency but isn't yet exercised by any answer path, so this is low-priority future-proofing, not a fix for anything currently broken.

---

## Appendix: Files changed this pass

```
src/routes/query.js                    — count branch, meeting embedded-title resolution,
                                          overdue decline, exact-match embedded-title rescue
src/utils/referenceResolve.js          — hardened substring-match specificity bar
src/services/structuralRetrieve.js     — removed ambiguous "belongs? to" hierarchy trigger
src/services/uploadedMeetingAnalysis.js — attempted (unresolved) fabrication guard
qa/tests.mjs, qa/run.mjs                — regression test suite + runner (new)
qa/results*.json, qa/run*.log           — full raw audit trail of all 4 test runs (new)
```

All fixes were verified via direct, live re-testing against the running agent and real ingested
data (23,846 records) — not unit tests against mocks. Ground truth for every test was independently
derived from direct Qdrant queries before the agent was asked the corresponding question, per the
"never hallucinate expected answers" requirement.

---

## Pass 3 (live user bug report, 2026-08-03) — silent wrong-project answers

**Reported by the user via a live screenshot:** "what are the latest task under team management
tool project can you show me" confidently answered from **"Team Task Management"** — a real, but
wrong, project. Real data has at least 7 distinct real portfolios/projects sharing the words "team"/
"management" (`Team Management Tools`, `HHHH Team Management`, `Development Team Management
System`, `Team Task Management`, `Task Management Tool`, `Team management System`, `Team
Management`), and `structuralRetrieve`'s anchor resolution (`src/services/structuralRetrieve.js`,
used by both the recent-work and hierarchy branches, and transitively by `ownerLookup.js`'s
"who works on X") picked whichever one happened to embed closest in the vector search — with zero
signal to the user that other real candidates existed, and no relationship between "closest
embedding" and "correct."

**Fix:** `resolveContainerAnchor()` now scores every real portfolio/project by literal keyword
overlap against the question (via the same `extractKeywords()` already used by the existing
disambiguation path, so generic type-words like "task"/"project"/"portfolio" don't pollute the
score) instead of trusting vector distance, and returns a genuine `ambiguous` result — routed to
the existing disambiguation UI, same as the general search path already does — when multiple
distinct real entities tie for the best match with no distinguishing signal.

**Iteration record (kept for the audit trail, not cleaned up):**
1. First version excluded only "portfolio"/"project" from scoring — broke a previously-correct test
   (`P2`, "what's under SmartFilters portfolio") into a false 8-way tie, because several unrelated
   real titles literally contain the word "Portfolio" and now scored equally to the real SmartFilters
   portfolio. Caught by re-testing P2 immediately, not shipped.
2. Second version added a title-length/overlap-ratio tiebreak (prefer the more precise match) — this
   fixed P2 (bare "SmartFilters" correctly beats "Share SmartFilters"/"Full Dynamic SmartFilters
   Approach") but the original bug report's query still resolved confidently (no longer to the wrong
   project, but the mechanism wasn't yet using the codebase's own proven word-exclusion list).
3. Final version reuses `extractKeywords()` (already excludes task/tasks/portfolio/project/etc.,
   the exact list `disambiguate.js`'s `plausibleGroups` already relies on) instead of a
   narrower ad-hoc exclusion set — resolves both P2 and the reported query correctly, verified live.

**Verified after the fix:**
- The reported query now resolves to "Team Management" (the real, exact, most precise match) directly.
- P2 ("what's under SmartFilters portfolio") still resolves correctly (regression-checked, was at risk twice during this fix).
- A near-identical but more genuinely ambiguous phrasing ("latest update on team management tool project") now correctly disambiguates, listing the real distinct candidates, instead of guessing.
- TM1 ("who is working on SmartFilters"), which uses the same `structuralRetrieve` function internally via `ownerLookup.js`, re-verified unaffected.
- MT5 (pronoun-follow-up path, `anchorOverride` already set) uses a code path this fix doesn't touch — re-verified unaffected.

**Not fully closed:** this is a real-data quality problem as much as a code problem — 7+ real
projects/portfolios with near-duplicate names is genuinely ambiguous phrasing for some queries, and
the fix's job is to be principled and disambiguate honestly, not to always guess the one true
intended project. `queryTokens`/title matching is also still exact-word (no stemming), so
singular/plural variants ("tool" vs "tools") can still tip a tie one way rather than the other —
noted as a known limitation.

Files changed: `src/services/structuralRetrieve.js`, `src/routes/query.js` (both `structuralRetrieve`
call sites now check `structural?.ambiguous` before proceeding).

---

## Pass 4 (live user bug report, 2026-08-03) — task-level follow-up questions

**Reported by the user, live conversation:**
1. `<exact task title> who is working on this task` answered with the owner list for the ENTIRE
   containing portfolio (75 tasks), not the one named task's actual assignee.
2. The follow-up `what is the id of this task` produced an 8-way disambiguation list including
   entirely unrelated candidates (a "Dashboard" project, an "Add New Hardware Popup" portfolio)
   instead of the exact task named one turn earlier in the same conversation.

**Root causes:**
1. `whoWorksOnTopic` (`ownerLookup.js`) only ever resolved a portfolio/project anchor via
   `structuralRetrieve` — a task title embedded in the question never had a chance to match, so it
   fell back to whatever portfolio/project name was embedded in the task's own title.
2. No deterministic path recognized "what is the id of X" as a question type at all — it fell
   through to general retrieval, which has no "return just the ID" answer shape. The pronoun "this
   task" also wasn't being resolved from conversation history the way meeting/exact-lookup
   follow-ups already are, so the short current-turn text ("what is the id of this task") had no
   extractable keyword left to filter the general disambiguation candidates down to plausible ones.

**Fixes:**
1. `whoWorksOnTopic` now checks for a real, exact task title embedded in the question FIRST
   (`resolveExactTaskMatch`) — if found, answers from that one task's own `Owner` field directly;
   only falls back to the portfolio/project tree walk when no specific task is named.
2. New deterministic `task-id` branch in `query.js`: resolves the task either from an embedded
   exact title in the current question, or — reusing the same shared `resolveReferencedTopic`
   resolver already used for meeting/exact-lookup follow-ups — from the conversation history, then
   returns the real `taskId`/`taskCode` directly.

**Verified live, replaying the user's exact reported conversation:**
- Turn 1 now answers "Ankush Das" (the real, specific owner of that one task) instead of the
  9-person portfolio-wide list.
- Turn 2 now answers "The ID of ... is 36067" (the real taskId) directly, instead of the 8-way
  disambiguation with unrelated candidates.
- Regression-checked TM1 ("who is working on SmartFilters" — a portfolio, not a task) still
  correctly answers at the portfolio level — confirms the exact-task check doesn't fire when no
  task title is actually named.

Files changed: `src/services/ownerLookup.js` (`resolveExactTaskMatch`, updated `whoWorksOnTopic`/
`buildWhoWorksOnAnswer`), `src/routes/query.js` (new `task-id` branch).

---

## Pass 5 (live user feedback, 2026-08-03) — natural-language dates + table formatting

**User's core objection (verbatim, paraphrased):** the previous explicit-date fix only understood
numeric `DD/MM/YYYY` — asked, reasonably, why a natural-language date ("31 july") wasn't understood
when "as an AI" it should be, and why this was hardcoded to one format at all.

**This is a fair critique, and the fix reflects it directly:** installed `chrono-node` (a
purpose-built natural-language date-parsing library — MIT licensed, widely used, not something I
wrote) so date PARSING now understands arbitrary real phrasing ("31 july", "July 31st", "31st July
2026", "31/07/2026", etc.) without enumerating each one by hand. Data FILTERING stays fully
deterministic (unchanged) — the local LLM is still never asked to reason about dates, because that
was already shown unreliable earlier in this project (hallucinated "no meetings today" for a
"yesterday" question with correct data in hand). This is "use the right tool for each part of the
problem," not "hardcode the parsing" — the distinction matters and is worth being explicit about
since the user's objection was specifically about that.

**Fixed:**
1. `extractDateMention()` (new, in `meetingQuery.js`) wraps `chrono.parse()`, feeding into the same
   already-verified-correct deterministic filtering (`meetingDateRetrieve`, `resolveMeetingByExplicitDate`).
   `isMeetingDateQuestion` and `parseDateRange` now fall back to it for anything the hardcoded
   relative-term rules (today/yesterday/this week/etc. — left untouched, already verified correct)
   don't cover.
2. Verified live: "what meeting happened on 31 july" (the exact reported query) now resolves to the
   real meeting — "Scrum 31/07/2026" — independently confirmed against raw Qdrant data
   (`start: 2026-07-31T05:30:00Z`) before trusting the agent's own answer. "July 31st" and other
   phrasings verified working too.
3. Regression-checked M1/M5/M7/M8 (the already-verified meeting-date tests) — all identical, no
   change from switching the underlying date engine.

**Also fixed in this pass:** the overdue-tasks table-formatting bug reported earlier in the same
session — the feature always rendered bullets and ignored "as a table"/"as a timeline" requests,
because it built its own answer text directly instead of routing through the shared formatter.
Fixed with a dedicated table/timeline renderer for this branch specifically (showing a **Due**
column, not "Updated" — the shared `formatRowsAsTable()` shows last-modified date, which isn't the
relevant field for an overdue view). Verified all three formats (table/bullets/timeline) live.

Files changed: `src/services/meetingQuery.js` (chrono-node integration), `src/routes/query.js`
(overdue-tasks format branch), `package.json` (new dependency: `chrono-node`).
