// Standalone SharePoint/Microsoft Graph client — mirrors php-mcp/lib/SharePoint.php exactly (same
// endpoints, same field shapes, same rules). No dependency on ../src/services/sharepoint.js — that
// file also handles full ingestion (hierarchyIngest.js, meetingIngest.js, multi-site config), none
// of which these two tools need; this is a from-scratch, narrow, self-contained port instead.
let cachedToken = null;
let tokenExpiresAt = 0;

export async function getAccessToken(cfg) {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const { tenantId, clientId, clientSecret } = cfg;
  if (!tenantId || !clientId || !clientSecret) return null;

  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!res.ok) throw new Error(`SharePoint auth failed: ${res.status}`);

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

/**
 * Live (uncached) read of the Meetings list — for resolving which real meeting to write into,
 * where the meeting may have been created/updated moments ago.
 */
export async function fetchRecentMeetings(cfg, { limit = 10 } = {}) {
  const token = await getAccessToken(cfg);
  if (!token) return { items: [], configured: false };

  const { siteId, meetingsListId } = cfg;
  const params = new URLSearchParams({ $expand: 'fields', $top: '200' });
  const url = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${meetingsListId}/items?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Prefer: 'HonorNonIndexedQueriesWarningMayFailRandomly' },
  });
  if (!res.ok) throw new Error(`Graph meetings list failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();

  // Unscheduled "Follow-up: ..." placeholder stubs carry a sentinel far-future Start (2099-12-31).
  const oneYearOut = Date.now() + 365 * 24 * 60 * 60 * 1000;
  const notPlaceholder = (item) => {
    const start = item.fields?.Start ? new Date(item.fields.Start) : null;
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

async function getMeetingItemFields(cfg, meetingId, selectFields) {
  const token = await getAccessToken(cfg);
  if (!token) throw new Error('SharePoint credentials not configured');
  const { siteId, meetingsListId } = cfg;
  const select = selectFields ? `?$select=${selectFields.join(',')}` : '';
  const url = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${meetingsListId}/items/${meetingId}/fields${select}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Graph get meeting fields failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function patchMeetingItemFields(cfg, meetingId, fields) {
  const token = await getAccessToken(cfg);
  if (!token) throw new Error('SharePoint credentials not configured');
  const { siteId, meetingsListId } = cfg;
  const url = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${meetingsListId}/items/${meetingId}/fields`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new Error(`Graph update meeting failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/**
 * Deliberately does NOT touch the `Tasks` lookup column — owned by an existing Power Automate flow
 * that auto-links a "meeting task" on creation; overwriting it was confirmed live to destroy that
 * flow's own linkage. "Already exists" is an ActionItemJSON entry with status "Task Created" +
 * real omtTaskId instead — the same mechanism the sibling Meeting Tool app already uses.
 */
export async function saveReportToMeeting(cfg, meetingId, { summary, newActionItems = [], existingTaskMatches = [] } = {}) {
  const results = {};

  if (summary) {
    await patchMeetingItemFields(cfg, meetingId, { AISummary: summary });
    results.summary = 'updated';
  }

  // Fail loudly on a malformed item instead of silently writing blank data to a real record.
  const requireField = (item, field, index, listLabel) => {
    if (!item[field]) {
      throw new Error(
        `${listLabel}[${index}] is missing required field "${field}" — refusing to save a blank ` +
          'action item. Re-check the exact argument shape against the tool schema.'
      );
    }
  };
  newActionItems.forEach((item, i) => requireField(item, 'description', i, 'newActionItems'));
  existingTaskMatches.forEach((item, i) => {
    requireField(item, 'description', i, 'existingTaskMatches');
    requireField(item, 'omtTaskId', i, 'existingTaskMatches');
  });

  const buildEntry = (item, status, omtTaskId) => ({
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
    linkedProject: item.linkedProject || null,
    siteType: 'HHHH',
    taskType: item.taskType || 'Implementation',
    priorityRank: String(item.priorityRank || '5'),
    source: 'AI-Extracted',
    status,
    id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    dueDate: item.dueDate || '',
    omtTaskId,
  });

  if (newActionItems.length || existingTaskMatches.length) {
    const current = await getMeetingItemFields(cfg, meetingId, ['ActionItemJSON']);
    let existing;
    try {
      existing = JSON.parse(current.ActionItemJSON || '[]');
    } catch {
      existing = [];
    }

    // "Pending Review" (not "Approved") is the real app's own default for a fresh entry.
    const builtNew = newActionItems.map((item) => buildEntry(item, 'Pending Review', ''));
    const builtExisting = existingTaskMatches.map((item) => buildEntry(item, 'Task Created', String(item.omtTaskId)));

    await patchMeetingItemFields(cfg, meetingId, {
      ActionItemJSON: JSON.stringify([...existing, ...builtNew, ...builtExisting]),
    });
    results.newActionItems = builtNew.length;
    results.linkedExistingTasks = builtExisting.length;
  }

  return results;
}
