import { Router } from 'express';
import { generateAnswer } from '../services/ai.js';
import { buildContextPack } from '../services/contextPack.js';
import { hybridRetrieve } from '../services/hybridSearch.js';
import { scrollPayloads } from '../services/qdrantScroll.js';
import { queryStructuredData } from '../services/sharepoint.js';
import {
  buildEnterpriseMessages,
  INSUFFICIENT_DATA_MESSAGE,
} from '../prompts/enterpriseQuery.js';
import {
  evidenceMatchesQuestion,
  filterResultsByQuestion,
} from '../utils/evidenceMatch.js';
import { sanitizeEnterpriseAnswer } from '../utils/answerSanitizer.js';
import {
  isHierarchyQuestion,
  structuralRetrieve,
  buildStructuralPrompt,
} from '../services/structuralRetrieve.js';
import {
  isMeetingDateQuestion,
  meetingDateRetrieve,
  buildMeetingDateAnswer,
  isMeetingDetailFollowup,
  resolveReferencedMeeting,
  resolveExactMeetingTitle,
  resolveMeetingByExplicitDate,
  buildMeetingDetailPrompt,
} from '../services/meetingQuery.js';
import {
  isOwnedByPersonQuestion,
  isWhoWorksOnQuestion,
  tasksOwnedByPerson,
  whoWorksOnTopic,
  buildOwnedByPersonAnswer,
  buildWhoWorksOnAnswer,
} from '../services/ownerLookup.js';
import {
  isRecentWorkQuestion,
  recentWorkRetrieve,
  buildRecentWorkPrompt,
} from '../services/recentWork.js';
import {
  isExactLookupQuestion,
  extractLookupPhrase,
  resolveReferencedEntity,
  exactLookup,
  buildRawAnswer,
} from '../services/exactLookup.js';
import { detectPresentationFormat, formatRows, isPureReformatRequest, forceBulletLines } from '../utils/presentFormat.js';
import {
  groupByEntity,
  plausibleGroups,
  toCandidates,
  buildDisambiguationAnswer,
  buildDisambiguationSuggestions,
} from '../utils/disambiguate.js';
import { normalizeText } from '../utils/textMatch.js';
import { resolveReferencedTopic, isPronounFollowup } from '../utils/referenceResolve.js';

const router = Router();

/** Self-contained chat UI — talks to POST /api/query. Styles/script are static files
 *  (public/query-ui.css, public/query-ui.js) so they're plain, unescaped CSS/JS to edit. */
router.get('/ui', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>HHHH Agent</title>
  <link rel="stylesheet" href="/query-ui.css"/>
  <script>
    // Set the saved theme before first paint, else the page flashes light then re-themes.
    try { document.documentElement.setAttribute('data-theme', localStorage.getItem('omt_theme') || 'light'); } catch (e) {}
  </script>
</head>
<body>
  <header>
    <span class="brand">HHHH Agent</span>
    <span class="actions">
      <select id="providerSelect" title="Chat model" aria-label="Chat model">
        <option value="ollama">Ollama (local)</option>
        <option value="gemini">Gemini</option>
        <option value="hermes">Hermes</option>
        <option value="gemini-flash">Gemini Flash</option>
      </select>
      <button class="hdr-btn" id="themeToggle" type="button" title="Toggle theme" aria-label="Toggle theme">
        <svg id="iconMoon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        <svg id="iconSun" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" hidden><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
      </button>
      <button class="hdr-btn" id="newchat" type="button" title="New chat" aria-label="New chat">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
      </button>
      <a class="hdr-btn" href="/api/ingest/progress/ui" title="Ingest / backup" aria-label="Ingest / backup">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/></svg>
      </a>
    </span>
  </header>
  <div id="log"></div>
  <form id="f">
    <input id="file" type="file" accept=".pdf,.docx,.txt,application/pdf,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document"/>
    <div class="file-chip" id="fileChip" hidden>
      <span id="fileChipName"></span>
      <button type="button" id="fileChipRemove" aria-label="Remove attachment">&times;</button>
    </div>
    <div class="input-bar">
      <button type="button" class="icon-btn attach-btn" id="attachBtn" title="Attach file" aria-label="Attach file">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
      <textarea id="q" rows="1" placeholder="Ask about projects, tasks, meetings…" autocomplete="off" autofocus></textarea>
      <button id="send" class="icon-btn send-btn" type="submit" title="Send" aria-label="Send">
        <svg id="sendIcon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
        <svg id="stopIcon" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" hidden><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
      </button>
    </div>
  </form>
  <script src="/query-ui.js"></script>
</body>
</html>`);
});

router.post('/', async (req, res) => {
  // Client hit "Stop" or navigated away — cancel the in-flight Ollama call too, instead of
  // burning GPU time on an answer nobody will see. Declared outside the try block so the
  // catch block below can still read it.
  //
  // NB: listen on `res`, not `req`. `req`'s "close" fires as soon as the request body has been
  // fully read — which express.json() already did before this handler runs — so it would abort
  // every healthy request instantly. `res` "close" with writableEnded still false means the
  // client really did go away before we answered.
  const abortController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abortController.abort();
  });
  const { signal } = abortController;

  try {
    const { question: rawQuestion, limit = 8, history = [], provider } = req.body;
    const opts = { signal, provider };

    if (!rawQuestion) {
      return res.status(400).json({ success: false, error: 'question is required' });
    }

    // Testing mode: the model searches Qdrant itself (via a tool call) and answers directly —
    // bypasses every intent-detection/entity-resolution branch below entirely.
    const DIRECT_SEARCH_MODULES = {
      hermes: '../services/hermes.js',
      'gemini-flash': '../services/hfFlash.js',
    };
    if (DIRECT_SEARCH_MODULES[provider]) {
      const { searchAndAnswer } = await import(DIRECT_SEARCH_MODULES[provider]);
      const answer = await searchAndAnswer(rawQuestion, history).catch(
        (err) => `Error: ${err.message}`
      );
      return res.json({ success: true, answer, format: 'prose', confidence: 1, intent: `${provider}-direct` });
    }

    // Conversation memory: recent turns the client sent (last ~8, capped for prompt size).
    const priorTurns = (Array.isArray(history) ? history : [])
      .filter((m) => m && m.text)
      .slice(-8);

    // "as a table" / "in bullet points" / "chronologically" → render deterministically, no LLM,
    // so the layout is exactly what was asked for (a local model can't be trusted to always
    // produce a real table). Applied below wherever a branch already has its rows in hand.
    const presentationFormat = detectPresentationFormat(rawQuestion);

    // A PURE reformat request ("show that as bullets", "give me the above as a table") names no
    // new topic at all — searching for its literal words always fails ("couldn't find anything
    // matching that"). Re-run retrieval for the previous real question instead, and let the
    // presentationFormat captured above render it in the newly-requested layout.
    let question = rawQuestion;
    let isReformatSubstitution = false;
    if (presentationFormat && isPureReformatRequest(rawQuestion)) {
      const lastUserQuestion = [...priorTurns].reverse().find((m) => m.role === 'user')?.text;
      if (lastUserQuestion) {
        question = lastUserQuestion;
        isReformatSubstitution = true;
      }
    }

    const convo = priorTurns
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.text).slice(0, 500)}`)
      .join('\n');
    // Follow-ups ("who were the participants?", "what was discussed in that meeting?") retrieve
    // better with the previous turns prepended — the entity name (e.g. "Scrum 30/07/2026") is
    // usually in the ASSISTANT's last answer, not the user's words. Skipped on a reformat
    // substitution: `question` there is already the complete original question (not a vague
    // pronoun follow-up), so prepending the same turns again just duplicates/dilutes the search
    // text and can tank retrieval confidence enough to misfire the low-confidence disambiguation.
    const recentContext = isReformatSubstitution
      ? ''
      : priorTurns
          .slice(-2)
          .map((m) => String(m.text).slice(0, 300))
          .join('\n');
    const retrievalQuestion = recentContext ? `${recentContext}\n${question}` : question;
    // "latest / recent / current work" → prefer the most recently updated records.
    const wantsRecent = /\b(latest|recent|recently|current|currently|now|nowadays|these days|up[- ]?to[- ]?date|newest|last few)\b/i.test(question);
    const tsMs = (r) => Date.parse(r?.timestamp || r?.payload?.timestamp || '') || 0;
    const withHistory = (messages) =>
      convo
        ? { system: messages.system, user: `CONVERSATION SO FAR (for context):\n${convo}\n\n${messages.user}` }
        : messages;

    // Greetings / small talk / trivially short input → reply directly, don't search the KB.
    const norm = String(question).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const words = norm ? norm.split(' ') : [];
    const GREETING_PHRASES = new Set([
      'hi', 'hey', 'hello', 'yo', 'hiya', 'howdy', 'sup', 'hii', 'helloo',
      'thanks', 'thank you', 'thankyou', 'ok', 'okay', 'k', 'bye', 'goodbye',
      'good morning', 'good afternoon', 'good evening', 'how are you',
      'who are you', 'what are you', 'what can you do', 'what do you do', 'help',
    ]);
    // Exact-phrase matching alone misses natural variants ("hello there", "hi team", "good
    // morning all"), which then fall through to a KB search and get the no-data reply. Treat a
    // short opener that STARTS with a greeting word as a greeting too.
    const GREETING_OPENER =
      /^(hi|hii+|hey+|hello+|yo|hiya|howdy|sup|greetings|good (morning|afternoon|evening))\b/;
    const isShortGreeting = words.length <= 4 && GREETING_OPENER.test(norm);
    if (words.length <= 1 || GREETING_PHRASES.has(norm) || isShortGreeting) {
      // Let the LLM reply conversationally — but no KB retrieval, so it can't dump data.
      const greetingReply = await generateAnswer(withHistory({
        system:
          'You are HHHH Agent, a friendly assistant for a project-management knowledge base. ' +
          'Reply to the user\'s greeting or small talk in 1-2 short, warm sentences. ' +
          'Do NOT invent any project, task, or people data. ' +
          'Briefly invite them to ask about their portfolio, projects, or tasks.',
        user: String(question).trim(),
      }), opts).catch(() => null);
      return res.json({
        success: true,
        answer:
          greetingReply ||
          "Hi! I'm HHHH Agent — ask me about your portfolio, projects, or tasks.",
        format: 'prose',
        confidence: 1,
        intent: 'greeting',
        sources: { qdrant: [], sharepoint: {} },
      });
    }

    // "how many X do we have" — checked EARLY, before any of the more specific intent branches
    // below, because those branches (meeting-detail, hierarchy, etc.) can otherwise intercept a
    // count question first purely because it happens to contain a trigger word like "meetings".
    // Tested live: "how many meetings have we had" (real answer: 144) was hijacked by the
    // meeting-detail branch and answered "this is the first meeting... only one meeting recorded"
    // — moving the count check ahead of it fixes that class of misrouting entirely.
    // The true total is a fully known fact via a full collection count, but the general retrieval
    // path only ever hands the LLM its top ~10-12 evidence records: tested "how many tasks do we
    // have" (real answer 14,167) and the model answered "10" — it was just counting the evidence
    // snippets it happened to see. Deterministic count, no LLM guess, same principle as every
    // other exact-fact path this session.
    const COUNT_RE = /\bhow many\b|\bcount of\b|\bnumber of\b|\btotal (number|count)\b/i;
    if (COUNT_RE.test(question)) {
      const COUNT_TYPES = [
        { re: /\bportfolio/i, type: 'portfolio', label: 'portfolio items' },
        { re: /\bproject/i, type: 'project', label: 'projects' },
        { re: /\btask/i, type: 'task', label: 'tasks' },
        { re: /\bmeeting/i, type: 'meeting', label: 'meetings' },
        { re: /\btime ?entr/i, type: 'timeentry', label: 'time entries' },
      ];
      const matchedTypes = COUNT_TYPES.filter((t) => t.re.test(question));
      const typesToCount = matchedTypes.length ? matchedTypes : COUNT_TYPES;
      const counted = await Promise.all(
        typesToCount.map(async (t) => ({
          label: t.label,
          n: (await scrollPayloads({ types: [t.type], limit: 30000 }).catch(() => [])).length,
        }))
      );
      const answer = `There ${counted.length === 1 && counted[0].n === 1 ? 'is' : 'are'} ${counted
        .map((c) => `${c.n} ${c.label}`)
        .join(', ')} in the indexed knowledge base.`;
      return res.json({
        success: true,
        answer,
        format: 'prose',
        confidence: 0.95,
        intent: 'count',
        sources: { qdrant: [], sharepoint: {} },
      });
    }

    // "which tasks are overdue" / "what's past its deadline" — originally declined deterministically
    // because task payloads carried no due-date field at all (confirmed by grepping the schema).
    // Root cause turned out to be an ingestion gap, not a real data gap: the real SharePoint task
    // list HAS a DueDate field (confirmed against the live SPFx app source, TaskDetailComponent.tsx),
    // Graph was already returning it, it just was never pulled into the ingested text/metadata —
    // see hierarchyIngest.js's taskItemToKnowledge. Now that it's ingested, answer for real: a task
    // is overdue when its DueDate is in the past AND its status isn't one of the "done" states.
    if (/\b(overdue|past due|late|behind schedule)\b/i.test(question) && /\btasks?\b/i.test(question)) {
      const allTasks = await scrollPayloads({ types: ['task'], limit: 30000 }).catch(() => []);
      const withDueDate = allTasks.filter((t) => t.dueDate);
      if (!withDueDate.length) {
        // Ingested data hasn't been re-ingested since DueDate was added — stay honest instead of
        // silently answering "no overdue tasks" from an actually-empty dataset.
        return res.json({
          success: true,
          answer:
            "None of the currently indexed tasks have a due date recorded yet — the knowledge base needs to be re-ingested to pick up SharePoint's DueDate field before I can answer this. I can tell you each task's current status or when it was last updated instead.",
          format: 'prose',
          confidence: 0.6,
          intent: 'insufficient-schema',
          sources: { qdrant: [], sharepoint: {} },
        });
      }
      const DONE_RE = /^(task completed|completed|approved|ready to go)/i;
      const now = new Date();
      const overdue = withDueDate
        .filter((t) => new Date(t.dueDate) < now && !DONE_RE.test(t.status || ''))
        .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
      if (!overdue.length) {
        return res.json({
          success: true,
          answer: `No tasks are currently overdue (checked ${withDueDate.length} tasks with a recorded due date).`,
          format: 'prose',
          confidence: 0.95,
          intent: 'overdue',
          sources: { qdrant: [], sharepoint: {} },
        });
      }
      // Honor "as a table"/"timeline" like every other deterministic branch does — this one was
      // reported live as always rendering bullets regardless of what was asked, because it built
      // its own answer text directly instead of going through the shared formatter. Built locally
      // rather than reusing formatRows()/formatRowsAsTable() as-is: those show "Updated" (last
      // modified), but the whole point of this view is the Due date, which itemDate() doesn't read.
      const MAX = 30;
      const shown = overdue.slice(0, MAX);
      const more = overdue.length > MAX ? `\n…and ${overdue.length - MAX} more` : '';
      let answer;
      let answerFormat = 'bullets';
      if (presentationFormat === 'table') {
        const header = '| Title | Due | Status |';
        const sep = '|---|---|---|';
        const rows = shown.map(
          (t) => `| ${String(t.title || 'Untitled').replace(/\|/g, '/')} | ${String(t.dueDate).slice(0, 10)} | ${t.status || '-'} |`
        );
        answer = [header, sep, ...rows].join('\n') + more;
        answerFormat = 'table';
      } else if (presentationFormat === 'timeline') {
        const lines = shown.map((t) => `- ${String(t.dueDate).slice(0, 10)} — ${t.title || 'Untitled'}${t.status ? ` [${t.status}]` : ''}`);
        answer = lines.join('\n') + more;
        answerFormat = 'timeline';
      } else {
        const lines = shown.map((t) => `- ${t.title || 'Untitled'} — due ${String(t.dueDate).slice(0, 10)}${t.status ? ` [${t.status}]` : ''}`);
        answer = `${overdue.length} task${overdue.length === 1 ? ' is' : 's are'} overdue:\n\n${lines.join('\n')}${more}`;
      }
      return res.json({
        success: true,
        answer,
        format: answerFormat,
        confidence: 0.95,
        intent: 'overdue',
        counts: { overdue: overdue.length, withDueDate: withDueDate.length },
        sources: { qdrant: overdue.slice(0, 10).map((payload) => ({ payload })), sharepoint: {} },
      });
    }

    // "which tasks belong to <person>" / "who is working on <project>" — the general
    // hybridRetrieve → LLM path is a SUMMARIZER (deliberately, for "what's the status of X"), which
    // tested live as vague ("coordination, preparation, follow-up activities...") for genuinely
    // enumerable ownership questions where a real, specific answer exists in the data. Deterministic
    // full-scan instead, same principle as exactLookup.js.
    if (isOwnedByPersonQuestion(question)) {
      const owned = await tasksOwnedByPerson(question).catch(() => null);
      if (owned) {
        return res.json({
          success: true,
          answer: buildOwnedByPersonAnswer(owned),
          format: 'bullets',
          confidence: owned.matches.length ? 0.9 : 0.5,
          intent: 'owned-by',
          counts: { matched: owned.matches.length },
          sources: { qdrant: owned.matches.slice(0, 20).map((payload) => ({ payload })), sharepoint: {} },
        });
      }
    }
    if (isWhoWorksOnQuestion(question)) {
      const who = await whoWorksOnTopic(question).catch(() => null);
      if (who) {
        return res.json({
          success: true,
          answer: buildWhoWorksOnAnswer(who),
          format: 'prose',
          confidence: who.owners.length ? 0.9 : 0.5,
          intent: 'who-works-on',
          counts: { owners: who.owners.length, tasks: who.taskCount },
          sources: { qdrant: [{ payload: who.anchor }], sharepoint: {} },
        });
      }
    }

    // "what is the id of this task" / "task id for X" — a real, already-known fact (taskId/
    // taskCode) that had no deterministic path at all: it fell through to general retrieval, which
    // has no "return just the ID" answer shape, AND the pronoun "this task" wasn't being resolved
    // from the conversation the way meeting/exact-lookup follow-ups already are. Verified live:
    // this produced an 8-way disambiguation list including entirely unrelated candidates (a
    // "Dashboard" project, an "Add New Hardware Popup" portfolio) instead of the exact task named
    // one turn earlier in the same conversation.
    const TASK_ID_RE = /\btask\s*(id|code)\b|\b(id|code)\s+(of|for)\s+(this|that|the)?\s*task\b/i;
    if (TASK_ID_RE.test(question)) {
      const qLower = String(question).toLowerCase();
      const allTasksForId = await scrollPayloads({ types: ['task'], limit: 30000 }).catch(() => []);
      let idTask = null;
      for (const t of allTasksForId) {
        const title = String(t.title || '').trim();
        if (title.length < 8 || !qLower.includes(title.toLowerCase())) continue;
        if (!idTask || title.length > String(idTask.title || '').length) idTask = t;
      }
      // Not named in THIS question — resolve "this task" from the conversation, same shared
      // resolver used for "that meeting"/"it" follow-ups elsewhere.
      if (!idTask && convo) {
        idTask = await resolveReferencedTopic(convo, question, ['task']).catch(() => null);
      }
      if (idTask) {
        const id = idTask.taskCode || (idTask.taskId != null ? String(idTask.taskId) : null);
        const answer = id
          ? `The ID of "${idTask.title}" is ${id}.`
          : `"${idTask.title}" doesn't have a recorded task ID/code in the indexed data.`;
        return res.json({
          success: true,
          answer,
          format: 'prose',
          confidence: id ? 0.95 : 0.5,
          intent: 'task-id',
          sources: { qdrant: [{ payload: idTask }], sharepoint: {} },
        });
      }
    }

    // Follow-up about a specific meeting from the conversation ("what was discussed in that meeting?",
    // "who were the participants?") → answer from THAT meeting's full record, not a broad search.
    // Also: a bare exact meeting title with no context at all — SharePoint can have a meeting and
    // an unrelated task sharing an identical title, so this routes straight to the real meeting
    // instead of letting the type-agnostic general search possibly answer from the wrong record.
    const exactTitleMeeting = await resolveExactMeetingTitle(question).catch(() => null);
    // "tell me about the meeting with Stefan" — not a bare exact title (extra words), not a
    // conversational follow-up (no prior convo needed), but a real meeting's title IS embedded in
    // the question. Confirmed by testing: real data has a MEETING, a PORTFOLIO item, and several
    // TASKS all titled ~"Meeting with Stefan" — the general type-agnostic search pulled in the
    // portfolio/task records instead of the actual meeting (0 of its evidence was the real
    // meeting). Reusing resolveReferencedTopic against the question's OWN text (not conversation
    // history) catches this: it finds the real meeting title as a substring of the question.
    const embeddedTitleMeeting =
      !exactTitleMeeting && /\bmeetings?\b/i.test(question)
        ? await resolveReferencedTopic(question, question, ['meeting']).catch(() => null)
        : null;
    // "summarize the scrum 25/06/2026 meeting" — a literal calendar date names a real meeting even
    // when the natural phrasing doesn't contain the real title verbatim (real titles are formatted
    // "SCRUM - 25/06/2026"). See resolveMeetingByExplicitDate's comment for the full root cause.
    const explicitDateMeeting =
      !exactTitleMeeting && !embeddedTitleMeeting
        ? await resolveMeetingByExplicitDate(question).catch(() => null)
        : null;
    if (exactTitleMeeting || embeddedTitleMeeting || explicitDateMeeting || (convo && isMeetingDetailFollowup(question))) {
      const meeting =
        exactTitleMeeting ||
        embeddedTitleMeeting ||
        explicitDateMeeting ||
        (await resolveReferencedMeeting(convo, question).catch(() => null));
      if (meeting) {
        const meetingPrompt = await buildMeetingDetailPrompt(question, meeting, presentationFormat);
        let answer =
          sanitizeEnterpriseAnswer(
            await generateAnswer(withHistory(meetingPrompt), opts),
            question,
            Boolean(presentationFormat)
          ) || INSUFFICIENT_DATA_MESSAGE;
        // Guarantee real line breaks: qwen3 often ignores "write bullets" and writes one flowing
        // paragraph instead — deterministic post-process, same principle as formatRows() elsewhere.
        if ((presentationFormat === 'bullets' || presentationFormat === 'timeline') && answer !== INSUFFICIENT_DATA_MESSAGE) {
          answer = forceBulletLines(answer);
        }
        return res.json({
          success: true,
          answer,
          format: presentationFormat || 'prose',
          confidence: 0.9,
          intent: 'meeting-detail',
          sources: { qdrant: [{ payload: meeting }], sharepoint: {} },
        });
      }
    }

    // Date-aware meeting questions ("meetings today", "latest meeting", "yesterday's scrum")
    // → filter/sort meeting points by their real start date, not flat vector search.
    if (isMeetingDateQuestion(question)) {
      const result = await meetingDateRetrieve(question).catch(() => null);
      if (result) {
        // Deterministic, not LLM-narrated: the date range and matching list are already fully
        // known facts, and a local model was observed hallucinating "no meetings today" for a
        // "yesterday" question despite correct evidence — see buildMeetingDateAnswer's comment.
        const formatted = presentationFormat
          ? formatRows(presentationFormat, result.meetings)
          : buildMeetingDateAnswer(result);
        const answer = formatted || INSUFFICIENT_DATA_MESSAGE;
        return res.json({
          success: true,
          answer,
          format: presentationFormat || 'bullets',
          confidence: result.meetings.length ? 0.9 : 0,
          intent: 'meeting-date',
          counts: { meetings: result.meetings.length, range: result.range?.label || 'latest' },
          sources: {
            qdrant: result.meetings.slice(0, 10).map((payload) => ({ payload })),
            sharepoint: {},
          },
        });
      }
    }

    // Exact/verbatim lookup ("comments on X", "feedback for X", "what does X say") → deterministic
    // substring match over ALL records, returning the RAW stored text with no LLM in the loop —
    // so the answer is exactly what's in the record, not a paraphrase from top-K vector search.
    if (isExactLookupQuestion(question)) {
      let phrase = extractLookupPhrase(question);
      if (!phrase && convo) {
        phrase = await resolveReferencedEntity(convo, question).catch(() => null);
      }
      if (phrase) {
        const rows = await exactLookup({ phrase }).catch(() => []);
        if (rows.length) {
          // Table/timeline requests get the shared formatter; bullets (or no format) keep
          // exactLookup's own verbatim rendering (title + raw description on its own line).
          const formatted =
            presentationFormat === 'table' || presentationFormat === 'timeline'
              ? formatRows(presentationFormat, rows)
              : null;
          return res.json({
            success: true,
            answer: formatted || buildRawAnswer(rows),
            format: formatted ? presentationFormat : 'bullets',
            confidence: 0.95,
            intent: 'exact-lookup',
            counts: { matched: rows.length },
            sources: {
              qdrant: rows.slice(0, 20).map((payload) => ({ payload })),
              sharepoint: {},
            },
          });
        }
      }
    }

    // "Latest / recent work on X" for tasks & projects.
    if (isRecentWorkQuestion(question)) {
      // A bare-pronoun follow-up ("what's the latest task UNDER IT") names no topic of its own —
      // vector search on "it"/generic filler alone can resolve to a totally unrelated project. The
      // ONE shared resolver (used by meeting and exact-lookup follow-ups too) finds what "it"
      // actually refers to from the conversation; only used when the question truly has no
      // distinguishing words of its own, so a fresh unrelated question in the same conversation
      // isn't wrongly pinned to whatever was discussed earlier.
      const pronounAnchor =
        convo && isPronounFollowup(question)
          ? await resolveReferencedTopic(convo, question, ['portfolio', 'project']).catch(() => null)
          : null;

      // Prefer resolving ONE real project/portfolio anchor and walking its actual descendant tree
      // (same approach as the hierarchy branch below) over broad topic-keyword matching. Real data
      // can have 100+ items loosely sharing generic words ("team", "management"), spanning dozens
      // of genuinely unrelated projects — that's a real recall problem, not real ambiguity, and it
      // was surfacing as a confusing "8 different items, which did you mean?" for a question that
      // named ONE specific project. Only fall back to the broader matching below when no single
      // anchor resolves (e.g. the question doesn't actually name one real project/portfolio).
      const structural = await structuralRetrieve(question, { anchorOverride: pronounAnchor }).catch(() => null);
      if (structural?.ambiguous) {
        return res.json({
          success: true,
          answer: buildDisambiguationAnswer(structural.candidates),
          format: 'bullets',
          confidence: 0,
          intent: 'disambiguation',
          suggestions: buildDisambiguationSuggestions(structural.candidates),
          sources: { qdrant: structural.candidates.map((payload) => ({ payload })), sharepoint: {} },
        });
      }
      if (structural && (structural.masters.length > 1 || structural.tasks.length > 0)) {
        const answer =
          sanitizeEnterpriseAnswer(
            await generateAnswer(buildStructuralPrompt(question, structural), opts),
            question
          ) || INSUFFICIENT_DATA_MESSAGE;
        return res.json({
          success: true,
          answer,
          format: 'prose',
          confidence: 0.9,
          intent: 'recent-work',
          counts: { subItems: structural.masters.length - 1, tasks: structural.tasks.length },
          sources: {
            qdrant: structural.masters.slice(0, 10).map((payload) => ({ payload })),
            sharepoint: {},
          },
        });
      }

      // If the pronoun resolved to a real anchor above but the tree walk found too little to be
      // worth returning on its own, still search using the RESOLVED name, not the bare pronoun.
      const topicText = pronounAnchor
        ? pronounAnchor.title
        : recentContext
          ? `${recentContext}\n${question}`
          : question;
      const recent = await recentWorkRetrieve(topicText).catch(() => null);
      if (recent?.ambiguous) {
        return res.json({
          success: true,
          answer: buildDisambiguationAnswer(recent.candidates),
          format: 'bullets',
          confidence: 0,
          intent: 'disambiguation',
          suggestions: buildDisambiguationSuggestions(recent.candidates),
          sources: {
            qdrant: recent.candidates.map((payload) => ({ payload })),
            sharepoint: {},
          },
        });
      }
      if (recent && recent.items.length) {
        // No withHistory here on purpose: the newest-first list is authoritative, and stale prior
        // answers in the history make the model repeat an older "latest task".
        const formatted = presentationFormat ? formatRows(presentationFormat, recent.items) : null;
        const answer =
          formatted ||
          sanitizeEnterpriseAnswer(
            await generateAnswer(buildRecentWorkPrompt(question, recent), opts),
            question
          ) ||
          INSUFFICIENT_DATA_MESSAGE;
        return res.json({
          success: true,
          answer,
          format: formatted ? presentationFormat : 'prose',
          confidence: 0.9,
          intent: 'recent-work',
          counts: { matched: recent.items.length },
          sources: {
            qdrant: recent.items.slice(0, 10).map((payload) => ({ payload })),
            sharepoint: {},
          },
        });
      }
    }

    // Structural questions ("what's under X", "structure of X") → walk the tree by ID,
    // not flat vector search. Falls through to normal retrieval if nothing structural found.
    if (isHierarchyQuestion(question)) {
      // Same bare-pronoun handling as the recent-work branch above ("what's under it") — reuse
      // the resolved anchor if this question has no real topic of its own.
      const hierarchyAnchor =
        convo && isPronounFollowup(question)
          ? await resolveReferencedTopic(convo, question, ['portfolio', 'project']).catch(() => null)
          : null;
      const structural = await structuralRetrieve(question, { anchorOverride: hierarchyAnchor }).catch(() => null);
      if (structural?.ambiguous) {
        return res.json({
          success: true,
          answer: buildDisambiguationAnswer(structural.candidates),
          format: 'bullets',
          confidence: 0,
          intent: 'disambiguation',
          suggestions: buildDisambiguationSuggestions(structural.candidates),
          sources: { qdrant: structural.candidates.map((payload) => ({ payload })), sharepoint: {} },
        });
      }
      if (structural && (structural.masters.length > 1 || structural.tasks.length)) {
        const formatted = presentationFormat
          ? formatRows(presentationFormat, [...structural.masters, ...structural.tasks])
          : null;
        const answer =
          formatted ||
          sanitizeEnterpriseAnswer(
            await generateAnswer(withHistory(buildStructuralPrompt(question, structural)), opts),
            question
          ) ||
          INSUFFICIENT_DATA_MESSAGE;
        return res.json({
          success: true,
          answer,
          format: formatted ? presentationFormat : 'prose',
          confidence: 0.9,
          intent: 'hierarchy',
          counts: {
            subItems: structural.masters.length - 1,
            tasks: structural.tasks.length,
          },
          sources: {
            qdrant: structural.masters.slice(0, 10).map((payload) => ({ payload })),
            sharepoint: {},
          },
        });
      }
    }

    const retrieval = await hybridRetrieve(retrievalQuestion, {
      limit: wantsRecent ? 24 : Math.max(Number(limit) || 8, 10),
    });

    const { intent, results, confidence, meta } = retrieval;

    // The user (or a disambiguation chip they clicked) named a real item exactly — that beats
    // any confidence score. Without this, clicking a candidate from OUR OWN disambiguation list
    // could re-trigger a second, unrelated round of disambiguation instead of just answering.
    const qNorm = normalizeText(question);
    let exactMatch = qNorm
      ? results.find((r) => {
          const p = r.payload || r;
          const t = normalizeText(p.title || p.projectName || '');
          return t && t === qNorm;
        })
      : null;

    // Below this, retrieval found essentially nothing meaningful (e.g. 0.08) — real matches from
    // deliberate keyword+vector overlap score well above it. The enterprise prompt is instructed
    // to always write a confident-sounding summary once it clears this gate, so letting
    // noise-level matches through means a fabricated-feeling answer about the wrong thing.
    // Checked regardless of `convo`: a numeric floor doesn't share the keyword gate's follow-up
    // brittleness, so there's no reason to skip it just because this is mid-conversation.
    const CONFIDENCE_FLOOR = 0.25;
    const lowConfidence = confidence < CONFIDENCE_FLOOR;

    // The keyword guard is brittle for follow-ups (short/pronoun questions, paraphrases), so with
    // conversation history we trust vector retrieval + the LLM's own "insufficient" rule instead.
    if (!exactMatch && (!results.length || (!convo && !evidenceMatchesQuestion(question, results)) || lowConfidence)) {
      // Last resort before giving up: hybridRetrieve's top-K vector/BM25 search can simply miss
      // an exact real title (e.g. clicking a candidate from OUR OWN disambiguation list, whose
      // title didn't rank highly enough to make the top-K). A full-collection check, same as
      // recentWork's, catches it. Only paid on the failure path, not on every query.
      if (qNorm) {
        const allEntities = await scrollPayloads({ types: ['portfolio', 'project', 'task'], limit: 30000 }).catch(() => []);
        let hit = allEntities.find((p) => normalizeText(p.title || '') === qNorm);
        // Tested live: "what is the status of Bug - Cancel button not working of smart favorite
        // popup" (a real, exact title with a natural question wrapped around it) still fell
        // through to disambiguation, because the check above requires the WHOLE question to equal
        // the title — it only ever caught bare-title-only questions. Fall back to "the real title
        // appears verbatim inside the question", same principle as the meeting embedded-title fix
        // above; require length >= 8 for the same reason (avoid short generic titles colliding
        // with ordinary phrasing) and prefer the LONGEST embedded match if more than one qualifies.
        if (!hit) {
          const qLower = String(question).toLowerCase();
          for (const p of allEntities) {
            const t = String(p.title || '').trim();
            if (t.length < 8 || !qLower.includes(t.toLowerCase())) continue;
            if (!hit || t.length > String(hit.title || '').length) hit = p;
          }
        }
        if (hit) exactMatch = hit;
      }
    }

    if (!exactMatch && (!results.length || (!convo && !evidenceMatchesQuestion(question, results)) || lowConfidence)) {
      // Before giving up: several distinct real entities loosely matched (same "which Team
      // Management Tool?" problem as recent-work) rather than nothing relevant existing at all.
      const groups = plausibleGroups(groupByEntity(results.map((r) => r.payload || r)), question);
      if (groups.length > 1) {
        const candidates = toCandidates(groups);
        return res.json({
          success: true,
          answer: buildDisambiguationAnswer(candidates),
          format: 'bullets',
          confidence: 0,
          intent: 'disambiguation',
          suggestions: buildDisambiguationSuggestions(candidates),
          sources: { qdrant: candidates.map((payload) => ({ payload })), sharepoint: {} },
        });
      }
      return res.json({
        success: true,
        answer: INSUFFICIENT_DATA_MESSAGE,
        format: 'prose',
        confidence: 0,
        intent: intent.intent,
        sources: { qdrant: [], sharepoint: {} },
      });
    }

    const relevantResults = convo ? results : filterResultsByQuestion(question, results);
    let resultsForLlm = relevantResults.length ? relevantResults : results;
    if (wantsRecent) {
      // Surface the newest work first (retrieval ranks by relevance only, ignoring date).
      resultsForLlm = [...resultsForLlm].sort((a, b) => tsMs(b) - tsMs(a));
    }
    if (exactMatch) {
      // Named exactly — put it first so it's what the LLM actually writes about, not just one
      // of several loosely-relevant records competing for attention.
      resultsForLlm = [exactMatch, ...resultsForLlm.filter((r) => r !== exactMatch)];
    }
    const contextPack = buildContextPack(intent, resultsForLlm);

    // "as a table" / "in bullet points" / "chronologically" → render the retrieved records
    // deterministically and skip the LLM summarizer entirely.
    const formattedAnswer = presentationFormat
      ? formatRows(presentationFormat, resultsForLlm.map((r) => r.payload || r))
      : null;

    const sharepointResult = formattedAnswer
      ? { data: {} }
      : await queryStructuredData(question, resultsForLlm);
    const sharepointData = sharepointResult.data || {};

    let answer = formattedAnswer;
    if (!answer) {
      // Ollama is the brain: LLM writes every answer from retrieved evidence + aggregated facts,
      // plus the recent conversation so it can resolve follow-ups.
      const messages = withHistory(buildEnterpriseMessages({
        userQuestion: question,
        qdrantContext: resultsForLlm.slice(0, 12),
        contextPack,
        recency: wantsRecent,
      }));
      answer = sanitizeEnterpriseAnswer(await generateAnswer(messages, opts), question);
    }

    if (!answer) {
      answer = INSUFFICIENT_DATA_MESSAGE;
    }

    res.json({
      success: true,
      answer,
      format: formattedAnswer ? presentationFormat : 'prose',
      // An exact title match overrides retrieval's own (possibly low) top-K score — the answer
      // isn't a guess anymore once we've found the literal named record, so it shouldn't display
      // as low-confidence.
      confidence: exactMatch ? Math.max(confidence, 0.9) : confidence,
      intent: intent.intent,
      contextPack,
      retrievalMeta: meta,
      sources: {
        qdrant: resultsForLlm,
        sharepoint: sharepointData,
      },
    });
  } catch (err) {
    if (res.writableEnded || abortController.signal.aborted) return; // client stopped/disconnected
    console.error('Query error:', err.message);
    const msg = String(err.message || err);
    const status =
      msg.includes('429') || msg.includes('quota')
        ? 429
        : msg.includes('inference provider')
          ? 503
          : 500;
    res.status(status).json({
      success: false,
      error: msg,
      hint:
        status === 429
          ? 'Gemini quota exceeded. Wait ~1 min or use Ollama locally.'
          : undefined,
    });
  }
});

export default router;
