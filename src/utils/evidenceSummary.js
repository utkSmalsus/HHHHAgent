import { extractKeywords, normalizeText } from './textMatch.js';
import { filterResultsByQuestion } from './evidenceMatch.js';

function displayTitle(record) {
  const p = record.payload || record;
  return (
    record.title ||
    record.projectName ||
    p.title ||
    p.projectName ||
    (record.text || '').split('.')[0]?.trim() ||
    'Untitled'
  );
}

function fieldFromText(text, field) {
  const m = String(text || '').match(new RegExp(`${field}:\\s*([^.,\\n]+)`, 'i'));
  return m?.[1]?.trim() || '';
}

function cleanTitle(title) {
  return String(title || '')
    .replace(/^(Bug|Task|Development|Improvement)\s*[-–:]\s*/i, '')
    .trim()
    .slice(0, 90);
}

function isCompleted(text) {
  return /task completed|completed|ready for|deployed|90%|100%/i.test(text || '');
}

function isActive(text) {
  return /working on|in progress|active|ongoing|10%|20%|30%/i.test(text || '');
}

/**
 * Build a factual answer directly from Qdrant evidence — no LLM hallucination.
 */
export function buildEvidenceSummaryAnswer(question, results = [], contextPack = {}) {
  const filtered = filterResultsByQuestion(question, results);
  const items = (filtered.length ? filtered : results).slice(0, 10);
  if (!items.length) return null;

  const keywords = extractKeywords(question);
  const topic =
    keywords.includes('meeting') && keywords.includes('tool')
      ? 'the Meeting Tool'
      : keywords.length
        ? keywords.slice(0, 3).join(' ')
        : 'this topic';

  const portfolios = items.filter((r) => r.type === 'portfolio');
  const projects = items.filter((r) => r.type === 'project');
  const tasks = items.filter((r) => r.type === 'task');
  const timeentries = items.filter((r) => r.type === 'timeentry');

  const sentences = [];

  const anchor = portfolios[0] || projects[0] || tasks[0];
  if (anchor) {
    const text = anchor.text || '';
    const name = displayTitle(anchor).slice(0, 100);
    const status = fieldFromText(text, 'Status');
    const completion = fieldFromText(text, 'Completion');
    const owner = fieldFromText(text, 'Owner');

    let line = `${name || topic}`;
    if (status) line += ` is ${status.toLowerCase()}`;
    if (completion) line += ` (${completion} complete)`;
    line += '.';
    sentences.push(line);

    if (owner) {
      sentences.push(`${owner} is listed as owner on this work.`);
    }
  }

  const taskTitles = tasks
    .map((t) => cleanTitle(displayTitle(t)))
    .filter((t) => t && t !== 'Untitled')
    .slice(0, 4);

  const completedCount = tasks.filter((t) => isCompleted(t.text)).length;
  const activeCount = tasks.filter((t) => isActive(t.text)).length;

  if (taskTitles.length) {
    let taskLine = `Related tasks include ${taskTitles.join(', ')}`;
    if (completedCount) taskLine += `, with ${completedCount} largely completed`;
    if (activeCount) taskLine += ` and ${activeCount} still in progress`;
    taskLine += '.';
    sentences.push(taskLine);
  }

  const owners = new Set();
  for (const r of items) {
    const o = fieldFromText(r.text, 'Owner');
    if (o) owners.add(o);
    if (r.authorName) owners.add(r.authorName);
  }
  if (contextPack.totalHoursLogged > 0) {
    sentences.push(
      `Approximately ${contextPack.totalHoursLogged} hours have been logged on related work.`
    );
  } else if (owners.size) {
    sentences.push(`Contributors include ${[...owners].slice(0, 3).join(', ')}.`);
  }

  if (timeentries.length && !contextPack.totalHoursLogged) {
    const recent = timeentries[0];
    const author = recent.authorName || fieldFromText(recent.text, 'author');
    const hours = recent.timeHours ?? recent.payload?.timeHours;
    if (author || hours) {
      sentences.push(
        `Recent time logged${author ? ` by ${author}` : ''}${hours ? ` (${hours}h)` : ''}.`
      );
    }
  }

  if (!sentences.length) {
    const snippet = (items[0].text || '').slice(0, 240);
    if (snippet) sentences.push(`Latest indexed updates on ${topic}: ${snippet}`);
  }

  const answer = sentences.slice(0, 4).join(' ').replace(/\s+/g, ' ').trim();
  return answer.length > 30 ? answer : null;
}
