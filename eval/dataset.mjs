/**
 * RAG retrieval evaluation dataset — 42 cases built from REAL records in this Qdrant collection.
 *
 * Ground truth is expressed as a CONTENT MARKER (a literal string that must appear in the target
 * record/chunk), not a hardcoded chunk index — the harness resolves the marker against live data
 * and fails loudly if it no longer matches, so the dataset can't silently rot after a re-ingest.
 *
 * expect forms:
 *   { meetingTitle, marker }            → any meeting chunk whose text contains marker
 *   { type, titleExact }                → any chunk of the record(s) with that exact title
 *   { type, titleExact, marker }        → that record AND the chunk containing marker
 *
 * Fields per case: id, question, category, language, queryType, expect, explanation.
 *   language: en->en | en->hi | en->hinglish | hi->hi | hinglish->hi
 *   category: meeting-transcript | structured
 */

export const DATASET = [
  // ─────────────────────────────────────────────────────────────────────────
  // Meeting transcripts — BEGINNING / MIDDLE / END, English content
  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'M01', category: 'meeting-transcript', language: 'en->en', queryType: 'begin',
    question: 'What was the Hermes meeting with Stefan and Utkarsh about?',
    expect: { meetingTitle: 'Hermese Meeting with Stefan and Utkarsh', marker: 'open-source AI agent framework' },
    explanation: 'Executive summary in the first chunk: evaluating Hermes, an open-source AI agent framework, for task generation and workflow automation.',
  },
  {
    id: 'M02', category: 'meeting-transcript', language: 'en->en', queryType: 'begin',
    question: 'What server infrastructure and RAM was discussed for hosting Hermes?',
    expect: { meetingTitle: 'Hermese Meeting with Stefan and Utkarsh', marker: '16GB RAM' },
    explanation: 'Summary states Delgado hosting with 16GB RAM.',
  },
  {
    id: 'M03', category: 'meeting-transcript', language: 'en->en', queryType: 'middle',
    question: 'How should Hermes memory be retained beyond its built-in storage limits?',
    expect: { meetingTitle: 'Hermese Meeting with Stefan and Utkarsh', marker: 'retention beyond built-in storage' },
    explanation: 'Mid-transcript: export memory data periodically and re-import it to maintain continuous organizational learning.',
  },
  {
    id: 'M04', category: 'meeting-transcript', language: 'en->en', queryType: 'middle',
    question: 'Who said the meeting should be created using out-of-the-box tools rather than by Hermes?',
    expect: { meetingTitle: 'Hermese Meeting with Stefan and Utkarsh', marker: 'should not be Hermes who creates the meeting' },
    explanation: 'Stefan Hochhuth argues the meeting should be created by out-of-the-box tools, not Hermes.',
  },
  {
    id: 'M05', category: 'meeting-transcript', language: 'en->en', queryType: 'middle',
    question: 'What happens to the knowledge and memory when you switch between different LLM models?',
    expect: { meetingTitle: 'Hermese Meeting with Stefan and Utkarsh', marker: 'switch in between the models' },
    explanation: 'Discussion that Hermes owns the memory/knowledge so models can be switched underneath it.',
  },
  {
    id: 'M06', category: 'meeting-transcript', language: 'en->en', queryType: 'end',
    question: 'How did the Hermes meeting with Stefan end?',
    expect: { meetingTitle: 'Hermese Meeting with Stefan and Utkarsh', marker: 'Anything else or we' },
    explanation: 'Final chunk: Stefan asks "Anything else or we\'re fine?" and the meeting closes.',
  },
  {
    id: 'M07', category: 'meeting-transcript', language: 'en->en', queryType: 'action-item',
    question: 'What was the plan for integrating Hermes with the new SPA architecture?',
    expect: { meetingTitle: 'Hermese Meeting with Stefan and Utkarsh', marker: 'integrating Hermes with new SPA' },
    explanation: 'Action item: develop strategy to integrate Hermes with the new SPA architecture in an initial phase.',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Meeting transcripts — English query → Hindi / Hinglish content
  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'M08', category: 'meeting-transcript', language: 'en->en', queryType: 'begin',
    question: 'Who were the participants in the SCRUM 25/06/2026 meeting?',
    expect: { meetingTitle: 'SCRUM - 25/06/2026', marker: 'Prashant Kumar, Deepak Trivedi' },
    explanation: 'Participants are listed in the English metadata header of the first chunk.',
  },
  {
    id: 'M09', category: 'meeting-transcript', language: 'en->hi', queryType: 'middle',
    question: 'What was said about task points being added to the tasks in the SCRUM 25/06/2026 meeting?',
    expect: { meetingTitle: 'SCRUM - 25/06/2026', marker: 'टास्क प्वाइंट' },
    explanation: 'Anshu Mishra says the task points were not filled in earlier and have now been added.',
  },
  {
    id: 'M10', category: 'meeting-transcript', language: 'en->hinglish', queryType: 'end',
    question: 'Near the end of the SCRUM 25/06/2026 meeting, what did Deepak say about not being satisfied and continuing to look at AI options?',
    expect: { meetingTitle: 'SCRUM - 25/06/2026', marker: 'डोन्ट बी सटिस्फीएड' },
    explanation: 'Deepak: "don\'t be satisfied, keep looking at options" — spoken in Hinglish transliterated into Devanagari.',
  },
  {
    id: 'M11', category: 'meeting-transcript', language: 'en->hi', queryType: 'end',
    question: 'What did Deepak say about using AI to help with testing and watching videos about it?',
    expect: { meetingTitle: 'SCRUM - 25/06/2026', marker: 'टेस्टिंग में भी हेल्प करते है' },
    explanation: 'Deepak notes development AI tools also help with testing and asks the team to watch related videos.',
  },
  {
    id: 'M12', category: 'meeting-transcript', language: 'en->en', queryType: 'begin',
    question: 'Who attended the Loveable KT session?',
    expect: { meetingTitle: 'Loveable KT', marker: 'Jatin Rai' },
    explanation: 'Participant list in the English metadata header of the first chunk.',
  },
  {
    id: 'M13', category: 'meeting-transcript', language: 'en->hi', queryType: 'middle',
    question: 'In the Loveable KT meeting, what was said about changes being reverted?',
    expect: { meetingTitle: 'Loveable KT', marker: 'रिवर्ट भी होता जा रहा' },
    explanation: 'Kamal Kishore observes that things are also getting reverted.',
  },
  {
    id: 'M14', category: 'meeting-transcript', language: 'en->hi', queryType: 'end',
    question: 'At the end of the Loveable KT meeting, what was said about building a component to display a team member?',
    expect: { meetingTitle: 'Loveable KT', marker: 'टीम मेंबर दिखाने का एक कम्पोनेन्ट' },
    explanation: 'Discussion that without project knowledge the AI will produce a wrong component when asked to build a team-member display component.',
  },
  {
    id: 'M15', category: 'meeting-transcript', language: 'en->en', queryType: 'begin',
    question: 'What was the SPA development and deployment guidelines meeting meant to cover?',
    expect: { meetingTitle: 'SPA Development and Deployment Guidelines', marker: 'Discuss the SPA development process' },
    explanation: 'Description field: SPA development process, deployment workflow, QA validation and coding standards.',
  },
  {
    id: 'M16', category: 'meeting-transcript', language: 'en->hi', queryType: 'middle',
    question: 'In the SPA guidelines meeting, what was said about the UI breaking when something was clicked?',
    expect: { meetingTitle: 'SPA Development and Deployment Guidelines', marker: 'फटने लग गया' },
    explanation: 'Complaint that clicking caused the layout to break; agreement that it should not happen.',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Hindi / Hinglish QUERIES (query itself is not English)
  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'H01', category: 'meeting-transcript', language: 'hi->hi', queryType: 'paraphrased',
    question: 'दीपक ने ए आई टेस्टिंग के बारे में क्या कहा?',
    expect: { meetingTitle: 'SCRUM - 25/06/2026', marker: 'टेस्टिंग में भी हेल्प करते है' },
    explanation: 'Hindi query for the same Hindi content as M11 — tests same-language retrieval.',
  },
  {
    id: 'H02', category: 'meeting-transcript', language: 'hi->hi', queryType: 'middle',
    question: 'मीटिंग में टास्क प्वाइंट के बारे में क्या बात हुई?',
    expect: { meetingTitle: 'SCRUM - 25/06/2026', marker: 'टास्क प्वाइंट' },
    explanation: 'Hindi query for the task-points discussion (same target as M09).',
  },
  {
    id: 'H03', category: 'meeting-transcript', language: 'hinglish->hi', queryType: 'end',
    question: 'Deepak ne AI options ke baare mein kya kaha, satisfied nahi hone ke baare mein?',
    expect: { meetingTitle: 'SCRUM - 25/06/2026', marker: 'डोन्ट बी सटिस्फीएड' },
    explanation: 'Romanized Hinglish query for Devanagari-transliterated Hinglish content (same target as M10).',
  },
  {
    id: 'H04', category: 'meeting-transcript', language: 'hi->hi', queryType: 'paraphrased',
    question: 'टीम मेंबर दिखाने वाले कम्पोनेन्ट के बारे में क्या चर्चा हुई?',
    expect: { meetingTitle: 'Loveable KT', marker: 'टीम मेंबर दिखाने का एक कम्पोनेन्ट' },
    explanation: 'Hindi query for the team-member component discussion (same target as M14).',
  },
  {
    id: 'H05', category: 'meeting-transcript', language: 'hinglish->hi', queryType: 'middle',
    question: 'Loveable KT meeting mein revert hone ke baare mein kya kaha gaya?',
    expect: { meetingTitle: 'Loveable KT', marker: 'रिवर्ट भी होता जा रहा' },
    explanation: 'Hinglish query for the revert discussion (same target as M13).',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Structured SharePoint data — exact title
  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'S01', category: 'structured', language: 'en->en', queryType: 'exact-title',
    question: 'Add & Connect Tool Migration',
    expect: { type: 'project', titleExact: 'Add & Connect Tool Migration' },
    explanation: 'Exact project title lookup; project 16798, In Progress.',
  },
  {
    id: 'S02', category: 'structured', language: 'en->en', queryType: 'exact-title',
    question: 'Webstudio - User Management & Governance Setup',
    expect: { type: 'portfolio', titleExact: 'Webstudio - User Management & Governance Setup' },
    explanation: 'Exact portfolio title lookup; portfolio 16343.',
  },
  {
    id: 'S03', category: 'structured', language: 'en->en', queryType: 'exact-title',
    question: 'Development - Tasks By Team View',
    expect: { type: 'task', titleExact: 'Development - Tasks By Team View' },
    explanation: 'Exact task title lookup; task 8151, owned by Ranu Trivedi.',
  },
  {
    id: 'S04', category: 'structured', language: 'en->en', queryType: 'exact-title',
    question: 'Gruene Contact Database via PnP Provisioning',
    expect: { type: 'project', titleExact: 'Gruene Contact Database via PnP Provisioning' },
    explanation: 'Exact project title lookup; project 14708.',
  },
  {
    id: 'S05', category: 'structured', language: 'en->en', queryType: 'exact-title',
    question: 'Show Monthly & Weekly Attendance on User Click',
    expect: { type: 'task', titleExact: 'Show Monthly & Weekly Attendance on User Click' },
    explanation: 'Exact task title lookup; task 33384, In QA Review, owner Devendra Dixit.',
  },
  {
    id: 'S06', category: 'structured', language: 'en->en', queryType: 'exact-title',
    question: 'HR Admin Page - Global Attendance',
    expect: { type: 'project', titleExact: 'HR Admin Page - Global Attendance' },
    explanation: 'Exact project title lookup; project 16444.',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Structured — paraphrased / semantic (no literal title overlap)
  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'S07', category: 'structured', language: 'en->en', queryType: 'paraphrased',
    question: 'The selected item count shown at the top does not match how many items are actually selected',
    expect: { type: 'task', titleExact: 'Feedback - SmartSearch filter on Team portfolio page' },
    explanation: 'Task 11120 describes 10 items selected but the counter showing 11.',
  },
  {
    id: 'S08', category: 'structured', language: 'en->en', queryType: 'paraphrased',
    question: 'After tagging a portfolio and project it only appears once the page is reloaded',
    expect: { type: 'task', titleExact: 'Bug - New Tagged Portfolio and Project does not Showing Task Profile Page' },
    explanation: 'Task 24044: tagged portfolio/project only reflects after reloading the Task Profile page.',
  },
  {
    id: 'S09', category: 'structured', language: 'en->en', queryType: 'paraphrased',
    question: 'Assigned team members vanish from the portfolio popup after saving',
    expect: { type: 'task', titleExact: 'Bug - Team Members Disappearing After Clicking Save Button' },
    explanation: 'Task 13058: team members disappeared after clicking save in the portfolio popup.',
  },
  {
    id: 'S10', category: 'structured', language: 'en->en', queryType: 'paraphrased',
    question: 'managing PHP framework work for the Webstudio site',
    expect: { type: 'project', titleExact: 'Webstudio - Manage PHP Framework' },
    explanation: 'Project 15155, working on it.',
  },
  {
    id: 'S11', category: 'structured', language: 'en->en', queryType: 'paraphrased',
    question: 'software and hardware licence tracking for staff equipment',
    expect: { type: 'portfolio', titleExact: 'Team Management System (Hardware/Software and Licenses)' },
    explanation: 'Portfolio 14779 covers hardware/software and licence management.',
  },
  {
    id: 'S12', category: 'structured', language: 'en->en', queryType: 'paraphrased',
    question: 'building a weekly report generation capability',
    expect: { type: 'portfolio', titleExact: 'Generate Weekly Report' },
    explanation: 'Portfolio 16538.',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Structured — person / owner, status, date, recency
  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'S13', category: 'structured', language: 'en->en', queryType: 'person',
    question: 'Which tasks are owned by Devendra Dixit?',
    expect: { type: 'task', titleExact: 'Show Monthly & Weekly Attendance on User Click' },
    explanation: 'Task 33384 is owned by Devendra Dixit.',
  },
  {
    id: 'S14', category: 'structured', language: 'en->en', queryType: 'person',
    question: 'Tasks assigned to Ranu Trivedi about team views',
    expect: { type: 'task', titleExact: 'Development - Tasks By Team View' },
    explanation: 'Task 8151, owner Ranu Trivedi.',
  },
  {
    id: 'S15', category: 'structured', language: 'en->en', queryType: 'person',
    question: 'What did Stefan Hochhuth report about the portfolio profile page?',
    expect: { type: 'task', titleExact: 'Portfolio Profile Page Bug' },
    explanation: 'Task 875, owner Stefan Hochhuth.',
  },
  {
    id: 'S16', category: 'structured', language: 'en->en', queryType: 'status',
    question: 'Which attendance task is currently in QA review?',
    expect: { type: 'task', titleExact: 'Show Monthly & Weekly Attendance on User Click' },
    explanation: 'Task 33384 has status "In QA Review".',
  },
  {
    id: 'S17', category: 'structured', language: 'en->en', queryType: 'status',
    question: 'Which SDC tooling project has not been started yet?',
    expect: { type: 'project', titleExact: 'SDC Project Tools Migration to SP Online' },
    explanation: 'Project 16727, status Not Started.',
  },
  {
    id: 'S18', category: 'structured', language: 'en->en', queryType: 'recent',
    question: 'What is the most recent SDC project tools migration work?',
    expect: { type: 'project', titleExact: 'SDC Project Tools Migration to SP Online' },
    explanation: 'Project 16727, updated 2026-07-31 — the newest SDC migration project.',
  },
  {
    id: 'S19', category: 'structured', language: 'en->en', queryType: 'recent',
    question: 'latest task profile migration work for the SPA',
    expect: { type: 'project', titleExact: 'Task Profile Migration SPA' },
    explanation: 'Project 16821, Acknowledged, updated 2026-07-28.',
  },
  {
    id: 'S20', category: 'structured', language: 'en->en', queryType: 'date',
    question: 'Which tagging bug was due on 2 December 2024?',
    expect: { type: 'task', titleExact: 'Bug - New Tagged Portfolio and Project does not Showing Task Profile Page' },
    explanation: 'Task 24044 has dueDate 2024-12-02.',
  },
  {
    id: 'S21', category: 'structured', language: 'en->en', queryType: 'date',
    question: 'Which SPFX profile pages feedback task was due in June 2023?',
    expect: { type: 'task', titleExact: 'Feedback - SPFX profile pages Client category' },
    explanation: 'Task 7802, dueDate 2023-06-02, owner Ranu Trivedi.',
  },
  {
    id: 'S22', category: 'structured', language: 'en->en', queryType: 'action-item',
    question: 'What needs to be implemented for showing today\'s working tasks grouped by team?',
    expect: { type: 'task', titleExact: 'Development - Tasks By Team View' },
    explanation: 'Task 8151 asks to implement a "Todays Tasks By Team" view.',
  },
  {
    id: 'S23', category: 'structured', language: 'en->en', queryType: 'semantic',
    question: 'attendance reporting for the HR admin area',
    expect: { type: 'project', titleExact: 'HR Admin Page - Global Attendance' },
    explanation: 'Project 16444.',
  },
  {
    id: 'S24', category: 'structured', language: 'en->en', queryType: 'semantic',
    question: 'migrating the add and connect tool',
    expect: { type: 'project', titleExact: 'Add & Connect Tool Migration' },
    explanation: 'Project 16798, In Progress.',
  },
];

export default DATASET;
