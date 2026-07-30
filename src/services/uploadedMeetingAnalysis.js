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

function compactRecord(record, index) {
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

export async function retrieveMeetingAnalysisContext(transcriptText, { limitMeetings = 8, limitTasks = 14 } = {}) {
  const query = cleanText(transcriptText).slice(0, 4000);
  const [meetingResults, vectorTaskResults, allTasks] = await Promise.all([
    searchKnowledge(query, limitMeetings, {
      must: [{ key: 'type', match: { value: 'meeting' } }],
    }).catch(() => []),
    searchKnowledge(query, limitTasks, {
      must: [{ key: 'type', match: { value: 'task' } }],
    }).catch(() => []),
    scrollPayloads({ types: ['task'], limit: 15000 }).catch(() => []),
  ]);

  const lexicalTaskResults = allTasks
    .map((payload) => {
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
    })
    .filter((result) => result.keywordScore > 0.15 || result.bm25Score > 0)
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, limitTasks);

  const taskResults = topRecords([...vectorTaskResults, ...lexicalTaskResults], limitTasks);

  return {
    meetings: topRecords(meetingResults, limitMeetings),
    tasks: taskResults,
  };
}

export function buildUploadedMeetingAnalysisMessages({
  filename,
  transcriptText,
  meetings = [],
  tasks = [],
}) {
  const meetingEvidence = meetings.length
    ? meetings.map(compactRecord).join('\n\n')
    : 'No related previous meeting records were retrieved.';
  const taskEvidence = tasks.length
    ? tasks.map(compactRecord).join('\n\n')
    : 'No related existing task records were retrieved.';

  return {
    system:
      'You are OMT Meeting Intelligence. Use ONLY the uploaded transcript and retrieved Qdrant evidence. ' +
      'The uploaded transcript may be old or new. Your job is to summarize that uploaded meeting, connect it to older meeting context, and identify action items/follow-ups. ' +
      'Do not stop at a summary. Always produce an Action items section, even if the transcript is exploratory; infer concrete follow-ups such as verify, test, confirm service name, validate ID/configuration, or create/update task. ' +
      'When an action item appears to already exist as a task, cite the existing taskId/taskCode from the task evidence. ' +
      'If no matching task is present in evidence, mark it as New task needed. Do not invent task IDs, owners, dates, or previous discussions.',
    user:
      `Uploaded transcript file: ${filename || 'transcript'}\n\n` +
      `UPLOADED TRANSCRIPT (may be historical):\n${cleanText(transcriptText).slice(0, MAX_TRANSCRIPT_CHARS)}\n\n` +
      `RELATED OLD MEETINGS / SUMMARIES FROM QDRANT:\n${meetingEvidence}\n\n` +
      `RELATED EXISTING TASKS FROM QDRANT:\n${taskEvidence}\n\n` +
      'Write the response in this exact structure:\n' +
      'Uploaded meeting summary: 4-7 concise sentences.\n' +
      'What was already discussed before: 2-5 bullets based only on related old meetings. If none are relevant, say no strong previous-meeting match was retrieved.\n' +
      'Action items / follow-ups: bullets. For each item include: action, owner if stated, due date if stated, existing task match with taskId/taskCode if evidence supports it, otherwise New task needed.\n' +
      'Existing tasks already created: list matching or possibly related tasks with exact taskId/taskCode and why they may cover the action.\n' +
      'Potential duplicates or follow-ups: bullets for any action item that may duplicate an existing task but is not certain.\n' +
      'Important: include exact task IDs from task evidence wherever they match. Never omit a matching task ID from task evidence.\n',
  };
}

export async function analyzeUploadedTranscript(file) {
  const transcriptText = await extractUploadedTranscript(file);
  if (!transcriptText) {
    throw new Error('Could not extract readable text from the uploaded file');
  }

  const context = await retrieveMeetingAnalysisContext(transcriptText);
  const messages = buildUploadedMeetingAnalysisMessages({
    filename: file.originalname,
    transcriptText,
    meetings: context.meetings,
    tasks: context.tasks,
  });
  let answer = ensureRequiredSections(await generateMeetingAnalysis(messages));
  const matches = taskMatchesText(context.tasks);
  if (matches) {
    answer = `${answer}\n\nRelated existing task candidates from Qdrant:\n${matches}`;
  }

  return {
    filename: file.originalname,
    transcriptChars: transcriptText.length,
    answer,
    retrieved: {
      meetings: context.meetings.length,
      tasks: context.tasks.length,
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
