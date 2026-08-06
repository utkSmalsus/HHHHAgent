/**
 * Eval V2 scorer — automated deterministic scoring for count/date/status/entity-fact/behavior
 * questions; flags anything requiring free-text semantic judgment as REVIEW_REQUIRED rather than
 * having the same production LLM (or an automated heuristic pretending to be reliable) grade its
 * own free-text answers. REVIEW_REQUIRED items are hand-reviewed separately using the stored
 * `evidence` (never the agent's own answer) as ground truth, and merged back in by the caller.
 *
 * Usage: node eval/v2/scorer.mjs [--results eval/v2/results/baseline.json]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, arr) => {
    if (arg.startsWith('--')) acc.push([arg.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);
const RESULTS_PATH = args.results || path.join(__dirname, 'results', 'baseline.json');

const groundTruth = JSON.parse(fs.readFileSync(path.join(__dirname, 'ground_truth.json'), 'utf8'));
const dataset = JSON.parse(fs.readFileSync(path.join(__dirname, 'dataset.json'), 'utf8'));
const runResults = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));

const byId = new Map(runResults.results.map((r) => [r.id, r]));
const datasetById = new Map(dataset.items.map((it) => [it.id, it]));

function numIn(s) {
  const m = String(s || '').match(/-?\d[\d,]*(\.\d+)?/);
  return m ? Number(m[0].replace(/,/g, '')) : null;
}
const NOT_FOUND_RE = /couldn't (confidently )?(find|match)|no such|does(n'?t| not) exist|not found|no (real )?(project|portfolio|task|person|meeting) (named|called|titled)|I can't find|no results?/i;
const AMBIGUOUS_RE = /which one|matches \d+ different|ambiguous|could you clarify|did you mean/i;
const UNSUPPORTED_RE = /no separate ["']?created["']? field|not tracked|can't (reliably )?determine|unsupported|don't have that information|isn't tracked/i;
const CLARIFY_RE = /which (one|project|portfolio|task|meeting)|could you (clarify|specify)|what do you mean|can you clarify/i;

function scoreOne(id) {
  const gt = groundTruth.items[id];
  const ds = datasetById.get(id);
  const run = byId.get(id);
  const base = { id, category: ds?.category, difficulty: ds?.difficulty, question: ds?.question, failureSeverity: gt?.failureSeverity };

  if (!run) return { ...base, verdict: 'FAIL', flags: ['MISSING_RESULT'], automated: true, note: 'no run result found' };
  if (run.error) return { ...base, verdict: 'FAIL', flags: ['RETRIEVAL_FAILURE'], automated: true, answer: null, note: `run error: ${run.error}` };

  const answer = run.answer || '';
  const exp = gt?.expected || {};
  const flags = [];
  let verdict = null;
  let automated = true;

  if (exp.answerType === 'count') {
    const got = numIn(answer);
    if (got === null) { verdict = 'FAIL'; flags.push('GROUNDING_FAILURE'); }
    else if (got === exp.count) { verdict = 'PASS'; }
    else {
      verdict = 'FAIL';
      // Heuristic: a much-too-large number close to a known "global" scale suggests a dropped filter.
      if (exp.count < 1000 && got > 2000) flags.push('UNSAFE_GLOBAL_FALLBACK');
      flags.push('WRONG_SCOPE');
    }
  } else if (exp.answerType === 'fact' && exp.value !== undefined) {
    const valStr = String(exp.value ?? '').slice(0, 10); // dates: compare by day
    if (valStr && answer.toLowerCase().includes(valStr.toLowerCase())) verdict = 'PASS';
    else { verdict = 'FAIL'; flags.push('GROUNDING_FAILURE'); }
  } else if (exp.answerType === 'fact' && Array.isArray(exp.answerContains)) {
    const hit = exp.answerContains.some((s) => answer.toLowerCase().includes(String(s).toLowerCase()));
    verdict = hit ? 'PASS' : 'FAIL';
    if (!hit) flags.push('WRONG_ENTITY');
  } else if (exp.answerType === 'list' && Array.isArray(exp.titles)) {
    const found = exp.titles.filter((t) => answer.toLowerCase().includes(String(t).toLowerCase()));
    if (found.length === exp.titles.length) verdict = 'PASS';
    else if (found.length > 0) { verdict = 'PARTIAL'; flags.push('RETRIEVAL_FAILURE'); }
    else { verdict = 'FAIL'; flags.push('RETRIEVAL_FAILURE'); }
  } else if (exp.answerType === 'behavior') {
    const rb = exp.requiredBehavior;
    if (rb === 'NOT_FOUND' || rb === 'UNRESOLVABLE_DATE') {
      verdict = NOT_FOUND_RE.test(answer) ? 'PASS' : 'FAIL';
      if (verdict === 'FAIL') flags.push('HALLUCINATION');
    } else if (rb === 'AMBIGUOUS' || rb === 'AMBIGUOUS_OR_QUALIFIED') {
      verdict = AMBIGUOUS_RE.test(answer) ? 'PASS' : 'FAIL';
      if (verdict === 'FAIL') flags.push('AMBIGUITY_FAILURE');
    } else if (rb === 'UNSUPPORTED') {
      verdict = UNSUPPORTED_RE.test(answer) ? 'PASS' : 'FAIL';
      if (verdict === 'FAIL') flags.push('HALLUCINATION');
    } else if (rb === 'CLARIFY' || rb === 'CLARIFY_OR_NOT_FOUND') {
      verdict = (CLARIFY_RE.test(answer) || NOT_FOUND_RE.test(answer)) ? 'PASS' : 'FAIL';
      if (verdict === 'FAIL') flags.push('CONVERSATION_CONTEXT_FAILURE');
    } else if (rb === 'FAIL_CLOSED_ON_UNRESOLVED') {
      verdict = NOT_FOUND_RE.test(answer) ? 'PASS' : 'REVIEW_REQUIRED';
      automated = verdict !== 'REVIEW_REQUIRED';
    } else if (rb === 'YES' || rb === 'NO') {
      const said = /\byes\b/i.test(answer) ? 'YES' : /\bno\b/i.test(answer) ? 'NO' : null;
      verdict = said === rb ? 'PASS' : said ? 'FAIL' : 'REVIEW_REQUIRED';
      automated = verdict !== 'REVIEW_REQUIRED';
    } else {
      verdict = 'REVIEW_REQUIRED'; automated = false;
    }
  } else {
    // semantic / list without concrete titles / anything else needing judgment.
    verdict = 'REVIEW_REQUIRED';
    automated = false;
  }

  return { ...base, verdict, flags, automated, answer, intent: run.intent, confidence: run.confidence };
}

const scored = dataset.items.map((it) => scoreOne(it.id));
const outPath = path.join(path.dirname(RESULTS_PATH), 'scored-auto.json');
fs.writeFileSync(outPath, JSON.stringify({ scoredAt: new Date().toISOString(), scored }, null, 2));

const counts = { PASS: 0, PARTIAL: 0, FAIL: 0, REVIEW_REQUIRED: 0 };
for (const s of scored) counts[s.verdict] = (counts[s.verdict] || 0) + 1;
console.log('Automated scoring complete:', counts);
console.log('Wrote', outPath);
