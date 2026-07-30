import { Router } from 'express';
import { generateAnswer } from '../services/ai.js';
import { buildContextPack } from '../services/contextPack.js';
import { hybridRetrieve } from '../services/hybridSearch.js';
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
  buildMeetingDatePrompt,
  isMeetingDetailFollowup,
  resolveReferencedMeeting,
  buildMeetingDetailPrompt,
} from '../services/meetingQuery.js';
import {
  isRecentWorkQuestion,
  recentWorkRetrieve,
  buildRecentWorkPrompt,
} from '../services/recentWork.js';

const router = Router();

/** Minimal self-contained chat UI — talks to POST /api/query */
router.get('/ui', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>OMT AI Agent</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; margin: 0; height: 100vh; display: flex; flex-direction: column; background: #f8fafc; color: #0f172a; }
    header { padding: 0.9rem 1rem; background: #1e293b; color: #fff; font-weight: 600; display: flex; align-items: center; justify-content: space-between; }
    header a, header .newchat { background: #2563eb; color: #fff; text-decoration: none; font-size: 0.85rem; font-weight: 500; padding: 0.4rem 0.8rem; border-radius: 6px; border: 0; cursor: pointer; }
    header .newchat { background: #334155; margin-right: 0.5rem; }
    header .actions { display: flex; align-items: center; }
    #log { flex: 1; overflow-y: auto; padding: 1rem; display: flex; flex-direction: column; gap: 0.75rem; }
    .msg { max-width: 80%; padding: 0.7rem 0.9rem; border-radius: 12px; white-space: pre-wrap; line-height: 1.45; overflow-wrap: anywhere; }
    .user { align-self: flex-end; background: #2563eb; color: #fff; border-bottom-right-radius: 3px; }
    .bot { align-self: flex-start; background: #fff; color: #0f172a; border: 1px solid #e2e8f0; border-bottom-left-radius: 3px; }
    .bot.loading { color: #475569; font-style: italic; }
    .meta { font-size: 0.72rem; color: #64748b; margin-top: 0.35rem; }
    form { display: flex; gap: 0.5rem; padding: 0.75rem 1rem; border-top: 1px solid #e2e8f0; background: #fff; align-items: center; }
    input { flex: 1; padding: 0.7rem 0.9rem; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 1rem; }
    input[type=file] { display: none; }
    button { padding: 0.7rem 1.2rem; border: 0; border-radius: 8px; background: #2563eb; color: #fff; font-size: 1rem; cursor: pointer; }
    .attach { padding: 0.7rem 0.9rem; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; color: #334155; cursor: pointer; white-space: nowrap; }
    .attach.has-file { border-color: #2563eb; color: #2563eb; background: #eff6ff; }
    button:disabled { opacity: 0.5; cursor: default; }
  </style>
</head>
<body>
  <header><span>OMT AI Agent</span><span class="actions"><button class="newchat" id="newchat" type="button">New Chat</button><a href="/api/ingest/progress/ui">Backup</a></span></header>
  <div id="log"></div>
  <form id="f">
    <label class="attach" id="attachLabel" for="file">Attach</label>
    <input id="file" type="file" accept=".pdf,.docx,.txt,application/pdf,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document"/>
    <input id="q" placeholder="Ask about projects, tasks, meetings…" autocomplete="off" autofocus/>
    <button id="send" type="submit">Send</button>
  </form>
  <script>
    const log = document.getElementById('log');
    const form = document.getElementById('f');
    const input = document.getElementById('q');
    const file = document.getElementById('file');
    const attachLabel = document.getElementById('attachLabel');
    const send = document.getElementById('send');

    const MAX = 20; // keep last 20 messages; 21st added → oldest dropped, stays 20
    let history = [];
    try { history = JSON.parse(localStorage.getItem('omt_chat') || '[]'); } catch (e) { history = []; }
    function save() {
      history = history.slice(-MAX);
      localStorage.setItem('omt_chat', JSON.stringify(history));
    }

    function render(text, cls, meta) {
      const el = document.createElement('div');
      el.className = 'msg ' + cls;
      el.textContent = text;
      if (meta) { const m = document.createElement('div'); m.className = 'meta'; m.textContent = meta; el.appendChild(m); }
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
      return el;
    }

    function cleanDisplayText(text) {
      return String(text || '')
        .replace(/\\r/g, '\\n')
        .replace(/[ \\t]+\\n/g, '\\n')
        .replace(/\\n{3,}/g, '\\n\\n')
        .trim();
    }

    file.addEventListener('change', () => {
      const picked = file.files[0];
      attachLabel.textContent = picked ? picked.name.slice(0, 24) : 'Attach';
      attachLabel.classList.toggle('has-file', Boolean(picked));
      input.placeholder = picked ? 'Optional note for this transcript…' : 'Ask about projects, tasks, meetings…';
      input.focus();
    });

    // Restore saved conversation on load.
    history.forEach((m) => render(m.text, m.role === 'user' ? 'user' : 'bot', m.meta));

    // New Chat: wipe history + context and start fresh.
    document.getElementById('newchat').addEventListener('click', () => {
      history = [];
      localStorage.removeItem('omt_chat');
      log.innerHTML = '';
      input.focus();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const question = input.value.trim();
      const pickedFile = file.files[0];
      if (!question && !pickedFile) return;
      const priorHistory = history.slice(-10); // conversation so far, before this question
      const shownUserText = pickedFile
        ? 'Uploaded transcript: ' + pickedFile.name + (question ? '\\n' + question : '')
        : question;
      render(shownUserText, 'user');
      history.push({ role: 'user', text: shownUserText }); save();
      input.value = '';
      send.disabled = true;
      const thinking = render(pickedFile ? 'Analyzing transcript…' : 'Thinking…', 'bot loading'); // transient, not saved until answered
      try {
        let r;
        if (pickedFile) {
          const fd = new FormData();
          fd.append('file', pickedFile);
          r = await fetch('/api/meetings/analyze', { method: 'POST', body: fd });
        } else {
          r = await fetch('/api/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question, history: priorHistory }),
          });
        }
        const data = await r.json();
        if (data.success) {
          const srcCount = pickedFile
            ? ((data.sources?.meetings || []).length + (data.sources?.tasks || []).length)
            : (data.sources?.qdrant || []).length;
          const text = cleanDisplayText(data.answer) || '(no answer)';
          const meta = pickedFile
            ? 'transcript analysis · ' + (data.retrieved?.meetings || 0) + ' meeting sources · ' + (data.retrieved?.tasks || 0) + ' task sources'
            : 'intent: ' + (data.intent || '?') + ' · confidence: ' + (data.confidence ?? '?') + ' · ' + srcCount + ' sources';
          thinking.textContent = text;
          thinking.classList.remove('loading');
          const m = document.createElement('div'); m.className = 'meta'; m.textContent = meta; thinking.appendChild(m);
          history.push({ role: 'bot', text, meta }); save();
          if (pickedFile) {
            file.value = '';
            attachLabel.textContent = 'Attach';
            attachLabel.classList.remove('has-file');
            input.placeholder = 'Ask about projects, tasks, meetings…';
          }
        } else {
          const text = 'Error: ' + (data.error || 'unknown');
          thinking.textContent = text;
          thinking.classList.remove('loading');
          history.push({ role: 'bot', text }); save();
        }
      } catch (err) {
        thinking.textContent = 'Request failed: ' + err.message;
        thinking.classList.remove('loading');
      } finally {
        send.disabled = false;
        input.focus();
      }
    });
  </script>
</body>
</html>`);
});

router.post('/', async (req, res) => {
  try {
    const { question, limit = 8, history = [] } = req.body;

    if (!question) {
      return res.status(400).json({ success: false, error: 'question is required' });
    }

    // Conversation memory: recent turns the client sent (last ~8, capped for prompt size).
    const priorTurns = (Array.isArray(history) ? history : [])
      .filter((m) => m && m.text)
      .slice(-8);
    const convo = priorTurns
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.text).slice(0, 500)}`)
      .join('\n');
    // Follow-ups ("who were the participants?", "what was discussed in that meeting?") retrieve
    // better with the previous turns prepended — the entity name (e.g. "Scrum 30/07/2026") is
    // usually in the ASSISTANT's last answer, not the user's words.
    const recentContext = priorTurns
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
    if (words.length <= 1 || GREETING_PHRASES.has(norm)) {
      // Let the LLM reply conversationally — but no KB retrieval, so it can't dump data.
      const greetingReply = await generateAnswer(withHistory({
        system:
          'You are the OMT knowledge agent, a friendly assistant for a project-management knowledge base. ' +
          'Reply to the user\'s greeting or small talk in 1-2 short, warm sentences. ' +
          'Do NOT invent any project, task, or people data. ' +
          'Briefly invite them to ask about their portfolio, projects, or tasks.',
        user: String(question).trim(),
      })).catch(() => null);
      return res.json({
        success: true,
        answer:
          greetingReply ||
          "Hi! I'm the OMT knowledge agent — ask me about your portfolio, projects, or tasks.",
        confidence: 1,
        intent: 'greeting',
        sources: { qdrant: [], sharepoint: {} },
      });
    }

    // Follow-up about a specific meeting from the conversation ("what was discussed in that meeting?",
    // "who were the participants?") → answer from THAT meeting's full record, not a broad search.
    if (convo && isMeetingDetailFollowup(question)) {
      const meeting = await resolveReferencedMeeting(convo).catch(() => null);
      if (meeting) {
        const answer =
          sanitizeEnterpriseAnswer(
            await generateAnswer(withHistory(buildMeetingDetailPrompt(question, meeting))),
            question
          ) || INSUFFICIENT_DATA_MESSAGE;
        return res.json({
          success: true,
          answer,
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
        const answer =
          sanitizeEnterpriseAnswer(
            await generateAnswer(withHistory(buildMeetingDatePrompt(question, result))),
            question
          ) || INSUFFICIENT_DATA_MESSAGE;
        return res.json({
          success: true,
          answer,
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

    // "Latest / recent work on X" for tasks & projects → keyword-match ALL items on the topic,
    // then sort by real updated date (relevance-only vector search misses the genuinely newest).
    if (isRecentWorkQuestion(question)) {
      const topicText = recentContext ? `${recentContext}\n${question}` : question;
      const recent = await recentWorkRetrieve(topicText).catch(() => null);
      if (recent && recent.items.length) {
        // No withHistory here on purpose: the newest-first list is authoritative, and stale prior
        // answers in the history make the model repeat an older "latest task".
        const answer =
          sanitizeEnterpriseAnswer(
            await generateAnswer(buildRecentWorkPrompt(question, recent)),
            question
          ) || INSUFFICIENT_DATA_MESSAGE;
        return res.json({
          success: true,
          answer,
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
      const structural = await structuralRetrieve(question).catch(() => null);
      if (structural && (structural.masters.length > 1 || structural.tasks.length)) {
        const answer =
          sanitizeEnterpriseAnswer(
            await generateAnswer(withHistory(buildStructuralPrompt(question, structural))),
            question
          ) || INSUFFICIENT_DATA_MESSAGE;
        return res.json({
          success: true,
          answer,
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

    // The keyword guard is brittle for follow-ups (short/pronoun questions, paraphrases), so with
    // conversation history we trust vector retrieval + the LLM's own "insufficient" rule instead.
    if (!results.length || (!convo && !evidenceMatchesQuestion(question, results))) {
      return res.json({
        success: true,
        answer: INSUFFICIENT_DATA_MESSAGE,
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
    const contextPack = buildContextPack(intent, resultsForLlm);

    const sharepointResult = await queryStructuredData(question, resultsForLlm);
    const sharepointData = sharepointResult.data || {};

    // Ollama is the brain: LLM writes every answer from retrieved evidence + aggregated facts,
    // plus the recent conversation so it can resolve follow-ups.
    const messages = withHistory(buildEnterpriseMessages({
      userQuestion: question,
      qdrantContext: resultsForLlm.slice(0, 12),
      contextPack,
      recency: wantsRecent,
    }));
    let answer = sanitizeEnterpriseAnswer(await generateAnswer(messages), question);

    if (!answer) {
      answer = INSUFFICIENT_DATA_MESSAGE;
    }

    res.json({
      success: true,
      answer,
      confidence,
      intent: intent.intent,
      contextPack,
      retrievalMeta: meta,
      sources: {
        qdrant: resultsForLlm,
        sharepoint: sharepointData,
      },
    });
  } catch (err) {
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
