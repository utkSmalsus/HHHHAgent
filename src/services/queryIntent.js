import { extractKeywords, normalizeText, queryTokens } from '../utils/textMatch.js';

const TYPE_ALIASES = {
  portfolio: [
    'portfolio',
    'portfolios',
    'component',
    'components',
    'subcomponent',
    'sub component',
    'sub components',
    'feature',
    'features',
    'capability',
    'workstream',
    'program',
  ],
  project: [
    'project',
    'projects',
    'sprint',
    'sprints',
    'cycle',
    'cycles',
    'initiative',
    'initiatives',
    'delivery',
  ],
  task: ['task', 'tasks', 'work item', 'work items'],
  timeentry: [
    'time entry',
    'time entries',
    'timeentry',
    'timesheet',
    'timesheets',
    'time sheet',
    'hours logged',
    'effort',
  ],
};

function detectEntityTypes(question) {
  const q = normalizeText(question);
  const types = [];

  for (const [type, aliases] of Object.entries(TYPE_ALIASES)) {
    if (aliases.some((a) => q.includes(a))) types.push(type);
  }

  return types;
}

export function parseQueryIntent(question) {
  const q = normalizeText(question);
  const keywords = extractKeywords(question);
  const entityTypes = detectEntityTypes(question);

  let intent = 'summary';

  if (/\bhow many\b|\bcount\b|\bnumber of\b|\btotal\b/.test(q)) {
    intent = 'count';
  } else if (/\bwho\b|\bworking on\b|\bassigned\b|\bowners?\b|\bcontributors?\b/.test(q)) {
    intent = 'who';
  } else if (/\blist\b|\bshow all\b|\bname all\b/.test(q)) {
    intent = 'list';
  } else if (
    /\btime\b|\bhours\b|\beffort\b|\bspent\b|\blogged\b|\btimesheet\b|\butilization\b/.test(q)
  ) {
    intent = 'time';
  } else if (/\bstatus\b|\bprogress\b|\bblocker\b|\bcompletion\b|\beod\b/.test(q)) {
    intent = 'status';
  } else if (/\brisk\b|\bdelay\b|\boverdue\b|\bstuck\b/.test(q)) {
    intent = 'risk';
  }

  if (intent === 'count' && entityTypes.length === 0) {
    if (/\bportfolio\b/.test(q)) entityTypes.push('portfolio');
    else if (/\btask\b/.test(q)) entityTypes.push('task');
    else if (/\btime\b/.test(q)) entityTypes.push('timeentry');
    else entityTypes.push('project');
  }

  if (intent === 'summary' && entityTypes.length === 0) {
    entityTypes.push('project', 'task', 'portfolio', 'timeentry');
  }

  if (intent === 'who' && entityTypes.length === 0) {
    entityTypes.push('task', 'timeentry', 'project');
  }

  if (intent === 'time') {
    if (!entityTypes.includes('timeentry')) entityTypes.push('timeentry');
    if (entityTypes.length === 1 && entityTypes[0] === 'timeentry') {
      entityTypes.push('task', 'project');
    }
  }

  if (intent === 'risk' && entityTypes.length === 0) {
    entityTypes.push('task', 'project', 'portfolio');
  }

  const hierarchy =
    intent === 'count' || intent === 'list'
      ? entityTypes
      : ['portfolio', 'project', 'task', 'timeentry'];

  return {
    intent,
    keywords,
    entityTypes: [...new Set(entityTypes)],
    hierarchy: [...new Set(hierarchy)],
    rawQuestion: question,
    tokens: queryTokens(question),
  };
}
