import {
  dedupeByTitleKey,
  dedupeKey,
  extractOwnersFromText,
  normalizeText,
} from '../utils/textMatch.js';

function groupByType(results) {
  const groups = { portfolio: [], project: [], task: [], timeentry: [] };
  for (const r of results) {
    const t = r.type;
    if (groups[t]) groups[t].push(r);
  }
  return groups;
}

function countUnique(results, type) {
  const items = results.filter((r) => r.type === type);
  const useTitleDedupe = type === 'project' || type === 'portfolio';
  const seen = new Set();
  let count = 0;
  for (const r of items) {
    const key = useTitleDedupe ? dedupeByTitleKey(r.payload || r) : dedupeKey(r.payload || r);
    if (seen.has(key)) continue;
    seen.add(key);
    count += 1;
  }
  return count;
}

function displayName(r) {
  return (
    r.title ||
    r.projectName ||
    r.payload?.title ||
    r.payload?.projectName ||
    (r.text || '').slice(0, 80) ||
    'Untitled'
  );
}

export function buildContextPack(intent, results) {
  const groups = groupByType(results);
  const keywords = intent.keywords;
  const entityLabel = keywords.length ? keywords.join(' ') : 'the query';

  const counts = {
    portfolio: countUnique(results, 'portfolio'),
    project: countUnique(results, 'project'),
    task: countUnique(results, 'task'),
    timeentry: countUnique(results, 'timeentry'),
  };

  const people = new Set();
  for (const r of results) {
    for (const name of extractOwnersFromText(r.text)) {
      people.add(name);
    }
    if (r.authorName) people.add(String(r.authorName).trim());
  }

  const portfolioItems = groups.portfolio.slice(0, 6).map((r) => ({
    name: displayName(r),
    itemType: r.itemType || r.payload?.itemType,
    hierarchyPath: r.hierarchyPath || r.payload?.hierarchyPath,
    structureId: r.payload?.structureId,
    confidence: r.confidence,
  }));

  const topProjects = groups.project.slice(0, 8).map((r) => ({
    name: displayName(r),
    itemType: r.itemType || r.payload?.itemType,
    projectId: r.projectId,
    portfolioId: r.portfolioId,
    hierarchyPath: r.hierarchyPath || r.payload?.hierarchyPath,
    confidence: r.confidence,
    snippet: (r.text || '').slice(0, 200),
  }));

  const topTasks = groups.task.slice(0, 8).map((r) => ({
    name: displayName(r),
    projectName: r.projectName || r.payload?.projectName,
    taskCode: r.taskCode || r.payload?.taskCode,
    siteType: r.siteType || r.payload?.siteType,
    hierarchyPath: r.hierarchyPath || r.payload?.hierarchyPath,
    projectId: r.projectId,
    confidence: r.confidence,
  }));

  const recentTime = groups.timeentry
    .sort((a, b) => String(b.timeDate || b.timestamp).localeCompare(String(a.timeDate || a.timestamp)))
    .slice(0, 8)
    .map((r) => ({
      author: r.authorName || r.payload?.authorName,
      hours: r.timeHours ?? r.payload?.timeHours,
      date: r.timeDate || r.timestamp,
      task: r.payload?.title,
      project: r.projectName || r.payload?.projectName,
      hierarchyPath: r.hierarchyPath || r.payload?.hierarchyPath,
      siteType: r.siteType || r.payload?.siteType,
      confidence: r.confidence,
    }));

  const totalHours = groups.timeentry.reduce((sum, r) => {
    const h = Number(r.timeHours ?? r.payload?.timeHours ?? 0);
    return sum + (Number.isFinite(h) ? h : 0);
  }, 0);

  const hierarchyPaths = [
    ...new Set(
      results
        .map((r) => r.hierarchyPath || r.payload?.hierarchyPath)
        .filter(Boolean)
    ),
  ].slice(0, 5);

  const statuses = [];
  for (const r of [...groups.project, ...groups.task, ...groups.portfolio].slice(0, 12)) {
    const m = (r.text || '').match(/Status:\s*([^.\n]+)/i);
    if (m) statuses.push(m[1].trim());
  }

  const siteTypes = [
    ...new Set(
      groups.task
        .map((r) => r.siteType || r.payload?.siteType)
        .filter(Boolean)
    ),
  ];

  return {
    intent: intent.intent,
    entityLabel,
    keywords,
    entityTypes: intent.entityTypes,
    counts,
    people: [...people].slice(0, 10),
    portfolioItems,
    topProjects,
    topTasks,
    recentTime,
    totalHoursLogged: Math.round(totalHours * 100) / 100,
    hierarchyPaths,
    siteTypes,
    statuses: [...new Set(statuses)].slice(0, 5),
    recordCount: results.length,
  };
}

export function formatDeterministicAnswer(intent, pack, confidence) {
  const label = pack.entityLabel;
  const c = confidence ?? 0;

  if (intent.intent === 'count') {
    const types = intent.entityTypes.length ? intent.entityTypes : ['project'];
    const parts = [];

    for (const type of types) {
      const n = pack.counts[type] ?? 0;
      const name =
        type === 'timeentry'
          ? 'time entries'
          : type === 'portfolio'
            ? 'portfolio items (components/features)'
            : `${type}s`;
      parts.push(`${n} ${name}`);
    }

    if (!parts.length || parts.every((p) => p.startsWith('0 '))) {
      return {
        answer: `No matching ${types.join(' or ')} records were found for "${label}" in the indexed enterprise data.`,
        confidence: c,
      };
    }

    const joined = parts.join(', ');
    return {
      answer: `Based on the indexed SharePoint hierarchy data, there are ${joined} related to "${label}".`,
      confidence: c,
      counts: pack.counts,
    };
  }

  if (intent.intent === 'who') {
    if (!pack.people.length) {
      return {
        answer: `No clear owners or contributors were found in the indexed records for "${label}".`,
        confidence: c,
      };
    }
    const names = pack.people.slice(0, 5).join(', ');
    return {
      answer: `People associated with "${label}" in tasks and time entries include: ${names}.`,
      confidence: c,
      people: pack.people,
    };
  }

  if (intent.intent === 'time' && pack.totalHoursLogged > 0) {
    const contributors = pack.recentTime
      .map((t) => t.author)
      .filter(Boolean)
      .slice(0, 5)
      .join(', ');
    return {
      answer: `Indexed time entries for "${label}" total approximately ${pack.totalHoursLogged} hours${
        contributors ? `, with recent logging by ${contributors}` : ''
      }.`,
      confidence: c,
    };
  }

  if (intent.intent === 'list') {
    const portfolioNames = pack.portfolioItems.map((p) => p.name).filter(Boolean);
    const projectNames = pack.topProjects.map((p) => p.name).filter(Boolean);
    const taskNames = pack.topTasks.map((t) => t.name).filter(Boolean);

    if (portfolioNames.length && intent.entityTypes.includes('portfolio')) {
      return {
        answer: `Matching portfolio items for "${label}": ${portfolioNames.slice(0, 10).join(', ')}.`,
        confidence: c,
      };
    }
    if (projectNames.length) {
      return {
        answer: `Matching projects/sprints/cycles for "${label}": ${projectNames.slice(0, 10).join(', ')}.`,
        confidence: c,
      };
    }
    if (taskNames.length) {
      return {
        answer: `Matching tasks for "${label}": ${taskNames.slice(0, 10).join(', ')}.`,
        confidence: c,
      };
    }
    return {
      answer: `No matching items were found for "${label}".`,
      confidence: c,
    };
  }

  return null;
}

export function contextPackForPrompt(pack) {
  if (!pack) return '{}';
  return JSON.stringify(
    {
      intent: pack.intent,
      searchTerms: pack.keywords,
      hierarchySummary: pack.hierarchyPaths || [],
      counts: pack.counts || {},
      portfolioItems: pack.portfolioItems || [],
      projects: (pack.topProjects || []).map((p) => ({
        name: p.name,
        type: p.itemType,
        path: p.hierarchyPath,
      })),
      tasks: (pack.topTasks || []).map((t) => ({
        name: t.name,
        project: t.projectName,
        site: t.siteType,
        path: t.hierarchyPath,
      })),
      timeActivity: pack.recentTime || [],
      totalHoursInEvidence: pack.totalHoursLogged || 0,
      people: pack.people || [],
      sites: pack.siteTypes || [],
      statusesSeen: pack.statuses || [],
    },
    null,
    2
  );
}
