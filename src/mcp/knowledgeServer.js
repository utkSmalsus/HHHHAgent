#!/usr/bin/env node
// MCP server exposing the HHHH enterprise knowledge base to external AI clients (Claude, Codex,
// Perplexity, ...) over stdio. Reuses searchKnowledge() as-is — same hybrid vector+keyword
// retrieval, dedup and reranking the app itself uses — so results here match what the app sees.
import path from 'path';
import { fileURLToPath } from 'url';
import { config as loadDotenv } from 'dotenv';

// Pre-load the project's own .env by absolute path so this works regardless of the MCP client's
// cwd. Harmless if a .env was already loaded (dotenv never overrides existing process.env values).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.join(__dirname, '../../.env') });

// Everything below must be a DYNAMIC import, not static. ES modules evaluate every static import
// in a file before that file's own top-level code runs, regardless of source order — so a static
// import here would pull in config.js (transitively, via qdrant.js/sharepoint.js/etc.) and let it
// read process.env BEFORE the loadDotenv() call above ever executes, silently resolving `.env`
// relative to whatever cwd the MCP client happened to launch this process from instead of this
// project's real .env. Confirmed live: this is why SharePoint calls failed with "credentials not
// configured" when launched from a different cwd, despite working in a manual same-directory test.
const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } =
  await import('@modelcontextprotocol/sdk/types.js');
const { searchKnowledge } = await import('../services/qdrant.js');
const { analyzeTranscriptText, retrieveMeetingAnalysisContext, compactRecord } =
  await import('../services/uploadedMeetingAnalysis.js');
const { scrollPayloads } = await import('../services/qdrantScroll.js');
const {
  resolveStructuredFilters,
  checkStructuredFiltersBlocked,
  buildBlockedResponse,
  applyStructuredFilters,
  applyDateSort,
  resolveDateFilter,
  buildScopeText,
} = await import('../services/structuredFilters.js');
const { fetchRecentMeetings, saveReportToMeeting } = await import('../services/sharepoint.js');
const { PROJECT_INTELLIGENCE_REPORT_PROMPT } = await import('./prompts.js');

const RECORD_TYPES = ['portfolio', 'project', 'task', 'meeting', 'timeentry'];
// NOTE: person-filtering for 'timeentry' still won't match by author — applyStructuredFilters()
// in structuredFilters.js only ever checks `owner`, never `authorName` (the field timeentries
// actually use). Confirmed live via the PHP MCP port, which fixes this with a per-type field
// lookup — porting that fix back here means editing shared core logic query.js's count/overdue/
// list branches also depend on, so it's deliberately left alone pending an explicit decision to
// touch that shared file. Date/status/overdue-scoped timeentry listing (no person) works fine.
const LISTABLE_TYPES = ['portfolio', 'project', 'task', 'timeentry'];

const server = new Server(
  { name: 'hhhh-enterprise-knowledge', version: '1.0.0' },
  { capabilities: { tools: {}, prompts: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'search_knowledge_base',
      description:
        'Hybrid semantic + keyword search over the HHHH enterprise knowledge base ' +
        '(SharePoint portfolios, projects, tasks, meetings, timesheets, ~26k chunks). ' +
        'Returns raw matching records with scores for the caller to reason over directly.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language search query' },
          type: {
            type: 'string',
            enum: RECORD_TYPES,
            description: 'Optional: restrict results to one record type',
          },
          limit: {
            type: 'number',
            description: 'Max results to return (default 10, max 25)',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'analyze_transcript',
      description:
        'Legacy single-shot transcript analysis — DO NOT use this by default. Prefer ' +
        'start_project_intelligence_report for any transcript the user wants analyzed, read, or ' +
        'summarized. Only call this one if the user explicitly asks for the old/simple/quick version ' +
        'instead of the full report.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Full plain-text content of the meeting transcript' },
          filename: { type: 'string', description: 'Optional original filename, for display only' },
          question: {
            type: 'string',
            description: 'Optional specific question about the transcript, beyond the default full analysis',
          },
        },
        required: ['text'],
      },
    },
    {
      name: 'count_records',
      description:
        'Use for EXACT counting questions — "how many meetings happened last week", "how many ' +
        'tasks does X have", "how many overdue tasks in project Y". Do NOT use search_knowledge_base ' +
        'for counting — it only returns a capped top-K similarity sample, never a real total, and ' +
        'will silently undercount. This scans the full collection and applies real filters (person, ' +
        'project/portfolio, status, overdue, date range — including phrases like "last week", ' +
        '"yesterday", "this month", or an explicit date) extracted from the question text.',
      inputSchema: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description:
              'The natural-language question, e.g. "how many meetings happened last week" — used to ' +
              'extract person/project/status/overdue/date filters',
          },
          type: {
            type: 'string',
            enum: RECORD_TYPES,
            description: 'Optional: restrict to one record type. Omit to count every type.',
          },
        },
        required: ['question'],
      },
    },
    {
      name: 'list_records',
      description:
        'Use for filtered/date-scoped LIST questions — "which tasks are due this week", "list ' +
        'projects updated yesterday", "show overdue tasks for X", "latest 5 projects". Do NOT use ' +
        'search_knowledge_base for these — it ranks by semantic similarity, not by date/status/owner, ' +
        'and will miss or misorder real matches. This scans the full collection and applies real ' +
        'filters extracted from the question text (person, project/portfolio, status, overdue, date ' +
        'range/sort).',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: LISTABLE_TYPES,
            description: 'Record type to list (portfolio, project, task, or timeentry — not meeting). ' +
              'Person-name filtering does not work for timeentry (only date/status/overdue do).',
          },
          question: {
            type: 'string',
            description:
              'The natural-language question, e.g. "which tasks are due this week" — used to extract ' +
              'filters and sort order',
          },
          limit: { type: 'number', description: 'Max records to return (default 30, or 1 for a "latest" query)' },
        },
        required: ['type', 'question'],
      },
    },
    {
      name: 'find_recent_meetings',
      description:
        'Use this to find the REAL SharePoint meeting item id before writing any AI report back to ' +
        'it — e.g. when the user says "the latest meeting" or names a meeting to confirm which one a ' +
        'transcript belongs to. This queries SharePoint LIVE (not the Qdrant-cached knowledge base), ' +
        'so it will correctly show a meeting created moments ago that search_knowledge_base or ' +
        'count_records/list_records may not have indexed yet. Returns id/title/start/status for the ' +
        'most recent meetings, sorted newest first by when the meeting actually occurred.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'How many recent meetings to return (default 10)' },
        },
      },
    },
    {
      name: 'save_report_to_meeting',
      description:
        'Writes a Project Intelligence Report back onto a REAL SharePoint meeting item, confirmed by ' +
        'the user or found via find_recent_meetings — never guess the meetingId. All parts are ' +
        'optional and independent, and existing data is appended to, never overwritten: summary sets ' +
        'AISummary (Section 1); newActionItems appends new entries to ActionItemJSON with status ' +
        '"Pending Review" (Section 5 — items with NO existing task found — a human must still ' +
        'approve them, this never auto-approves); existingTaskMatches appends entries with status ' +
        '"Task Created" and the real omtTaskId (Section 4 — items an existing task already covers). ' +
        'Does NOT touch the meeting\'s Tasks lookup column — that is owned by an existing Power ' +
        'Automate flow that auto-links a "meeting task" on creation, and overwriting it was confirmed ' +
        'live to destroy that flow\'s own linkage. This performs a REAL, VISIBLE write to production ' +
        'SharePoint data your whole team sees — confirm with the user before calling this, don\'t ' +
        'call it automatically just because a report was generated.',
      inputSchema: {
        type: 'object',
        properties: {
          meetingId: { type: 'string', description: 'Real SharePoint Meetings-list item id (e.g. from find_recent_meetings)' },
          summary: { type: 'string', description: 'Executive summary text for the AISummary field' },
          newActionItems: {
            type: 'array',
            description: 'New action items with no existing covering task (Section 5) — saved as "Pending Review"',
            items: {
              type: 'object',
              properties: {
                description: { type: 'string' },
                taskDescription: { type: 'string' },
                sectionTopic: { type: 'string' },
                owningTool: { type: 'string' },
                discussionContext: { type: 'string', description: 'Verbatim supporting quote from the transcript' },
                projectHints: { type: 'array', items: { type: 'string' } },
                assignedTo: { type: 'object', description: '{name, id?, email?} of the suggested owner' },
                linkedProject: { type: 'object', description: '{name, id?} of the suggested project' },
                taskType: { type: 'string' },
                priorityRank: { type: 'string' },
                dueDate: { type: 'string' },
              },
              required: ['description'],
            },
          },
          existingTaskMatches: {
            type: 'array',
            description: 'Action items already covered by a real existing task (Section 4) — saved as "Task Created"',
            items: {
              type: 'object',
              properties: {
                description: { type: 'string' },
                taskDescription: { type: 'string' },
                sectionTopic: { type: 'string' },
                owningTool: { type: 'string' },
                discussionContext: { type: 'string' },
                assignedTo: { type: 'object' },
                linkedProject: { type: 'object' },
                taskType: { type: 'string' },
                priorityRank: { type: 'string' },
                omtTaskId: { type: 'string', description: 'The real existing SharePoint task id this covers' },
              },
              required: ['description', 'omtTaskId'],
            },
          },
        },
        required: ['meetingId'],
      },
    },
    {
      name: 'investigate_transcript_context',
      description:
        'Call this ONCE, right after start_project_intelligence_report, to gather your investigation ' +
        'evidence in a single fast call: related past meetings, related existing tasks, and related ' +
        'projects/portfolios — all retrieved in parallel server-side and pre-trimmed to a manageable ' +
        'size. Strongly prefer this over calling search_knowledge_base yourself multiple times, which ' +
        'is much slower (each call is a separate sequential round trip returning large untrimmed text) ' +
        'and is why past reports took 10+ minutes. Only fall back to search_knowledge_base for a ' +
        'narrow, specific follow-up this does not cover (e.g. one named person, or a project not ' +
        'among the returned containers).',
      inputSchema: {
        type: 'object',
        properties: {
          transcript: { type: 'string', description: 'Full plain-text content of the meeting transcript' },
          scanMode: {
            type: 'string',
            enum: ['quick', 'full'],
            description:
              'Ask the user to choose before calling this tool — see start_project_intelligence_report\'s ' +
              'STEP 0 for the exact wording to use. "quick" (default): existing tasks are always scanned ' +
              'exhaustively regardless of mode, but related past meetings and projects/portfolios are ' +
              'matched only by semantic similarity against the ~8/6 most relevant — fast (a few seconds), ' +
              'but a related meeting or project phrased very differently from this transcript could be ' +
              'missed. "full": meetings and projects/portfolios also get the exhaustive scan-and-rank ' +
              'tasks already get, and more of each are returned — slower, but nothing is skipped for being ' +
              'phrased differently. Default to "quick" only if the user has no preference.',
          },
        },
        required: ['transcript'],
      },
    },
    {
      name: 'start_project_intelligence_report',
      description:
        'DEFAULT tool for any meeting transcript. Call this FIRST, before anything else, whenever ' +
        'the user shares, pastes, or uploads a meeting transcript with ANY request to look at it — ' +
        'including short/informal phrasings such as "read this", "read transcript", "analyse this", ' +
        '"analyze this", "analyse transcript", "analyze transcript", "summarise this", "summarize ' +
        'this", "go through this", "look at this transcript", "check this meeting", "what happened ' +
        'in this meeting", or a bare file upload with no instructions at all. If the input is a ' +
        'meeting transcript and the user wants ANYTHING done with it, call this tool, not ' +
        'search_knowledge_base or analyze_transcript directly.\n\n' +
        'It does not call an LLM itself — it returns your own investigation instructions: call ' +
        'investigate_transcript_context ONCE to gather prior meetings, decisions, and existing tasks ' +
        'related to the transcript (fast, parallel, pre-trimmed — do not loop search_knowledge_base ' +
        'calls instead, that is much slower), then write a 7-section Project Intelligence Report ' +
        '(executive summary, historical timeline, progress-since-last-meeting diff, existing-tasks ' +
        'table, new-tasks table with project/portfolio suggestions, AI insights, next steps) — never ' +
        'a plain transcript summary.',
      inputSchema: {
        type: 'object',
        properties: {
          transcript: { type: 'string', description: 'Full plain-text content of the meeting transcript' },
        },
        required: ['transcript'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'search_knowledge_base') {
    const { query, type, limit } = request.params.arguments || {};
    if (!query) throw new Error('query is required');
    if (type && !RECORD_TYPES.includes(type)) {
      throw new Error(`type must be one of: ${RECORD_TYPES.join(', ')}`);
    }

    const filter = type ? { must: [{ key: 'type', match: { value: type } }] } : null;
    const results = await searchKnowledge(query, limit || 10, filter);

    const records = results.map((r) => ({
      score: Number(r.combinedScore.toFixed(3)),
      ...r.payload,
    }));

    return { content: [{ type: 'text', text: JSON.stringify(records, null, 2) }] };
  }

  if (request.params.name === 'analyze_transcript') {
    const { text, filename, question } = request.params.arguments || {};
    if (!text) throw new Error('text is required');

    const result = await analyzeTranscriptText({ transcriptText: text, filename, question });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }

  if (request.params.name === 'count_records') {
    const { question, type } = request.params.arguments || {};
    if (!question) throw new Error('question is required');
    if (type && !RECORD_TYPES.includes(type)) {
      throw new Error(`type must be one of: ${RECORD_TYPES.join(', ')}`);
    }

    const typesToCount = type ? [type] : RECORD_TYPES;
    const sf = await resolveStructuredFilters(question, typesToCount.length === 1 ? typesToCount[0] : 'task');
    const blocked = checkStructuredFiltersBlocked(sf);
    if (blocked.blocked) {
      return { content: [{ type: 'text', text: JSON.stringify({ blocked: blocked.kind, message: buildBlockedResponse(blocked).answer }, null, 2) }] };
    }

    const counted = await Promise.all(
      typesToCount.map(async (t) => {
        const items = await scrollPayloads({ types: [t], limit: 30000 }).catch(() => []);
        const filters = typesToCount.length === 1 ? sf : { ...sf, dateFilter: resolveDateFilter(question, t) };
        return { type: t, count: applyStructuredFilters(items, filters).length };
      })
    );

    const result = { counts: counted, scope: buildScopeText(sf) || null };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }

  if (request.params.name === 'list_records') {
    const { type, question, limit } = request.params.arguments || {};
    if (!type || !LISTABLE_TYPES.includes(type)) {
      throw new Error(`type must be one of: ${LISTABLE_TYPES.join(', ')}`);
    }
    if (!question) throw new Error('question is required');

    const sf = await resolveStructuredFilters(question, type);
    const blocked = checkStructuredFiltersBlocked(sf);
    if (blocked.blocked) {
      return { content: [{ type: 'text', text: JSON.stringify({ blocked: blocked.kind, message: buildBlockedResponse(blocked).answer }, null, 2) }] };
    }

    let items = await scrollPayloads({ types: [type], limit: 30000 }).catch(() => []);
    items = applyStructuredFilters(items, sf);
    if (sf.dateFilter.sort) items = applyDateSort(items, sf.dateFilter);

    const n = limit || (sf.dateFilter.sort ? 1 : 30);
    const shown = items.slice(0, n);

    const result = {
      totalMatched: items.length,
      shown: shown.map((p) => ({
        title: p.title,
        status: p.status,
        owner: p.owner || null,
        authorName: p.authorName || null,
        timeHours: p.timeHours ?? null,
        timeDate: p.timeDate || null,
        projectName: p.projectName || null,
        portfolioName: p.portfolioName || null,
        hierarchyPath: p.hierarchyPath || null,
        dueDate: p.dueDate || null,
        timestamp: p.timestamp || null,
        text: p.text || null,
      })),
      scope: buildScopeText(sf) || null,
    };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }

  if (request.params.name === 'find_recent_meetings') {
    const { limit } = request.params.arguments || {};
    const result = await fetchRecentMeetings({ limit: limit || 10 });
    if (!result.configured) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'SharePoint credentials not configured' }, null, 2) }],
      };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result.items, null, 2) }] };
  }

  if (request.params.name === 'save_report_to_meeting') {
    const { meetingId, summary, newActionItems, existingTaskMatches } = request.params.arguments || {};
    if (!meetingId) throw new Error('meetingId is required');

    const result = await saveReportToMeeting(meetingId, { summary, newActionItems, existingTaskMatches });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }

  if (request.params.name === 'investigate_transcript_context') {
    const { transcript, scanMode } = request.params.arguments || {};
    if (!transcript) throw new Error('transcript is required');
    if (scanMode && !['quick', 'full'].includes(scanMode)) {
      throw new Error('scanMode must be "quick" or "full"');
    }

    const context = await retrieveMeetingAnalysisContext(transcript, { scanMode });
    const format = (records) =>
      records.length ? records.map((r, i) => compactRecord(r, i)).join('\n\n') : 'None found.';

    const payload = {
      scanMode: context.scanMode,
      relatedPastMeetings: format(context.meetings),
      relatedExistingTasks: format(context.tasks),
      relatedProjectsPortfolios: format(context.containers),
      counts: {
        meetings: context.meetings.length,
        tasks: context.tasks.length,
        containers: context.containers.length,
      },
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }

  if (request.params.name === 'start_project_intelligence_report') {
    const { transcript } = request.params.arguments || {};
    if (!transcript) throw new Error('transcript is required');

    return {
      content: [
        { type: 'text', text: PROJECT_INTELLIGENCE_REPORT_PROMPT.replace('{{TRANSCRIPT}}', transcript) },
      ],
    };
  }

  throw new Error(`Unknown tool: ${request.params.name}`);
});

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: 'project_intelligence_report',
      description:
        'Investigate an uploaded meeting transcript together with the full HHHH knowledge base ' +
        '(past meetings, decisions, tasks, projects, portfolios) and produce a structured Project ' +
        'Intelligence Report — not a transcript summary. Use whenever a transcript is uploaded and ' +
        'the user asks to analyze/read/summarize it.',
      arguments: [
        {
          name: 'transcript',
          description: 'Full plain-text content of the uploaded meeting transcript',
          required: true,
        },
      ],
    },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  if (request.params.name !== 'project_intelligence_report') {
    throw new Error(`Unknown prompt: ${request.params.name}`);
  }
  const transcript = request.params.arguments?.transcript;
  if (!transcript) throw new Error('transcript argument is required');

  return {
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: PROJECT_INTELLIGENCE_REPORT_PROMPT.replace('{{TRANSCRIPT}}', transcript),
        },
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
