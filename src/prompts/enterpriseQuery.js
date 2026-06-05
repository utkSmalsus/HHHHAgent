import { contextPackForPrompt } from '../services/contextPack.js';

export const INSUFFICIENT_DATA_MESSAGE =
  'Insufficient enterprise activity data available.';

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
  if (p.siteType) parts.push(`site=${p.siteType}`);

  const snippet = (c.text || p.text || '').slice(0, 220).replace(/\s+/g, ' ');
  return `${parts.join(' | ')}\n  ${snippet}`;
}

export function buildEnterpriseSystemPrompt() {
  return `You are OMT Enterprise Project Intelligence. You answer questions about project/portfolio work using ONLY the evidence in the user message.

STRICT OUTPUT RULES:
- Write 2-4 sentences of plain business English only.
- Answer the exact topic in the user's question (e.g. "meeting tool" = only meeting-tool-related work from evidence).
- Start directly with the answer. No preamble, no role-play title, no section headings.
- FORBIDDEN: section headings, "Summary of Query Intent", "Business Understanding", "Key Insights", "Enterprise Project Intelligence Report", bracket placeholders like [Green/Yellow/Red] or [briefly explain].
- FORBIDDEN: Qdrant, SharePoint, vectors, metadata, IDs, bullet lists (unless user asked to list items).
- Copy real task names, statuses, and owners verbatim from evidence — never use template placeholders.
- Never invent owners, hours, counts, or progress not stated in the evidence.
- If evidence does not mention the asked topic, reply with exactly: ${INSUFFICIENT_DATA_MESSAGE}`;
}

export function buildEnterpriseUserPrompt({
  userQuestion,
  qdrantContext,
  contextPack,
}) {
  const evidence =
    qdrantContext?.length > 0
      ? qdrantContext.map((c, i) => formatEvidenceRecord(c, i)).join('\n\n')
      : 'No matching records.';

  const packText = contextPack ? contextPackForPrompt(contextPack) : '{}';

  return `USER QUESTION:
${userQuestion}

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
