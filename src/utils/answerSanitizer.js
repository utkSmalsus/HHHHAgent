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
    : text
        .replace(/\[[^\]]*\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

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
