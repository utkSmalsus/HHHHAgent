// One-off data-mining script for Phase 15 (Eval V2). Reads production Qdrant data directly
// (never through the agent) to catalog real, diverse entities and compute independent ground
// truth. Output written to scratchpad for manual curation into eval/v2/dataset.json.
import { scrollPayloads, uniqueBusinessEntities, getBusinessEntityKey } from '../src/services/qdrantScroll.js';
import { taskIsOverdue } from '../src/services/structuredFilters.js';
import fs from 'fs';

const OUT = '/private/tmp/claude-501/-Users-smalsus-office-Agent/cf0a9928-bfeb-4220-b5f6-8f1fd49752e8/scratchpad/eval15';

function uniqBy(arr, fn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = fn(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

const tasksRaw = await scrollPayloads({ types: ['task'], limit: 30000 });
const tasks = uniqueBusinessEntities(tasksRaw);
const projectsRaw = await scrollPayloads({ types: ['project'], limit: 20000 });
const projects = uniqueBusinessEntities(projectsRaw);
const portfoliosRaw = await scrollPayloads({ types: ['portfolio'], limit: 20000 });
const portfolios = uniqueBusinessEntities(portfoliosRaw);
const meetingsRaw = await scrollPayloads({ types: ['meeting'], limit: 60000 });
const meetings = uniqueBusinessEntities(meetingsRaw);
const timeentriesRaw = await scrollPayloads({ types: ['timeentry'], limit: 60000 });
const timeentries = uniqueBusinessEntities(timeentriesRaw);

// People: individual names split out of comma-joined owner strings.
const people = new Map(); // lower -> {name, taskCount, overdueCount}
for (const t of tasks) {
  const raw = String(t.owner || '').trim();
  if (!raw) continue;
  for (const single of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const key = single.toLowerCase();
    if (!people.has(key)) people.set(key, { name: single, taskCount: 0, overdueCount: 0, statuses: {} });
    const p = people.get(key);
    p.taskCount++;
    if (taskIsOverdue(t)) p.overdueCount++;
    p.statuses[t.status || 'Unknown'] = (p.statuses[t.status || 'Unknown'] || 0) + 1;
  }
}
const peopleList = [...people.values()].sort((a, b) => b.taskCount - a.taskCount);

// Status distribution
const statusCounts = {};
for (const t of tasks) statusCounts[t.status || 'Unknown'] = (statusCounts[t.status || 'Unknown'] || 0) + 1;

// Overdue tasks globally
const overdueTasks = tasks.filter((t) => taskIsOverdue(t));

// Projects/portfolios with real hierarchy (parentId) and recency
const containerSample = (arr, n) =>
  [...arr].sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0)).slice(0, n)
    .map((p) => ({ title: p.title, id: p.sharePointItemId, type: p.type, status: p.status, timestamp: p.timestamp, parentId: p.parentId }));

// Meetings: pick a spread — recent, old, heavily chunked (for transcript region tests), lightly chunked
const meetingsSorted = [...meetings].sort((a, b) => new Date(b.start || 0) - new Date(a.start || 0));
const heavilyChunked = [...meetings].filter((m) => (m.totalChunks || 1) >= 15).sort((a, b) => (b.totalChunks||0)-(a.totalChunks||0));
const lightlyChunked = [...meetings].filter((m) => (m.totalChunks || 1) === 1);

// Tasks with real due dates (for date-specific questions)
const tasksWithDue = tasks.filter((t) => t.dueDate);

// Tasks under specific real projects/portfolios (sample a few containers with real task counts)
function tasksUnderContainer(containerId) {
  return tasks.filter((t) => Number(t.projectId) === containerId || Number(t.portfolioId) === containerId);
}
const projectsWithTaskCounts = projects.map((p) => ({
  title: p.title, id: Number(p.sharePointItemId), type: p.type, status: p.status,
  taskCount: tasksUnderContainer(Number(p.sharePointItemId)).length,
})).filter((p) => p.taskCount > 0).sort((a, b) => b.taskCount - a.taskCount);

const summary = {
  counts: {
    tasks: { raw: tasksRaw.length, unique: tasks.length },
    projects: { raw: projectsRaw.length, unique: projects.length },
    portfolios: { raw: portfoliosRaw.length, unique: portfolios.length },
    meetings: { raw: meetingsRaw.length, unique: meetings.length },
    timeentries: { raw: timeentriesRaw.length, unique: timeentries.length },
    overdueTasksGlobal: overdueTasks.length,
  },
  statusCounts,
  topPeople: peopleList.slice(0, 30),
  recentProjects: containerSample(projects, 15),
  recentPortfolios: containerSample(portfolios, 15),
  projectsWithTaskCounts: projectsWithTaskCounts.slice(0, 25),
  meetingsRecent: meetingsSorted.slice(0, 20).map(m => ({ title: m.title, start: m.start, sourceKey: m.sourceKey, totalChunks: m.totalChunks })),
  meetingsOld: meetingsSorted.slice(-10).map(m => ({ title: m.title, start: m.start, sourceKey: m.sourceKey, totalChunks: m.totalChunks })),
  heavilyChunkedMeetings: heavilyChunked.slice(0, 10).map(m => ({ title: m.title, start: m.start, sourceKey: m.sourceKey, totalChunks: m.totalChunks })),
  lightlyChunkedMeetingsSample: lightlyChunked.slice(0, 10).map(m => ({ title: m.title, start: m.start, sourceKey: m.sourceKey })),
  tasksWithDueSample: tasksWithDue.slice(0, 20).map(t => ({ title: t.title, owner: t.owner, dueDate: t.dueDate, status: t.status, sharePointItemId: t.sharePointItemId })),
  overdueTasksSample: overdueTasks.slice(0, 20).map(t => ({ title: t.title, owner: t.owner, dueDate: t.dueDate, status: t.status })),
};

fs.writeFileSync(`${OUT}/data-catalog.json`, JSON.stringify(summary, null, 2));
console.log('Written to', `${OUT}/data-catalog.json`);
console.log('tasks', tasks.length, 'projects', projects.length, 'portfolios', portfolios.length, 'meetings', meetings.length, 'timeentries', timeentries.length);
console.log('unique people', peopleList.length);
console.log('overdue tasks global', overdueTasks.length);
process.exit(0);
