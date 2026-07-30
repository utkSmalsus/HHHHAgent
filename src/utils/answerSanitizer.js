export const INSUFFICIENT_DATA_MESSAGE =
  'Insufficient enterprise activity data available.';

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

export function sanitizeEnterpriseAnswer(answer, userQuestion = '') {
  let text = String(answer || '').trim();
  if (!text) return INSUFFICIENT_DATA_MESSAGE;

  for (const re of META_PATTERNS) {
    text = text.replace(re, '');
  }

  text = text
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text || isMetaOrInstructionalAnswer(text)) {
    return INSUFFICIENT_DATA_MESSAGE;
  }

  const wordCount = text.split(/\s+/).filter((w) => w.length > 2).length;
  if (wordCount < 6 && !/insufficient/i.test(text)) {
    return INSUFFICIENT_DATA_MESSAGE;
  }

  return text;
}
