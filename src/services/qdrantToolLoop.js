import { config } from '../config.js';

const today = () => new Date().toISOString().slice(0, 10);

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
  'You have TWO tools — pick deliberately, they cost very differently AND fit different questions:\n' +
  '- qdrant_semantic_search: ranked by MEANING (embeddings), returns only the few best-matching ' +
  'records. CHEAP. Use this for topical/conceptual questions — "who is working on X", "status of Y", ' +
  '"comments about Z". UNRELIABLE for exact dates or numbers: "Scrum 30/07/2026" and "Scrum ' +
  '31/07/2026" are nearly identical text, so embeddings cannot reliably tell which one you meant — ' +
  'never trust it alone to pick between records that differ only by a date/number.\n' +
  '- qdrant_scroll: raw unranked filter/listing, no relevance ranking. EXPENSIVE (large result sets ' +
  'cost many tokens) but exact. Use it whenever the question names a SPECIFIC date, or you already ' +
  'have a specific title/entity from a previous turn to look up precisely — filter as narrowly as ' +
  'possible (e.g. by exact title/type) and keep limit small.';

export const QDRANT_BRIEFING =
  "A Qdrant vector DB collection 'enterprise_knowledge' is available via two tools (see below). " +
  "Each point's payload has fields: type (portfolio/project/task/timeentry/meeting), title, text " +
  '(full raw description/comments), hierarchyPath, status, owner, timestamp, portfolioName, ' +
  "projectName. Use the tools to answer the question grounded in this real data — check actual " +
  "timestamps for 'latest', read the full text field for comments/details, and explicitly flag " +
  'it when multiple real entities share a similar name instead of silently guessing one. Call ' +
  'tools as many times as you need, then give a concise but complete final answer in plain text. ' +
  `${TOOL_CHOICE_RULE} ` +
  DATE_RULE;

export const TRANSCRIPT_SYSTEM =
  'You are OMT Meeting Intelligence. A Qdrant vector DB collection \'enterprise_knowledge\' is ' +
  "available via two tools (see below) — fields: type (portfolio/project/task/timeentry/meeting), " +
  'title, text (full raw description/comments), hierarchyPath, status, owner, timestamp, ' +
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

async function execQdrantSemanticSearch(args = {}) {
  const { searchKnowledge } = await import('./qdrant.js');
  const filter = args.type ? { must: [{ key: 'type', match: { value: args.type } }] } : null;
  const results = await searchKnowledge(String(args.query || ''), Math.min(Number(args.limit) || 8, 15), filter);
  return results.map((r) => ({ ...r.payload, text: String(r.payload?.text || '').slice(0, 400) }));
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
    // cut off mid-object and hand the model malformed JSON. Full text for one specific record is
    // still reachable via a follow-up filtered call (e.g. by taskId).
    payloads: points.map((p) => ({ ...p.payload, text: String(p.payload?.text || '').slice(0, 400) })),
  };
}

const TOOL_EXECUTORS = {
  qdrant_semantic_search: execQdrantSemanticSearch,
  qdrant_scroll: execQdrantScroll,
};

/**
 * Runs a chat-completions model against an OpenAI-compatible endpoint with both Qdrant tools
 * available (ranked semantic search — cheap, and raw scroll — expensive), feeding tool results
 * back until it gives a final plain-text answer (or the turn cap is hit). Shared by every "model
 * searches Qdrant itself" provider — talks straight to the endpoint over HTTP rather than
 * spawning any CLI agent, so there's no process startup and no unrelated toolsets loaded.
 */
export async function runToolLoop({ baseUrl, apiKey, model, messages, maxTurns = 6, providerLabel = 'Model' }) {
  for (let turn = 0; turn < maxTurns; turn++) {
    let res;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, tools: [SEMANTIC_SEARCH_TOOL, QDRANT_TOOL] }),
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
          const executor = TOOL_EXECUTORS[tc.function.name];
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

export function buildTranscriptMessages(transcriptText, filename = 'transcript', question = '') {
  const userAsk = String(question || '').trim();
  return [
    { role: 'system', content: TRANSCRIPT_SYSTEM },
    {
      role: 'user',
      content:
        `Uploaded transcript file: ${filename}\n` +
        (userAsk ? `USER'S REQUEST ABOUT THIS UPLOAD: ${userAsk}\n` : '') +
        `\nUPLOADED TRANSCRIPT:\n${transcriptText.slice(0, 8000)}`,
    },
  ];
}
