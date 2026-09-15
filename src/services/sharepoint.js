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

export async function getAccessToken() {
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

/**
 * Live (uncached) read of the Meetings list — for resolving WHICH real meeting item to write an AI
 * report back into, where the meeting may have been created/updated moments ago and not yet be in
 * Qdrant (which only reflects the last ingestion run). Deliberately skips fetchListItems('meetings')'s
 * per-row transcript download (fetchTranscriptText) — that's expensive and irrelevant here, we only
 * need id/title/start/status to identify the record, not its content.
 * ponytail: single page, no pagination — fine at the current ~150-meeting scale; add paging if the
 * list grows past ~200 items and a truly old meeting needs to be found this way.
 */
export async function fetchRecentMeetings({ limit = 10 } = {}) {
  const token = await getAccessToken();
  if (!token) return { items: [], configured: false };

  const source = getIngestSource('meetings', config.sharepoint.ingestSources);
  const params = new URLSearchParams({ $expand: 'fields', $top: '200' });
  const url = `https://graph.microsoft.com/v1.0/sites/${source.siteId}/lists/${source.listId}/items?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Prefer: 'HonorNonIndexedQueriesWarningMayFailRandomly' },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Graph meetings list failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  // Unscheduled "Follow-up: ..." placeholder stubs carry a sentinel far-future Start
  // (2099-12-31) so they'd otherwise sort to the very top as if they were the newest meeting —
  // same real-data quirk found earlier scanning meetings through Qdrant. Exclude anything more
  // than a year out; a genuinely scheduled real meeting is never booked that far ahead here.
  const notPlaceholder = (item) => {
    const start = item.fields?.Start ? new Date(item.fields.Start) : null;
    const oneYearOut = Date.now() + 365 * 24 * 60 * 60 * 1000;
    return !/unscheduled/i.test(item.fields?.Status || '') && (!start || start.getTime() < oneYearOut);
  };
  const items = (data.value || [])
    .filter(notPlaceholder)
    .map((item) => ({
      id: item.id,
      title: item.fields?.Title || 'Untitled',
      start: item.fields?.Start || null,
      end: item.fields?.End || null,
      status: item.fields?.Status || null,
      meetingType: item.fields?.MeetingType || null,
    }))
    .sort((a, b) => new Date(b.start || 0) - new Date(a.start || 0))
    .slice(0, limit);

  return { items, configured: true };
}

async function getMeetingItemFields(meetingId, selectFields) {
  const token = await getAccessToken();
  if (!token) throw new Error('SharePoint credentials not configured');
  const source = getIngestSource('meetings', config.sharepoint.ingestSources);
  const select = selectFields ? `?$select=${selectFields.join(',')}` : '';
  const url = `https://graph.microsoft.com/v1.0/sites/${source.siteId}/lists/${source.listId}/items/${meetingId}/fields${select}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Graph get meeting fields failed: ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function patchMeetingItemFields(meetingId, fields) {
  const token = await getAccessToken();
  if (!token) throw new Error('SharePoint credentials not configured');
  const source = getIngestSource('meetings', config.sharepoint.ingestSources);
  const url = `https://graph.microsoft.com/v1.0/sites/${source.siteId}/lists/${source.listId}/items/${meetingId}/fields`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Graph update meeting failed: ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Writes an AI report back onto a real Meeting item — AISummary is a plain overwrite; both action
 * item lists are appended into ActionItemJSON (read-modify-write, never a blind overwrite, so this
 * never erases existing manually-entered items), matching the entry shape confirmed against
 * TeamsMeetingTool's own source (sharePointDataService.ts normalizeActionItem).
 *
 * Deliberately does NOT touch the `Tasks` lookup column at all: that field is owned by an existing
 * Power Automate flow which auto-creates and links a "meeting task" (with participants as owners)
 * whenever a meeting is created — confirmed live (see the meetingId=207 test) that a naive write
 * there overwrote that flow's own linkage. "Already exists, don't duplicate" (Section 4 of the
 * report) is instead represented the same way a genuinely newly-created task already is elsewhere
 * in this schema: an ActionItemJSON entry with status "Task Created" and a real omtTaskId — this
 * is exactly how the sibling app's own "From action item" Linked-Tasks rows already work, so it's
 * proven safe, not a new mechanism.
 */
export async function saveReportToMeeting(meetingId, { summary, newActionItems, existingTaskMatches } = {}) {
  const results = {};

  if (summary) {
    await patchMeetingItemFields(meetingId, { AISummary: summary });
    results.summary = 'updated';
  }

  // Fail loudly on a malformed item instead of silently writing blank data to a real SharePoint
  // record. Confirmed live (meeting 211, via the PHP port of this same function): a caller's tool
  // call omitted/misnamed these fields, and the old `|| ''` fallbacks let it "succeed" with 17 real
  // ActionItemJSON entries that all had empty description/assignedTo/omtTaskId — a much worse
  // outcome than a clear rejection the caller could immediately fix and retry.
  const requireField = (item, field, index, listLabel) => {
    if (!item[field]) {
      throw new Error(
        `${listLabel}[${index}] is missing required field "${field}" — refusing to save a blank ` +
          'action item. Re-check the exact argument shape against the tool schema.'
      );
    }
  };
  (newActionItems || []).forEach((item, i) => requireField(item, 'description', i, 'newActionItems'));
  (existingTaskMatches || []).forEach((item, i) => {
    requireField(item, 'description', i, 'existingTaskMatches');
    requireField(item, 'omtTaskId', i, 'existingTaskMatches');
  });

  // A model can literally write "undetermined" (or similar) as the suggested project/portfolio
  // NAME when no real match was found — confirmed live in a real generated report. Correct as
  // report TEXT, but must never land in a real SharePoint field as if it were an actual project
  // reference — strip it back to null rather than trust the caller followed the "omit it instead"
  // instruction in the tool description.
  const PLACEHOLDER_PROJECT_NAMES = new Set([
    'undetermined', 'unknown', 'unclear', 'n/a', 'na', 'none', 'tbd', 'not determined', 'not applicable', 'not found',
  ]);
  const sanitizeLinkedProject = (linkedProject) => {
    if (!linkedProject) return null;
    const name = String(linkedProject.name || '').trim().toLowerCase();
    if (!name || PLACEHOLDER_PROJECT_NAMES.has(name) || name.startsWith('undetermined')) return null;
    return linkedProject;
  };

  const buildEntry = (item, { status, omtTaskId }) => ({
    meetingId: String(meetingId),
    description: item.description || '',
    taskDescription: item.taskDescription || '',
    sectionId: '',
    sectionTopic: item.sectionTopic || '',
    sectionSummary: '',
    owningTool: item.owningTool || '',
    mentionedTools: [],
    discussionIntent: '',
    discussionContext: item.discussionContext || '',
    projectHints: item.projectHints || [],
    assignedTo: item.assignedTo || null,
    linkedProject: sanitizeLinkedProject(item.linkedProject),
    siteType: 'HHHH',
    taskType: item.taskType || 'Implementation',
    priorityRank: String(item.priorityRank || '5'),
    source: 'AI-Extracted',
    status,
    id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    dueDate: item.dueDate || '',
    omtTaskId,
  });

  if (newActionItems?.length || existingTaskMatches?.length) {
    const current = await getMeetingItemFields(meetingId, ['ActionItemJSON']);
    const existing = (() => {
      try {
        return JSON.parse(current.ActionItemJSON || '[]');
      } catch {
        return [];
      }
    })();

    // "Pending Review" (not "Approved") is normalizeActionItem's own real default for an entry
    // with no explicit status — an AI suggestion isn't the same as a human approving it, so this
    // must leave the same human-review gate the app already relies on, not silently bypass it.
    const builtNew = (newActionItems || []).map((item) => buildEntry(item, { status: 'Pending Review', omtTaskId: '' }));
    const builtExisting = (existingTaskMatches || []).map((item) =>
      buildEntry(item, { status: 'Task Created', omtTaskId: String(item.omtTaskId) })
    );

    await patchMeetingItemFields(meetingId, {
      ActionItemJSON: JSON.stringify([...existing, ...builtNew, ...builtExisting]),
    });
    results.newActionItems = builtNew.length;
    results.linkedExistingTasks = builtExisting.length;
  }

  return results;
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

export async function fetchListItems(listKey, { modifiedSince } = {}) {
  const token = await getAccessToken();
  if (!token) {
    return { items: [], structured: [], configured: false };
  }

  const source = getIngestSource(listKey, config.sharepoint.ingestSources);
  const allItems = [];
  const sourcesUsed = [];

  if (listKey === 'portfolio' || listKey === 'projects') {
    // Deliberately ALWAYS full-fetched, never filtered by modifiedSince — this is the reference
    // data every task resolves its portfolio/project NAME against (ensureMasterCache below).
    // Filtering it to "recently changed" would silently break name resolution for every task
    // under an unchanged portfolio, not just the ones actually skipped. Cheap enough to always
    // fully re-embed daily (~3,400 records) that this isn't worth the correctness risk.
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
      const rows = await fetchGraphListItems(token, site.siteId, site.listId, { modifiedSince });
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
        modifiedSince: modifiedSince || null,
      });
    }

    setIngestCacheTaskLinkIndex(buildTaskLinkIndex(allItems));
  } else if (listKey === 'timeentries' && source.timesheetSources) {
    const taskSource = config.sharepoint.ingestSources.tasks;
    const taskLinkIndex = taskSource
      ? await ensureTaskLinkIndex(token, taskSource)
      : new Map();

    // Incremental runs pass a real `modifiedSince` (since the last successful run — typically
    // ~24h) which is far tighter than the historical-backfill default window; the wider
    // TIMEENTRIES_MONTHS window is only the fallback for a first/full run with no prior state.
    const effectiveModifiedSince = modifiedSince || monthsAgoIso(config.sharepoint.timeEntriesMonths);
    for (const sheet of source.timesheetSources) {
      const rows = await fetchGraphListItems(token, source.siteId, sheet.listId, {
        modifiedSince: effectiveModifiedSince,
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
        modifiedSince: effectiveModifiedSince,
      });
    }
  } else if (listKey === 'meetings') {
    const rows = await fetchGraphListItems(token, source.siteId, source.listId, { modifiedSince });
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
      modifiedSince: modifiedSince || null,
    });
  } else {
    const rows = await fetchGraphListItems(token, source.siteId, source.listId, { modifiedSince });
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
