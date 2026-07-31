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

/** @returns {'table' | 'timeline' | 'bullets' | null} */
export function detectPresentationFormat(question) {
  const q = String(question || '');
  if (FORMAT_RE.table.test(q)) return 'table';
  if (FORMAT_RE.timeline.test(q)) return 'timeline';
  if (FORMAT_RE.bullets.test(q)) return 'bullets';
  return null;
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
