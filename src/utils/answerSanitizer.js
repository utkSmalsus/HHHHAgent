/**
 * Shown whenever the agent has no indexed evidence to answer from. It answers ONLY from the
 * ingested SharePoint data, so this doubles as the "that's outside what I cover" reply — say so
 * plainly and point at what can be asked instead.
 */
export const INSUFFICIENT_DATA_MESSAGE =
  "I can only answer from your indexed OMT data — portfolio items, projects, tasks, time entries and meetings — and I couldn't find anything matching that. Try naming a specific project, task, or meeting.";

const META_PATTERNS = [
  /Enterprise Project Intelligence(?:\s+Assistant|\s+Report)?:?\s*/gi,
  /OMT Enterprise Project Intelligence[^.]*\.?\s*/gi,
  /Summary of Query Intent:?:?\s*/gi,
  /Business Understanding:?:?\s*/gi,
  /Key Insights:?:?\s*/gi,
  /Query Intent:?:?\s*/gi,
  /Recent Activity:?:?\s*/gi,
  /EXECUTIVE NARRATIVE MODE[^.]*\.?\s*/gi,
  /Roll up across the full hierarchy[^.]*\.\s*/gi,
  /The system will provide[^.]*\.\s*/gi,
  /It will roll up evidence[^.]*\.\s*/gi,
  /Your responsibility is[^.]*\.\s*/gi,
  /Use this hierarchy when reasoning[^.]*\.\s*/gi,
  /The current project status is\s*/gi,
];

const META_CONTENT_RE =
  /query intent|business understanding|key insights|the system will|roll up across the full hierarchy|will provide an overall business|please provide a question|enterprise data model|reasoning rules|to get started|enterprise project intelligence report/i;

const HEADING_PATTERN =
  /^(verdict|key findings|recommendation|recommendations|next steps|summary|overall conclusion|business understanding|key insights|query intent|recent activity|enterprise project intelligence report):?$/i;

/**
 * Flattens an LLM's markdown-formatted answer (headings, **bold**, "- " / "1. " list markers,
 * one bullet per line) into clean flowing prose — stripping markers per-line BEFORE collapsing
 * newlines, so "- item\n- item" becomes "item. item." instead of a run-on "- item - item" once
 * the newlines are gone. Every provider's raw output goes through this the same way, so answer
 * quality doesn't depend on which model happens to also self-format like Ollama's does.
 */
export function normalizePlainBusinessAnswer(answer) {
  const lines = answer
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^\*\*(.+?):?\*\*:?\s*$/, '$1:').trim())
    .filter((line) => !HEADING_PATTERN.test(line.replace(/:$/, '')))
    .map((line) => line.replace(/^[-*•]\s+/, '').trim())
    .map((line) => line.replace(/^\d+\.\s+/, '').trim())
    .map((line) => line.replace(/^Task\s*\d+\s*[:.)-]?\s*/i, '').trim())
    .filter(Boolean);

  let text = lines.join(' ');
  text = text
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\*\*/g, '')
    .replace(/^Summary of [^:]+:\s*/i, '')
    .replace(/\bConclusion:\s*/gi, 'Overall, ')
    .replace(/Based on the provided context and evidence,\s*/gi, '')
    .replace(/Based on the provided Qdrant context and SharePoint structured data,\s*/gi, '')
    .replace(/Based on the provided context,\s*/gi, '')
    .replace(/The key findings include:\s*/gi, '')
    .replace(/Overall,\s*:\s*/gi, 'Overall, ')
    .replace(/\s+\d+\.\s+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/The tasks related to ([^.]+?) include:/i, 'The work around $1 includes')
    .replace(/The overall conclusion is that\s+/i, 'Overall, ')
    .trim();

  const sentences = text.match(/[^.!?]+[.!?]+/g);
  if (sentences?.length > 4) {
    text = sentences.slice(0, 4).join(' ').trim();
  }

  return text || answer;
}

export function hasTemplatePlaceholders(text) {
  return (
    /\[[^\]]{3,}\]/.test(text) ||
    /\[Green\/Yellow\/Red\]/i.test(text) ||
    /\[briefly explain/i.test(text) ||
    /\[List recent activity/i.test(text) ||
    /e\.?\s*g\.?\s*,/i.test(text) && /\[/.test(text)
  );
}

export function isMetaOrInstructionalAnswer(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (hasTemplatePlaceholders(t)) return true;
  if (META_CONTENT_RE.test(t)) return true;
  if (/^Enterprise Project Intelligence/i.test(t)) return true;
  if ((t.match(/:?:\s*/g) || []).length >= 2 && /Understanding|Insights|Intent|Activity/i.test(t)) {
    return true;
  }
  return false;
}

/**
 * @param {boolean} [preserveStructure] - keep newlines (only squash runs of spaces/tabs and
 *   excess blank lines) instead of collapsing everything to one line. Needed whenever the LLM
 *   itself was asked to produce a bullet list / table (e.g. meeting-detail's format instruction,
 *   which has no deterministic formatRows() equivalent to bypass this sanitizer) — collapsing all
 *   whitespace would otherwise flatten "- item\n- item" into one run-on paragraph.
 */
export function sanitizeEnterpriseAnswer(answer, userQuestion = '', preserveStructure = false) {
  let text = String(answer || '').trim();
  if (!text) return INSUFFICIENT_DATA_MESSAGE;

  for (const re of META_PATTERNS) {
    text = text.replace(re, '');
  }

  text = preserveStructure
    ? text
        .replace(/\[[^\]]*\]/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    : normalizePlainBusinessAnswer(text);

  if (!text || isMetaOrInstructionalAnswer(text)) {
    return INSUFFICIENT_DATA_MESSAGE;
  }

  // Too-short replies are almost always the model failing rather than answering — swap in the
  // scope message. (Our own message is exempt so it never gets recursively replaced.)
  const wordCount = text.split(/\s+/).filter((w) => w.length > 2).length;
  if (wordCount < 6 && text !== INSUFFICIENT_DATA_MESSAGE) {
    return INSUFFICIENT_DATA_MESSAGE;
  }

  return text;
}
