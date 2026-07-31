/**
 * Deterministic presentation formatters — render already-retrieved records as markdown
 * bullets/table/timeline with no LLM involved, so the layout is exactly what was asked for
 * (a local model can't be trusted to follow "give me a table" reliably) and the data itself
 * stays byte-for-byte accurate, same principle as exactLookup.js.
 */
import { itemDate, itemStatus, rawDescription } from './textMatch.js';

const FORMAT_RE = {
  table: /\b(as a table|in a table|tabular|table format|table view)\b/i,
  timeline: /\b(timeline|chronological(ly)?|in order of date|by date)\b/i,
  bullets: /\b(bullet points?|bulleted|in points|as a list|in list form|list format)\b/i,
};

/**
 * Force free-text prose into real bullet lines — for spots (like meeting-detail) with no
 * structured "rows" to run through formatRows(), so the LLM itself was asked to write bullets
 * directly. Local models are unreliable at that (often write one flowing paragraph despite the
 * instruction), so this deterministically guarantees real line breaks either way: if the model
 * DID produce "- "/"* " lines, they're just cleaned up; otherwise the prose is split at sentence
 * boundaries and each sentence becomes its own bullet.
 */
export function forceBulletLines(text) {
  const clean = String(text || '').trim();
  if (!clean) return '';
  if (/^[-*•]\s/m.test(clean)) {
    const lines = clean
      .split(/\n+/)
      .map((l) => l.replace(/^[-*•]\s*/, '').trim())
      .filter(Boolean);
    return lines.map((l) => `- ${l}`).join('\n');
  }
  const sentences = clean
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter(Boolean);
  return (sentences.length ? sentences : [clean]).map((s) => `- ${s}`).join('\n');
}

/** @returns {'table' | 'timeline' | 'bullets' | null} */
export function detectPresentationFormat(question) {
  const q = String(question || '');
  if (FORMAT_RE.table.test(q)) return 'table';
  if (FORMAT_RE.timeline.test(q)) return 'timeline';
  if (FORMAT_RE.bullets.test(q)) return 'bullets';
  return null;
}

// Words meaning "reformat what you just told me", not a new topic — e.g. "show that as bullets",
// "give me the above as a table". Retrieval for a question made entirely of these (plus the format
// trigger itself) has no real topic to search for and always fails with "couldn't find anything".
const REFORMAT_META_WORDS = new Set([
  'show', 'me', 'give', 'list', 'display', 'put', 'present', 'in', 'as', 'a', 'an', 'the', 'of',
  'it', 'that', 'this', 'above', 'previous', 'last', 'prior', 'ans', 'answer', 'answers', 'format',
  'view', 'form', 'please', 'can', 'you', 'again', 'same', 'data', 'result', 'results', 'one',
]);
const FORMAT_WORD_RE = /\b(bullet|bullets|bulleted|points?|table|tabular|timeline|chronological(?:ly)?|list|form|view|format)\b/gi;

/** True when the question is ONLY asking to reformat the previous answer, naming no new topic. */
export function isPureReformatRequest(question) {
  const stripped = String(question || '')
    .toLowerCase()
    .replace(FORMAT_WORD_RE, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !REFORMAT_META_WORDS.has(w));
  return stripped.length === 0;
}

export function formatRowsAsBullets(rows) {
  return rows
    .map((p) => {
      const date = itemDate(p) ? ` — ${String(itemDate(p)).slice(0, 10)}` : '';
      const desc = rawDescription(p.text) || itemStatus(p) || '';
      return `- **${p.title || 'Untitled'}**${date}${desc ? `: ${desc}` : ''}`;
    })
    .join('\n');
}

export function formatRowsAsTable(rows) {
  const header = '| Title | Type | Status | Updated |';
  const sep = '|---|---|---|---|';
  const lines = rows.map((p) => {
    const title = String(p.title || 'Untitled').replace(/\|/g, '/');
    const type = p.type || p.itemType || '-';
    const status = itemStatus(p) || '-';
    const date = itemDate(p) ? String(itemDate(p)).slice(0, 10) : '-';
    return `| ${title} | ${type} | ${status} | ${date} |`;
  });
  return [header, sep, ...lines].join('\n');
}

export function formatRowsAsTimeline(rows) {
  const sorted = [...rows].sort(
    (a, b) => (Date.parse(itemDate(b)) || 0) - (Date.parse(itemDate(a)) || 0)
  );
  return formatRowsAsBullets(sorted);
}

/** @returns {string | null} formatted markdown, or null when there's nothing to format */
export function formatRows(format, rows) {
  if (!rows?.length) return null;
  if (format === 'table') return formatRowsAsTable(rows);
  if (format === 'timeline') return formatRowsAsTimeline(rows);
  if (format === 'bullets') return formatRowsAsBullets(rows);
  return null;
}
