import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { generateAnswer } from './ai.js';
import { searchKnowledge } from './qdrant.js';
import { scrollPayloads } from './qdrantScroll.js';
import { config } from '../config.js';
import { bm25Score, payloadToResult, scoreRecordMatch } from '../utils/textMatch.js';

const MAX_TRANSCRIPT_CHARS = 14000;
const MAX_CONTEXT_TEXT = 900;

function cleanText(value) {
  return String(value || '')
    .replace(/\u0000/g, ' ')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extensionFromName(name = '') {
  const match = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || '';
}

export async function extractUploadedTranscript(file) {
  if (!file?.buffer?.length) {
    throw new Error('Upload a non-empty .pdf, .docx, or .txt transcript file');
  }

  const ext = extensionFromName(file.originalname);
  const mime = String(file.mimetype || '').toLowerCase();

  if (ext === 'txt' || mime.startsWith('text/')) {
    return cleanText(file.buffer.toString('utf8'));
  }

  if (ext === 'docx' || mime.includes('wordprocessingml.document')) {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return cleanText(result.value || '');
  }

  if (ext === 'pdf' || mime === 'application/pdf') {
    const parser = new PDFParse({ data: file.buffer });
    try {
      const result = await parser.getText();
      return cleanText(result.text || '');
    } finally {
      await parser.destroy?.();
    }
  }

  throw new Error('Unsupported file type. Upload .pdf, .docx, or .txt');
}

export function compactRecord(record, index) {
  const p = record.payload || record;
  const id = p.taskId || p.taskCode || p.meetingId || p.sharePointItemId || '';
  const idLabel = p.type === 'task' || record.type === 'task' ? 'taskId' : 'id';
  const label = [
    `[${index + 1}] ${p.type || record.type || 'record'}: ${p.title || p.projectName || 'Untitled'}`,
    id ? `${idLabel}=${id}` : '',
    p.projectName ? `project=${p.projectName}` : '',
    p.portfolioName ? `portfolio=${p.portfolioName}` : '',
    p.hierarchyPath ? `path=${p.hierarchyPath}` : '',
    p.status ? `status=${p.status}` : '',
    p.timestamp ? `updated=${String(p.timestamp).slice(0, 10)}` : '',
  ]
    .filter(Boolean)
    .join(' | ');
  const text = String(p.text || record.text || '').replace(/\s+/g, ' ').slice(0, MAX_CONTEXT_TEXT);
  return `${label}\n${text}`;
}

function topRecords(results, limit) {
  const seen = new Set();
  const out = [];
  for (const result of results || []) {
    const p = result.payload || result;
    const key = `${p.type}:${p.sharePointListId || ''}:${p.sharePointItemId || p.taskId || p.meetingId || p.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(result);
    if (out.length >= limit) break;
  }
  return out;
}

function taskMatchLine(record) {
  const p = record.payload || record;
  const taskId = p.taskId || p.taskCode || p.sharePointItemId;
  if (!taskId) return '';
  return [
    `- taskId ${taskId}: ${p.title || 'Untitled task'}`,
    p.projectName ? `project=${p.projectName}` : '',
    p.hierarchyPath ? `path=${p.hierarchyPath}` : '',
  ]
    .filter(Boolean)
    .join(' | ');
}

function taskMatchesText(tasks, limit = 8) {
  return tasks.map(taskMatchLine).filter(Boolean).slice(0, limit).join('\n');
}

function collectRealTaskIds(tasks) {
  const ids = new Set();
  for (const record of tasks) {
    const p = record.payload || record;
    if (p.taskId != null) ids.add(String(p.taskId));
    if (p.taskCode) {
      ids.add(String(p.taskCode));
      ids.add(String(p.taskCode).replace(/^T/i, ''));
    }
  }
  return ids;
}

function collectRealContainerNames(tasks, containers) {
  const names = new Set();
  for (const record of [...tasks, ...containers]) {
    const p = record.payload || record;
    if (p.projectName) names.add(p.projectName.trim().toLowerCase());
    if (p.portfolioName) names.add(p.portfolioName.trim().toLowerCase());
    if (p.title) names.add(p.title.trim().toLowerCase());
  }
  return names;
}

/**
 * Deterministic post-processing guard against fabrication. Verified live that prompt-level
 * instructions alone don't reliably stop this local 3B model from inventing plausible-sounding
 * project names and task IDs when it has thin/no container evidence — a second real attempt at a
 * stronger prompt instruction made it WORSE (it started fabricating fake task IDs that weren't
 * present before). Rather than keep guessing at prompt wording, verify the model's claims against
 * the actual retrieved evidence after the fact and strip/flag anything that doesn't check out —
 * the fix this situation actually needs, not more prose.
 */
export function validateAnswerAgainstEvidence(answer, { tasks = [], containers = [] } = {}) {
  const realIds = collectRealTaskIds(tasks);
  const realNames = collectRealContainerNames(tasks, containers);
  const flagged = [];

  // Verified live: the model doesn't reliably use "taskId=X" — one real run instead wrote "the
  // exact taskId/taskCode is 12345", a fully fabricated ID (not among the 8 real retrieved IDs)
  // that the narrower "taskId[=:]?\s*(\d+)" pattern missed entirely because of the "/taskCode is"
  // in between. Tolerate any short connector between the label and the number.
  let out = String(answer || '').replace(/\btaskId(?:\/taskCode)?\s*(?:is|=|:)?\s*([A-Za-z]?\d+)\b/gi, (full, id) => {
    const norm = String(id).replace(/^T/i, '');
    if (realIds.has(String(id)) || realIds.has(norm)) return full;
    flagged.push(`taskId ${id}`);
    return `[unverified taskId ${id} — not found in retrieved evidence, do not treat as confirmed]`;
  });

  // The system prompt asks for the literal template "Recommended project: X, portfolio: Y", but
  // verified live that the model doesn't reliably stick to it — one real run instead wrote
  // "RELATED PROJECTS/PORTFOLIOS: GitHub Structure and Code Organization (New task — none found)",
  // a fully invented project name that a narrower "Recommended project:"-only regex let straight
  // through. Covers every container-name-claiming label actually observed. The capitalization
  // check is done in the callback (not as `[A-Z]` inside the pattern) because the pattern needs the
  // `i` flag for the label itself — `[A-Z]` under `i` matches lowercase too, which let plain prose
  // like "...project/portfolio evidence was retrieved" get flagged as a fabricated name; found via
  // a direct unit test before this ever reached a live response.
  const looksLikeProperNoun = (s) => /^[A-Z][A-Za-z0-9]/.test(s) && !/^(none|undetermined|n\/a|none found)$/i.test(s);
  const checkClaim = (full, prefix, rawName, suffix = '') => {
    const clean = String(rawName).trim().replace(/[.,]$/, '');
    if (!clean || !looksLikeProperNoun(clean)) return full;
    if (realNames.has(clean.toLowerCase())) return full;
    flagged.push(`"${clean}"`);
    return `${prefix}undetermined — "${clean}" was not found in retrieved evidence${suffix}`;
  };

  // "recommend project: X" (verified live — the model also drops the "-ed") is covered by
  // recommend(?:ed|s)? rather than requiring the exact word the prompt asked for.
  const labeledFieldRe =
    /((?:recommend(?:ed|s)?\s+(?:a\s+)?project|RELATED (?:NEW )?PROJECTS?(?:\/PORTFOLIOS?)?|portfolio)\s*:\s*"?)([^\n,."]{2,70}?)("?)(?=[\n(]|$|\.\s|,\s|,$)/gi;
  out = out.replace(labeledFieldRe, checkClaim);

  const underTheProjectRe = /(\bunder the\s+"?)([^\n,."]{2,70}?)("?\s+project\b)/gi;
  out = out.replace(underTheProjectRe, checkClaim);

  return { answer: out, flagged };
}

function ensureRequiredSections(answer) {
  const text = String(answer || '').trim();
  if (/action items?/i.test(text)) return text;
  return `${text}\n\nAction items / follow-ups:\n- No explicit action-item section was produced by the model. Review the related task candidates below and create or update tasks for any transcript follow-up that is not already covered.`;
}

async function generateMeetingAnalysis(messages) {
  if (config.chat.provider !== 'ollama') {
    return generateAnswer(messages);
  }

  const isQwen3 = /qwen3/i.test(config.ollama.chatModel);
  const system = `${messages.system}${isQwen3 ? '\n/no_think' : ''}`;
  const res = await fetch(`${config.ollama.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.ollama.chatModel,
      messages: [
        { role: 'system', content: system.slice(0, 5000) },
        { role: 'user', content: messages.user.slice(0, config.ollama.maxPromptChars) },
      ],
      stream: false,
      options: {
        temperature: config.ollama.temperature,
        num_predict: Math.max(config.ollama.maxTokens, 1400),
      },
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Ollama /api/chat ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = JSON.parse(text);
  const answer = String(data.message?.content || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^<\/?think>/gi, '')
    .trim();
  if (!answer) throw new Error('Ollama returned empty meeting analysis');
  return answer;
}

function lexicalScore(query, payload) {
  const match = scoreRecordMatch(query, payload);
  const doc = [
    payload.title,
    payload.projectName,
    payload.portfolioName,
    payload.hierarchyPath,
    payload.taskId,
    payload.taskCode,
    payload.text,
  ]
    .filter(Boolean)
    .join(' ');
  const bm25 = bm25Score(query, doc);
  return payloadToResult(payload, {
    keywordScore: match.score,
    bm25Score: bm25,
    combinedScore: match.score + bm25 * 0.2,
    confidence: match.confidence,
    matchReason: match.matchReason,
  });
}

/**
 * `exhaustive: true` scrolls every record of `types` (not just a vector top-K) and ranks it by
 * keyword/BM25 score before merging with the vector hits — used always for tasks (a task match
 * must never be missed) and optionally for meetings/containers under "full scan" mode. Plain
 * vector search alone can miss a match that's relevant but phrased very differently from the
 * transcript; the exhaustive scan can't, at the cost of pulling the whole collection into memory.
 */
async function typeSearch(query, types, limit, { exhaustive = false } = {}) {
  const filter = types.length === 1
    ? { must: [{ key: 'type', match: { value: types[0] } }] }
    : { should: types.map((type) => ({ key: 'type', match: { value: type } })) };
  const vectorResults = await searchKnowledge(query, limit, filter).catch(() => []);
  if (!exhaustive) return topRecords(vectorResults, limit);

  const allRecords = await scrollPayloads({ types, limit: 15000 }).catch(() => []);
  const lexicalResults = allRecords
    .map((payload) => lexicalScore(query, payload))
    .filter((result) => result.keywordScore > 0.15 || result.bm25Score > 0)
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, limit);

  return topRecords([...vectorResults, ...lexicalResults], limit);
}

export async function retrieveMeetingAnalysisContext(
  transcriptText,
  { scanMode = 'quick', limitMeetings = 8, limitTasks = 14, limitContainers = 6 } = {}
) {
  const query = cleanText(transcriptText).slice(0, 4000);
  const full = scanMode === 'full';
  const meetingsLimit = full ? Math.max(limitMeetings, 20) : limitMeetings;
  const containersLimit = full ? Math.max(limitContainers, 15) : limitContainers;

  const [meetings, tasks, containers] = await Promise.all([
    typeSearch(query, ['meeting'], meetingsLimit, { exhaustive: full }),
    typeSearch(query, ['task'], limitTasks, { exhaustive: true }), // always exhaustive — a task match must never be missed
    typeSearch(query, ['portfolio', 'project'], containersLimit, { exhaustive: full }),
  ]);

  return { meetings, tasks, containers, scanMode };
}

export function buildUploadedMeetingAnalysisMessages({
  filename,
  transcriptText,
  meetings = [],
  tasks = [],
  containers = [],
  question = '',
}) {
  const meetingEvidence = meetings.length
    ? meetings.map(compactRecord).join('\n\n')
    : 'No related previous meeting records were retrieved.';
  const taskEvidence = tasks.length
    ? tasks.map(compactRecord).join('\n\n')
    : 'No related existing task records were retrieved.';
  // Verified live: with zero container evidence, the model invented plausible-sounding project
  // names anyway ("SharePoint/Web Studio Tools", "URL Validation Bugs") instead of following the
  // system prompt's own "say so instead of guessing" instruction — the rigid response template
  // ("Recommended project: <real name>") outweighed a instruction buried in prose. Made the empty
  // case an explicit, impossible-to-miss directive instead of leaving it to prose alone.
  const containerEvidence = containers.length
    ? containers.map(compactRecord).join('\n\n')
    : 'No related project/portfolio records were retrieved. Do NOT invent or guess a project or ' +
      'portfolio name for any new task — if a real project name appears in the RELATED EXISTING ' +
      'TASKS evidence below and clearly matches the topic, use that instead; otherwise write ' +
      'exactly "Recommended project: undetermined — no matching project/portfolio evidence was retrieved."';
  const userAsk = String(question || '').trim();

  return {
    system:
      'You are OMT Meeting Intelligence. Use ONLY the uploaded transcript and retrieved Qdrant evidence. ' +
      'The uploaded transcript may be old or new. Your job is to summarize that uploaded meeting, connect it to older meeting context on the same topic, and turn it into action items. ' +
      'Do not stop at a summary. Always produce an Action items section, even if the transcript is exploratory; infer concrete follow-ups such as verify, test, confirm service name, validate ID/configuration, or create/update task.\n' +
      'For EVERY action item, first check the RELATED EXISTING TASKS evidence for a task that already covers it:\n' +
      '  - If one does: say plainly "This task already exists — do not create a new one" and cite its EXACT taskId/taskCode. Never propose creating a duplicate of a task that is already in the evidence.\n' +
      '  - If none does (a genuinely new action item): mark it "New task — none found" and recommend which EXISTING project and portfolio it should be created under, using ONLY names from the RELATED EXISTING TASKS or RELATED PROJECTS/PORTFOLIOS evidence below (whichever real project/portfolio most closely matches the topic). NEVER invent a project or portfolio name that is not literally present in that evidence, even a plausible-sounding one — if genuinely nothing fits, write "undetermined", not a guess.\n' +
      'Do not invent task IDs, owners, dates, project names, portfolio names, or previous discussions not present in the evidence.',
    user:
      `Uploaded transcript file: ${filename || 'transcript'}\n` +
      (userAsk ? `USER'S REQUEST ABOUT THIS UPLOAD: ${userAsk}\n` : '') +
      `\nUPLOADED TRANSCRIPT (may be historical):\n${cleanText(transcriptText).slice(0, MAX_TRANSCRIPT_CHARS)}\n\n` +
      `RELATED OLD MEETINGS / SUMMARIES FROM QDRANT (what was already discussed on this topic):\n${meetingEvidence}\n\n` +
      `RELATED EXISTING TASKS FROM QDRANT (what has already been created/done — each carries its real project/portfolio):\n${taskEvidence}\n\n` +
      `RELATED PROJECTS/PORTFOLIOS FROM QDRANT (real containers a NEW task could be placed under):\n${containerEvidence}\n\n` +
      'Write the response in this exact structure:\n' +
      'Uploaded meeting summary: 4-7 concise sentences.\n' +
      'What was already discussed before: 2-5 bullets based only on related old meetings. If none are relevant, say no strong previous-meeting match was retrieved.\n' +
      'Action items / follow-ups: bullets. For each item include the action, owner/due date if stated, and EITHER "Already exists — taskId=X, do not create a new one" OR "New task — none found. Recommended project: <real name>, portfolio: <real name>".\n' +
      'Existing tasks already created: list every matching task with its exact taskId/taskCode and why it covers the action — this is the do-not-duplicate list.\n' +
      'Potential duplicates or follow-ups: bullets for any action item that may duplicate an existing task but is not certain.\n' +
      'Important: include exact task IDs from task evidence wherever they match, and exact project/portfolio names from evidence for any new task. Never omit a matching task ID. Never invent a name not present in the evidence.\n',
  };
}

/** Shared by the web upload (file → extracted text) and the MCP tool (already-plain text) —
 *  both just need this once the transcript is a string, so neither has to duplicate the
 *  retrieval + prompt + validation pipeline below. */
export async function analyzeTranscriptText({ transcriptText, filename = 'transcript', question = '' }) {
  if (!transcriptText) {
    throw new Error('Could not extract readable text from the transcript');
  }

  const context = await retrieveMeetingAnalysisContext(transcriptText);
  const messages = buildUploadedMeetingAnalysisMessages({
    filename,
    transcriptText,
    meetings: context.meetings,
    tasks: context.tasks,
    containers: context.containers,
    question,
  });
  let answer = ensureRequiredSections(await generateMeetingAnalysis(messages));
  const { answer: validatedAnswer, flagged } = validateAnswerAgainstEvidence(answer, {
    tasks: context.tasks,
    containers: context.containers,
  });
  answer = validatedAnswer;
  const matches = taskMatchesText(context.tasks);
  if (matches) {
    answer = `${answer}\n\nRelated existing task candidates from Qdrant:\n${matches}`;
  }

  return {
    filename,
    transcriptChars: transcriptText.length,
    answer,
    hallucinationFlags: flagged,
    retrieved: {
      meetings: context.meetings.length,
      tasks: context.tasks.length,
      containers: context.containers.length,
    },
    taskMatches: context.tasks
      .map((record) => {
        const p = record.payload || record;
        return {
          taskId: p.taskId || p.taskCode || p.sharePointItemId || null,
          title: p.title || null,
          projectName: p.projectName || null,
          hierarchyPath: p.hierarchyPath || null,
        };
      })
      .filter((task) => task.taskId)
      .slice(0, 8),
    sources: {
      meetings: context.meetings,
      tasks: context.tasks,
    },
  };
}

export async function analyzeUploadedTranscript(file, question = '') {
  const transcriptText = await extractUploadedTranscript(file);
  return analyzeTranscriptText({ transcriptText, filename: file.originalname, question });
}
