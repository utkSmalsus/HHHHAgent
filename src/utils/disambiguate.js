/**
 * Entity disambiguation — the piece that was missing from "keyword-match everything, sort by
 * date" retrieval: real SharePoint data has near-duplicate names (e.g. 21 different "Team
 * Management ..." projects/portfolios). Silently picking whichever loose match is newest gives
 * a confident-sounding answer about the WRONG project. A real search doesn't guess when there
 * are several plausible distinct hits — it surfaces them. This does that.
 */
import { extractKeywords, normalizeText } from './textMatch.js';

/** Group items into "the same real thing" buckets by normalized display title. */
export function groupByEntity(items, titleOf = (p) => p?.title || p?.projectName || '') {
  const groups = new Map();
  for (const item of items) {
    const key = normalizeText(titleOf(item));
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { title: titleOf(item), items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()];
}

/**
 * Drop groups that only got pulled in via loose full-text/vector similarity on unrelated
 * fields (description text, hierarchy path, etc.) — keep only groups whose own TITLE shares a
 * keyword with the question, so the disambiguation list stays genuinely plausible candidates.
 */
export function plausibleGroups(groups, question) {
  const keywords = extractKeywords(question);
  if (!keywords.length) return groups;
  return groups.filter((g) => {
    const t = normalizeText(g.title);
    return keywords.some((k) => t.includes(k));
  });
}

export const tsOf = (p) => Date.parse(p?.timestamp || p?.start || '') || 0;

/** One representative candidate per group (its most recently updated item), newest first. */
export function toCandidates(groups, limit = 8) {
  return groups
    .map((g) => {
      const latest = [...g.items].sort((a, b) => tsOf(b) - tsOf(a))[0];
      return {
        title: g.title,
        type: latest.type || latest.itemType,
        hierarchyPath: latest.hierarchyPath,
        timestamp: latest.timestamp || latest.start,
        count: g.items.length,
      };
    })
    .sort((a, b) => tsOf(b) - tsOf(a))
    .slice(0, limit);
}

/** Deterministic, no-LLM disambiguation message — never fabricate a narrative from ambiguous evidence. */
export function buildDisambiguationAnswer(candidates) {
  const lines = candidates.map((c) => {
    const date = c.timestamp ? ` — updated ${String(c.timestamp).slice(0, 10)}` : '';
    const type = c.type ? ` (${c.type})` : '';
    return `- **${c.title}**${type}${date}`;
  });
  return (
    `That matches ${candidates.length} different items in your data — which one did you mean?\n\n` +
    lines.join('\n')
  );
}

/** Clickable follow-ups: re-asking with the exact title resolves unambiguously next time. */
export function buildDisambiguationSuggestions(candidates) {
  return candidates.map((c) => ({ label: c.title, question: c.title }));
}
