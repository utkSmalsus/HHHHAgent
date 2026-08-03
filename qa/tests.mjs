// Regression test definitions. Each test is either standalone or part of a named "thread"
// (conversation) where history carries over between tests sharing the same thread id.
// `expected` is a human-written ground-truth note derived directly from real Qdrant data
// (gathered via direct scrollPayloads queries before writing these), used for manual scoring —
// not fed to the agent.
export const tests = [
  // ===== Phase 4: Meetings =====
  { id: 'M1', category: 'meetings', thread: null, q: 'what meetings happened this week',
    expected: 'Deterministic list of meetings within the current week range; must not claim "no meetings today" incorrectly, must use real dates.' },
  { id: 'M2', category: 'meetings', thread: 'stefan', q: 'tell me about the meeting with Stefan',
    expected: 'Real summary: 2-hour discussion Stefan Hochhuth + Deepak Trivedi, July 8 2026. Topics: PM/SAP data, URL validation bug, GitHub code review, Web Studio/Lovable migration, design tokens, permissions, SPA framework, meeting-tool automation, portfolio interlinking, GitHub structure, team accountability.' },
  { id: 'M3', category: 'meetings', thread: 'stefan', q: 'who attended that meeting',
    expected: 'Participants: Deepak Trivedi (and Stefan as organizer/creator).' },
  { id: 'M4', category: 'meetings', thread: 'stefan', q: 'what blockers were discussed in it',
    expected: 'Missing design-token framework, unconfirmed PM column deployment, URL validation bugs, unclear Lovable/SPFX data branches, undefined role model, meeting-tool task generation failures.' },
  { id: 'M5', category: 'meetings', thread: null, q: 'summarize the scrum 25/06/2026 meeting',
    expected: 'Real summary grounded in the actual 147,749-char transcript for that specific date — must not confuse with a different Scrum date.' },
  { id: 'M6', category: 'meetings', thread: null, q: 'which meeting discussed GitHub code review',
    expected: '"Meeting with Stefan" (2026-07-08) covers "AI-Assisted GitHub Code Review and Systematic QA" as a major discussion area.' },
  { id: 'M7', category: 'meetings', thread: null, q: 'how many meetings have we had',
    expected: 'Real count = 144 meeting records in the KB.' },
  { id: 'M8', category: 'meetings', thread: null, q: 'what meetings happened today',
    expected: 'Deterministic, date-correct — must say "today" not confuse with yesterday (regression check for the earlier fixed bug).' },

  // ===== Phase 5: Projects =====
  { id: 'P1', category: 'projects', thread: null, q: 'what is Dashboard - Webparts',
    expected: 'Real project under portfolio path "Dashboard > Dashboard - Webparts" — answer should describe it using only real evidence, no invented details.' },
  { id: 'P2', category: 'projects', thread: null, q: "what's under SmartFilters portfolio",
    expected: 'Real hierarchy: "SmartFilters > SharePoint Framework - SPFx Issues and Bug fixing > SmartFilters- SPFx Issues and Bug fixing" and sibling projects/tasks — should list real sub-items, not invent any.' },
  { id: 'P3', category: 'projects', thread: null, q: 'how many projects do we have',
    expected: 'Real count = 746 project records in the KB.' },
  { id: 'P4', category: 'projects', thread: null, q: 'how many portfolio items do we have',
    expected: 'Real count = 2666 portfolio records in the KB.' },

  // ===== Phase 6: Tasks =====
  { id: 'T1', category: 'tasks', thread: null, q: 'what is the status of Bug - Cancel button not working of smart favorite popup',
    expected: 'Real: Status "Task completed", Completion 90%.' },
  { id: 'T2', category: 'tasks', thread: null, q: 'how many tasks do we have',
    expected: 'Real count = 14167 task records in the KB. KEY TEST for dead-code finding (formatDeterministicAnswer never wired in) — local LLM must count/estimate this itself.' },
  { id: 'T3', category: 'tasks', thread: null, q: 'which tasks belong to Deepak Trivedi',
    expected: 'Real: 1035 task records have "Owner: Deepak Trivedi" in text — answer should list some real ones (e.g. "Bug- Component portfolio", "Bug - Task Profile Page") not invented ones.' },
  { id: 'T4', category: 'tasks', thread: null, q: 'which tasks are overdue',
    expected: 'FIXED THIS PASS: DueDate is a real SharePoint field (confirmed against the SPFx app source) that was never ingested — now ingested (hierarchyIngest.js), answer should deterministically list real tasks whose DueDate has passed and whose status is not a done-state (see query.js DONE_RE), with an exact count matching a direct Qdrant scroll.' },
  { id: 'T5', category: 'tasks', thread: null, q: 'show me tasks as a table',
    expected: 'Deterministic markdown table format (format:"table" in response), real task rows.' },

  // ===== Phase 7: Comments =====
  { id: 'C1', category: 'comments', thread: null, q: 'what are the comments on Bug - Cancel button not working of smart favorite popup',
    expected: 'EXACT VERBATIM: \'Cancel button doesn\'t work in "Add Smart Favorite popup". Callback functionality was breaking due to which it was not closing.\' — must be byte-exact, no paraphrase.' },
  { id: 'C2', category: 'comments', thread: null, q: 'show me feedback on Bug - Cancel button not working of smart favorite popup',
    expected: 'Same exact record/content as C1 via the exact-lookup path.' },

  // ===== Phase 8: Team =====
  { id: 'TM1', category: 'team', thread: null, q: 'who is working on SmartFilters',
    expected: 'Real owners from SmartFilters-related task records — must be real names present in the data, not invented.' },
  { id: 'TM2', category: 'team', thread: null, q: 'who has the highest workload',
    expected: 'MISSING-CAPABILITY TEST: no workload-aggregation feature exists — correct behavior is to decline/say this isn\'t something it can compute, not fabricate a ranking.' },

  // ===== Phase 3: Multi-turn / disambiguation / reformat / pronoun follow-up =====
  { id: 'MT1', category: 'multiturn', thread: 'ambig', q: 'latest update on team management tool project',
    expected: 'Real data has 20+ similarly-named "Team Management ..." projects — correct behavior is disambiguation (a list of real candidates), NOT a silently-picked single wrong answer.' },
  { id: 'MT2', category: 'multiturn', thread: 'reformat', q: 'what is the status of Bug - Cancel button not working of smart favorite popup',
    expected: 'Same as T1 — Task completed, 90%.' },
  { id: 'MT3', category: 'multiturn', thread: 'reformat', q: 'show that as a table',
    expected: 'PURE REFORMAT TEST: must re-run retrieval for the PREVIOUS question (the cancel-button task) and render it as a table — not fail with "couldn\'t find anything matching that".' },
  { id: 'MT4', category: 'multiturn', thread: 'pronoun', q: 'what is SmartFilters portfolio',
    expected: 'Real portfolio info about SmartFilters.' },
  { id: 'MT5', category: 'multiturn', thread: 'pronoun', q: "what's under it",
    expected: 'PRONOUN FOLLOW-UP TEST: "it" must resolve to SmartFilters (the portfolio just discussed), not drift to an unrelated project.' },

  // ===== Edge / negative cases =====
  { id: 'E1', category: 'edge', thread: null, q: 'what is the status of Project Zorbotron 9000',
    expected: 'Fabricated entity that does not exist — must decline/say no match, NOT hallucinate a status for a nonexistent project.' },
  { id: 'E2', category: 'edge', thread: null, q: 'what is 2 plus 2',
    expected: 'Off-topic (outside the KB scope) — must decline per the KB-only scope design, not answer "4" from general knowledge.' },
  { id: 'E3', category: 'edge', thread: null, q: 'asdkjfh qwoeiur',
    expected: 'Gibberish input — must decline gracefully, not crash or hallucinate.' },
  { id: 'E4', category: 'edge', thread: null, q: 'AIS Conversion to MS Teams App',
    expected: 'REGRESSION CHECK: bare exact real project title (from earlier-verified fix) — must answer directly, not disambiguate.' },
];

export const threads = [...new Set(tests.map((t) => t.thread).filter(Boolean))];
