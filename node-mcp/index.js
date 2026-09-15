#!/usr/bin/env node
// Standalone Node.js mirror of the REMOTE (PHP, dogado-hosted) MCP server's exact 6-tool surface.
// Zero dependency on the main HHHHAgent Node app — nothing here imports from ../src/services or
// ../src/config.js. Every file this folder needs is its own self-contained port, one-to-one with
// php-mcp/'s own lib/ files (config.js↔config.php, lib/qdrant.js↔lib/Qdrant.php, lib/sharePoint.js
// ↔lib/SharePoint.php, lib/structuredFilters.js↔lib/StructuredFilters.php, lib/textMatch.js↔
// lib/TextMatch.php, lib/prompts.js↔lib/Prompts.php) — not a re-export of the richer main app.
//
// Purpose: a Node-readable copy of the PHP logic for someone who doesn't read PHP, and a fast local
// testbed for changes before hand-porting them into php-mcp/. Keep the two folders in sync BY HAND —
// there is deliberately no shared code between them, the same way php-mcp/ shares no code with
// ../src/services either.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { config } from './config.js';
import { scrollPayloads } from './lib/qdrant.js';
import { fetchRecentMeetings, saveReportToMeeting } from './lib/sharePoint.js';
import {
  resolveStatusFilter,
  isOverdueRequested,
  resolvePersonFilter,
  collectRealNames,
  unresolvedPersonAnswer,
  ambiguousPersonAnswer,
  resolveDateFilter,
  applyFilters,
  applySort,
  buildScopeText,
  personField,
} from './lib/structuredFilters.js';
import { rankByRelevance, compactRecord } from './lib/textMatch.js';
import { projectIntelligenceReportPrompt } from './lib/prompts.js';

const RECORD_TYPES = ['portfolio', 'project', 'task', 'meeting', 'timeentry'];
const LISTABLE_TYPES = ['portfolio', 'project', 'task', 'timeentry'];

/** Resolves the person filter and returns a blocked-response message if it's ambiguous/unresolved —
 *  mirrors resolveOrBlockPerson() in php-mcp/index.php exactly. */
function resolveOrBlockPerson(question, items, entityType) {
  const realNames = collectRealNames(items, entityType);
  const personFilter = resolvePersonFilter(question, realNames);
  if (personFilter.ambiguous) {
    return [null, ambiguousPersonAnswer(personFilter.candidateText, personFilter.ambiguous)];
  }
  if (personFilter.requested && !personFilter.resolvedName) {
    return [null, unresolvedPersonAnswer(personFilter.candidateText)];
  }
  return [personFilter, null];
}

const server = new Server({ name: 'hhhh-remote-dev', version: '2.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'count_records',
      description:
        'Use for EXACT counting questions scoped by type/person/status/overdue/date — e.g. ' +
        '"how many meetings happened last week", "how many tasks does Ankush Das have", "how ' +
        'many overdue tasks". Does NOT support scoping by a project/portfolio NAME (e.g. "tasks ' +
        'in Team Management Tools") — say so rather than silently answering unscoped for that. ' +
        'Never use semantic/vector search for counting. The returned "count" is exact — report ' +
        'it verbatim. Never recompute, round, or substitute a different number from memory or a ' +
        'separate estimate — a wrong reported count when the tool itself returned the right one ' +
        'is a reporting failure, not a data problem.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'e.g. "how many meetings happened last week"' },
          type: { type: 'string', enum: RECORD_TYPES, description: 'Optional: restrict to one record type. Omit to count every type.' },
        },
        required: ['question'],
      },
    },
    {
      name: 'list_records',
      description:
        'Use for filtered/date-scoped LIST questions by type/person/status/overdue/date — e.g. ' +
        '"which tasks are due this week", "time entries logged by Ankush Das today", "latest 5 ' +
        'projects". Does NOT support scoping by a project/portfolio NAME, and does NOT do ' +
        'keyword/topic search on title or content (e.g. "tasks about SPA") — never claim a topic ' +
        'match this tool did not actually filter on. Never use semantic/vector search for this. ' +
        'Every field in the result (owner, projectName, portfolioName, status, dates) is the real ' +
        'value from SharePoint — quote it EXACTLY in your answer. Never paraphrase, shorten, or ' +
        'substitute a different-sounding project/portfolio/owner name.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: LISTABLE_TYPES },
          question: { type: 'string' },
          limit: { type: 'number', description: 'Max records to return (default 30, or 1 for a "latest" query)' },
        },
        required: ['type', 'question'],
      },
    },
    {
      name: 'find_recent_meetings',
      description:
        'Use this to find the REAL SharePoint meeting item id before writing any AI report back ' +
        'to it — e.g. when the user says "the latest meeting". Queries SharePoint LIVE, so it ' +
        'sees a meeting created moments ago.',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'How many recent meetings to return (default 10)' } },
      },
    },
    {
      name: 'save_report_to_meeting',
      description:
        'Writes a Project Intelligence Report back onto a REAL SharePoint meeting item, ' +
        'confirmed by the user or found via find_recent_meetings — never guess the meetingId. ' +
        'summary sets AISummary; newActionItems appends entries with status "Pending Review" ' +
        '(a human must still approve them); existingTaskMatches appends entries with status ' +
        '"Task Created" and the real omtTaskId. Does NOT touch the meeting\'s Tasks lookup ' +
        'column (owned by an existing Power Automate flow). This performs a REAL, VISIBLE write ' +
        'to production SharePoint data — confirm with the user before calling this. If a new ' +
        'action item has no real project/portfolio suggestion (the report says "undetermined" ' +
        'for it), omit linkedProject entirely for that item — never pass {name: "undetermined"} ' +
        'or any other placeholder into a real SharePoint field.',
      inputSchema: {
        type: 'object',
        properties: {
          meetingId: { type: 'string' },
          summary: { type: 'string' },
          newActionItems: { type: 'array', items: { type: 'object' } },
          existingTaskMatches: { type: 'array', items: { type: 'object' } },
        },
        required: ['meetingId'],
      },
    },
    {
      name: 'investigate_transcript_context',
      description:
        'Call this ONCE, right after start_project_intelligence_report, to gather investigation ' +
        'evidence: related past meetings, related existing tasks, and related projects/portfolios. ' +
        'IMPORTANT: this dev-mirror server has no embedding-model access (same constraint as the ' +
        'real PHP remote server), so this is KEYWORD/TEXT matching only, not semantic search — it ' +
        'scans every record and ranks by keyword/BM25 overlap with the transcript. A related record ' +
        'worded very differently from the transcript may not surface here. There is only one mode — ' +
        'no "quick" option to trade off against, since every call here is already an exhaustive scan. ' +
        'Every field in the returned evidence (owner, projectName, portfolioName, taskId) is the real ' +
        'value — quote it EXACTLY, never paraphrase or substitute a different-sounding name.',
      inputSchema: {
        type: 'object',
        properties: { transcript: { type: 'string', description: 'Full plain-text content of the meeting transcript' } },
        required: ['transcript'],
      },
    },
    {
      name: 'start_project_intelligence_report',
      description:
        'DEFAULT tool for any meeting transcript. Call this FIRST, before anything else, whenever ' +
        'the user shares, pastes, or uploads a meeting transcript with ANY request to look at it. ' +
        'It does not call an LLM itself — it returns your own investigation instructions: call ' +
        'investigate_transcript_context ONCE, then write a 7-section Project Intelligence Report — ' +
        'never a plain transcript summary.',
      inputSchema: {
        type: 'object',
        properties: { transcript: { type: 'string', description: 'Full plain-text content of the meeting transcript' } },
        required: ['transcript'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'count_records') {
    const { question, type } = request.params.arguments || {};
    if (!question) throw new Error('question is required');
    if (type && !RECORD_TYPES.includes(type)) throw new Error(`type must be one of: ${RECORD_TYPES.join(', ')}`);

    const typesToCount = type ? [type] : RECORD_TYPES;
    const statusFilter = resolveStatusFilter(question);
    const overdueRequested = isOverdueRequested(question);

    // Fetch every type's items once, and resolve the person filter ONCE against the combined name
    // pool across all of them — resolving per-type independently wrongly BLOCKS a whole multi-type
    // count just because the person owns no portfolios/projects (a normal state, not "unresolved").
    const itemsByType = {};
    const combinedNames = new Set();
    for (const t of typesToCount) {
      itemsByType[t] = await scrollPayloads(config.qdrant, [t]);
      for (const n of collectRealNames(itemsByType[t], t)) combinedNames.add(n);
    }
    const personFilter = resolvePersonFilter(question, [...combinedNames]);
    if (personFilter.ambiguous) {
      return { content: [{ type: 'text', text: JSON.stringify({ blocked: true, message: ambiguousPersonAnswer(personFilter.candidateText, personFilter.ambiguous) }, null, 2) }] };
    }
    if (personFilter.requested && !personFilter.resolvedName) {
      return { content: [{ type: 'text', text: JSON.stringify({ blocked: true, message: unresolvedPersonAnswer(personFilter.candidateText) }, null, 2) }] };
    }

    // A type that has no person field at all (meeting) can't be scoped to the requested person —
    // showing its unconstrained total next to the correctly-scoped types would misread as if it
    // were also about that person. Omit it from a person-scoped multi-type count rather than
    // showing a number that has nothing to do with the question asked.
    const relevantTypes =
      personFilter.resolvedName !== null ? typesToCount.filter((t) => personField(t) !== null) : typesToCount;

    const counts = relevantTypes.map((t) => {
      const dateFilter = resolveDateFilter(question, t);
      return { type: t, count: applyFilters(itemsByType[t], t, personFilter, statusFilter, overdueRequested, dateFilter).length };
    });
    const scope =
      typesToCount.length === 1
        ? buildScopeText(personFilter, statusFilter, overdueRequested, resolveDateFilter(question, typesToCount[0]))
        : buildScopeText(personFilter, statusFilter, overdueRequested, { requested: false, range: null });

    return { content: [{ type: 'text', text: JSON.stringify({ counts, scope: scope || null }, null, 2) }] };
  }

  if (request.params.name === 'list_records') {
    const { type, question, limit } = request.params.arguments || {};
    if (!type || !LISTABLE_TYPES.includes(type)) throw new Error(`type must be one of: ${LISTABLE_TYPES.join(', ')}`);
    if (!question) throw new Error('question is required');

    const statusFilter = resolveStatusFilter(question);
    const overdueRequested = isOverdueRequested(question);
    const dateFilter = resolveDateFilter(question, type);

    const rawItems = await scrollPayloads(config.qdrant, [type]);
    const [personFilter, blocked] = resolveOrBlockPerson(question, rawItems, type);
    if (blocked !== null) {
      return { content: [{ type: 'text', text: JSON.stringify({ blocked: true, message: blocked }, null, 2) }] };
    }

    let items = applyFilters(rawItems, type, personFilter, statusFilter, overdueRequested, dateFilter);
    items = applySort(items, dateFilter);

    const n = limit || (dateFilter.sortDesc ? 1 : 30);
    const shown = items.slice(0, n);

    const result = {
      totalMatched: items.length,
      shown: shown.map((p) => ({
        title: p.title ?? null, status: p.status ?? null, owner: p.owner ?? null, authorName: p.authorName ?? null,
        timeHours: p.timeHours ?? null, timeDate: p.timeDate ?? null, projectName: p.projectName ?? null,
        portfolioName: p.portfolioName ?? null, hierarchyPath: p.hierarchyPath ?? null, dueDate: p.dueDate ?? null,
        timestamp: p.timestamp ?? null, text: p.text ?? null,
      })),
      scope: buildScopeText(personFilter, statusFilter, overdueRequested, dateFilter) || null,
    };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }

  if (request.params.name === 'find_recent_meetings') {
    const { limit } = request.params.arguments || {};
    const result = await fetchRecentMeetings(config.sharepoint, { limit: limit || 10 });
    if (!result.configured) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'SharePoint credentials not configured' }, null, 2) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result.items, null, 2) }] };
  }

  if (request.params.name === 'save_report_to_meeting') {
    const { meetingId, summary, newActionItems, existingTaskMatches } = request.params.arguments || {};
    if (!meetingId) throw new Error('meetingId is required');
    const result = await saveReportToMeeting(config.sharepoint, meetingId, { summary, newActionItems, existingTaskMatches });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }

  if (request.params.name === 'investigate_transcript_context') {
    const { transcript } = request.params.arguments || {};
    if (!transcript) throw new Error('transcript is required');

    // No character truncation — a transcript's relevant topic can be discussed anywhere in it.
    // rankByRelevance tokenizes once and reuses the result across every record.
    const [meetings, tasks, containers] = await Promise.all([
      scrollPayloads(config.qdrant, ['meeting']).then((items) => rankByRelevance(transcript, items, 15)),
      scrollPayloads(config.qdrant, ['task']).then((items) => rankByRelevance(transcript, items, 14)),
      scrollPayloads(config.qdrant, ['portfolio', 'project']).then((items) => rankByRelevance(transcript, items, 12)),
    ]);

    const format = (records) => (records.length ? records.map((r, i) => compactRecord(r, i)).join('\n\n') : 'None found.');
    const payload = {
      relatedPastMeetings: format(meetings),
      relatedExistingTasks: format(tasks),
      relatedProjectsPortfolios: format(containers),
      counts: { meetings: meetings.length, tasks: tasks.length, containers: containers.length },
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }

  if (request.params.name === 'start_project_intelligence_report') {
    const { transcript } = request.params.arguments || {};
    if (!transcript) throw new Error('transcript is required');
    return { content: [{ type: 'text', text: projectIntelligenceReportPrompt(transcript) }] };
  }

  throw new Error(`Unknown tool: ${request.params.name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
