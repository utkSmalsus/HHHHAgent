import { contextPackForPrompt } from '../services/contextPack.js';

// Re-exported, not redefined: ollama.js compares answers against this exact string, so a second
// copy that drifted out of sync would silently break that comparison.
export { INSUFFICIENT_DATA_MESSAGE } from '../utils/answerSanitizer.js';

function formatEvidenceRecord(c, index) {
  const p = c.payload || c;
  const type = c.type || p.type || 'unknown';
  const title = c.title || p.title || c.projectName || p.projectName || 'Untitled';
  const parts = [`[${index + 1}] ${type}: "${title}"`];

  if (p.hierarchyPath) parts.push(`path=${String(p.hierarchyPath).slice(0, 100)}`);
  if (p.itemType) parts.push(`kind=${p.itemType}`);
  if (p.projectName && p.projectName !== title) parts.push(`project=${p.projectName}`);
  const statusFromText = (c.text || p.text || '').match(/Status:\s*([^.,]+)/i);
  const status = p.status || statusFromText?.[1];
  if (status) parts.push(`status=${status}`);
  if (p.authorName) parts.push(`author=${p.authorName}`);
  if (p.timeHours != null) parts.push(`hours=${p.timeHours}`);
  if (p.timeDate) parts.push(`date=${p.timeDate}`);
  if (p.timestamp) parts.push(`updated=${String(p.timestamp).slice(0, 10)}`);
  if (p.siteType) parts.push(`site=${p.siteType}`);

  const snippet = (c.text || p.text || '').slice(0, 220).replace(/\s+/g, ' ');
  return `${parts.join(' | ')}\n  ${snippet}`;
}

export function buildEnterpriseSystemPrompt() {
  return `You are HHHH Agent. You answer questions about project/portfolio work using ONLY the evidence in the user message.

HOW TO ANSWER:
- SYNTHESIZE a real summary — do NOT just list task titles back. Describe what the work is ABOUT: the main focus areas / themes, the overall progress (roughly how many items are in progress vs completed vs not started), and what is actively happening now.
- Write 3-6 sentences of flowing business English, like a project lead briefing a colleague. Group related work into themes rather than enumerating every record.
- You may name 2-3 of the most important tasks as concrete examples, but examples support the summary — they are not the summary. Never dump a bare list of titles.
- Answer the topic in the user's question using the MOST RELEVANT evidence records. Treat spelling and spacing variants as the same topic (e.g. "web studio" = "Webstudio", "meeting tool" = "MeetingTool").
- The evidence records were already retrieved as relevant — assume they are on-topic and summarize them. Do not demand an exact literal string match.
- Start directly with the answer. No preamble, no role-play title, no section headings.
- FORBIDDEN: section headings, "Summary of Query Intent", "Business Understanding", "Key Insights", "Enterprise Project Intelligence Report", bracket placeholders like [Green/Yellow/Red] or [briefly explain].
- FORBIDDEN: Qdrant, SharePoint, vectors, metadata, IDs, and bullet-point lists of task titles.
- Use only real names/statuses from the evidence — never invent owners, hours, counts, progress, or task names not present in the evidence.
- The evidence records have ALREADY been filtered for relevance to the question. ALWAYS write an answer that summarizes them. Do not reply that data is insufficient — you always have relevant records to work with here.`;
}

export function buildEnterpriseUserPrompt({
  userQuestion,
  qdrantContext,
  contextPack,
  recency = false,
}) {
  const evidence =
    qdrantContext?.length > 0
      ? qdrantContext.map((c, i) => formatEvidenceRecord(c, i)).join('\n\n')
      : 'No matching records.';

  const packText = contextPack ? contextPackForPrompt(contextPack) : '{}';

  const recencyNote = recency
    ? `\nRECENCY: The user is asking about the LATEST / most recent work. Records are sorted newest-first and each shows updated=YYYY-MM-DD. Lead with the most recently updated items, say how recent they are, and ignore clearly old records unless nothing recent exists.\n`
    : '';

  return `USER QUESTION:
${userQuestion}
${recencyNote}
AGGREGATED FACTS (use for counts and rollups):
${packText}

EVIDENCE RECORDS (only source of truth — do not use anything else):
${evidence}

Write your answer now about "${userQuestion}". Use only the evidence above.`;
}

/** @deprecated Use buildEnterpriseMessages — kept for compatibility */
export function buildEnterprisePrompt(opts) {
  const { system, user } = buildEnterpriseMessages(opts);
  return `${system}\n\n${user}`;
}

export function buildEnterpriseMessages(opts) {
  return {
    system: buildEnterpriseSystemPrompt(),
    user: buildEnterpriseUserPrompt(opts),
  };
}
