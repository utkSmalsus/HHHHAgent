/**
 * Structural (hierarchy-aware) retrieval.
 *
 * Flat vector search can't reliably answer "what's under X" / "structure of X".
 * The ingested points already carry the tree links (portfolio/project via parentId,
 * tasks via projectId/portfolioId), so we resolve an anchor by vector search, then
 * walk descendants by ID and hand the real subtree to the LLM. No re-ingest needed.
 */
import { scrollPayloads } from './qdrantScroll.js';
import { searchKnowledge } from './qdrant.js';

const HIERARCHY_RE =
  /\b(under|within|inside|structure of|break\s?down|hierarchy|children of|child items|sub[- ]?(items|components|tasks|features)|all (tasks|projects|items|features|components|sub ?components)\b.*\b(in|under|of|for|below)|belongs? to|part of|contained in|what'?s (in|under)|list (the )?(tasks|projects|items|features|components)\b.*\b(in|under|for|of))\b/i;

export function isHierarchyQuestion(question) {
  return HIERARCHY_RE.test(String(question || ''));
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * @returns {Promise<null | { anchor: object, masters: object[], tasks: object[], descendantIds: Set<number> }>}
 */
export async function structuralRetrieve(question) {
  const all = await scrollPayloads({ types: ['portfolio', 'project', 'task'], limit: 20000 });
  if (!all.length) return null;

  const byId = new Map();
  for (const p of all) {
    const id = num(p.sharePointItemId);
    if (id && !byId.has(id)) byId.set(id, p);
  }

  // Anchor = the container the user named. Prefer a portfolio/project over a task.
  const hits = await searchKnowledge(question, 8);
  const anchor =
    (hits.find((h) => h.payload && (h.payload.type === 'portfolio' || h.payload.type === 'project'))
      || hits[0])?.payload;
  const anchorId = num(anchor?.sharePointItemId);
  if (!anchor || !anchorId) return null;

  // Master tree: children keyed by parentId.
  const childrenOf = new Map();
  for (const p of all) {
    if (p.type !== 'portfolio' && p.type !== 'project') continue;
    const par = num(p.parentId);
    if (!par) continue;
    if (!childrenOf.has(par)) childrenOf.set(par, []);
    childrenOf.get(par).push(p);
  }

  // BFS descendant master ids (anchor included).
  const descendantIds = new Set([anchorId]);
  const queue = [anchorId];
  while (queue.length) {
    const cur = queue.shift();
    for (const child of childrenOf.get(cur) || []) {
      const cid = num(child.sharePointItemId);
      if (cid && !descendantIds.has(cid)) {
        descendantIds.add(cid);
        queue.push(cid);
      }
    }
  }

  const masters = [...descendantIds].map((id) => byId.get(id)).filter(Boolean);
  const tasks = all.filter(
    (p) => p.type === 'task' && (descendantIds.has(num(p.projectId)) || descendantIds.has(num(p.portfolioId)))
  );

  return { anchor, masters, tasks, descendantIds };
}

/** Compact, deterministic rendering of the subtree for the LLM prompt. */
export function buildStructuralPrompt(question, structural) {
  const { anchor, masters, tasks } = structural;
  const line = (p) => {
    const status = p.status || (String(p.text || '').match(/Status:\s*([^.,]+)/i)?.[1] || '').trim();
    const kind = p.itemType || p.type;
    return `- ${p.title || 'Untitled'}${kind ? ` [${kind}]` : ''}${status ? ` (status: ${status})` : ''}`;
  };

  // anchor is first in masters; list the rest as its descendants.
  const descMasters = masters.filter((m) => num(m.sharePointItemId) !== num(anchor.sharePointItemId));
  const MAX = 80;
  const mastersText = descMasters.slice(0, MAX).map(line).join('\n') || '(none)';
  const tasksText = tasks.slice(0, MAX).map(line).join('\n') || '(none)';
  const more = (n, cap) => (n > cap ? `\n…and ${n - cap} more` : '');

  const system =
    'You are HHHH Agent. You are given the EXACT structure of one item from the ' +
    'knowledge base (its sub-components/projects and tasks). Answer the user\'s question using ONLY ' +
    'this structure. When listing, use the real titles verbatim. State counts when asked. ' +
    'Do NOT invent items, statuses, or owners. Keep it clear and concise.';

  const user = `USER QUESTION:
${question}

ANCHOR ITEM: "${anchor.title}" (type: ${anchor.type}${anchor.hierarchyPath ? `, path: ${anchor.hierarchyPath}` : ''})

SUB-COMPONENTS / PROJECTS UNDER IT (${descMasters.length} total):
${mastersText}${more(descMasters.length, MAX)}

TASKS UNDER IT (${tasks.length} total):
${tasksText}${more(tasks.length, MAX)}

Answer the question about "${anchor.title}" using only the structure above.`;

  return { system, user };
}
