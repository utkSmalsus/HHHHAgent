import { config } from '../config.js';
import { chunkText } from '../utils/chunking.js';

const today = () => new Date().toISOString().slice(0, 10);

// How much of an uploaded transcript is inlined directly into the prompt. Anything beyond this is
// NOT discarded (the old `slice(0, 8000)` silently dropped it) — it stays reachable in full via the
// get_transcript_part tool below. Bounded rather than unlimited so a huge upload can't blow the
// context window or tip Hermes past its ~100s gateway timeout in a single request.
const TRANSCRIPT_INLINE_CHARS = Number(process.env.TRANSCRIPT_INLINE_CHARS) || 60000;

// Match filters on `timestamp` compare the WHOLE ISO string exactly — {"match":{"value":"2026-
// 07-31"}} never matches "2026-07-31T05:30:00Z", and weaker models also tend to guess the wrong
// year with no "today" anchor. Broad-filter-then-reason-over-real-timestamps is the strategy that
// actually works reliably across models, so state it as the rule, not just a suggestion.
const DATE_RULE =
  `Today's date is ${today()}. Never filter Qdrant by an exact date/timestamp match — the ` +
  '"timestamp" field is a full ISO datetime string, so an exact match filter will silently match ' +
  'nothing. Instead, filter broadly (e.g. just {"must":[{"key":"type","match":{"value":"meeting"}}]}) ' +
  "with a large limit, then read each real result's own timestamp yourself to find/sort by date.";

// Two tools, two very different token costs. Stated up front so the model reaches for the cheap
// one first instead of defaulting to broad scrolls (verified live: brute-force scrolling was
// burning through free-tier token quotas fast).
const TOOL_CHOICE_RULE =
  'You have THREE tools — pick deliberately, they cost very differently AND fit different questions:\n' +
  '- qdrant_semantic_search: ranked by MEANING (embeddings), returns only the few best-matching ' +
  'records. CHEAP. Use this for topical/conceptual questions — "who is working on X", "status of Y", ' +
  '"comments about Z". UNRELIABLE for exact dates or numbers: "Scrum 30/07/2026" and "Scrum ' +
  '31/07/2026" are nearly identical text, so embeddings cannot reliably tell which one you meant — ' +
  'never trust it alone to pick between records that differ only by a date/number.\n' +
  '- qdrant_scroll: raw unranked filter/listing, no relevance ranking. EXPENSIVE (large result sets ' +
  'cost many tokens) but exact. Use it whenever the question names a SPECIFIC date, or you already ' +
  'have a specific title/entity from a previous turn to look up precisely — filter as narrowly as ' +
  'possible (e.g. by exact title/type) and keep limit small.\n' +
  '- qdrant_get_chunk: the COMPLETE text of ONE record by pointId. Both search tools return a ' +
  'PREVIEW of each record\'s text, not all of it; any result whose "truncated" field is true has ' +
  'more text you have not seen. CHEAP (one record). Whenever the answer could plausibly be in the ' +
  'unseen remainder, call this before concluding — never answer "not mentioned"/"no information" ' +
  'based only on a truncated preview.';

export const QDRANT_BRIEFING =
  "A Qdrant vector DB collection 'enterprise_knowledge' is available via three tools (see below). " +
  "Each point's payload has fields: type (portfolio/project/task/timeentry/meeting), title, text " +
  '(raw description/comments — the search tools return a PREVIEW of this, use qdrant_get_chunk ' +
  'for the complete text), hierarchyPath, status, owner, timestamp, portfolioName, ' +
  "projectName. Use the tools to answer the question grounded in this real data — check actual " +
  "timestamps for 'latest', fetch the full text with qdrant_get_chunk for comments/details, and explicitly flag " +
  'it when multiple real entities share a similar name instead of silently guessing one. Call ' +
  'tools as many times as you need, then give a concise but complete final answer in plain text. ' +
  `${TOOL_CHOICE_RULE} ` +
  DATE_RULE;

export const TRANSCRIPT_SYSTEM =
  'You are OMT Meeting Intelligence. A Qdrant vector DB collection \'enterprise_knowledge\' is ' +
  "available via two tools (see below) — fields: type (portfolio/project/task/timeentry/meeting), " +
  'title, text (raw description/comments — returned as a PREVIEW by the search tools; use ' +
  'qdrant_get_chunk for the complete text), hierarchyPath, status, owner, timestamp, ' +
  'portfolioName, projectName. Read the uploaded transcript, identify the real topics/people/' +
  'project names it actually names, then search (as many calls as you need — by topic ' +
  'keyword, by person name, by project/portfolio name) to find: (a) older meetings already ' +
  'discussing the same topic, (b) existing tasks that already cover each action item, (c) the ' +
  'real project/portfolio an action item without an existing task should live under. ' +
  `${TOOL_CHOICE_RULE} ` +
  `${DATE_RULE} ` +
  'NEVER invent a task ID, owner, date, project name, or portfolio name — every one you state must ' +
  'come from an actual tool result; if nothing fits, say "undetermined". ' +
  'Structure your final answer exactly as:\n' +
  'Uploaded meeting summary: 4-7 concise sentences.\n' +
  'What was already discussed before: 2-5 bullets from real older meetings found via search, or say none found.\n' +
  'Action items / follow-ups: bullets. For each: the action, owner/due date if stated, and either ' +
  '"Already exists — taskId=X, do not create a new one" (X from a real search result) or "New task ' +
  '— none found. Recommended title: <title>. Recommended project: <real name from search>, portfolio: <real name from search>".\n' +
  'Existing tasks already created: list every matching task with its exact taskId/taskCode and why it covers the action.\n' +
  'Potential duplicates or follow-ups: bullets for anything uncertain.';

const QDRANT_TOOL = {
  type: 'function',
  function: {
    name: 'qdrant_scroll',
    description:
      "Scroll/filter points in the 'enterprise_knowledge' Qdrant collection. Returns matching " +
      'payloads (no vectors) PLUS hasMore/nextOffset — if hasMore is true, the result was ' +
      'truncated and you have NOT seen every matching record yet. Never state a count or "these ' +
      'are all of them" while hasMore is true — call again with offset=nextOffset (or a bigger ' +
      'limit) until hasMore is false.',
    parameters: {
      type: 'object',
      properties: {
        filter: {
          type: 'object',
          description:
            'Qdrant filter object, e.g. {"must":[{"key":"title","match":{"text":"SmartMetaSearch"}}]}. Omit for no filter.',
        },
        limit: { type: 'number', description: 'Max points to return (default 25, max 60). Prefer a narrower filter over a huge limit — page with offset if you need more.' },
        // Some models generate this as a number even when told it's an opaque token — nextOffset
        // can be a string or a numeric point ID depending on the collection, so accept both rather
        // than have strict-schema providers reject the whole tool call outright.
        offset: {
          type: ['string', 'number'],
          description: "Pass the previous response's nextOffset (as-is, whatever type it was) to get the next page.",
        },
      },
    },
  },
};

const SEMANTIC_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'qdrant_semantic_search',
    description:
      "Ranked semantic search over the 'enterprise_knowledge' Qdrant collection — embeds your " +
      'query and returns only the few most relevant records (reranked with keyword matching too). ' +
      'Cheap and precise. Use this as your default search tool.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language search text — topic, name, or question.' },
        limit: { type: 'number', description: 'Max results to return (default 8, max 15).' },
        type: {
          type: 'string',
          enum: ['portfolio', 'project', 'task', 'timeentry', 'meeting'],
          description: 'Optionally restrict results to one record type.',
        },
      },
      required: ['query'],
    },
  },
};

// Stage 1 of retrieval hands back a PREVIEW, not the whole chunk, so a wide result set stays a
// bounded prompt. The previous 400 chars was far too small — an indexed chunk is up to ~5000 chars,
// so the correct record could be found while the sentence answering the question sat past the cut,
// and nothing in the result told the model that text was missing (it would conclude "not in the
// data"). Now the cut is bigger, and every truncated result carries textLength/truncated/pointId so
// the model can see there IS more and fetch the full chunk via qdrant_get_chunk (stage 2).
const PREVIEW_CHARS = 1200;

function toToolResult(pointId, payload) {
  const text = String(payload?.text || '');
  const truncated = text.length > PREVIEW_CHARS;
  return {
    ...payload,
    pointId,
    text: truncated ? text.slice(0, PREVIEW_CHARS) : text,
    ...(truncated
      ? {
          textLength: text.length,
          truncated: true,
          note: `Preview only — ${text.length - PREVIEW_CHARS} more chars. Call qdrant_get_chunk with pointId="${pointId}" for the full text.`,
        }
      : { truncated: false }),
  };
}

async function execQdrantSemanticSearch(args = {}) {
  const { searchKnowledge } = await import('./qdrant.js');
  const filter = args.type ? { must: [{ key: 'type', match: { value: args.type } }] } : null;
  const results = await searchKnowledge(String(args.query || ''), Math.min(Number(args.limit) || 8, 15), filter);
  return results.map((r) => toToolResult(r.id, r.payload));
}

/** Stage 2 — full text of one specific chunk the model already decided is relevant. */
async function execQdrantGetChunk(args = {}) {
  const pointId = args.pointId ?? args.point_id ?? args.id;
  if (pointId === undefined || pointId === null || pointId === '') {
    return { error: 'pointId is required (take it from a qdrant_semantic_search/qdrant_scroll result)' };
  }
  const res = await fetch(`${config.qdrant.url}/collections/${config.qdrant.collection}/points`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [pointId], with_payload: true, with_vector: false }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Qdrant ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  const point = data.result?.[0];
  if (!point) return { error: `No point found with pointId=${pointId}` };

  const payload = point.payload || {};
  return {
    pointId,
    title: payload.title,
    type: payload.type,
    chunkIndex: payload.chunkIndex ?? 0,
    totalChunks: payload.totalChunks ?? 1,
    // Full chunk text, deliberately not truncated — this tool exists precisely to undo the preview.
    text: String(payload.text || ''),
  };
}

async function execQdrantScroll(args = {}) {
  const res = await fetch(`${config.qdrant.url}/collections/${config.qdrant.collection}/points/scroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filter: args.filter,
      limit: Math.min(Number(args.limit) || 25, 60),
      offset: args.offset || undefined,
      with_payload: true,
      with_vector: false,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Qdrant ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  const points = data.result?.points || [];
  const nextOffset = data.result?.next_page_offset ?? null;
  return {
    returnedCount: points.length,
    hasMore: nextOffset != null,
    nextOffset,
    // Cap each record's own text so a wide scroll (many records) still serializes to a bounded,
    // always-VALID JSON blob — an outer blind string truncation on a large result would instead
    // cut off mid-object and hand the model malformed JSON. Anything cut is flagged per-record and
    // its full text is one qdrant_get_chunk call away (see toToolResult).
    payloads: points.map((p) => toToolResult(p.id, p.payload)),
  };
}

const GET_CHUNK_TOOL = {
  type: 'function',
  function: {
    name: 'qdrant_get_chunk',
    description:
      'Fetch the COMPLETE text of one record/chunk by its pointId (taken from a ' +
      'qdrant_semantic_search or qdrant_scroll result). Use this whenever a result is marked ' +
      '"truncated": true and the answer might be in the part you have not seen. Cheap — it returns ' +
      'exactly one record.',
    parameters: {
      type: 'object',
      properties: {
        pointId: { type: ['string', 'number'], description: "The result's pointId field, passed back as-is." },
      },
      required: ['pointId'],
    },
  },
};

const TOOL_EXECUTORS = {
  qdrant_semantic_search: execQdrantSemanticSearch,
  qdrant_scroll: execQdrantScroll,
  qdrant_get_chunk: execQdrantGetChunk,
};

/**
 * Runs a chat-completions model against an OpenAI-compatible endpoint with both Qdrant tools
 * available (ranked semantic search — cheap, and raw scroll — expensive), feeding tool results
 * back until it gives a final plain-text answer (or the turn cap is hit). Shared by every "model
 * searches Qdrant itself" provider — talks straight to the endpoint over HTTP rather than
 * spawning any CLI agent, so there's no process startup and no unrelated toolsets loaded.
 */
export async function runToolLoop({
  baseUrl,
  apiKey,
  model,
  messages,
  maxTurns = 6,
  providerLabel = 'Model',
  extraTools = [],
  extraExecutors = {},
}) {
  const tools = [SEMANTIC_SEARCH_TOOL, QDRANT_TOOL, GET_CHUNK_TOOL, ...extraTools];
  const executors = { ...TOOL_EXECUTORS, ...extraExecutors };

  for (let turn = 0; turn < maxTurns; turn++) {
    let res;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, tools }),
      });
    } catch (err) {
      throw new Error(`Cannot reach ${providerLabel} at ${baseUrl}: ${err.message}`);
    }

    const text = await res.text();
    if (!res.ok) throw new Error(`${providerLabel} ${res.status}: ${text.slice(0, 300)}`);
    const data = JSON.parse(text);
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error(`${providerLabel} returned no message`);

    if (msg.tool_calls?.length) {
      messages.push(msg);
      for (const tc of msg.tool_calls) {
        let result;
        try {
          const executor = executors[tc.function.name];
          if (!executor) throw new Error(`Unknown tool: ${tc.function.name}`);
          result = await executor(JSON.parse(tc.function.arguments || '{}'));
        } catch (err) {
          result = { error: err.message };
        }
        // No blind length cap here — result is already bounded (limit<=500 records, text<=600
        // chars each) by the executors above, so truncating the serialized string on top of that
        // would risk cutting valid JSON in half and handing the model a malformed tool result.
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      continue;
    }

    const answer = msg.content?.trim();
    if (!answer) throw new Error(`${providerLabel} returned empty response`);
    return answer;
  }

  throw new Error(`${providerLabel} search: too many tool-call turns without a final answer.`);
}

export function buildSearchMessages(question, history = []) {
  const convo = (Array.isArray(history) ? history : [])
    .slice(-8)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.text || '').slice(0, 500)}`)
    .join('\n');

  return [
    { role: 'system', content: QDRANT_BRIEFING },
    { role: 'user', content: convo ? `CONVERSATION SO FAR:\n${convo}\n\nQuestion: ${question}` : question },
  ];
}

/**
 * Builds the transcript prompt WITHOUT losing anything past a fixed cut-off (the old behavior
 * inlined only the first 8000 chars and silently dropped the rest, so an uploaded meeting could be
 * fully indexed in Qdrant yet invisible to this upload/analyze path).
 *
 * The transcript is split with the same chunkText() used at ingestion, then:
 *   - as many whole parts as fit TRANSCRIPT_INLINE_CHARS go straight into the prompt, and
 *   - any remaining parts are listed with an index + preview and stay retrievable IN FULL via the
 *     get_transcript_part tool returned alongside the messages.
 *
 * @returns {{messages: object[], tools: object[], executors: Record<string, Function>}}
 */
export function buildTranscriptRequest(transcriptText, filename = 'transcript', question = '') {
  const userAsk = String(question || '').trim();
  const full = String(transcriptText || '');
  const parts = chunkText(full);

  const inlined = [];
  let used = 0;
  for (const part of parts) {
    if (used && used + part.length > TRANSCRIPT_INLINE_CHARS) break;
    inlined.push(part);
    used += part.length;
  }
  const remaining = parts.slice(inlined.length);

  const partLabel = (i, part) =>
    `  part ${i + 1}/${parts.length} (${part.length} chars): ` +
    `${part.slice(0, 150).replace(/\s+/g, ' ')}…`;

  const inlineBlock = inlined
    .map((part, i) => `--- TRANSCRIPT PART ${i + 1}/${parts.length} ---\n${part}`)
    .join('\n\n');

  const remainderBlock = remaining.length
    ? `\n\nNOT SHOWN ABOVE — ${remaining.length} further part(s) of this same transcript exist. ` +
      'Call get_transcript_part with the part number to read any of them IN FULL:\n' +
      remaining.map((part, i) => partLabel(inlined.length + i, part)).join('\n') +
      '\n\nYou have NOT seen the whole transcript yet. Before summarizing, or before saying the ' +
      'transcript does not mention something, read the remaining parts with get_transcript_part — ' +
      'action items and decisions frequently appear at the very end of a meeting.'
    : '';

  return {
    messages: [
      { role: 'system', content: TRANSCRIPT_SYSTEM },
      {
        role: 'user',
        content:
          `Uploaded transcript file: ${filename}\n` +
          `Transcript length: ${full.length} chars, split into ${parts.length} part(s); ` +
          `parts 1-${inlined.length} are included below.\n` +
          (userAsk ? `USER'S REQUEST ABOUT THIS UPLOAD: ${userAsk}\n` : '') +
          `\nUPLOADED TRANSCRIPT:\n${inlineBlock}${remainderBlock}`,
      },
    ],
    tools: remaining.length ? [buildTranscriptPartTool(parts.length)] : [],
    executors: remaining.length
      ? {
          get_transcript_part: async (args = {}) => {
            const index = Number(args.index);
            if (!Number.isInteger(index) || index < 1 || index > parts.length) {
              return { error: `index must be an integer between 1 and ${parts.length}` };
            }
            return {
              index,
              totalParts: parts.length,
              // Full part text — deliberately NOT previewed/truncated; reading a selected part in
              // full is the entire point of this tool.
              text: parts[index - 1],
            };
          },
        }
      : {},
  };
}

function buildTranscriptPartTool(totalParts) {
  return {
    type: 'function',
    function: {
      name: 'get_transcript_part',
      description:
        `Read one part of the UPLOADED transcript in full. The transcript has ${totalParts} parts; ` +
        'parts not already shown in the prompt can only be read with this tool. Returns the ' +
        'complete text of that part (not a preview).',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'number', description: `1-based part number (1 to ${totalParts}).` },
        },
        required: ['index'],
      },
    },
  };
}
