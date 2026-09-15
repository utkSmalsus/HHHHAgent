/**
 * SharePoint list mapping (from .env):
 *
 *   SP_TASKS              → single default task list (optional if SP_TASKS_* set)
 *   SP_TASKS_HHHH         → per-site task lists (siteType = HHHH)
 *   SP_TASKS_QA           → per-site task lists (siteType = QA)
 *   SP_SITE_HHHH          → optional Graph site ID override per alias
 *   SP_MASTER_TASK        → portfolio + projects (same list, filtered by Item_x0020_Type)
 *   SP_TIMSHEET1/2        → timeentries (AdditionalTimeEntry slices)
 *   SHAREPOINT_SITE_ID    → default site for all lists
 */

export function parseSharePointSites() {
  const sites = {};

  if (process.env.SHAREPOINT_SITE_ID) {
    sites.DEFAULT = process.env.SHAREPOINT_SITE_ID;
  }

  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('SP_SITE_') && value) {
      sites[key.slice('SP_SITE_'.length)] = value;
    }
  }

  return sites;
}

function resolveSiteId(sites, alias) {
  if (alias && sites[alias]) return sites[alias];
  return sites.DEFAULT || null;
}

function buildTaskSources(sites) {
  const taskSources = [];

  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('SP_TASKS_') || !value) continue;
    const siteType = key.slice('SP_TASKS_'.length);
    const siteAlias = process.env[`SP_LIST_${siteType}_SITE`] || siteType;
    taskSources.push({
      listId: value,
      envVar: key,
      siteType,
      siteAlias,
      siteId: resolveSiteId(sites, siteAlias),
    });
  }

  if (!taskSources.length && process.env.SP_TASKS) {
    const siteAlias = process.env.SP_TASKS_SITE || 'DEFAULT';
    taskSources.push({
      listId: process.env.SP_TASKS,
      envVar: 'SP_TASKS',
      siteType: process.env.SP_TASKS_SITE_TYPE || 'DEFAULT',
      siteAlias,
      siteId: resolveSiteId(sites, siteAlias),
    });
  }

  return taskSources;
}

/** @returns {Record<string, import('./sharepointTypes.js').IngestSource>} */
export function buildIngestSources(sites) {
  const siteId = sites.DEFAULT;
  const siteAlias = 'DEFAULT';

  const sources = {};
  const taskSources = buildTaskSources(sites);

  if (taskSources.length) {
    sources.tasks = {
      listKey: 'tasks',
      type: 'task',
      siteAlias,
      siteId,
      taskSources,
    };
  }

  if (process.env.SP_MASTER_TASK) {
    sources.portfolio = {
      listKey: 'portfolio',
      listId: process.env.SP_MASTER_TASK,
      envVar: 'SP_MASTER_TASK',
      type: 'portfolio',
      siteAlias,
      siteId,
    };
    sources.projects = {
      listKey: 'projects',
      listId: process.env.SP_MASTER_TASK,
      envVar: 'SP_MASTER_TASK',
      type: 'project',
      siteAlias,
      siteId,
    };
  }

  const timesheetSources = [];
  if (process.env.SP_TIMSHEET1) {
    timesheetSources.push({
      listId: process.env.SP_TIMSHEET1,
      envVar: 'SP_TIMSHEET1',
      label: 'timesheet1',
    });
  }
  if (process.env.SP_TIMSHEET2) {
    timesheetSources.push({
      listId: process.env.SP_TIMSHEET2,
      envVar: 'SP_TIMSHEET2',
      label: 'timesheet2',
    });
  }
  if (timesheetSources.length) {
    sources.timeentries = {
      listKey: 'timeentries',
      type: 'timeentry',
      siteAlias,
      siteId,
      timesheetSources,
    };
  }

  if (process.env.SP_MEETINGS) {
    const meetingsAlias = process.env.SP_MEETINGS_SITE || 'DEFAULT';
    sources.meetings = {
      listKey: 'meetings',
      listId: process.env.SP_MEETINGS,
      envVar: 'SP_MEETINGS',
      type: 'meeting',
      siteAlias: meetingsAlias,
      siteId: resolveSiteId(sites, meetingsAlias),
    };
  }

  return sources;
}

export function getIngestSource(listKey, ingestSources) {
  const source = ingestSources[listKey];
  if (!source) {
    throw new Error(
      `List "${listKey}" not configured. Set SP_TASKS or SP_TASKS_<SITE>, SP_MASTER_TASK, SP_TIMSHEET1/2 in .env`
    );
  }
  if (!source.siteId) {
    throw new Error(`SHAREPOINT_SITE_ID is required for list "${listKey}"`);
  }

  if (listKey === 'timeentries') {
    if (!source.timesheetSources?.length) {
      throw new Error('Set SP_TIMSHEET1 and/or SP_TIMSHEET2 in .env');
    }
    return source;
  }

  if (listKey === 'tasks') {
    if (!source.taskSources?.length) {
      throw new Error('Set SP_TASKS or SP_TASKS_<SITETYPE> in .env');
    }
    return source;
  }

  if (!source.listId) {
    throw new Error(`List ID missing for "${listKey}"`);
  }

  return source;
}

export function getSharePointConfigSummary(sites, ingestSources) {
  const taskEnvVars = Object.keys(process.env).filter(
    (k) => (k === 'SP_TASKS' || k.startsWith('SP_TASKS_')) && process.env[k]
  );

  return {
    sites: Object.keys(sites).map((alias) => ({ alias, configured: Boolean(sites[alias]) })),
    lists: Object.values(ingestSources).map((s) => {
      if (s.timesheetSources) {
        return {
          listKey: s.listKey,
          type: s.type,
          siteAlias: s.siteAlias,
          timesheets: s.timesheetSources.map((t) => ({
            envVar: t.envVar,
            listId: t.listId,
            label: t.label,
          })),
          siteConfigured: Boolean(s.siteId),
        };
      }
      if (s.taskSources) {
        return {
          listKey: s.listKey,
          type: s.type,
          taskLists: s.taskSources.map((t) => ({
            envVar: t.envVar,
            listId: t.listId,
            siteType: t.siteType,
            siteAlias: t.siteAlias,
          })),
          siteConfigured: Boolean(s.siteId),
        };
      }
      return {
        listKey: s.listKey,
        type: s.type,
        envVar: s.envVar,
        listId: s.listId,
        siteAlias: s.siteAlias,
        siteConfigured: Boolean(s.siteId),
      };
    }),
    envVars: {
      SP_TASKS: Boolean(process.env.SP_TASKS),
      SP_TASKS_MULTI: taskEnvVars.filter((k) => k.startsWith('SP_TASKS_')).length,
      SP_MASTER_TASK: Boolean(process.env.SP_MASTER_TASK),
      SP_TIMSHEET1: Boolean(process.env.SP_TIMSHEET1),
      SP_TIMSHEET2: Boolean(process.env.SP_TIMSHEET2),
    },
  };
}

// meetings only joins the full ingest once SP_MEETINGS is configured (else /all would fail on it).
// eodreports has no such env-gate — it degrades gracefully instead (ingestFromSharePoint returns
// {ingested: 0, message: '...run scripts/teams-auth-setup.js once'} until the one-time Teams login
// has run, same pattern sharepoint.js's own missing-credentials case already uses).
export const INGEST_LIST_KEYS = [
  'portfolio',
  'projects',
  'tasks',
  'timeentries',
  ...(process.env.SP_MEETINGS ? ['meetings'] : []),
  'eodreports',
];
