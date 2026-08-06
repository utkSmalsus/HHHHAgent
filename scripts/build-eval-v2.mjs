// Phase 15 — builds eval/v2/dataset.json + eval/v2/ground_truth.json from REAL production data.
// Ground truth is computed independently here (raw Qdrant payloads + the app's own verified,
// unit-tested business-logic functions — taskIsOverdue, descendantContainerIds, uniqueBusinessEntities),
// never from the live agent's own answers.
import { scrollPayloads, uniqueBusinessEntities } from '../src/services/qdrantScroll.js';
import { taskIsOverdue } from '../src/services/structuredFilters.js';
import { descendantContainerIds } from '../src/services/structuralRetrieve.js';
import fs from 'fs';

const NOW = new Date(); // frozen at generation time; recorded in ground_truth.json metadata

const tasks = uniqueBusinessEntities(await scrollPayloads({ types: ['task'], limit: 30000 }));
const projects = uniqueBusinessEntities(await scrollPayloads({ types: ['project'], limit: 20000 }));
const portfolios = uniqueBusinessEntities(await scrollPayloads({ types: ['portfolio'], limit: 20000 }));
const containers = [...projects, ...portfolios];
const meetings = uniqueBusinessEntities(await scrollPayloads({ types: ['meeting'], limit: 60000 }));
const timeentries = uniqueBusinessEntities(await scrollPayloads({ types: ['timeentry'], limit: 60000 }));
const byContainerId = new Map(containers.map((c) => [Number(c.sharePointItemId), c]));

function tasksOwnedBy(name) {
  return tasks.filter((t) => (t.owner || '') === name);
}
function tasksUnder(containerTitle) {
  const c = containers.find((x) => x.title === containerTitle);
  if (!c) return { container: null, tasks: [] };
  const ids = descendantContainerIds(Number(c.sharePointItemId), containers);
  return { container: c, tasks: tasks.filter((t) => ids.has(Number(t.projectId)) || ids.has(Number(t.portfolioId))) };
}
function meetingsInRange(start, end) {
  return meetings.filter((m) => m.start && new Date(m.start) >= start && new Date(m.start) <= end);
}
function dayRange(d) {
  const s = new Date(d); s.setHours(0, 0, 0, 0);
  const e = new Date(d); e.setHours(23, 59, 59, 999);
  return [s, e];
}
function weekRange(refDate) {
  const dow = (refDate.getDay() + 6) % 7;
  const mon = new Date(refDate); mon.setDate(refDate.getDate() - dow); mon.setHours(0, 0, 0, 0);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6); sun.setHours(23, 59, 59, 999);
  return [mon, sun];
}

// ---------------------------------------------------------------------------
// Question list. `q()` builds a single-turn item; `conv()` builds a multi-turn conversation
// (returned as an array of items sharing a conversationId, each with a turn index).
// ---------------------------------------------------------------------------
const items = [];
let autoId = {};
function nextId(prefix) {
  autoId[prefix] = (autoId[prefix] || 0) + 1;
  return `${prefix}_${String(autoId[prefix]).padStart(3, '0')}`;
}

function q({ prefix, category, difficulty, question, expected, evidence, failureSeverity, tags, note }) {
  const id = nextId(prefix);
  items.push({ id, category, difficulty, question, expected, evidence: evidence || { source: 'qdrant-direct' }, failureSeverity, tags: tags || [], note });
  return id;
}

// =========================================================================
// 1. PROJECTS / PORTFOLIOS (25)
// =========================================================================
q({ prefix: 'PROJ', category: 'projects_portfolios', difficulty: 'easy',
  question: 'What is the status of "SharePoint Framework - SPFx Improvement"?',
  expected: { answerType: 'fact', entityType: 'project', entityTitle: 'SharePoint Framework - SPFx Improvement', field: 'status', value: containers.find(c=>c.title==='SharePoint Framework - SPFx Improvement')?.status },
  failureSeverity: 'MEDIUM', tags: ['project', 'status', 'exact-title'] });

q({ prefix: 'PROJ', category: 'projects_portfolios', difficulty: 'easy',
  question: 'Is "Team Management System (Hardware/Software and Licenses)" a project or a portfolio?',
  expected: { answerType: 'fact', entityTitle: 'Team Management System (Hardware/Software and Licenses)', field: 'type', value: containers.find(c=>c.title==='Team Management System (Hardware/Software and Licenses)')?.type },
  failureSeverity: 'LOW', tags: ['type-lookup'] });

{
  const { container, tasks: t } = tasksUnder('SharePoint Framework - SPFx Improvement');
  q({ prefix: 'PROJ', category: 'projects_portfolios', difficulty: 'easy',
    question: 'How many tasks does "SharePoint Framework - SPFx Improvement" have?',
    expected: { answerType: 'count', entityType: 'task', containerTitle: container.title, containerId: Number(container.sharePointItemId), count: t.length },
    failureSeverity: 'HIGH', tags: ['count', 'container'] });
}

q({ prefix: 'PROJ', category: 'projects_portfolios', difficulty: 'easy',
  question: 'What is the status of "Content Management and Search"?',
  expected: { answerType: 'fact', entityTitle: 'Content Management and Search', field: 'status', value: containers.find(c=>c.title==='Content Management and Search')?.status },
  failureSeverity: 'MEDIUM', tags: ['project', 'status'] });

q({ prefix: 'PROJ', category: 'projects_portfolios', difficulty: 'easy',
  question: 'Is "MCP Server" a project or a portfolio?',
  expected: { answerType: 'fact', entityTitle: 'MCP Server', field: 'type', value: containers.find(c=>c.title==='MCP Server')?.type },
  failureSeverity: 'LOW', tags: ['type-lookup'] });

q({ prefix: 'PROJ', category: 'projects_portfolios', difficulty: 'medium',
  question: 'What portfolio is "MCP Server" a part of?',
  expected: { answerType: 'fact', entityTitle: 'MCP Server', field: 'parentTitle', value: byContainerId.get(Number(containers.find(c=>c.title==='MCP Server')?.parentId))?.title },
  failureSeverity: 'MEDIUM', tags: ['hierarchy', 'parent'] });

{
  const contactDb = containers.find(c => c.title === 'Contact Database' && c.type === 'portfolio');
  const children = containers.filter(c => Number(c.parentId) === Number(contactDb.sharePointItemId));
  q({ prefix: 'PROJ', category: 'projects_portfolios', difficulty: 'easy',
    question: 'How many direct sub-items does the "Contact Database" portfolio have?',
    expected: { answerType: 'count', entityType: 'portfolio+project', containerTitle: 'Contact Database', count: children.length },
    evidence: { source: 'qdrant-direct', note: 'direct children by parentId, not full descendant tree' },
    failureSeverity: 'MEDIUM', tags: ['hierarchy', 'count'] });
}

q({ prefix: 'PROJ', category: 'projects_portfolios', difficulty: 'easy',
  question: 'What is the status of "HHHH Automation"?',
  expected: { answerType: 'fact', entityTitle: 'HHHH Automation', field: 'status', value: containers.find(c=>c.title==='HHHH Automation')?.status },
  failureSeverity: 'MEDIUM', tags: ['project', 'status'] });

q({ prefix: 'PROJ', category: 'projects_portfolios', difficulty: 'easy',
  question: 'When was "Development Team Management System (Assets Accounts Permissions)" last updated?',
  expected: { answerType: 'fact', entityTitle: 'Development Team Management System (Assets Accounts Permissions)', field: 'timestamp', value: containers.find(c=>c.title==='Development Team Management System (Assets Accounts Permissions)')?.timestamp, note: 'field is Modified-or-Created, no separate Created field exists' },
  failureSeverity: 'MEDIUM', tags: ['date', 'timestamp'] });

q({ prefix: 'PROJ', category: 'projects_portfolios', difficulty: 'medium',
  question: 'Which project is a child of "HHHH Solution Migration to Single Page Application (SPA)"?',
  expected: { answerType: 'fact', entityType: 'project', answerContains: ['Task Management SPA'], note: 'multiple valid children exist; Task Management SPA is one correct real answer' },
  failureSeverity: 'MEDIUM', tags: ['hierarchy'] });

q({ prefix: 'PROJ', category: 'projects_portfolios', difficulty: 'easy',
  question: 'What is the status of the "Loveable AI" portfolio?',
  expected: { answerType: 'fact', entityTitle: 'Loveable AI', field: 'status', value: containers.find(c=>c.title==='Loveable AI')?.status },
  failureSeverity: 'MEDIUM', tags: ['portfolio', 'status'] });

{
  const { container, tasks: t } = tasksUnder('Timesheet - SPFx Issues and Bug fixing');
  q({ prefix: 'PROJ', category: 'projects_portfolios', difficulty: 'medium',
    question: 'How many tasks are there under "Timesheet - SPFx Issues and Bug fixing"?',
    expected: { answerType: 'count', entityType: 'task', containerTitle: container.title, count: t.length },
    failureSeverity: 'HIGH', tags: ['count', 'container'] });
}

q({ prefix: 'PROJ', category: 'projects_portfolios', difficulty: 'easy',
  question: 'What is the current status of "GitHub Backup Automation"?',
  expected: { answerType: 'fact', entityTitle: 'GitHub Backup Automation', field: 'status', value: containers.find(c=>c.title==='GitHub Backup Automation')?.status },
  failureSeverity: 'MEDIUM', tags: ['portfolio', 'status'] });

q({ prefix: 'PROJ', category: 'projects_portfolios', difficulty: 'medium',
  question: 'Tell me about "Create Mailweaver Tool" — what\'s its current status?',
  expected: { answerType: 'fact', entityTitle: 'Create Mailweaver Tool', field: 'status', value: containers.find(c=>c.title==='Create Mailweaver Tool')?.status },
  failureSeverity: 'MEDIUM', tags: ['vague-phrasing', 'status'] });

q({ prefix: 'PROJ', category: 'projects_portfolios', difficulty: 'medium',
  question: 'What is the parent project of "Task Management SPA"?',
  expected: { answerType: 'fact', entityTitle: 'Task Management SPA', field: 'parentTitle', value: byContainerId.get(Number(containers.find(c=>c.title==='Task Management SPA')?.parentId))?.title },
  failureSeverity: 'MEDIUM', tags: ['hierarchy', 'parent'] });

{
  const { container, tasks: t } = tasksUnder('Portfolio Tool - SPFx Issues and Bug fixing');
  q({ prefix: 'PROJ', category: 'projects_portfolios', difficulty: 'medium',
    question: 'How many tasks does "Portfolio Tool - SPFx Issues and Bug fixing" have?',
    expected: { answerType: 'count', entityType: 'task', containerTitle: container.title, count: t.length },
    failureSeverity: 'HIGH', tags: ['count', 'container'] });
}

q({ prefix: 'PROJ', category: 'projects_portfolios', difficulty: 'easy',
  question: 'What is the status of "AI Compatible Project for HHHH Components"?',
  expected: { answerType: 'fact', entityTitle: 'AI Compatible Project for HHHH Components', field: 'status', value: containers.find(c=>c.title==='AI Compatible Project for HHHH Components')?.status },
  failureSeverity: 'MEDIUM', tags: ['project', 'status'] });

q({ prefix: 'PROJ', category: 'projects_portfolios', difficulty: 'medium',
  question: 'Which portfolio contains "Scrum Agent"?',
  expected: { answerType: 'fact', entityTitle: 'Scrum Agent', field: 'parentTitle', value: byContainerId.get(Number(containers.find(c=>c.title==='Scrum Agent')?.parentId))?.title },
  failureSeverity: 'MEDIUM', tags: ['hierarchy', 'parent'] });

q({ prefix: 'PROJ', category: 'projects_portfolios', difficulty: 'hard',
  question: 'What\'s under the "Webstudio - SP & Public Site (Backend)" portfolio?',
  expected: { answerType: 'list', entityType: 'project+task', containerTitle: 'Webstudio - SP & Public Site (Backend)', requiredBehavior: 'must list real sub-items, not a vague summary' },
  failureSeverity: 'HIGH', tags: ['hierarchy', 'structural'] });

{
  const { container, tasks: t } = tasksUnder('Dynamic Dashboard development / improvements');
  q({ prefix: 'PROJ', category: 'projects_portfolios', difficulty: 'medium',
    question: 'How many tasks does "Dynamic Dashboard development / improvements" have?',
    expected: { answerType: 'count', entityType: 'task', containerTitle: container.title, count: t.length },
    failureSeverity: 'HIGH', tags: ['count', 'container'] });
}

q({ prefix: 'PROJ', category: 'projects_portfolios', difficulty: 'easy',
  question: 'What is the status of the "SharePoint Backup Automation" portfolio?',
  expected: { answerType: 'fact', entityTitle: 'SharePoint Backup Automation', field: 'status', value: containers.find(c=>c.title==='SharePoint Backup Automation')?.status },
  failureSeverity: 'MEDIUM', tags: ['portfolio', 'status'] });

q({ prefix: 'PROJ', category: 'projects_portfolios', difficulty: 'hard',
  question: 'Give me the structure of the "Design" project — what\'s under it?',
  expected: { answerType: 'list', entityType: 'task', containerTitle: 'Design', requiredBehavior: 'must reflect real sub-tasks, not invent structure' },
  failureSeverity: 'HIGH', tags: ['hierarchy', 'structural'] });

q({ prefix: 'PROJ', category: 'projects_portfolios', difficulty: 'easy',
  question: 'What is the status of "Webstudio - SP & Public Site UI/UX"?',
  expected: { answerType: 'fact', entityTitle: 'Webstudio - SP & Public Site UI/UX', field: 'status', value: containers.find(c=>c.title==='Webstudio - SP & Public Site UI/UX')?.status },
  failureSeverity: 'MEDIUM', tags: ['project', 'status'] });

{
  const proj = [...projects].sort((a,b)=>new Date(b.timestamp||0)-new Date(a.timestamp||0))[0];
  q({ prefix: 'PROJ', category: 'projects_portfolios', difficulty: 'hard',
    question: 'What is the most recently updated project?',
    expected: { answerType: 'fact', entityType: 'project', answerContains: [proj.title], field: 'timestamp', value: proj.timestamp },
    failureSeverity: 'HIGH', tags: ['recency', 'single-entity'] });
}

{
  const [y0, y1] = dayRange(new Date(Date.now() - 86400000));
  const updated = projects.filter(p => p.timestamp && new Date(p.timestamp) >= y0 && new Date(p.timestamp) <= y1);
  q({ prefix: 'PROJ', category: 'projects_portfolios', difficulty: 'medium',
    question: 'Which projects were updated yesterday?',
    expected: { answerType: 'list', entityType: 'project', count: updated.length, titles: updated.map(p=>p.title) },
    failureSeverity: 'HIGH', tags: ['date-list', 'temporal'] });
}

console.log('PROJ done:', items.filter(i=>i.id.startsWith('PROJ')).length);

// =========================================================================
// 2. TASKS / PEOPLE / OWNERS (25)
// =========================================================================
const PEOPLE = ['Stefan Hochhuth','Deepak Trivedi','Ranu Trivedi','Kamal Darani','Pravesh Kumar','Prashant Kumar','Ankita Pandit','Kamal Singh','Anshika Chaudhary','Robert Ungethuem','Shivdutt Mishra','Kristina Kovach','Piyoosh Bhardwaj','Thordis Jacobs','Sonal Choudhary','Garima Arya','Aditi Mishra','Satyendra Kumar','Divyanshu Kumar','Mattis Hahn','Utkarsh Srivastava','Anshu Mishra','Ankush Das','Kamal Kishore'];

for (const [name, diff] of [['Stefan Hochhuth','easy'],['Deepak Trivedi','easy'],['Kamal Darani','easy'],['Pravesh Kumar','easy'],['Ankita Pandit','easy'],['Anshika Chaudhary','medium'],['Robert Ungethuem','medium'],['Kristina Kovach','medium'],['Thordis Jacobs','medium'],['Garima Arya','medium']]) {
  const t = tasksOwnedBy(name);
  q({ prefix: 'TASK', category: 'tasks_people_owners', difficulty: diff,
    question: `How many tasks does ${name} have?`,
    expected: { answerType: 'count', entityType: 'task', person: name, count: t.length },
    evidence: { source: 'qdrant-direct', businessEntityKey: 'sourceKey', note: 'exact Owner-field match (sole owner), not any-co-owner' },
    failureSeverity: 'CRITICAL', tags: ['person-filter', 'count'] });
}

for (const name of ['Ranu Trivedi', 'Deepak Trivedi', 'Ankita Pandit']) {
  const t = tasksOwnedBy(name).filter((x) => taskIsOverdue(x, NOW));
  q({ prefix: 'TASK', category: 'tasks_people_owners', difficulty: 'medium',
    question: `Does ${name} have any overdue tasks?`,
    expected: { answerType: 'count', entityType: 'task', person: name, overdue: true, count: t.length },
    evidence: { source: 'qdrant-direct', businessEntityKey: 'sourceKey' },
    failureSeverity: 'CRITICAL', tags: ['person-filter', 'overdue', 'count'] });
}

{
  const t = tasksOwnedBy('Ranu Trivedi').filter((x) => /completed/i.test(x.status || ''));
  q({ prefix: 'TASK', category: 'tasks_people_owners', difficulty: 'medium',
    question: 'How many completed tasks does Ranu Trivedi have?',
    expected: { answerType: 'count', entityType: 'task', person: 'Ranu Trivedi', status: 'completed', count: t.length },
    failureSeverity: 'HIGH', tags: ['person-filter', 'status', 'count'] });
}
{
  const t = tasksOwnedBy('Deepak Trivedi').filter((x) => x.status === 'working on it' || x.status === 'In Progress');
  q({ prefix: 'TASK', category: 'tasks_people_owners', difficulty: 'medium',
    question: 'How many in-progress tasks does Deepak Trivedi have?',
    expected: { answerType: 'count', entityType: 'task', person: 'Deepak Trivedi', status: 'in progress', count: t.length },
    failureSeverity: 'HIGH', tags: ['person-filter', 'status', 'count'] });
}

q({ prefix: 'TASK', category: 'tasks_people_owners', difficulty: 'easy',
  question: 'Who is the owner of the "Development - Tasks By Team View" task?',
  expected: { answerType: 'fact', entityType: 'task', entityTitle: 'Development - Tasks By Team View', field: 'owner', value: tasks.find(t=>t.title==='Development - Tasks By Team View')?.owner },
  failureSeverity: 'HIGH', tags: ['owner-lookup', 'exact-title'] });

q({ prefix: 'TASK', category: 'tasks_people_owners', difficulty: 'easy',
  question: 'Who is working on "Team Management System (Hardware/Software and Licenses)"?',
  expected: { answerType: 'list', entityType: 'person', containerTitle: 'Team Management System (Hardware/Software and Licenses)', requiredBehavior: 'must list real distinct owners from tasks under this portfolio' },
  failureSeverity: 'HIGH', tags: ['who-works-on'] });

{
  const t1 = tasksOwnedBy('Ranu Trivedi'), tmt = tasksUnder('Team Management Tools');
  const idsSet = tmt.container ? descendantContainerIds(Number(tmt.container.sharePointItemId), containers) : new Set();
  const combo = t1.filter(t => idsSet.has(Number(t.projectId)) || idsSet.has(Number(t.portfolioId)));
  q({ prefix: 'TASK', category: 'tasks_people_owners', difficulty: 'hard',
    question: 'How many tasks does Ranu Trivedi have in Team Management Tools?',
    expected: { answerType: 'count', entityType: 'task', person: 'Ranu Trivedi', containerTitle: 'Team Management Tools', count: combo.length },
    failureSeverity: 'CRITICAL', tags: ['person-filter', 'container-filter', 'count', 'composition'] });
}
{
  const t1 = tasksOwnedBy('Ranu Trivedi').filter(t=>taskIsOverdue(t,NOW)), tmt = tasksUnder('Team Management Tools');
  const idsSet = tmt.container ? descendantContainerIds(Number(tmt.container.sharePointItemId), containers) : new Set();
  const combo = t1.filter(t => idsSet.has(Number(t.projectId)) || idsSet.has(Number(t.portfolioId)));
  q({ prefix: 'TASK', category: 'tasks_people_owners', difficulty: 'hard',
    question: 'Does Ranu Trivedi have any overdue tasks in Team Management Tools?',
    expected: { answerType: 'count', entityType: 'task', person: 'Ranu Trivedi', overdue: true, containerTitle: 'Team Management Tools', count: combo.length },
    failureSeverity: 'CRITICAL', tags: ['person-filter', 'container-filter', 'overdue', 'count', 'composition'] });
}

q({ prefix: 'TASK', category: 'tasks_people_owners', difficulty: 'hard',
  question: 'How many tasks does Kamal have?',
  expected: { answerType: 'behavior', requiredBehavior: 'AMBIGUOUS', note: '"Kamal" matches 3 distinct real people: Kamal Darani, Kamal Singh, Kamal Kishore — must surface ambiguity, never arbitrarily pick one' },
  failureSeverity: 'CRITICAL', tags: ['ambiguity', 'person-filter'] });

q({ prefix: 'TASK', category: 'tasks_people_owners', difficulty: 'easy',
  question: 'What tasks are assigned to Kamal Darani?',
  expected: { answerType: 'list', entityType: 'task', person: 'Kamal Darani', count: tasksOwnedBy('Kamal Darani').length },
  failureSeverity: 'HIGH', tags: ['person-filter', 'owned-by'] });

q({ prefix: 'TASK', category: 'tasks_people_owners', difficulty: 'medium',
  question: 'What tasks belong to Piyoosh Bhardwaj?',
  expected: { answerType: 'list', entityType: 'task', person: 'Piyoosh Bhardwaj', count: tasksOwnedBy('Piyoosh Bhardwaj').length },
  failureSeverity: 'HIGH', tags: ['person-filter', 'owned-by'] });

q({ prefix: 'TASK', category: 'tasks_people_owners', difficulty: 'easy',
  question: "Whose tasks include \"Bug - All Time Entry\"?",
  expected: { answerType: 'fact', entityType: 'task', entityTitle: 'Bug - All Time Entry', field: 'owner', value: tasks.find(t=>t.title==='Bug - All Time Entry')?.owner },
  failureSeverity: 'HIGH', tags: ['owner-lookup'] });

{
  const t = tasksOwnedBy('Sonal Choudhary');
  q({ prefix: 'TASK', category: 'tasks_people_owners', difficulty: 'medium',
    question: "Sonal Choudhary's tasks — how many are there?",
    expected: { answerType: 'count', entityType: 'task', person: 'Sonal Choudhary', count: t.length },
    failureSeverity: 'CRITICAL', tags: ['person-filter', 'possessive-phrasing', 'count'] });
}
{
  const t = tasksOwnedBy('Aditi Mishra').filter(x=>taskIsOverdue(x,NOW));
  q({ prefix: 'TASK', category: 'tasks_people_owners', difficulty: 'medium',
    question: "Aditi Mishra's overdue tasks — how many?",
    expected: { answerType: 'count', entityType: 'task', person: 'Aditi Mishra', overdue: true, count: t.length },
    failureSeverity: 'CRITICAL', tags: ['person-filter', 'possessive-phrasing', 'overdue', 'count'] });
}

q({ prefix: 'TASK', category: 'tasks_people_owners', difficulty: 'hard',
  question: 'Which of Satyendra Kumar\'s tasks are still In QA Review?',
  expected: { answerType: 'count', entityType: 'task', person: 'Satyendra Kumar', status: 'In QA Review', count: tasksOwnedBy('Satyendra Kumar').filter(t=>t.status==='In QA Review').length },
  failureSeverity: 'HIGH', tags: ['person-filter', 'status', 'count'] });

q({ prefix: 'TASK', category: 'tasks_people_owners', difficulty: 'easy',
  question: 'Who owns "Excel contact data base + payroll template"?',
  expected: { answerType: 'fact', entityType: 'task', entityTitle: 'Excel contact data base + payroll template', field: 'owner', value: tasks.find(t=>t.title==='Excel contact data base + payroll template')?.owner },
  failureSeverity: 'HIGH', tags: ['owner-lookup'] });

{
  const t = tasksOwnedBy('Divyanshu Kumar');
  q({ prefix: 'TASK', category: 'tasks_people_owners', difficulty: 'medium',
    question: 'How many tasks does Divyanshu Kumar currently have?',
    expected: { answerType: 'count', entityType: 'task', person: 'Divyanshu Kumar', count: t.length },
    failureSeverity: 'CRITICAL', tags: ['person-filter', 'count'] });
}
{
  const t = tasksOwnedBy('Mattis Hahn');
  q({ prefix: 'TASK', category: 'tasks_people_owners', difficulty: 'medium',
    question: 'What tasks are owned by Mattis Hahn?',
    expected: { answerType: 'list', entityType: 'task', person: 'Mattis Hahn', count: t.length },
    failureSeverity: 'HIGH', tags: ['person-filter', 'owned-by'] });
}

q({ prefix: 'TASK', category: 'tasks_people_owners', difficulty: 'hard',
  question: 'How many tasks does Utkarsh Srivastava have that are Acknowledged?',
  expected: { answerType: 'count', entityType: 'task', person: 'Utkarsh Srivastava', status: 'Acknowledged', count: tasksOwnedBy('Utkarsh Srivastava').filter(t=>t.status==='Acknowledged').length },
  failureSeverity: 'HIGH', tags: ['person-filter', 'status', 'count'] });

q({ prefix: 'TASK', category: 'tasks_people_owners', difficulty: 'easy',
  question: 'Does Anshu Mishra have any overdue tasks?',
  expected: { answerType: 'count', entityType: 'task', person: 'Anshu Mishra', overdue: true, count: tasksOwnedBy('Anshu Mishra').filter(t=>taskIsOverdue(t,NOW)).length },
  failureSeverity: 'CRITICAL', tags: ['person-filter', 'overdue', 'count'] });

q({ prefix: 'TASK', category: 'tasks_people_owners', difficulty: 'hard',
  question: 'How many tasks does Priya Malhotra have?',
  expected: { answerType: 'behavior', requiredBehavior: 'NOT_FOUND', forbiddenBehaviors: ['GLOBAL_COUNT', 'WRONG_ENTITY_GUESS'], note: 'Priya Malhotra does not exist in the indexed data — verified against all 62 real owner names' },
  failureSeverity: 'CRITICAL', tags: ['negative', 'nonexistent-person'] });

console.log('TASK done:', items.filter(i=>i.id.startsWith('TASK')).length);

// =========================================================================
// 3. COUNTS / STATUS / OVERDUE (20) — global and status/overdue aggregates,
// distinct from TASK's person-scoped counts above.
// =========================================================================
const DONE_RE = /^(task completed|completed|approved|ready to go)/i;

q({ prefix: 'CNT', category: 'counts_status_overdue', difficulty: 'easy',
  question: 'How many tasks are there in total?',
  expected: { answerType: 'count', entityType: 'task', count: tasks.length },
  failureSeverity: 'CRITICAL', tags: ['global-count'] });
q({ prefix: 'CNT', category: 'counts_status_overdue', difficulty: 'easy',
  question: 'How many projects are there?',
  expected: { answerType: 'count', entityType: 'project', count: projects.length },
  failureSeverity: 'CRITICAL', tags: ['global-count'] });
q({ prefix: 'CNT', category: 'counts_status_overdue', difficulty: 'easy',
  question: 'How many portfolios are there?',
  expected: { answerType: 'count', entityType: 'portfolio', count: portfolios.length },
  failureSeverity: 'CRITICAL', tags: ['global-count'] });
q({ prefix: 'CNT', category: 'counts_status_overdue', difficulty: 'easy',
  question: 'How many meetings are there in total?',
  expected: { answerType: 'count', entityType: 'meeting', count: meetings.length },
  failureSeverity: 'CRITICAL', tags: ['global-count', 'chunk-inflation-risk'] });
q({ prefix: 'CNT', category: 'counts_status_overdue', difficulty: 'easy',
  question: 'How many time entries are there?',
  expected: { answerType: 'count', entityType: 'timeentry', count: timeentries.length },
  failureSeverity: 'CRITICAL', tags: ['global-count'] });

q({ prefix: 'CNT', category: 'counts_status_overdue', difficulty: 'easy',
  question: 'How many tasks are currently marked "Not Started"?',
  expected: { answerType: 'count', entityType: 'task', status: 'Not Started', count: tasks.filter(t=>t.status==='Not Started').length },
  failureSeverity: 'HIGH', tags: ['status', 'count'] });
q({ prefix: 'CNT', category: 'counts_status_overdue', difficulty: 'easy',
  question: 'How many tasks are in "In QA Review"?',
  expected: { answerType: 'count', entityType: 'task', status: 'In QA Review', count: tasks.filter(t=>t.status==='In QA Review').length },
  failureSeverity: 'HIGH', tags: ['status', 'count'] });
q({ prefix: 'CNT', category: 'counts_status_overdue', difficulty: 'medium',
  question: 'How many tasks have been completed?',
  expected: { answerType: 'count', entityType: 'task', status: 'completed', count: tasks.filter(t=>DONE_RE.test(t.status||'')).length, note: 'matches "Task completed"/"Completed"/"Approved"/"Ready to Go" per the app\'s own verified DONE_RE definition' },
  failureSeverity: 'HIGH', tags: ['status', 'count'] });
q({ prefix: 'CNT', category: 'counts_status_overdue', difficulty: 'easy',
  question: 'How many tasks are "Acknowledged"?',
  expected: { answerType: 'count', entityType: 'task', status: 'Acknowledged', count: tasks.filter(t=>t.status==='Acknowledged').length },
  failureSeverity: 'HIGH', tags: ['status', 'count'] });
q({ prefix: 'CNT', category: 'counts_status_overdue', difficulty: 'medium',
  question: 'How many tasks are "Deployment Pending"?',
  expected: { answerType: 'count', entityType: 'task', status: 'Deployment Pending', count: tasks.filter(t=>t.status==='Deployment Pending').length },
  failureSeverity: 'HIGH', tags: ['status', 'count'] });
q({ prefix: 'CNT', category: 'counts_status_overdue', difficulty: 'medium',
  question: 'How many tasks are in "Re-Open" status?',
  expected: { answerType: 'count', entityType: 'task', status: 'Re-Open', count: tasks.filter(t=>t.status==='Re-Open').length },
  failureSeverity: 'HIGH', tags: ['status', 'count'] });

q({ prefix: 'CNT', category: 'counts_status_overdue', difficulty: 'hard',
  question: 'How many tasks are overdue in total?',
  expected: { answerType: 'count', entityType: 'task', overdue: true, count: tasks.filter(t=>taskIsOverdue(t,NOW)).length },
  failureSeverity: 'CRITICAL', tags: ['overdue', 'global-count'] });

{
  const anchor = containers.find(c=>c.title==='Team Management Tools' && c.type==='project');
  const ids = descendantContainerIds(Number(anchor.sharePointItemId), containers);
  const t = tasks.filter(x=>ids.has(Number(x.projectId))||ids.has(Number(x.portfolioId)));
  q({ prefix: 'CNT', category: 'counts_status_overdue', difficulty: 'medium',
    question: 'How many tasks does Team Management Tools have?',
    expected: { answerType: 'count', entityType: 'task', containerTitle: 'Team Management Tools', count: t.length },
    evidence: { source: 'qdrant-direct', businessEntityKey: 'sourceKey', note: 'Phase 14 regression fixture — raw was 61, business-entity count is the value here' },
    failureSeverity: 'CRITICAL', tags: ['container-filter', 'count', 'chunk-inflation-risk'] });
  q({ prefix: 'CNT', category: 'counts_status_overdue', difficulty: 'hard',
    question: 'How many overdue tasks does Team Management Tools have?',
    expected: { answerType: 'count', entityType: 'task', containerTitle: 'Team Management Tools', overdue: true, count: t.filter(x=>taskIsOverdue(x,NOW)).length },
    failureSeverity: 'HIGH', tags: ['container-filter', 'overdue', 'count', 'composition'] });
}

q({ prefix: 'CNT', category: 'counts_status_overdue', difficulty: 'hard',
  question: 'How many distinct people own at least one task?',
  expected: { answerType: 'count', entityType: 'person', count: new Set(tasks.flatMap(t=>(t.owner||'').split(',').map(s=>s.trim()).filter(Boolean))).size },
  failureSeverity: 'MEDIUM', tags: ['aggregate', 'people'] });

{
  const anchor = containers.find(c=>c.title==='Task Popup - SPFx Issues and Bug fixing');
  const ids = descendantContainerIds(Number(anchor.sharePointItemId), containers);
  const t = tasks.filter(x=>ids.has(Number(x.projectId))||ids.has(Number(x.portfolioId)));
  q({ prefix: 'CNT', category: 'counts_status_overdue', difficulty: 'medium',
    question: 'How many tasks does "Task Popup - SPFx Issues and Bug fixing" have?',
    expected: { answerType: 'count', entityType: 'task', containerTitle: anchor.title, count: t.length },
    failureSeverity: 'HIGH', tags: ['container-filter', 'count'] });
}
{
  const anchor = containers.find(c=>c.title==='SharePoint Framework - SPFx Improvement');
  const ids = descendantContainerIds(Number(anchor.sharePointItemId), containers);
  const t = tasks.filter(x=>ids.has(Number(x.projectId))||ids.has(Number(x.portfolioId)));
  q({ prefix: 'CNT', category: 'counts_status_overdue', difficulty: 'hard',
    question: 'How many completed tasks does "SharePoint Framework - SPFx Improvement" have?',
    expected: { answerType: 'count', entityType: 'task', containerTitle: anchor.title, status: 'completed', count: t.filter(x=>DONE_RE.test(x.status||'')).length },
    failureSeverity: 'HIGH', tags: ['container-filter', 'status', 'count', 'composition'] });
}

q({ prefix: 'CNT', category: 'counts_status_overdue', difficulty: 'medium',
  question: 'How many tasks have no due date recorded?',
  expected: { answerType: 'count', entityType: 'task', count: tasks.filter(t=>!t.dueDate).length },
  failureSeverity: 'MEDIUM', tags: ['data-quality', 'count'] });

q({ prefix: 'CNT', category: 'counts_status_overdue', difficulty: 'medium',
  question: 'How many time entries has Ranu Trivedi logged?',
  expected: { answerType: 'count', entityType: 'timeentry', person: 'Ranu Trivedi', count: timeentries.filter(t=>t.authorName==='Ranu Trivedi').length },
  failureSeverity: 'HIGH', tags: ['timeentry', 'person-filter', 'count'] });

console.log('CNT done:', items.filter(i=>i.id.startsWith('CNT')).length);

// =========================================================================
// 4. DATES / LATEST / SORTING (20)
// =========================================================================
{
  const latest5 = [...projects].sort((a,b)=>new Date(b.timestamp||0)-new Date(a.timestamp||0)).slice(0,5);
  q({ prefix: 'DATE', category: 'dates_latest_sorting', difficulty: 'medium',
    question: 'Show the latest 5 projects.',
    expected: { answerType: 'list', entityType: 'project', titles: latest5.map(p=>p.title), orderMatters: true },
    failureSeverity: 'HIGH', tags: ['recency', 'list', 'sort'] });
}
{
  const latest5p = [...portfolios].sort((a,b)=>new Date(b.timestamp||0)-new Date(a.timestamp||0)).slice(0,5);
  q({ prefix: 'DATE', category: 'dates_latest_sorting', difficulty: 'medium',
    question: 'What are the 5 most recently updated portfolios?',
    expected: { answerType: 'list', entityType: 'portfolio', titles: latest5p.map(p=>p.title), orderMatters: true },
    failureSeverity: 'HIGH', tags: ['recency', 'list', 'sort'] });
}
{
  const mostRecent = [...portfolios].sort((a,b)=>new Date(b.timestamp||0)-new Date(a.timestamp||0))[0];
  q({ prefix: 'DATE', category: 'dates_latest_sorting', difficulty: 'hard',
    question: 'Which portfolio was updated most recently?',
    expected: { answerType: 'fact', entityType: 'portfolio', answerContains: [mostRecent.title], field: 'timestamp', value: mostRecent.timestamp },
    failureSeverity: 'HIGH', tags: ['recency', 'single-entity'] });
}
{
  const now = new Date();
  const y0 = new Date(now.getFullYear(),now.getMonth(),now.getDate()-1,0,0,0), y1 = new Date(now.getFullYear(),now.getMonth(),now.getDate()-1,23,59,59);
  const dueYesterday = tasks.filter(t=>t.dueDate && new Date(t.dueDate)>=y0 && new Date(t.dueDate)<=y1);
  q({ prefix: 'DATE', category: 'dates_latest_sorting', difficulty: 'medium',
    question: 'Which tasks were due yesterday?',
    expected: { answerType: 'list', entityType: 'task', count: dueYesterday.length, titles: dueYesterday.map(t=>t.title) },
    failureSeverity: 'HIGH', tags: ['due-date', 'temporal', 'list'] });
}
{
  const now = new Date();
  const dow=(now.getDay()+6)%7;
  const monThis=new Date(now.getFullYear(),now.getMonth(),now.getDate()-dow,0,0,0);
  const sunThis=new Date(monThis.getFullYear(),monThis.getMonth(),monThis.getDate()+6,23,59,59);
  const dueThisWeek = tasks.filter(t=>t.dueDate && new Date(t.dueDate)>=monThis && new Date(t.dueDate)<=sunThis);
  q({ prefix: 'DATE', category: 'dates_latest_sorting', difficulty: 'medium',
    question: 'Which tasks are due this week?',
    expected: { answerType: 'list', entityType: 'task', count: dueThisWeek.length, titles: dueThisWeek.map(t=>t.title) },
    failureSeverity: 'HIGH', tags: ['due-date', 'temporal', 'list'] });
}
q({ prefix: 'DATE', category: 'dates_latest_sorting', difficulty: 'easy',
  question: 'What tasks are due on 16/06/2026?',
  expected: { answerType: 'list', entityType: 'task', titles: ['Development - Migrate Project Profile from SDC to SP Online'], note: 'DD/MM/YYYY locale — must not be misread as US MM/DD' },
  failureSeverity: 'CRITICAL', tags: ['due-date', 'explicit-date', 'locale'] });
q({ prefix: 'DATE', category: 'dates_latest_sorting', difficulty: 'easy',
  question: 'What is the due date of "Development - Tasks By Team View"?',
  expected: { answerType: 'fact', entityType: 'task', entityTitle: 'Development - Tasks By Team View', field: 'dueDate', value: '2023-06-16' },
  failureSeverity: 'HIGH', tags: ['due-date', 'exact-title'] });
{
  const overdue = tasks.filter(t=>taskIsOverdue(t,NOW)).sort((a,b)=>new Date(a.dueDate)-new Date(b.dueDate));
  q({ prefix: 'DATE', category: 'dates_latest_sorting', difficulty: 'hard',
    question: 'Which overdue task has been overdue the longest?',
    expected: { answerType: 'fact', entityType: 'task', answerContains: [overdue[0].title], field: 'dueDate', value: overdue[0].dueDate },
    failureSeverity: 'MEDIUM', tags: ['overdue', 'sort', 'hard'] });
}
q({ prefix: 'DATE', category: 'dates_latest_sorting', difficulty: 'hard',
  question: 'What is the most recently updated project?',
  expected: { answerType: 'fact', entityType: 'project', answerContains: [[...projects].sort((a,b)=>new Date(b.timestamp||0)-new Date(a.timestamp||0))[0].title] },
  failureSeverity: 'HIGH', tags: ['recency', 'single-entity', 'duplicate-phrasing-check'] });
q({ prefix: 'DATE', category: 'dates_latest_sorting', difficulty: 'hard',
  question: 'Which project was updated most recently?',
  expected: { answerType: 'fact', entityType: 'project', answerContains: [[...projects].sort((a,b)=>new Date(b.timestamp||0)-new Date(a.timestamp||0))[0].title], note: 'word-reordered phrasing of the previous question — regression check for #16-class phrasing gaps' },
  failureSeverity: 'HIGH', tags: ['recency', 'single-entity', 'phrasing-variant'] });
{
  const t = containers.find(c=>c.title==='HHHH Automation');
  q({ prefix: 'DATE', category: 'dates_latest_sorting', difficulty: 'easy',
    question: 'When was "HHHH Automation" last updated?',
    expected: { answerType: 'fact', entityTitle: 'HHHH Automation', field: 'timestamp', value: t.timestamp },
    failureSeverity: 'MEDIUM', tags: ['date-lookup'] });
}
q({ prefix: 'DATE', category: 'dates_latest_sorting', difficulty: 'medium',
  question: 'Which projects were updated today?',
  expected: { answerType: 'list', entityType: 'project', requiredBehavior: 'must reflect real timestamp filtering for today only, not a stale cached list' },
  failureSeverity: 'HIGH', tags: ['temporal', 'list'] });
q({ prefix: 'DATE', category: 'dates_latest_sorting', difficulty: 'medium',
  question: 'Which portfolios were updated this week?',
  expected: { answerType: 'list', entityType: 'portfolio', requiredBehavior: 'must reflect real timestamp filtering for this week only' },
  failureSeverity: 'HIGH', tags: ['temporal', 'list'] });
q({ prefix: 'DATE', category: 'dates_latest_sorting', difficulty: 'hard',
  question: 'Which tasks are overdue and due before 01/01/2023?',
  expected: { answerType: 'list', entityType: 'task', count: tasks.filter(t=>taskIsOverdue(t,NOW) && new Date(t.dueDate) < new Date(2023,0,1)).length },
  failureSeverity: 'MEDIUM', tags: ['overdue', 'date-range', 'composition'] });
q({ prefix: 'DATE', category: 'dates_latest_sorting', difficulty: 'easy',
  question: 'Show the top 3 latest projects.',
  expected: { answerType: 'list', entityType: 'project', titles: [...projects].sort((a,b)=>new Date(b.timestamp||0)-new Date(a.timestamp||0)).slice(0,3).map(p=>p.title), orderMatters: true },
  failureSeverity: 'MEDIUM', tags: ['recency', 'list', 'limit'] });
q({ prefix: 'DATE', category: 'dates_latest_sorting', difficulty: 'medium',
  question: 'Was the "Design" project created in 2026?',
  expected: { answerType: 'behavior', requiredBehavior: 'UNSUPPORTED', note: 'no true "Created" field is tracked in the ingested schema — only Modified-or-Created timestamp; a correct answer discloses this limitation rather than asserting a real creation date' },
  failureSeverity: 'MEDIUM', tags: ['unsupported-field', 'hallucination-trap'] });
q({ prefix: 'DATE', category: 'dates_latest_sorting', difficulty: 'medium',
  question: 'What tasks are due in 2026?',
  expected: { answerType: 'list', entityType: 'task', count: tasks.filter(t=>t.dueDate && new Date(t.dueDate).getFullYear()===2026).length, note: 'bare-year query — must not resolve "2026" as an entity name collision (e.g. a title containing 2026)' },
  failureSeverity: 'MEDIUM', tags: ['bare-number', 'vocabulary-collision'] });
q({ prefix: 'DATE', category: 'dates_latest_sorting', difficulty: 'hard',
  question: 'How many tasks were due last month?',
  expected: { answerType: 'count', entityType: 'task', count: (() => {
    const now = NOW; const s = new Date(now.getFullYear(), now.getMonth()-1, 1); const e = new Date(now.getFullYear(), now.getMonth(), 0, 23,59,59,999);
    return tasks.filter(t=>t.dueDate && new Date(t.dueDate)>=s && new Date(t.dueDate)<=e).length;
  })() },
  failureSeverity: 'HIGH', tags: ['due-date', 'temporal', 'count'] });
q({ prefix: 'DATE', category: 'dates_latest_sorting', difficulty: 'medium',
  question: 'What is the earliest due date among Ranu Trivedi\'s tasks?',
  expected: { answerType: 'fact', entityType: 'task', person: 'Ranu Trivedi', field: 'dueDate', value: (() => {
    const withDue = tasksOwnedBy('Ranu Trivedi').filter(t=>t.dueDate).sort((a,b)=>new Date(a.dueDate)-new Date(b.dueDate));
    return withDue[0]?.dueDate;
  })() },
  failureSeverity: 'MEDIUM', tags: ['person-filter', 'sort', 'composition'] });

console.log('DATE done:', items.filter(i=>i.id.startsWith('DATE')).length);

// =========================================================================
// 5. MEETINGS (20)
// =========================================================================
function meetingByTitle(title) { return meetings.find((m) => m.title === title); }

q({ prefix: 'MEET', category: 'meetings', difficulty: 'easy',
  question: 'When did the "SCRUM - 25/06/2026" meeting happen?',
  expected: { answerType: 'fact', entityType: 'meeting', entityTitle: 'SCRUM - 25/06/2026', field: 'start', value: '2026-06-25' },
  evidence: { source: 'qdrant-direct', sourceKey: meetingByTitle('SCRUM - 25/06/2026')?.sourceKey },
  failureSeverity: 'HIGH', tags: ['meeting-date', 'exact-title'] });

q({ prefix: 'MEET', category: 'meetings', difficulty: 'easy',
  question: 'Who participated in the "SCRUM - 25/06/2026" meeting?',
  expected: { answerType: 'list', entityType: 'person', entityTitle: 'SCRUM - 25/06/2026',
    expectedFacts: ['Prashant Kumar', 'Deepak Trivedi', 'Ranu Trivedi', 'Ankush Das', 'Anshu Mishra', 'Utkarsh Srivastava', 'Kamal Kishore', 'Kamal Singh', 'Atul Kumar', 'Umang Kumar'] },
  evidence: { source: 'qdrant-direct', sourceKey: meetingByTitle('SCRUM - 25/06/2026')?.sourceKey, chunkIndex: 0, region: 'beginning' },
  failureSeverity: 'HIGH', tags: ['meeting-participants', 'exact-title'] });

q({ prefix: 'MEET', category: 'meetings', difficulty: 'medium',
  question: 'What were the action items from the "SCRUM - 25/06/2026" meeting?',
  expected: { answerType: 'semantic', entityTitle: 'SCRUM - 25/06/2026',
    expectedFacts: ['Clean up unused properties and fields from time-sheet JSON entries', 'Test Lovable tool to create a complex component', 'Prepare a guide for requesting and assigning software licenses'] },
  evidence: { source: 'qdrant-direct', sourceKey: meetingByTitle('SCRUM - 25/06/2026')?.sourceKey, chunkIndex: 0, region: 'beginning' },
  failureSeverity: 'MEDIUM', tags: ['action-items', 'semantic'] });

q({ prefix: 'MEET', category: 'meetings', difficulty: 'medium',
  question: 'Who attended the "Loveable KT" meeting?',
  expected: { answerType: 'list', entityType: 'person', entityTitle: 'Loveable KT',
    expectedFacts: ['Prashant Kumar', 'Ranu Trivedi', 'Deepak Trivedi', 'Vivekanand', 'Utkarsh Srivastava'] },
  evidence: { source: 'qdrant-direct', sourceKey: meetingByTitle('Loveable KT')?.sourceKey, chunkIndex: 0, region: 'beginning' },
  failureSeverity: 'HIGH', tags: ['meeting-participants'] });

q({ prefix: 'MEET', category: 'meetings', difficulty: 'medium',
  question: 'What was discussed in the "Loveable KT" meeting?',
  expected: { answerType: 'semantic', entityTitle: 'Loveable KT',
    expectedFacts: ['Lovable is an AI-powered development platform', 'connected to SharePoint via GitHub', 'automated CI/CD pipeline pushing code to the App Catalog'] },
  evidence: { source: 'qdrant-direct', sourceKey: meetingByTitle('Loveable KT')?.sourceKey, chunkIndex: 0, region: 'beginning' },
  failureSeverity: 'MEDIUM', tags: ['topic', 'semantic'] });

q({ prefix: 'MEET', category: 'meetings', difficulty: 'medium',
  question: 'Who was in the "SPA Shared Packages Discussion" meeting?',
  expected: { answerType: 'list', entityType: 'person', entityTitle: 'SPA Shared Packages Discussion',
    expectedFacts: ['Kamal Singh', 'Deepak Trivedi', 'Anshu Mishra', 'Utkarsh Srivastava', 'Nikky Jha', 'Nitin Chauhan', 'Ankush Das', 'Kamal Kishore', 'Vikas Kumar Yadav'] },
  evidence: { source: 'qdrant-direct', sourceKey: meetingByTitle('SPA Shared Packages Discussion')?.sourceKey, chunkIndex: 0, region: 'beginning' },
  failureSeverity: 'HIGH', tags: ['meeting-participants'] });

q({ prefix: 'MEET', category: 'meetings', difficulty: 'hard',
  question: 'What key decisions came out of the "SPA Shared Packages Discussion" meeting?',
  expected: { answerType: 'semantic', entityTitle: 'SPA Shared Packages Discussion',
    expectedFacts: ['the main solution was divided into six separate packages', 'using inline CSS only', 'targeting 80% design match initially'] },
  evidence: { source: 'qdrant-direct', sourceKey: meetingByTitle('SPA Shared Packages Discussion')?.sourceKey, chunkIndex: 0, region: 'beginning' },
  failureSeverity: 'MEDIUM', tags: ['decisions', 'semantic'] });

q({ prefix: 'MEET', category: 'meetings', difficulty: 'easy',
  question: 'Did any meetings happen today?',
  expected: { answerType: 'count', entityType: 'meeting', dateScope: 'today', count: 0, requiredBehavior: 'must correctly say zero, not fabricate a meeting' },
  failureSeverity: 'HIGH', tags: ['meeting-date', 'temporal', 'hallucination-trap'] });

q({ prefix: 'MEET', category: 'meetings', difficulty: 'easy',
  question: 'What meeting happened yesterday?',
  expected: { answerType: 'fact', entityType: 'meeting', answerContains: ['Scrum 4/08/2026'] },
  failureSeverity: 'HIGH', tags: ['meeting-date', 'temporal'] });

q({ prefix: 'MEET', category: 'meetings', difficulty: 'medium',
  question: 'How many meetings happened this week?',
  expected: { answerType: 'count', entityType: 'meeting', dateScope: 'this week', count: 2, titles: ['Scrum 4/08/2026', 'Scrum 3/08/2026'] },
  evidence: { source: 'qdrant-direct', businessEntityKey: 'sourceKey', note: 'Phase 13/14 regression fixture — must use start field + business-entity dedup, not raw chunk points' },
  failureSeverity: 'CRITICAL', tags: ['meeting-date', 'temporal', 'count', 'chunk-inflation-risk'] });

q({ prefix: 'MEET', category: 'meetings', difficulty: 'medium',
  question: 'How many meetings happened last week?',
  expected: { answerType: 'count', entityType: 'meeting', dateScope: 'last week', count: 6 },
  failureSeverity: 'CRITICAL', tags: ['meeting-date', 'temporal', 'count', 'chunk-inflation-risk'] });

q({ prefix: 'MEET', category: 'meetings', difficulty: 'medium',
  question: 'What meetings happened last week?',
  expected: { answerType: 'list', entityType: 'meeting', titles: ['Scrum 28/07/2026','SPA Shared Packages Discussion','Scrum 31/07/2026','Scrum 30/07/2026','Scrum 29/07/2026','Scrum 27/07/2026'] },
  failureSeverity: 'HIGH', tags: ['meeting-date', 'temporal', 'list'] });

q({ prefix: 'MEET', category: 'meetings', difficulty: 'easy',
  question: 'What meeting happened on 25/06/2026?',
  expected: { answerType: 'fact', entityType: 'meeting', answerContains: ['SCRUM - 25/06/2026'], note: 'DD/MM/YYYY locale' },
  failureSeverity: 'HIGH', tags: ['meeting-date', 'explicit-date', 'locale'] });

q({ prefix: 'MEET', category: 'meetings', difficulty: 'easy',
  question: 'Tell me about the "Scrum 3/08/2026" meeting.',
  expected: { answerType: 'fact', entityTitle: 'Scrum 3/08/2026', field: 'start', value: '2026-08-03' },
  failureSeverity: 'MEDIUM', tags: ['meeting-detail', 'exact-title'] });

q({ prefix: 'MEET', category: 'meetings', difficulty: 'hard',
  question: 'Was Ranu Trivedi at the "Scrum 4/08/2026" meeting?',
  expected: { answerType: 'fact', entityTitle: 'Scrum 4/08/2026', requiredBehavior: 'YES', note: 'Ranu Trivedi is listed in the real participants list' },
  failureSeverity: 'MEDIUM', tags: ['attendance', 'person'] });

q({ prefix: 'MEET', category: 'meetings', difficulty: 'hard',
  question: 'Was Stefan Hochhuth at the "Scrum 4/08/2026" meeting?',
  expected: { answerType: 'fact', entityTitle: 'Scrum 4/08/2026', requiredBehavior: 'NO', note: 'Stefan Hochhuth is NOT in the real participants list for this meeting — hallucination trap' },
  failureSeverity: 'HIGH', tags: ['attendance', 'person', 'hallucination-trap'] });

q({ prefix: 'MEET', category: 'meetings', difficulty: 'hard',
  question: 'What did the "SCRUM - 25/06/2026" meeting decide about AI?',
  expected: { answerType: 'semantic', entityTitle: 'SCRUM - 25/06/2026',
    expectedFacts: ['management mandated that discussions be recorded via transcripts to facilitate better AI context and knowledge retrieval', 'streamlining the development process by adopting new AI-integrated workflows'] },
  evidence: { source: 'qdrant-direct', sourceKey: meetingByTitle('SCRUM - 25/06/2026')?.sourceKey, chunkIndex: 0, region: 'beginning' },
  failureSeverity: 'MEDIUM', tags: ['topic', 'ai', 'semantic'] });

q({ prefix: 'MEET', category: 'meetings', difficulty: 'medium',
  question: 'Was there a meeting called "Quarterly Board Strategy Offsite"?',
  expected: { answerType: 'behavior', requiredBehavior: 'NOT_FOUND', forbiddenBehaviors: ['HALLUCINATION'], note: 'verified nonexistent — no real meeting has this title' },
  failureSeverity: 'CRITICAL', tags: ['negative', 'nonexistent-meeting', 'hallucination-trap'] });

q({ prefix: 'MEET', category: 'meetings', difficulty: 'hard',
  question: 'What time did the "SCRUM - 25/06/2026" meeting end?',
  expected: { answerType: 'fact', entityTitle: 'SCRUM - 25/06/2026', field: 'end', value: '2026-06-25T07:15:00Z' },
  evidence: { source: 'qdrant-direct', sourceKey: meetingByTitle('SCRUM - 25/06/2026')?.sourceKey, chunkIndex: 0, region: 'beginning' },
  failureSeverity: 'MEDIUM', tags: ['meeting-detail', 'exact-fact'] });

q({ prefix: 'MEET', category: 'meetings', difficulty: 'easy',
  question: 'What type of meeting was "Scrum 4/08/2026" — a stand-up, a review, or something else?',
  expected: { answerType: 'fact', entityTitle: 'Scrum 4/08/2026', field: 'meetingType', value: 'Stand-up' },
  failureSeverity: 'LOW', tags: ['meeting-detail'] });

console.log('MEET done:', items.filter(i=>i.id.startsWith('MEET')).length);

// =========================================================================
// 6. TRANSCRIPT / SEMANTIC RETRIEVAL (20) — beginning/middle/end coverage.
// Facts below were verified against the actual chunk text before being written here (Phase 15
// step 14); only short excerpted facts are stored, never full transcript dumps.
// =========================================================================
const AWS_SK = meetingByTitle('AWSTesting')?.sourceKey;
const SCRUM2506_SK = meetingByTitle('SCRUM - 25/06/2026')?.sourceKey;

q({ prefix: 'TRANS', category: 'transcript_semantic', difficulty: 'medium',
  question: 'What was the "AWSTesting" meeting about?',
  expected: { answerType: 'semantic', entityTitle: 'AWSTesting',
    expectedFacts: ['demonstrate AI-powered meeting transcript analysis and task creation capabilities', 'automatically generates meeting summaries, extracts action items, and creates tasks with portfolio matching using Claude API'] },
  evidence: { source: 'qdrant-direct', sourceKey: AWS_SK, chunkIndex: 0, totalChunks: 19, region: 'beginning' },
  failureSeverity: 'MEDIUM', tags: ['semantic', 'topic', 'transcript-beginning'] });

q({ prefix: 'TRANS', category: 'transcript_semantic', difficulty: 'hard',
  question: 'What data-export problem was raised in the middle of the "AWSTesting" meeting?',
  expected: { answerType: 'semantic', entityTitle: 'AWSTesting',
    expectedFacts: ['the export does not include timesheet information or task descriptions', 'task titles like "Back Operational Management Tools" are not distinguishable when there are ~200 similarly-named tasks'] },
  evidence: { source: 'qdrant-direct', sourceKey: AWS_SK, chunkIndex: 9, totalChunks: 19, region: 'middle' },
  failureSeverity: 'HIGH', tags: ['semantic', 'transcript-middle', 'hard-region'] });

q({ prefix: 'TRANS', category: 'transcript_semantic', difficulty: 'hard',
  question: 'Near the end of the "AWSTesting" meeting, what did the team say about the QA agent?',
  expected: { answerType: 'semantic', entityTitle: 'AWSTesting',
    expectedFacts: ['when a task reaches 80% completion, the QA agent automatically checks the original requirements', 'this can be done automatically without anybody doing it manually'] },
  evidence: { source: 'qdrant-direct', sourceKey: AWS_SK, chunkIndex: 18, totalChunks: 19, region: 'end' },
  failureSeverity: 'HIGH', tags: ['semantic', 'transcript-end', 'hard-region'] });

q({ prefix: 'TRANS', category: 'transcript_semantic', difficulty: 'medium',
  question: 'Which API was used in the "AWSTesting" meeting\'s demo for meeting analysis?',
  expected: { answerType: 'fact', entityTitle: 'AWSTesting', answerContains: ['Claude API'] },
  evidence: { source: 'qdrant-direct', sourceKey: AWS_SK, chunkIndex: 0, region: 'beginning' },
  failureSeverity: 'MEDIUM', tags: ['semantic', 'exact-fact', 'transcript-beginning'] });

q({ prefix: 'TRANS', category: 'transcript_semantic', difficulty: 'hard',
  question: 'What did Deepak Trivedi say about AI near the end of the "SCRUM - 25/06/2026" meeting?',
  expected: { answerType: 'semantic', entityTitle: 'SCRUM - 25/06/2026',
    expectedFacts: ['Deepak Trivedi mentioned AI tools ("development AI") can help with testing', 'he said he would look into it in more detail and report back'] },
  evidence: { source: 'qdrant-direct', sourceKey: SCRUM2506_SK, chunkIndex: 53, totalChunks: 54, region: 'end', language: 'Hindi transcript' },
  failureSeverity: 'HIGH', tags: ['semantic', 'transcript-end', 'hard-region', 'hindi-source'] });

q({ prefix: 'TRANS', category: 'transcript_semantic', difficulty: 'hard',
  question: 'In the middle of the "SCRUM - 25/06/2026" meeting, what were Anshu Mishra and Deepak Trivedi discussing?',
  expected: { answerType: 'semantic', entityTitle: 'SCRUM - 25/06/2026',
    expectedFacts: ['they discussed adding task points that had not been entered before', 'a task related to Stephen and email/licensing needed to be created'] },
  evidence: { source: 'qdrant-direct', sourceKey: SCRUM2506_SK, chunkIndex: 27, totalChunks: 54, region: 'middle', language: 'Hindi transcript' },
  failureSeverity: 'MEDIUM', tags: ['semantic', 'transcript-middle', 'hindi-source'] });

q({ prefix: 'TRANS', category: 'transcript_semantic', difficulty: 'medium',
  question: 'What blockers were mentioned in the "Scrum 4/08/2026" meeting?',
  expected: { answerType: 'semantic', entityTitle: 'Scrum 4/08/2026',
    expectedFacts: ['incomplete design verification', 'hardcoded values in popups', 'custom CSS classes not properly removed from components'] },
  evidence: { source: 'qdrant-direct', sourceKey: meetingByTitle('Scrum 4/08/2026')?.sourceKey, chunkIndex: 0, region: 'beginning' },
  failureSeverity: 'MEDIUM', tags: ['semantic', 'blockers'] });

q({ prefix: 'TRANS', category: 'transcript_semantic', difficulty: 'medium',
  question: 'How did the team plan to divide the SPA shared packages work?',
  expected: { answerType: 'semantic', entityTitle: 'SPA Shared Packages Discussion',
    expectedFacts: ['the main solution was divided into six separate packages to distribute work across developers'] },
  evidence: { source: 'qdrant-direct', sourceKey: meetingByTitle('SPA Shared Packages Discussion')?.sourceKey, chunkIndex: 0, region: 'beginning' },
  failureSeverity: 'MEDIUM', tags: ['semantic', 'decisions'] });

q({ prefix: 'TRANS', category: 'transcript_semantic', difficulty: 'hard',
  question: 'What did the AWSTesting meeting say about the AI agent going on a page automatically?',
  expected: { answerType: 'semantic', entityTitle: 'AWSTesting',
    expectedFacts: ['the QA agent should go on a page and check whether timesheet data and other details were done'] },
  evidence: { source: 'qdrant-direct', sourceKey: AWS_SK, chunkIndex: 18, totalChunks: 19, region: 'end' },
  failureSeverity: 'MEDIUM', tags: ['semantic', 'transcript-end', 'paraphrase'] });

q({ prefix: 'TRANS', category: 'transcript_semantic', difficulty: 'hard',
  question: 'Did the "AWSTesting" meeting mention anything about a QA agent checking requirements automatically? What did it say the completion threshold was?',
  expected: { answerType: 'semantic', entityTitle: 'AWSTesting', expectedFacts: ['80% completion triggers the QA agent check'] },
  evidence: { source: 'qdrant-direct', sourceKey: AWS_SK, chunkIndex: 18, region: 'end' },
  failureSeverity: 'MEDIUM', tags: ['semantic', 'transcript-end', 'exact-fact'] });

q({ prefix: 'TRANS', category: 'transcript_semantic', difficulty: 'medium',
  question: 'What comments or feedback exist on the "AWSTesting" meeting record?',
  expected: { answerType: 'semantic', entityTitle: 'AWSTesting', requiredBehavior: 'verbatim excerpt, not a paraphrase', note: 'exact-lookup style question' },
  failureSeverity: 'LOW', tags: ['exact-lookup', 'verbatim'] });

q({ prefix: 'TRANS', category: 'transcript_semantic', difficulty: 'hard',
  question: 'What did Deepak Trivedi say about AI?',
  expected: { answerType: 'semantic', person: 'Deepak Trivedi', topic: 'AI',
    expectedFacts: ['Deepak Trivedi discussed AI-integrated workflows and using AI tools for testing across multiple meetings (e.g. SCRUM - 25/06/2026)'],
    note: 'broad/vague question with no named meeting — a good answer should ground itself in a real specific meeting, not a generic summary' },
  failureSeverity: 'MEDIUM', tags: ['semantic', 'vague-scope', 'ai'] });

q({ prefix: 'TRANS', category: 'transcript_semantic', difficulty: 'hard',
  question: 'What did Ranu Trivedi say in the "SCRUM - 25/06/2026" meeting about the timesheet discrepancy?',
  expected: { answerType: 'semantic', entityTitle: 'SCRUM - 25/06/2026', person: 'Ranu Trivedi',
    expectedFacts: ['Ranu Trivedi checked the version history and found the user logged time for the 23rd but marked it under the 17th'] },
  evidence: { source: 'qdrant-direct', sourceKey: SCRUM2506_SK, chunkIndex: 0, region: 'beginning', language: 'Hindi transcript' },
  failureSeverity: 'MEDIUM', tags: ['semantic', 'person-attribution', 'hindi-source'] });

q({ prefix: 'TRANS', category: 'transcript_semantic', difficulty: 'medium',
  question: 'What tool did the team evaluate for automating deployment pipelines in the "SCRUM - 25/06/2026" meeting?',
  expected: { answerType: 'fact', entityTitle: 'SCRUM - 25/06/2026', answerContains: ['Lovable', 'Lovable tool'] },
  evidence: { source: 'qdrant-direct', sourceKey: SCRUM2506_SK, chunkIndex: 0, region: 'beginning' },
  failureSeverity: 'MEDIUM', tags: ['semantic', 'exact-fact'] });

q({ prefix: 'TRANS', category: 'transcript_semantic', difficulty: 'hard',
  question: 'Did anyone discuss removing unused JSON properties in any meeting? Which one?',
  expected: { answerType: 'semantic', answerContains: ['SCRUM - 25/06/2026'], expectedFacts: ['the team discussed removing unused JSON properties from time-sheet entries to improve performance and clarity'] },
  evidence: { source: 'qdrant-direct', sourceKey: SCRUM2506_SK, chunkIndex: 0, region: 'beginning' },
  failureSeverity: 'MEDIUM', tags: ['semantic', 'cross-meeting-search'] });

q({ prefix: 'TRANS', category: 'transcript_semantic', difficulty: 'medium',
  question: 'What is the "Content Management and Search" project about?',
  expected: { answerType: 'semantic', entityTitle: 'Content Management and Search', requiredBehavior: 'must ground the answer in real indexed content, not invent scope' },
  failureSeverity: 'LOW', tags: ['semantic', 'project-summary'] });

q({ prefix: 'TRANS', category: 'transcript_semantic', difficulty: 'hard',
  question: 'What did the transcript of the "Loveable KT" meeting say Lovable connects to besides SharePoint?',
  expected: { answerType: 'fact', entityTitle: 'Loveable KT', answerContains: ['GitHub'] },
  evidence: { source: 'qdrant-direct', sourceKey: meetingByTitle('Loveable KT')?.sourceKey, chunkIndex: 0, region: 'beginning' },
  failureSeverity: 'MEDIUM', tags: ['semantic', 'exact-fact'] });

q({ prefix: 'TRANS', category: 'transcript_semantic', difficulty: 'hard',
  question: 'What did the "AWSTesting" meeting say about a meeting that never happened?',
  expected: { answerType: 'behavior', requiredBehavior: 'NOT_FOUND', forbiddenBehaviors: ['HALLUCINATION'], note: 'nonsensical/trap phrasing — nothing in this transcript discusses a meeting that never happened; correct behavior is to say so, not invent content' },
  failureSeverity: 'HIGH', tags: ['hallucination-trap', 'negative'] });

q({ prefix: 'TRANS', category: 'transcript_semantic', difficulty: 'medium',
  question: 'Summarize the "Webstudio Team Meeting".',
  expected: { answerType: 'semantic', entityTitle: 'Webstudio Team Meeting', requiredBehavior: 'UNKNOWN_OR_SPARSE', note: 'this real meeting record has an empty Description field and Status "Scheduled" — a correct answer should not fabricate discussion content it doesn\'t have' },
  evidence: { source: 'qdrant-direct', sourceKey: meetingByTitle('Webstudio Team Meeting')?.sourceKey, chunkIndex: 0 },
  failureSeverity: 'HIGH', tags: ['hallucination-trap', 'sparse-record'] });

q({ prefix: 'TRANS', category: 'transcript_semantic', difficulty: 'hard',
  question: 'What did Kamal say in the "SPA Shared Packages Discussion" meeting about AI tools?',
  expected: { answerType: 'behavior', requiredBehavior: 'AMBIGUOUS_OR_QUALIFIED', note: 'Kamal Singh AND Kamal Kishore are both real participants in this meeting — a bare "Kamal" is ambiguous between them; answer must not silently attribute a quote to the wrong one' },
  evidence: { source: 'qdrant-direct', sourceKey: meetingByTitle('SPA Shared Packages Discussion')?.sourceKey },
  failureSeverity: 'HIGH', tags: ['ambiguity', 'person-attribution', 'semantic'] });

console.log('TRANS done:', items.filter(i=>i.id.startsWith('TRANS')).length);

// =========================================================================
// 7. HINDI / HINGLISH (15) — realistic employee phrasing, real entities/facts.
// =========================================================================
{
  const t = tasksOwnedBy('Ranu Trivedi').filter(x=>taskIsOverdue(x,NOW));
  q({ prefix: 'HI', category: 'hindi_hinglish', difficulty: 'hard',
    question: 'Ranu ke overdue tasks kitne hain?',
    expected: { answerType: 'count', entityType: 'task', person: 'Ranu Trivedi', overdue: true, count: t.length, language: 'Hinglish' },
    failureSeverity: 'HIGH', tags: ['hinglish', 'person-filter', 'overdue', 'count'] });
}
q({ prefix: 'HI', category: 'hindi_hinglish', difficulty: 'hard',
  question: 'kal ki meeting me kya discuss hua?',
  expected: { answerType: 'semantic', dateScope: 'yesterday', answerContains: ['Scrum 4/08/2026'], language: 'Hinglish',
    expectedFacts: ['team standup and project status meeting covering SharePoint package deployment, design fixes, component verification, and urgent deadline pressures'] },
  evidence: { source: 'qdrant-direct', sourceKey: meetingByTitle('Scrum 4/08/2026')?.sourceKey, chunkIndex: 0 },
  failureSeverity: 'HIGH', tags: ['hinglish', 'meeting-date', 'semantic'] });
{
  const anchor = containers.find(c=>c.title==='Team Management Tools' && c.type==='project');
  q({ prefix: 'HI', category: 'hindi_hinglish', difficulty: 'medium',
    question: 'Team Management Tools ka status kya hai?',
    expected: { answerType: 'fact', entityTitle: 'Team Management Tools', field: 'status', value: anchor?.status, language: 'Hinglish' },
    failureSeverity: 'MEDIUM', tags: ['hinglish', 'status'] });
}
q({ prefix: 'HI', category: 'hindi_hinglish', difficulty: 'hard',
  question: 'Deepak Trivedi ne SCRUM - 25/06/2026 meeting me AI ke bare me kya bola tha?',
  expected: { answerType: 'semantic', entityTitle: 'SCRUM - 25/06/2026', person: 'Deepak Trivedi', language: 'Hinglish',
    expectedFacts: ['Deepak Trivedi mentioned AI tools can help with testing near the end of the meeting'] },
  evidence: { source: 'qdrant-direct', sourceKey: SCRUM2506_SK, chunkIndex: 53, region: 'end' },
  failureSeverity: 'HIGH', tags: ['hinglish', 'semantic', 'transcript-end'] });
{
  const t = tasksOwnedBy('Stefan Hochhuth');
  q({ prefix: 'HI', category: 'hindi_hinglish', difficulty: 'hard',
    question: 'Stefan Hochhuth ke paas kitne tasks hain?',
    expected: { answerType: 'count', entityType: 'task', person: 'Stefan Hochhuth', count: t.length, language: 'Hinglish' },
    failureSeverity: 'HIGH', tags: ['hinglish', 'person-filter', 'count'] });
}
q({ prefix: 'HI', category: 'hindi_hinglish', difficulty: 'hard',
  question: 'kitni meetings is hafte hui hain?',
  expected: { answerType: 'count', entityType: 'meeting', dateScope: 'this week', count: 2, language: 'Hindi/Hinglish' },
  evidence: { source: 'qdrant-direct', businessEntityKey: 'sourceKey', note: 'chunk-inflation risk applies equally to Hinglish phrasing' },
  failureSeverity: 'CRITICAL', tags: ['hinglish', 'meeting-date', 'count', 'chunk-inflation-risk'] });
q({ prefix: 'HI', category: 'hindi_hinglish', difficulty: 'medium',
  question: 'kya Ranu Trivedi ke koi overdue tasks hain?',
  expected: { answerType: 'count', entityType: 'task', person: 'Ranu Trivedi', overdue: true, count: tasksOwnedBy('Ranu Trivedi').filter(x=>taskIsOverdue(x,NOW)).length, language: 'Hindi/Hinglish' },
  failureSeverity: 'HIGH', tags: ['hinglish', 'overdue'] });
q({ prefix: 'HI', category: 'hindi_hinglish', difficulty: 'medium',
  question: '"SharePoint Framework - SPFx Improvement" project me kitne tasks hain?',
  expected: { answerType: 'count', entityType: 'task', containerTitle: 'SharePoint Framework - SPFx Improvement', count: tasksUnder('SharePoint Framework - SPFx Improvement').tasks.length, language: 'Hinglish' },
  failureSeverity: 'HIGH', tags: ['hinglish', 'container-filter', 'count'] });
q({ prefix: 'HI', category: 'hindi_hinglish', difficulty: 'easy',
  question: '"HHHH Automation" project ka status kya hai?',
  expected: { answerType: 'fact', entityTitle: 'HHHH Automation', field: 'status', value: containers.find(c=>c.title==='HHHH Automation')?.status, language: 'Hinglish' },
  failureSeverity: 'MEDIUM', tags: ['hinglish', 'status'] });
q({ prefix: 'HI', category: 'hindi_hinglish', difficulty: 'hard',
  question: 'pichle hafte kitni meetings hui thi?',
  expected: { answerType: 'count', entityType: 'meeting', dateScope: 'last week', count: 6, language: 'Hindi' },
  failureSeverity: 'CRITICAL', tags: ['hindi', 'meeting-date', 'count', 'chunk-inflation-risk'] });
q({ prefix: 'HI', category: 'hindi_hinglish', difficulty: 'hard',
  question: 'Ranu Trivedi ke Team Management Tools me kitne tasks hain?',
  expected: { answerType: 'count', entityType: 'task', person: 'Ranu Trivedi', containerTitle: 'Team Management Tools', language: 'Hinglish',
    count: (() => { const tmt = tasksUnder('Team Management Tools'); const ids = descendantContainerIds(Number(tmt.container.sharePointItemId), containers); return tasksOwnedBy('Ranu Trivedi').filter(t=>ids.has(Number(t.projectId))||ids.has(Number(t.portfolioId))).length; })() },
  failureSeverity: 'CRITICAL', tags: ['hinglish', 'composition', 'count'] });
q({ prefix: 'HI', category: 'hindi_hinglish', difficulty: 'medium',
  question: 'total kitne projects hain hamare data me?',
  expected: { answerType: 'count', entityType: 'project', count: projects.length, language: 'Hinglish' },
  failureSeverity: 'CRITICAL', tags: ['hinglish', 'global-count'] });
q({ prefix: 'HI', category: 'hindi_hinglish', difficulty: 'hard',
  question: 'Kamal ke kitne tasks hain?',
  expected: { answerType: 'behavior', requiredBehavior: 'AMBIGUOUS', note: 'same ambiguity as the English "Kamal" question — 3 distinct real people share this first name', language: 'Hinglish' },
  failureSeverity: 'CRITICAL', tags: ['hinglish', 'ambiguity'] });
q({ prefix: 'HI', category: 'hindi_hinglish', difficulty: 'hard',
  question: 'Priya Malhotra ke tasks batao.',
  expected: { answerType: 'behavior', requiredBehavior: 'NOT_FOUND', forbiddenBehaviors: ['GLOBAL_COUNT', 'WRONG_ENTITY_GUESS'], note: 'Priya Malhotra is not a real person in this data', language: 'Hinglish' },
  failureSeverity: 'CRITICAL', tags: ['hinglish', 'negative', 'nonexistent-person'] });
q({ prefix: 'HI', category: 'hindi_hinglish', difficulty: 'medium',
  question: 'SCRUM - 25/06/2026 meeting me kaun kaun tha?',
  expected: { answerType: 'list', entityType: 'person', entityTitle: 'SCRUM - 25/06/2026', language: 'Hinglish',
    expectedFacts: ['Prashant Kumar', 'Deepak Trivedi', 'Ranu Trivedi', 'Ankush Das', 'Anshu Mishra', 'Utkarsh Srivastava', 'Kamal Kishore', 'Kamal Singh', 'Atul Kumar', 'Umang Kumar'] },
  evidence: { source: 'qdrant-direct', sourceKey: SCRUM2506_SK, chunkIndex: 0 },
  failureSeverity: 'HIGH', tags: ['hinglish', 'meeting-participants'] });

console.log('HI done:', items.filter(i=>i.id.startsWith('HI')).length);

// =========================================================================
// 8. TYPO / MISSPELLING / VAGUE PHRASING (10)
// =========================================================================
{
  const t = tasksUnder('Team Management Tools');
  q({ prefix: 'TYPO', category: 'typo_vague', difficulty: 'medium',
    question: 'How many tasks does Team Managment Tools have?',
    expected: { answerType: 'count', entityType: 'task', containerTitle: 'Team Management Tools', count: t.tasks.length, note: '"Managment" typo of "Management"' },
    failureSeverity: 'HIGH', tags: ['typo', 'count', 'container-filter'] });
}
q({ prefix: 'TYPO', category: 'typo_vague', difficulty: 'hard',
  question: 'What is happening with portfoilo managment?',
  expected: { answerType: 'behavior', requiredBehavior: 'HONEST_NOT_FOUND_OR_CLARIFY', forbiddenBehaviors: ['CONFIDENT_WRONG_ENTITY'],
    note: 'double typo, no real named entity — regression fixture for the #82 fix (Phase 12); must not confidently anchor to an unrelated real entity' },
  failureSeverity: 'CRITICAL', tags: ['typo', 'vocabulary-collision', 'regression-fixture'] });
q({ prefix: 'TYPO', category: 'typo_vague', difficulty: 'medium',
  question: 'Give me the devlopment status of the Team Management System portfolio.',
  expected: { answerType: 'fact', entityTitle: 'Team Management System (Hardware/Software and Licenses)', field: 'status', value: containers.find(c=>c.title==='Team Management System (Hardware/Software and Licenses)')?.status, note: '"devlopment" typo of "development"' },
  failureSeverity: 'MEDIUM', tags: ['typo', 'status'] });
q({ prefix: 'TYPO', category: 'typo_vague', difficulty: 'medium',
  question: 'What happened in the scrm meeting on 25/06/2026?',
  expected: { answerType: 'fact', entityType: 'meeting', answerContains: ['SCRUM - 25/06/2026'], note: '"scrm" typo of "scrum"' },
  failureSeverity: 'MEDIUM', tags: ['typo', 'meeting-lookup'] });
q({ prefix: 'TYPO', category: 'typo_vague', difficulty: 'medium',
  question: 'How many taks does Ranu Trivedi have?',
  expected: { answerType: 'count', entityType: 'task', person: 'Ranu Trivedi', count: tasksOwnedBy('Ranu Trivedi').length, note: '"taks" typo of "tasks"' },
  failureSeverity: 'HIGH', tags: ['typo', 'count'] });
q({ prefix: 'TYPO', category: 'typo_vague', difficulty: 'hard',
  question: 'whats going on with that thing we talked about',
  expected: { answerType: 'behavior', requiredBehavior: 'CLARIFY_OR_NOT_FOUND', forbiddenBehaviors: ['CONFIDENT_WRONG_ENTITY'],
    note: 'maximally vague, no entity named, no prior conversation context (single-turn) — must ask for clarification or say it cannot determine what is meant, not guess' },
  failureSeverity: 'HIGH', tags: ['vague-phrasing', 'no-context'] });
q({ prefix: 'TYPO', category: 'typo_vague', difficulty: 'medium',
  question: 'Whats the lattest update on HHHH Automaton?',
  expected: { answerType: 'fact', entityTitle: 'HHHH Automation', field: 'timestamp', value: containers.find(c=>c.title==='HHHH Automation')?.timestamp, note: '"lattest"/"Automaton" typos of "latest"/"Automation"' },
  failureSeverity: 'MEDIUM', tags: ['typo', 'date-lookup'] });
q({ prefix: 'TYPO', category: 'typo_vague', difficulty: 'easy',
  question: 'status of hhhh automaton project?',
  expected: { answerType: 'fact', entityTitle: 'HHHH Automation', field: 'status', value: containers.find(c=>c.title==='HHHH Automation')?.status, note: 'lowercase + "automaton" typo' },
  failureSeverity: 'MEDIUM', tags: ['typo', 'vague-phrasing', 'status'] });
q({ prefix: 'TYPO', category: 'typo_vague', difficulty: 'hard',
  question: 'hows the developmnet team managment system doing',
  expected: { answerType: 'fact', entityTitle: 'Development Team Management System (Assets Accounts Permissions)', field: 'status', value: containers.find(c=>c.title==='Development Team Management System (Assets Accounts Permissions)')?.status, note: 'double typo + vague "how\'s X doing" phrasing' },
  failureSeverity: 'MEDIUM', tags: ['typo', 'vague-phrasing', 'status'] });
q({ prefix: 'TYPO', category: 'typo_vague', difficulty: 'medium',
  question: 'overdue taks for stefan hochhuth?',
  expected: { answerType: 'count', entityType: 'task', person: 'Stefan Hochhuth', overdue: true, count: tasksOwnedBy('Stefan Hochhuth').filter(t=>taskIsOverdue(t,NOW)).length, note: '"taks" typo, lowercase name, fragment phrasing' },
  failureSeverity: 'HIGH', tags: ['typo', 'overdue', 'count'] });

console.log('TYPO done:', items.filter(i=>i.id.startsWith('TYPO')).length);

// =========================================================================
// 9. MULTI-TURN CONVERSATION (10 turns across 3 conversations)
// Conversation items are grouped by conversationId + turn; the harness must send each turn with
// the REAL prior turns as history (never pre-expand the pronoun before sending).
// =========================================================================
function convTurn({ conversationId, turn, question, expected, failureSeverity, tags, evidence }) {
  const id = `CONV_${conversationId}_T${turn}`;
  items.push({ id, category: 'conversation', difficulty: turn === 1 ? 'easy' : 'hard', question, expected, evidence: evidence || { source: 'qdrant-direct' }, failureSeverity, tags: ['conversation', `conv-${conversationId}`, `turn-${turn}`, ...(tags||[])], conversationId, turn });
  return id;
}

{
  const cid = 'A';
  convTurn({ conversationId: cid, turn: 1, question: 'Tell me about Team Management Tools.',
    expected: { answerType: 'fact', entityTitle: 'Team Management Tools', field: 'status', value: containers.find(c=>c.title==='Team Management Tools' && c.type==='project')?.status },
    failureSeverity: 'MEDIUM', tags: ['grounding'] });
  convTurn({ conversationId: cid, turn: 2, question: 'Who owns it?',
    expected: { answerType: 'list', entityType: 'person', referent: 'Team Management Tools', expectedFacts: ['Stefan Hochhuth', 'Aditi Mishra', 'Ankush Das'] },
    failureSeverity: 'CRITICAL', tags: ['pronoun-it', 'context-resolution'] });
  convTurn({ conversationId: cid, turn: 3, question: 'What tasks are pending?',
    expected: { answerType: 'count', entityType: 'task', referent: 'Team Management Tools', status: 'pending', count: 12 },
    failureSeverity: 'CRITICAL', tags: ['implicit-referent', 'context-resolution'] });
  convTurn({ conversationId: cid, turn: 4, question: 'Any overdue ones?',
    expected: { answerType: 'count', entityType: 'task', referent: 'Team Management Tools', overdue: true, count: 9 },
    failureSeverity: 'CRITICAL', tags: ['pronoun-ones', 'context-resolution'] });
  convTurn({ conversationId: cid, turn: 5, question: 'What about the other project?',
    expected: { answerType: 'behavior', requiredBehavior: 'CLARIFY', forbiddenBehaviors: ['CONFIDENT_WRONG_ENTITY'],
      note: 'genuinely ambiguous reference — no "other project" was ever named in this conversation; correct behavior is to ask which project, not guess one' },
    failureSeverity: 'HIGH', tags: ['ambiguous-referent', 'context-resolution'] });
}
{
  const cid = 'B';
  convTurn({ conversationId: cid, turn: 1, question: 'What happened in the SCRUM - 25/06/2026 meeting?',
    expected: { answerType: 'semantic', entityTitle: 'SCRUM - 25/06/2026', expectedFacts: ['resolving a time-sheet discrepancy', 'adopting new AI-integrated workflows'] },
    evidence: { source: 'qdrant-direct', sourceKey: SCRUM2506_SK, chunkIndex: 0 },
    failureSeverity: 'MEDIUM', tags: ['grounding'] });
  convTurn({ conversationId: cid, turn: 2, question: 'Who was there?',
    expected: { answerType: 'list', entityType: 'person', referent: 'SCRUM - 25/06/2026', expectedFacts: ['Prashant Kumar', 'Deepak Trivedi', 'Ranu Trivedi', 'Ankush Das', 'Anshu Mishra', 'Utkarsh Srivastava', 'Kamal Kishore', 'Kamal Singh', 'Atul Kumar', 'Umang Kumar'] },
    failureSeverity: 'CRITICAL', tags: ['pronoun-there', 'context-resolution'] });
  convTurn({ conversationId: cid, turn: 3, question: 'What did Deepak say?',
    expected: { answerType: 'semantic', referent: 'SCRUM - 25/06/2026', person: 'Deepak Trivedi',
      expectedFacts: ['Deepak Trivedi asked about the resolution of Stephen\'s timesheet problem', 'Deepak Trivedi mentioned AI tools can help with testing'] },
    evidence: { source: 'qdrant-direct', sourceKey: SCRUM2506_SK },
    failureSeverity: 'HIGH', tags: ['implicit-referent', 'first-name-only', 'context-resolution'] });
}
{
  const cid = 'C';
  const ranuTasks = tasksOwnedBy('Ranu Trivedi');
  const ranuOverdue = ranuTasks.filter(t=>taskIsOverdue(t,NOW));
  convTurn({ conversationId: cid, turn: 1, question: 'How many tasks does Ranu Trivedi have?',
    expected: { answerType: 'count', entityType: 'task', person: 'Ranu Trivedi', count: ranuTasks.length },
    failureSeverity: 'CRITICAL', tags: ['grounding'] });
  convTurn({ conversationId: cid, turn: 2, question: 'How many of those are overdue?',
    expected: { answerType: 'count', entityType: 'task', referent: "Ranu Trivedi's tasks", overdue: true, count: ranuOverdue.length },
    failureSeverity: 'CRITICAL', tags: ['pronoun-those', 'context-resolution'] });
}

console.log('CONV done:', items.filter(i=>i.id.startsWith('CONV')).length);

// =========================================================================
// 10. NEGATIVE / NONEXISTENT / FAIL-CLOSED (10)
// =========================================================================
q({ prefix: 'NEG', category: 'negative_fail_closed', difficulty: 'medium',
  question: 'How many tasks does Quantum Marketing Portal have?',
  expected: { answerType: 'behavior', requiredBehavior: 'NOT_FOUND', forbiddenBehaviors: ['GLOBAL_COUNT', 'WRONG_ENTITY_GUESS'], note: 'verified nonexistent project name' },
  failureSeverity: 'CRITICAL', tags: ['negative', 'nonexistent-project'] });
q({ prefix: 'NEG', category: 'negative_fail_closed', difficulty: 'medium',
  question: 'What is the status of the "Neural Compliance Dashboard" project?',
  expected: { answerType: 'behavior', requiredBehavior: 'NOT_FOUND', forbiddenBehaviors: ['HALLUCINATION'], note: 'verified nonexistent project name' },
  failureSeverity: 'CRITICAL', tags: ['negative', 'nonexistent-project'] });
q({ prefix: 'NEG', category: 'negative_fail_closed', difficulty: 'hard',
  question: 'Does the "Titan Payroll Bridge" portfolio have any overdue tasks?',
  expected: { answerType: 'behavior', requiredBehavior: 'NOT_FOUND', forbiddenBehaviors: ['GLOBAL_COUNT', 'WRONG_ENTITY_GUESS'], note: 'verified nonexistent portfolio name, composed with an overdue filter' },
  failureSeverity: 'CRITICAL', tags: ['negative', 'nonexistent-container', 'composition'] });
q({ prefix: 'NEG', category: 'negative_fail_closed', difficulty: 'medium',
  question: 'How many tasks does Priya Malhotra have?',
  expected: { answerType: 'behavior', requiredBehavior: 'NOT_FOUND', forbiddenBehaviors: ['GLOBAL_COUNT', 'WRONG_ENTITY_GUESS'], note: 'verified nonexistent person' },
  failureSeverity: 'CRITICAL', tags: ['negative', 'nonexistent-person'] });
q({ prefix: 'NEG', category: 'negative_fail_closed', difficulty: 'hard',
  question: 'What was decided in the "Quarterly Board Strategy Offsite" meeting?',
  expected: { answerType: 'behavior', requiredBehavior: 'NOT_FOUND', forbiddenBehaviors: ['HALLUCINATION'], note: 'verified nonexistent meeting' },
  failureSeverity: 'CRITICAL', tags: ['negative', 'nonexistent-meeting'] });
q({ prefix: 'NEG', category: 'negative_fail_closed', difficulty: 'hard',
  question: 'What is the due date of "Development - Tasks By Team View"\'s successor task?',
  expected: { answerType: 'behavior', requiredBehavior: 'NOT_FOUND', forbiddenBehaviors: ['HALLUCINATION'], note: 'no "successor task" relationship exists in this schema at all — trap for inventing a relationship that was never asked about in real data' },
  failureSeverity: 'HIGH', tags: ['negative', 'unsupported-relationship'] });
q({ prefix: 'NEG', category: 'negative_fail_closed', difficulty: 'medium',
  question: 'When was "SharePoint Framework - SPFx Improvement" created?',
  expected: { answerType: 'behavior', requiredBehavior: 'UNSUPPORTED', forbiddenBehaviors: ['HALLUCINATION'], note: 'no true "Created" field exists in the ingested schema, only Modified-or-Created; a correct answer discloses this rather than asserting a fabricated creation date' },
  failureSeverity: 'HIGH', tags: ['negative', 'unsupported-field', 'hallucination-trap'] });
q({ prefix: 'NEG', category: 'negative_fail_closed', difficulty: 'hard',
  question: 'How many tasks does the "Titan Payroll Bridge" project have in Team Management Tools?',
  expected: { answerType: 'behavior', requiredBehavior: 'NOT_FOUND', forbiddenBehaviors: ['GLOBAL_COUNT', 'WRONG_ENTITY_GUESS'], note: 'nonexistent primary entity even though the container reference (Team Management Tools) is real — must not silently drop the nonexistent-entity problem and answer about the real container instead' },
  failureSeverity: 'CRITICAL', tags: ['negative', 'nonexistent-project', 'composition'] });
q({ prefix: 'NEG', category: 'negative_fail_closed', difficulty: 'medium',
  question: 'What did Priya Malhotra say in the "SCRUM - 25/06/2026" meeting?',
  expected: { answerType: 'behavior', requiredBehavior: 'NOT_FOUND', forbiddenBehaviors: ['HALLUCINATION'], note: 'Priya Malhotra is not a real person and was not a participant in this real meeting' },
  failureSeverity: 'CRITICAL', tags: ['negative', 'nonexistent-person', 'hallucination-trap'] });
q({ prefix: 'NEG', category: 'negative_fail_closed', difficulty: 'hard',
  question: 'How many meetings happened on 31/02/2026?',
  expected: { answerType: 'behavior', requiredBehavior: 'UNRESOLVABLE_DATE', forbiddenBehaviors: ['HALLUCINATION'], note: '31 February does not exist on any calendar — must recognize the date is invalid, not silently substitute a nearby valid date' },
  failureSeverity: 'MEDIUM', tags: ['negative', 'invalid-date'] });

console.log('NEG done:', items.filter(i=>i.id.startsWith('NEG')).length);

// =========================================================================
// 11. COMPARISON / MULTI-ENTITY (5)
// =========================================================================
{
  const a = containers.find(c=>c.title==='Team Management Tools' && c.type==='project');
  const b = containers.find(c=>c.title==='Development Team Management System (Assets Accounts Permissions)');
  q({ prefix: 'CMP', category: 'comparison', difficulty: 'hard',
    question: 'Which is more recently updated, Team Management Tools or Development Team Management System?',
    expected: { answerType: 'fact', entityType: 'project', answerContains: [new Date(a.timestamp) >= new Date(b.timestamp) ? a.title : b.title] },
    failureSeverity: 'HIGH', tags: ['comparison', 'recency', 'independent-resolution'] });
}
{
  const anchorA = containers.find(c=>c.title==='Team Management Tools' && c.type==='project');
  const anchorB = containers.find(c=>c.title==='Development Team Management System (Assets Accounts Permissions)');
  const idsA = descendantContainerIds(Number(anchorA.sharePointItemId), containers);
  const idsB = descendantContainerIds(Number(anchorB.sharePointItemId), containers);
  const countA = tasks.filter(t=>idsA.has(Number(t.projectId))||idsA.has(Number(t.portfolioId))).length;
  const countB = tasks.filter(t=>idsB.has(Number(t.projectId))||idsB.has(Number(t.portfolioId))).length;
  q({ prefix: 'CMP', category: 'comparison', difficulty: 'hard',
    question: 'Which has more tasks, Team Management Tools or Development Team Management System?',
    expected: { answerType: 'fact', entityType: 'project', answerContains: [countA >= countB ? anchorA.title : anchorB.title], counts: { [anchorA.title]: countA, [anchorB.title]: countB } },
    evidence: { source: 'qdrant-direct', businessEntityKey: 'sourceKey', note: 'Phase 14 regression fixture — must use business-entity counts, not raw points' },
    failureSeverity: 'HIGH', tags: ['comparison', 'task-count', 'independent-resolution', 'chunk-inflation-risk'] });
}
q({ prefix: 'CMP', category: 'comparison', difficulty: 'medium',
  question: 'Compare "SharePoint Framework - SPFx Improvement" and "Content Management and Search".',
  expected: { answerType: 'list', entityType: 'project', requiredBehavior: 'must show real facts (status/updated date) for BOTH named entities independently, no forced winner if no comparison field is specified' },
  failureSeverity: 'MEDIUM', tags: ['comparison', 'side-by-side'] });
q({ prefix: 'CMP', category: 'comparison', difficulty: 'hard',
  question: 'Compare "Team Management Tools" and "Quantum Marketing Portal".',
  expected: { answerType: 'behavior', requiredBehavior: 'FAIL_CLOSED_ON_UNRESOLVED', forbiddenBehaviors: ['WRONG_ENTITY_GUESS', 'CONFIDENT_WRONG_ENTITY'],
    note: 'one real entity + one verified-nonexistent entity — must not substitute a different real entity for the fake one' },
  failureSeverity: 'CRITICAL', tags: ['comparison', 'nonexistent-entity', 'fail-closed'] });
q({ prefix: 'CMP', category: 'comparison', difficulty: 'hard',
  question: 'Compare "Team Management" and "Development Team Management System".',
  expected: { answerType: 'behavior', requiredBehavior: 'AMBIGUOUS', note: '"Team Management" (bare) matches multiple distinct real entities — must surface the ambiguity for that side, never silently pick one' },
  failureSeverity: 'HIGH', tags: ['comparison', 'ambiguity'] });

console.log('CMP done:', items.filter(i=>i.id.startsWith('CMP')).length);
console.log('TOTAL:', items.length);

// ---------------------------------------------------------------------------
// Write eval/v2/dataset.json (questions only) and eval/v2/ground_truth.json (expected/evidence),
// keyed by id, kept separate so the "what to ask" and "what's correct" concerns don't mix.
// ---------------------------------------------------------------------------
const EVAL_VERSION = 'v2.0';
const dataset = {
  version: EVAL_VERSION,
  generatedAt: NOW.toISOString(),
  totalQuestions: items.length,
  items: items.map((it) => ({
    id: it.id, category: it.category, difficulty: it.difficulty,
    question: it.question, tags: it.tags,
    ...(it.conversationId ? { conversationId: it.conversationId, turn: it.turn } : {}),
  })),
};
const groundTruth = {
  version: EVAL_VERSION,
  generatedAt: NOW.toISOString(),
  groundTruthMethod: 'Computed directly from raw Qdrant payloads (enterprise_knowledge) via the app\'s own verified, unit-tested business-logic functions (taskIsOverdue, descendantContainerIds, uniqueBusinessEntities) — never from the live agent\'s own answers.',
  items: Object.fromEntries(items.map((it) => [it.id, { expected: it.expected, evidence: it.evidence, failureSeverity: it.failureSeverity, note: it.note }])),
};

fs.mkdirSync('eval/v2/results', { recursive: true });
fs.writeFileSync('eval/v2/dataset.json', JSON.stringify(dataset, null, 2));
fs.writeFileSync('eval/v2/ground_truth.json', JSON.stringify(groundTruth, null, 2));
console.log('Wrote eval/v2/dataset.json and eval/v2/ground_truth.json');

// Category/difficulty distribution summary for the report.
const byCat = {};
const byDiff = {};
for (const it of items) {
  byCat[it.category] = (byCat[it.category] || 0) + 1;
  byDiff[it.difficulty] = (byDiff[it.difficulty] || 0) + 1;
}
console.log('By category:', byCat);
console.log('By difficulty:', byDiff);
