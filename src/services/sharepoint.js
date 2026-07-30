import { config } from '../config.js';
import {
  getIngestSource,
  getSharePointConfigSummary,
} from '../config/sharepointSites.js';
import {
  buildTaskLinkIndex,
  filterMasterRows,
  getIngestCacheMasterById,
  getIngestCacheTaskLinkIndex,
  masterItemToKnowledge,
  setIngestCacheMaster,
  setIngestCacheTaskLinkIndex,
  taskItemToKnowledge,
  timesheetRowsToKnowledge,
} from './hierarchyIngest.js';
import { meetingToKnowledge, inlineTranscript, fetchTranscriptText } from './meetingIngest.js';

let cachedToken = null;
let tokenExpiresAt = 0;

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'this',
  'that',
  'what',
  'when',
  'where',
  'give',
  'show',
  'tell',
  'update',
  'status',
  'project',
  'task',
  'tasks',
  'owner',
  'owners',
  'blocker',
  'blockers',
  'time',
  'entry',
  'entries',
  'summary',
  'please',
]);

function decodeBasicEntities(value) {
  return String(value || '')
    .replace(/&#58;/g, ':')
    .replace(/&#160;/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

function cleanText(value) {
  return decodeBasicEntities(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function valueToText(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined || value === '') return '';
  if (Array.isArray(value)) {
    if (depth > 3) return '';
    return value.map((entry) => valueToText(entry, depth + 1, seen)).filter(Boolean).join(', ');
  }
  if (typeof value === 'object') {
    if (seen.has(value) || depth > 3) return '';
    seen.add(value);
    const direct =
      value.LookupValue ||
      value.Title ||
      value.Email ||
      value.Description ||
      value.Url ||
      value.Name ||
      value.Label;
    if (direct) return cleanText(direct);

    const selectedValues = Object.entries(value)
      .filter(([key]) => /title|name|value|email|description|url|status|owner/i.test(key))
      .map(([, entry]) => valueToText(entry, depth + 1, seen))
      .filter(Boolean);

    return cleanText(
      selectedValues.length
        ? selectedValues.join(' ')
        : Object.values(value)
            .slice(0, 8)
            .map((entry) => valueToText(entry, depth + 1, seen))
            .filter(Boolean)
            .join(' ')
    );
  }
  return cleanText(value);
}

function firstField(fields, names) {
  for (const name of names) {
    const text = valueToText(fields[name]);
    if (text) return text;
  }
  return '';
}

function formatPercent(value) {
  if (value === null || value === undefined || value === '') return '';
  const number = Number(value);
  if (!Number.isFinite(number)) return valueToText(value);
  const percent = number > 0 && number <= 1 ? number * 100 : number;
  return `${Math.round(percent)}%`;
}

function normalizeText(value) {
  return valueToText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function queryTokens(question) {
  return normalizeText(question)
    .split(' ')
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

function itemSearchText(item) {
  return normalizeText([
    item.title,
    item.status,
    item.owner,
    item.completion,
    item.blockers,
    item.description,
    Object.entries(item.fields || {})
      .slice(0, 80)
      .map(([, value]) => valueToText(value))
      .join(' '),
  ].join(' '));
}

function scoreItem(item, tokens) {
  if (!tokens.length) return 0;
  const text = itemSearchText(item);
  return tokens.reduce((score, token) => score + (text.includes(token) ? 1 : 0), 0);
}

function monthsAgoIso(months) {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return date.toISOString();
}

function itemDate(item) {
  const fields = item.fields || {};
  const raw =
    item.lastModifiedDateTime ||
    fields.Modified ||
    fields.Created ||
    item.createdDateTime ||
    null;
  const date = raw ? new Date(raw) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function filterItemsSince(items, sinceIso) {
  if (!sinceIso) return items;
  const since = new Date(sinceIso);
  if (Number.isNaN(since.getTime())) return items;
  return items.filter((item) => {
    const date = itemDate(item);
    return date ? date >= since : false;
  });
}

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const { tenantId, clientId, clientSecret } = config.sharepoint;
  if (!tenantId || !clientId || !clientSecret) {
    return null;
  }

  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    throw new Error(`SharePoint auth failed: ${res.status}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

function itemToText(item, type, source, extraMeta = {}) {
  const fields = item.fields || {};
  const title = fields.Title || fields.ProjectName || fields.Name || 'Untitled';
  const status = firstField(fields, ['Status', 'ProjectStatus', 'TaskStatus']);
  const owner = firstField(fields, [
    'Owner',
    'AssignedTo',
    'ProjectOwner',
    'Responsible_x0020_Team',
    'Team_x0020_Members',
  ]);
  const completionRaw = fields.Completion ?? fields.PercentComplete ?? fields.Progress ?? '';
  const completion = formatPercent(completionRaw);
  const blockers = firstField(fields, ['Blockers', 'Risks', 'Issue', 'Issues']);
  const description = firstField(fields, [
    'ShortDescription',
    'Short_x0020_description_x0020__x0',
    'Description',
    'Body',
    'Background',
    'Idea',
    'Notes',
    'Comments',
    'FeedBack',
  ]);
  const priority = firstField(fields, ['Priority', 'Priority_x0020_Rank', 'PriorityRank']);
  const category = firstField(fields, ['Categories', 'Component', 'Services', 'ItemType']);
  const projectId =
    fields.ProjectId ||
    fields.ProjectID ||
    fields.projectId ||
    fields.PortfolioStructureID ||
    fields['Portfolio_x003a_IDLookupId'] ||
    fields.TaskID ||
    null;

  const parts = [`${title}`];
  if (status) parts.push(`Status: ${status}`);
  if (completion !== '') parts.push(`Completion: ${completion}`);
  if (owner) parts.push(`Owner: ${owner}`);
  if (priority) parts.push(`Priority: ${priority}`);
  if (category) parts.push(`Category: ${category}`);
  if (blockers) parts.push(`Blockers: ${blockers}`);
  if (description) parts.push(description);

  return {
    text: parts.join('. '),
    metadata: {
      type,
      projectId,
      projectName: valueToText(fields.ProjectName || title),
      sharePointItemId: item.id,
      sharePointSite: source.siteAlias,
      sharePointSiteId: source.siteId,
      sharePointListId: source.listId || extraMeta.timesheetListId,
      sharePointListEnv: source.envVar || extraMeta.timesheetEnv,
      timesheetSource: extraMeta.timesheetLabel || null,
      timestamp: fields.Modified || fields.Created || new Date().toISOString().slice(0, 10),
    },
    structured: {
      id: item.id,
      title: valueToText(title),
      status,
      owner,
      completion,
      blockers,
      description,
      priority,
      category,
      projectId,
      sharePointSite: source.siteAlias,
      timesheetSource: extraMeta.timesheetLabel || null,
      fields,
    },
  };
}

function buildListItemsUrl(siteId, listId, { modifiedSince, filterMode } = {}) {
  const params = new URLSearchParams({ $expand: 'fields' });
  if (modifiedSince && filterMode === 'fieldModified') {
    params.set('$filter', `fields/Modified ge '${modifiedSince}'`);
  }
  return `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/items?${params.toString()}`;
}

async function fetchGraphListItems(token, siteId, listId, { modifiedSince } = {}) {
  let url = buildListItemsUrl(siteId, listId, {
    modifiedSince,
    filterMode: modifiedSince ? 'fieldModified' : null,
  });
  const items = [];

  while (url) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Prefer: 'HonorNonIndexedQueriesWarningMayFailRandomly',
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Graph list ${listId} failed: ${res.status} ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    items.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }

  return filterItemsSince(items, modifiedSince);
}

export function getSharePointSitesConfig() {
  return getSharePointConfigSummary(
    config.sharepoint.sites,
    config.sharepoint.ingestSources
  );
}

async function ensureMasterCache(token, source) {
  let masterById = getIngestCacheMasterById();
  if (masterById) return masterById;
  const rows = await fetchGraphListItems(token, source.siteId, source.listId);
  setIngestCacheMaster(rows);
  return getIngestCacheMasterById();
}

async function ensureTaskLinkIndex(token, taskSource) {
  let taskLinkIndex = getIngestCacheTaskLinkIndex();
  if (taskLinkIndex) return taskLinkIndex;

  const masterSource = config.sharepoint.ingestSources.portfolio;
  const masterById = masterSource
    ? await ensureMasterCache(token, masterSource)
    : new Map();

  const allTaskKnowledge = [];
  for (const site of taskSource.taskSources) {
    const rows = await fetchGraphListItems(token, site.siteId, site.listId);
    const parsed = rows.map((row) =>
      taskItemToKnowledge(
        row,
        { ...site, listId: site.listId, siteId: site.siteId },
        masterById
      )
    );
    allTaskKnowledge.push(...parsed);
  }

  taskLinkIndex = buildTaskLinkIndex(allTaskKnowledge);
  setIngestCacheTaskLinkIndex(taskLinkIndex);
  return taskLinkIndex;
}

export async function fetchListItems(listKey) {
  const token = await getAccessToken();
  if (!token) {
    return { items: [], structured: [], configured: false };
  }

  const source = getIngestSource(listKey, config.sharepoint.ingestSources);
  const allItems = [];
  const sourcesUsed = [];

  if (listKey === 'portfolio' || listKey === 'projects') {
    const rows = await fetchGraphListItems(token, source.siteId, source.listId);
    setIngestCacheMaster(rows);
    const masterById = getIngestCacheMasterById();
    const filtered = filterMasterRows(rows, listKey);
    const parsed = filtered.map((row) => masterItemToKnowledge(row, listKey, source, masterById));
    allItems.push(...parsed);
    sourcesUsed.push({
      envVar: source.envVar,
      listId: source.listId,
      fetched: rows.length,
      count: parsed.length,
      filtered: listKey,
    });
  } else if (listKey === 'tasks' && source.taskSources) {
    const masterSource = config.sharepoint.ingestSources.portfolio;
    const masterById = masterSource
      ? await ensureMasterCache(token, masterSource)
      : new Map();

    for (const site of source.taskSources) {
      const rows = await fetchGraphListItems(token, site.siteId, site.listId);
      const parsed = rows.map((row) =>
        taskItemToKnowledge(
          row,
          { ...site, listId: site.listId, siteId: site.siteId },
          masterById
        )
      );
      allItems.push(...parsed);
      sourcesUsed.push({
        envVar: site.envVar,
        listId: site.listId,
        siteType: site.siteType,
        count: parsed.length,
      });
    }

    setIngestCacheTaskLinkIndex(buildTaskLinkIndex(allItems));
  } else if (listKey === 'timeentries' && source.timesheetSources) {
    const taskSource = config.sharepoint.ingestSources.tasks;
    const taskLinkIndex = taskSource
      ? await ensureTaskLinkIndex(token, taskSource)
      : new Map();

    const modifiedSince = monthsAgoIso(config.sharepoint.timeEntriesMonths);
    for (const sheet of source.timesheetSources) {
      const rows = await fetchGraphListItems(token, source.siteId, sheet.listId, {
        modifiedSince,
      });
      const parsed = timesheetRowsToKnowledge(
        rows,
        source,
        { listId: sheet.listId, envVar: sheet.envVar, label: sheet.label },
        taskLinkIndex
      );
      allItems.push(...parsed);
      sourcesUsed.push({
        envVar: sheet.envVar,
        listId: sheet.listId,
        label: sheet.label,
        rowsFetched: rows.length,
        slicesIngested: parsed.length,
        modifiedSince,
      });
    }
  } else if (listKey === 'meetings') {
    const rows = await fetchGraphListItems(token, source.siteId, source.listId);
    let transcriptsFetched = 0;
    for (const row of rows) {
      const fields = row.fields || {};
      let transcript = inlineTranscript(fields);
      const transcriptUrl = fields.TranscriptUrl || fields.TranscriptFileUrl || '';
      if (!transcript && transcriptUrl) {
        // ponytail: sequential per-row docx download; parallelize if meeting count grows large
        transcript = await fetchTranscriptText(token, source.siteId, transcriptUrl);
        if (transcript) transcriptsFetched += 1;
      }
      allItems.push(meetingToKnowledge(row, source, transcript));
    }
    sourcesUsed.push({
      envVar: source.envVar,
      listId: source.listId,
      count: allItems.length,
      transcriptsFromFile: transcriptsFetched,
    });
  } else {
    const rows = await fetchGraphListItems(token, source.siteId, source.listId);
    const parsed = rows.map((item) => itemToText(item, source.type, source));
    allItems.push(...parsed);
    sourcesUsed.push({
      envVar: source.envVar,
      listId: source.listId,
      count: parsed.length,
    });
  }

  return {
    items: allItems,
    structured: allItems.map((p) => p.structured),
    configured: true,
    sources: sourcesUsed,
  };
}

function structuredFromQdrantContext(qdrantContext = []) {
  const data = {
    portfolio: [],
    projects: [],
    tasks: [],
    timeEntries: [],
  };

  const seen = new Set();
  for (const context of qdrantContext.slice(0, 20)) {
    const payload = context.payload || {};
    const key = `${payload.type}:${payload.sharePointListId}:${payload.sharePointItemId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const item = {
      id: payload.sharePointItemId,
      title: payload.title || payload.projectName || payload.text?.slice(0, 120) || 'Untitled',
      type: payload.type,
      projectId: payload.projectId || null,
      portfolioId: payload.portfolioId || null,
      taskId: payload.taskId || null,
      projectName: payload.projectName || null,
      hierarchyPath: payload.hierarchyPath || null,
      timeHours: payload.timeHours ?? null,
      authorName: payload.authorName || null,
      summary: payload.text || '',
      timestamp: payload.timestamp || null,
      sharePointListEnv: payload.sharePointListEnv || null,
      timesheetSource: payload.timesheetSource || null,
      score: context.score,
      keywordScore: context.keywordScore,
    };

    if (payload.type === 'portfolio') data.portfolio.push(item);
    else if (payload.type === 'project') data.projects.push(item);
    else if (payload.type === 'task') data.tasks.push(item);
    else if (payload.type === 'timeentry') data.timeEntries.push(item);
  }

  return {
    portfolio: data.portfolio.slice(0, 5),
    projects: data.projects.slice(0, 5),
    tasks: data.tasks.slice(0, 10),
    timeEntries: data.timeEntries.slice(0, 8),
  };
}

export async function queryStructuredData(question, qdrantContext = []) {
  if (qdrantContext.length) {
    return {
      configured: true,
      data: structuredFromQdrantContext(qdrantContext),
      source: 'qdrant_context',
    };
  }

  const token = await getAccessToken();
  if (!token) {
    return { data: {}, configured: false };
  }

  const keys = config.sharepoint.ingestListKeys;
  const fetched = await Promise.all(
    keys.map((key) => fetchListItems(key).catch(() => ({ structured: [] })))
  );

  const byKey = Object.fromEntries(keys.map((key, i) => [key, fetched[i]]));

  const tokens = queryTokens(question);
  const broadQuery = tokens.length === 0;
  const rankItems = (items, extraTerms = []) =>
    items
      .map((item) => ({
        item,
        score: scoreItem(item, [...tokens, ...extraTerms]),
      }))
      .filter((entry) => broadQuery || entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.item);

  const allProjects = byKey.projects?.structured || [];
  const allPortfolio = byKey.portfolio?.structured || [];
  const matchedProjects = rankItems(allProjects);
  const matchedPortfolio = rankItems(allPortfolio);

  const matchedProjectTerms = Array.from(
    new Set(
      [...matchedProjects, ...matchedPortfolio]
        .slice(0, 5)
        .flatMap((item) => [item.title, item.projectId])
        .map(normalizeText)
        .filter(Boolean)
    )
  );

  const matchedTasks = rankItems(byKey.tasks?.structured || [], matchedProjectTerms);
  const matchedTimeEntries = rankItems(byKey.timeentries?.structured || [], matchedProjectTerms);

  return {
    configured: true,
    data: {
      portfolio: (matchedPortfolio.length ? matchedPortfolio : broadQuery ? allPortfolio : []).slice(0, 5),
      projects: (matchedProjects.length ? matchedProjects : broadQuery ? allProjects : []).slice(0, 5),
      tasks: (matchedTasks.length ? matchedTasks : broadQuery ? byKey.tasks?.structured || [] : []).slice(0, 12),
      timeEntries: (
        matchedTimeEntries.length ? matchedTimeEntries : broadQuery ? byKey.timeentries?.structured || [] : []
      ).slice(0, 12),
    },
  };
}
