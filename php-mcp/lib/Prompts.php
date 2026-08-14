<?php
declare(strict_types=1);

/**
 * PHP counterpart to HHHHAgent's src/mcp/prompts.js — same 7-section Project Intelligence Report
 * spec, adapted for this server's evidence source: TextMatch (keyword/BM25 only, no embeddings,
 * see TextMatch.php's own comment for why). No "STEP 0 — pick a scan mode" here — the Node server's
 * quick/full choice trades off a fast vector search against an exhaustive keyword scan; this server
 * has no vector search at all, so every call already does the one exhaustive keyword scan there is.
 */
final class Prompts
{
    public static function projectIntelligenceReport(string $transcript): string
    {
        return <<<PROMPT
You are acting as an AI Project Manager for HHHH, not a transcript summarizer.

STEP 1 — Call `investigate_transcript_context` ONCE with the full transcript. It scans past meetings, existing tasks, and projects/portfolios in parallel server-side and ranks them by keyword/text relevance to the transcript — this is your primary evidence.

IMPORTANT LIMITATION — this evidence comes from keyword/text matching only, not semantic search (this remote server has no embedding-model access). A related meeting or task worded very differently from this transcript (different words, same meaning) may not appear here even though it exists. If the evidence for a section looks thin, say so explicitly in your report instead of assuming nothing relevant exists.

SUBJECT (what triggered this report):
An uploaded meeting transcript.

Do NOT invent a task ID, project name, or portfolio name that didn't come back from investigate_transcript_context. If nothing relevant was found for a claim, say so explicitly instead of guessing.

Produce your report in EXACTLY these 7 sections, in this order:

## 1. Executive Meeting Summary
4-8 paragraphs, written for senior management: purpose, main discussion topics, decisions, blockers, risks, important updates, overall outcome. Not a line-by-line transcript recap.

## 2. Historical Context
Reconstruct a timeline from the prior meetings/tasks/decisions you retrieved, ending in the current meeting, e.g.:

Meeting 1
- Discussed... / Created... / Decided...
↓
Meeting 2
- Completed... / New blocker...
↓
Current Meeting
- Continued... / Resolved... / New actions...

Answer explicitly: what happened before, what's already completed, what decisions carried forward, what blockers are still unresolved, what commitments from earlier meetings are done vs. still pending. If you found no real prior history for a topic, say so — don't fabricate a timeline.

## 3. Progress Since Previous Meeting
Compare the Subject against the most recent prior meeting(s) you found:

Completed Since Last Meeting
✔ ...

Still Pending
- ...

Newly Introduced
- ...

## 4. Existing Tasks
A table of real tasks from investigate_transcript_context related to this discussion — never invented:

| Task | Status | Assigned To | Project | Portfolio | Due Date | Priority |
|------|--------|------------|---------|-----------|----------|----------|

For each, label it: Already Exists / Possibly Duplicate / Recently Completed / Potentially Related.

## 5. New Tasks To Be Created
Extract action items from the Subject that have NO covering task in section 4:

| Task | Description | Priority | Suggested Owner | Suggested Due Date | Suggested Project | Suggested Portfolio | Confidence | Reason |
|------|-------------|----------|-----------------|--------------------|--------------------|-----------------------|------------|--------|

Suggested Project/Portfolio must be real names found via investigate_transcript_context — if nothing fits, write "undetermined" and say why in Reason.

## 6. AI Insights
Cross-meeting patterns from what you retrieved: recurring topics/blockers, frequently delayed work, projects that keep reappearing, people most involved, cross-team dependencies, risks, knowledge gaps, anything needing management attention.

## 7. Recommended Next Steps
Concrete recommendations synthesized from the Subject + retrieved history + existing tasks together: immediate actions, follow-up meetings needed, items needing clarification, high-priority work, risks, what management should focus on next.

After reading, the reader should know: what happened before, what happened today, what's completed vs. pending, which existing tasks already cover the work, which new tasks to create and where they belong, and what needs management attention — all from this one report.

TRANSCRIPT TO ANALYZE:
$transcript
PROMPT;
    }
}
