/**
 * Hierarchy-aware SharePoint → Qdrant normalization.
 * Mirrors SPFx data-service.ts: portfolio → project → task → timeentry linking.
 */

const PORTFOLIO_TYPES = new Set(['component', 'subcomponent', 'feature']);
const PROJECT_TYPES = new Set(['project', 'sprint', 'cycle']);

/** @type {{ masterRows: any[] | null, masterById: Map<number, any> | null, taskLinkIndex: Map<string, object> | null }} */
const ingestCache = {
  masterRows: null,
  masterById: null,
  taskLinkIndex: null,
};

export function clearIngestCache() {
  ingestCache.masterRows = null;
  ingestCache.masterById = null;
  ingestCache.taskLinkIndex = null;
}

function decodeBasicEntities(value) {
  return String(value || '')
    .replace(/&#58;/g, ':')
    .replace(/&#160;/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
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
      value.LookupValue || value.Title || value.Email || value.Description || value.Name;
    if (direct) return cleanText(direct);
    return cleanText(
      Object.values(value)
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

function lookupId(fields, baseName) {
  if (!fields) return null;
  const direct = fields[`${baseName}LookupId`];
  if (direct != null && direct !== '') return Number(direct);
  const val = fields[baseName];
  if (Array.isArray(val)) {
    for (const entry of val) {
      const id = entry?.LookupId ?? entry?.Id ?? entry?.id;
      if (id != null && id !== '') return Number(id);
    }
  }
  if (typeof val === 'number') return val;
  if (val && typeof val === 'object') {
    const id = val.LookupId ?? val.Id ?? val.id;
    if (id != null) return Number(id);
  }
  return null;
}

function firstLookupId(fields, baseNames) {
  for (const baseName of baseNames) {
    const id = lookupId(fields, baseName);
    if (Number.isFinite(id) && id > 0) return id;
  }
  return null;
}

function resolveTaskProjectId(fields) {
  return firstLookupId(fields, [
    'Project',
    // Graph exposes the SPFx Project/Id lookup projection under this internal name.
    'Project_x003a_ID',
  ]);
}

function resolveTaskPortfolioId(fields) {
  return firstLookupId(fields, [
    'Portfolio',
    // Graph exposes the SPFx Portfolio/Id lookup projection under this internal name.
    'Portfolio_x003a_ID',
    'Component',
    'RelevantPortfolio',
  ]);
}

export function isPortfolioMasterItem(fields) {
  const type = String(fields?.Item_x0020_Type ?? '').toLowerCase();
  const cat = String(fields?.ItemCat ?? '').toLowerCase();
  if (cat === 'portfolio') return true;
  if (PROJECT_TYPES.has(type)) return false;
  if (PORTFOLIO_TYPES.has(type)) return true;
  return type !== '' && type !== 'project' && type !== 'sprint' && type !== 'cycle';
}

export function isProjectMasterItem(fields) {
  const type = String(fields?.Item_x0020_Type ?? '').toLowerCase();
  const cat = String(fields?.ItemCat ?? '').toLowerCase();
  if (cat === 'project') return true;
  return PROJECT_TYPES.has(type);
}

export function normalizeSiteTypeForLookup(siteType) {
  if (!siteType) return '';
  const s = decodeURIComponent(String(siteType)).trim();
  if (s === 'Offshore Tasks' || s.toLowerCase() === 'offshore tasks') return 'OffshoreTasks';
  return s.replace(/[^a-zA-Z0-9]/g, '');
}

export function taskLookupKeyForSite(siteType) {
  const normalized = normalizeSiteTypeForLookup(siteType);
  if (!normalized) return '';
  if (normalized === 'OffshoreTasks') return 'TaskOffshoreTasks';
  return `Task${normalized}`;
}

export function siteTypeFromTaskLookupKey(taskKey) {
  if (!taskKey || !taskKey.startsWith('Task')) return '';
  const rest = taskKey.slice(4);
  if (rest === 'OffshoreTasks') return 'OffshoreTasks';
  return rest;
}

export function parseAdditionalTimeEntry(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function parseEntryHours(entry) {
  const t = Number(entry?.TaskTime);
  if (Number.isFinite(t) && t > 0) return Math.round(t * 100) / 100;
  const min = Number(entry?.TaskTimeInMin);
  if (Number.isFinite(min) && min > 0) return Math.round((min / 60) * 100) / 100;
  return 0;
}

export function buildMasterById(masterRows) {
  const map = new Map();
  for (const row of masterRows || []) {
    const id = Number(row?.id ?? row?.Id ?? 0);
    if (id) map.set(id, row);
  }
  return map;
}

function masterFields(row) {
  return row?.fields || row || {};
}

function masterTitle(row) {
  const f = masterFields(row);
  return valueToText(f.Title || f.ProjectName || f.Name || 'Untitled');
}

export function resolveHierarchyPath(itemId, masterById) {
  const parts = [];
  let cur = masterById.get(Number(itemId));
  const seen = new Set();
  while (cur) {
    const id = Number(cur.id ?? cur.Id);
    if (seen.has(id)) break;
    seen.add(id);
    parts.unshift(masterTitle(cur));
    const parentId = lookupId(masterFields(cur), 'Parent');
    if (!parentId) break;
    cur = masterById.get(parentId);
  }
  return parts.join(' > ');
}

export function resolvePortfolioIdForProject(projectFields, masterById) {
  const parentId = lookupId(projectFields, 'Parent');
  if (!parentId) return null;
  let cur = masterById.get(parentId);
  const seen = new Set();
  while (cur) {
    const id = Number(cur.id ?? cur.Id);
    if (seen.has(id)) break;
    seen.add(id);
    const f = masterFields(cur);
    if (isPortfolioMasterItem(f)) return id;
    const nextParent = lookupId(f, 'Parent');
    if (!nextParent) break;
    cur = masterById.get(nextParent);
  }
  return parentId;
}

function structureIdFromFields(fields) {
  return fields.PortfolioStructureID ?? fields.TaskID ?? null;
}

export function filterMasterRows(rows, listKey) {
  return (rows || []).filter((row) => {
    const f = masterFields(row);
    if (listKey === 'portfolio') return isPortfolioMasterItem(f);
    if (listKey === 'projects') return isProjectMasterItem(f);
    return true;
  });
}

export function masterItemToKnowledge(row, listKey, source, masterById) {
  const fields = masterFields(row);
  const id = Number(row.id ?? row.Id);
  const type = listKey === 'projects' ? 'project' : 'portfolio';
  const title = masterTitle(row);
  const status = firstField(fields, ['Status', 'ProjectStatus']);
  const owner = firstField(fields, ['Owner', 'Responsible_x0020_Team', 'Team_x0020_Members']);
  const completion = formatPercent(fields.PercentComplete ?? fields.Completion);
  const description = firstField(fields, [
    'ShortDescription',
    'Short_x0020_description_x0020__x0',
    'Description',
    'Body',
    'Background',
    'Idea',
  ]);
  const itemType = valueToText(fields.Item_x0020_Type || fields.ItemType);
  const parentId = lookupId(fields, 'Parent');
  const structureId = structureIdFromFields(fields);
  const portfolioId =
    type === 'project' ? resolvePortfolioIdForProject(fields, masterById) : null;
  const hierarchyPath = resolveHierarchyPath(id, masterById);

  const parts = [title];
  if (itemType) parts.push(`Type: ${itemType}`);
  if (hierarchyPath) parts.push(`Path: ${hierarchyPath}`);
  if (status) parts.push(`Status: ${status}`);
  if (completion) parts.push(`Completion: ${completion}`);
  if (owner) parts.push(`Owner: ${owner}`);
  if (structureId) parts.push(`Structure: ${structureId}`);
  if (description) parts.push(description);

  return {
    text: parts.join('. '),
    metadata: {
      type,
      title,
      itemType: itemType || null,
      parentId: parentId || null,
      portfolioId: portfolioId || null,
      structureId: structureId != null ? String(structureId) : null,
      hierarchyPath: hierarchyPath || null,
      projectId: type === 'project' ? id : null,
      projectName: title,
      sharePointItemId: id,
      sharePointSite: source.siteAlias,
      sharePointSiteId: source.siteId,
      sharePointListId: source.listId,
      sharePointListEnv: source.envVar,
      timestamp: fields.Modified || fields.Created || new Date().toISOString().slice(0, 10),
    },
    structured: {
      id,
      title,
      type,
      status,
      owner,
      completion,
      description,
      itemType,
      parentId,
      portfolioId,
      structureId,
      hierarchyPath,
      projectId: type === 'project' ? id : null,
      fields,
    },
  };
}

export function taskItemToKnowledge(row, source, masterById) {
  const fields = row.fields || {};
  const id = Number(row.id ?? row.Id);
  const siteType = source.siteType || source.siteAlias || 'DEFAULT';
  const title = valueToText(fields.Title || 'Untitled');
  const status = firstField(fields, ['Status', 'TaskStatus']);
  const owner = firstField(fields, ['AssignedTo', 'Responsible_x0020_Team', 'Team_x0020_Members']);
  const completion = formatPercent(fields.PercentComplete);
  const description = firstField(fields, ['Body', 'FeedBack', 'Description', 'Comments']);
  const taskCode = fields.TaskID != null ? String(fields.TaskID) : null;
  const projectId = resolveTaskProjectId(fields);
  const portfolioId = resolveTaskPortfolioId(fields);
  const projectRow = projectId ? masterById.get(projectId) : null;
  const projectName = projectRow ? masterTitle(projectRow) : firstField(fields, ['Project']);
  const portfolioRow = portfolioId
    ? masterById.get(portfolioId)
    : projectRow
      ? masterById.get(resolvePortfolioIdForProject(masterFields(projectRow), masterById))
      : null;
  const portfolioName = portfolioRow ? masterTitle(portfolioRow) : firstField(fields, ['Portfolio']);
  const resolvedPortfolioId =
    portfolioId ||
    (projectRow ? resolvePortfolioIdForProject(masterFields(projectRow), masterById) : null);
  const projectPath = projectId ? resolveHierarchyPath(projectId, masterById) : '';
  const hierarchyPath = [portfolioName, projectPath || projectName].filter(Boolean).join(' > ');

  const parts = [title];
  if (taskCode) parts.push(`TaskID: ${taskCode}`);
  if (projectName) parts.push(`Project: ${projectName}`);
  if (portfolioName) parts.push(`Portfolio: ${portfolioName}`);
  if (hierarchyPath) parts.push(`Path: ${hierarchyPath}`);
  if (siteType) parts.push(`Site: ${siteType}`);
  if (status) parts.push(`Status: ${status}`);
  if (completion) parts.push(`Completion: ${completion}`);
  if (owner) parts.push(`Owner: ${owner}`);
  if (description) parts.push(description);

  const meta = {
    type: 'task',
    title,
    taskId: id,
    taskCode,
    siteType,
    taskLookupKey: taskLookupKeyForSite(siteType),
    projectId: projectId || null,
    portfolioId: resolvedPortfolioId || null,
    projectName: projectName || null,
    portfolioName: portfolioName || null,
    hierarchyPath: hierarchyPath || null,
    structureId: taskCode || structureIdFromFields(fields),
    sharePointItemId: id,
    sharePointSite: source.siteAlias,
    sharePointSiteId: source.siteId,
    sharePointListId: source.listId,
    sharePointListEnv: source.envVar,
    timestamp: fields.Modified || fields.Created || new Date().toISOString().slice(0, 10),
  };

  return {
    text: parts.join('. '),
    metadata: meta,
    structured: {
      id,
      title,
      type: 'task',
      status,
      owner,
      completion,
      description,
      taskCode,
      siteType,
      projectId,
      portfolioId: resolvedPortfolioId,
      projectName,
      hierarchyPath,
      fields,
    },
  };
}

function taskLookupKeysFromFields(fields) {
  const keys = [];
  for (const [key, value] of Object.entries(fields || {})) {
    const m = key.match(/^(Task[A-Za-z0-9]+)LookupId$/);
    if (m && value != null && value !== '') {
      keys.push({ taskKey: m[1], taskId: Number(value) });
      continue;
    }
    if (/^Task[A-Za-z0-9]+$/.test(key) && !key.endsWith('LookupId')) {
      const id =
        typeof value === 'number'
          ? value
          : value && typeof value === 'object'
            ? Number(value.LookupId ?? value.Id ?? value.id ?? 0) || null
            : fields[`${key}LookupId`] != null
              ? Number(fields[`${key}LookupId`])
              : null;
      if (id) keys.push({ taskKey: key, taskId: Number(id) });
    }
  }
  const seen = new Set();
  return keys.filter((k) => {
    const sig = `${k.taskId}|${k.taskKey}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
}

export function buildTaskLinkIndex(knowledgeItems) {
  const map = new Map();
  for (const item of knowledgeItems || []) {
    const m = item.metadata || {};
    if (m.type !== 'task' || !m.taskId) continue;
    const lookupKey = m.taskLookupKey || taskLookupKeyForSite(m.siteType);
    if (!lookupKey) continue;
    const linkKey = `${m.taskId}|${lookupKey}`;
    map.set(linkKey, {
      taskId: m.taskId,
      taskCode: m.taskCode,
      title: m.title,
      siteType: m.siteType,
      projectId: m.projectId,
      portfolioId: m.portfolioId,
      projectName: m.projectName,
      hierarchyPath: m.hierarchyPath,
    });
  }
  return map;
}

export function timesheetRowsToKnowledge(rows, source, sheetMeta, taskLinkIndex) {
  const out = [];
  for (const row of rows || []) {
    const fields = row.fields || {};
    const rowId = Number(row.id ?? row.Id);
    const categoryTitle = valueToText(fields.Title || fields.Category);
    const slices = parseAdditionalTimeEntry(fields.AdditionalTimeEntry);
    if (!slices.length) continue;

    const taskKeys = taskLookupKeysFromFields(fields);
    if (!taskKeys.length) continue;

    for (let sliceIndex = 0; sliceIndex < slices.length; sliceIndex++) {
      const entry = slices[sliceIndex];
      const hours = parseEntryHours(entry);
      const authorName = valueToText(entry.AuthorName || entry.Title || 'Unknown');
      const taskDate = valueToText(entry.TaskDate || entry.TaskDates || '');
      const description = cleanText(entry.Description || '');
      const workPending = cleanText(entry.WorkPending || '');

      for (const { taskKey, taskId } of taskKeys) {
        const linkKey = `${taskId}|${taskKey}`;
        const taskMeta = taskLinkIndex.get(linkKey) || {};
        const siteType = taskMeta.siteType || siteTypeFromTaskLookupKey(taskKey);

        const parts = [
          `${authorName} logged ${hours}h`,
          taskDate ? `on ${taskDate}` : '',
          description,
          workPending,
          taskMeta.title ? `Task: ${taskMeta.title}` : '',
          taskMeta.projectName ? `Project: ${taskMeta.projectName}` : '',
          taskMeta.hierarchyPath ? `Path: ${taskMeta.hierarchyPath}` : '',
          categoryTitle ? `Category: ${categoryTitle}` : '',
        ].filter(Boolean);

        const syntheticId = `${rowId}:${sliceIndex}:${taskKey}`;

        out.push({
          text: parts.join('. '),
          metadata: {
            type: 'timeentry',
            title: `${authorName} — ${hours}h — ${taskDate || 'no date'}`,
            taskId,
            taskLookupKey: taskKey,
            siteType: siteType || null,
            taskCode: taskMeta.taskCode || null,
            projectId: taskMeta.projectId || null,
            portfolioId: taskMeta.portfolioId || null,
            projectName: taskMeta.projectName || null,
            hierarchyPath: taskMeta.hierarchyPath || null,
            timeDate: taskDate || null,
            timeHours: hours,
            authorName,
            parentTimesheetId: rowId,
            sharePointItemId: syntheticId,
            sharePointSite: source.siteAlias,
            sharePointSiteId: source.siteId,
            sharePointListId: sheetMeta.listId,
            sharePointListEnv: sheetMeta.envVar,
            timesheetSource: sheetMeta.label || null,
            timestamp: taskDate || fields.Modified || fields.Created || new Date().toISOString().slice(0, 10),
          },
          structured: {
            id: syntheticId,
            taskId,
            taskLookupKey: taskKey,
            hours,
            authorName,
            taskDate,
            description,
            projectId: taskMeta.projectId,
            fields,
          },
        });
      }
    }
  }
  return out;
}

export function setIngestCacheMaster(rows) {
  ingestCache.masterRows = rows;
  ingestCache.masterById = buildMasterById(rows);
  return ingestCache.masterById;
}

export function getIngestCacheMasterById() {
  return ingestCache.masterById;
}

export function setIngestCacheTaskLinkIndex(index) {
  ingestCache.taskLinkIndex = index;
}

export function getIngestCacheTaskLinkIndex() {
  return ingestCache.taskLinkIndex;
}
