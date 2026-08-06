# Eval V2 — Complete Question Inventory

**Version:** v2.0  
**Generated:** 2026-08-05T11:31:45.121Z  
**Total questions:** 185

## Category distribution

| Category | Count |
|---|---|
| Projects / Portfolios | 25 |
| Tasks / People / Owners | 32 |
| Counts / Status / Overdue | 19 |
| Dates / Latest / Sorting | 19 |
| Meetings | 20 |
| Transcript / Semantic Retrieval | 20 |
| Hindi / Hinglish | 15 |
| Typo / Vague Phrasing | 10 |
| Multi-Turn Conversation | 10 |
| Negative / Fail-Closed | 10 |
| Comparison / Multi-Entity | 5 |

## Difficulty distribution

| Difficulty | Count |
|---|---|
| easy | 48 |
| medium | 73 |
| hard | 64 |

## Projects / Portfolios (25)

| ID | Difficulty | Question | Expected | Tags |
|---|---|---|---|---|
| PROJ_001 | easy | What is the status of "SharePoint Framework - SPFx Improvement"? | FACT: status = In Progress | project, status, exact-title |
| PROJ_002 | easy | Is "Team Management System (Hardware/Software and Licenses)" a project or a portfolio? | FACT: type = portfolio | type-lookup |
| PROJ_003 | easy | How many tasks does "SharePoint Framework - SPFx Improvement" have? | COUNT: count = 1213, container=SharePoint Framework - SPFx Improvement | count, container |
| PROJ_004 | easy | What is the status of "Content Management and Search"? | FACT: status = In Progress | project, status |
| PROJ_005 | easy | Is "MCP Server" a project or a portfolio? | FACT: type = portfolio | type-lookup |
| PROJ_006 | medium | What portfolio is "MCP Server" a part of? | FACT: parentTitle = Artificial Intelligence (AI) | hierarchy, parent |
| PROJ_007 | easy | How many direct sub-items does the "Contact Database" portfolio have? | COUNT: count = 0, container=Contact Database | hierarchy, count |
| PROJ_008 | easy | What is the status of "HHHH Automation"? | FACT: status = In Progress | project, status |
| PROJ_009 | easy | When was "Development Team Management System (Assets Accounts Permissions)" last updated? | FACT: timestamp = 2026-08-03T12:17:27Z | date, timestamp |
| PROJ_010 | medium | Which project is a child of "HHHH Solution Migration to Single Page Application (SPA)"? | FACT: answer must mention ['Task Management SPA'] | hierarchy |
| PROJ_011 | easy | What is the status of the "Loveable AI" portfolio? | FACT: status = Not Started | portfolio, status |
| PROJ_012 | medium | How many tasks are there under "Timesheet - SPFx Issues and Bug fixing"? | COUNT: count = 299, container=Timesheet - SPFx Issues and Bug fixing | count, container |
| PROJ_013 | easy | What is the current status of "GitHub Backup Automation"? | FACT: status = Not Started | portfolio, status |
| PROJ_014 | medium | Tell me about "Create Mailweaver Tool" — what's its current status? | FACT: status = Task completed | vague-phrasing, status |
| PROJ_015 | medium | What is the parent project of "Task Management SPA"? | FACT: parentTitle = HHHH Solution Migration to Single Page Application (SPA) | hierarchy, parent |
| PROJ_016 | medium | How many tasks does "Portfolio Tool - SPFx Issues and Bug fixing" have? | COUNT: count = 135, container=Portfolio Tool - SPFx Issues and Bug fixing | count, container |
| PROJ_017 | easy | What is the status of "AI Compatible Project for HHHH Components"? | FACT: status = In Progress | project, status |
| PROJ_018 | medium | Which portfolio contains "Scrum Agent"? | FACT: parentTitle = AI Agents | hierarchy, parent |
| PROJ_019 | hard | What's under the "Webstudio - SP & Public Site (Backend)" portfolio? | LIST (behavior-checked) | hierarchy, structural |
| PROJ_020 | medium | How many tasks does "Dynamic Dashboard development / improvements" have? | COUNT: count = 279, container=Dynamic Dashboard development / improvements | count, container |
| PROJ_021 | easy | What is the status of the "SharePoint Backup Automation" portfolio? | FACT: status = Not Started | portfolio, status |
| PROJ_022 | hard | Give me the structure of the "Design" project — what's under it? | LIST (behavior-checked) | hierarchy, structural |
| PROJ_023 | easy | What is the status of "Webstudio - SP & Public Site UI/UX"? | FACT: status = In Progress | project, status |
| PROJ_024 | hard | What is the most recently updated project? | FACT: timestamp = 2026-08-04T07:16:21Z | recency, single-entity |
| PROJ_025 | medium | Which projects were updated yesterday? | LIST: ['HHHH Automation', 'Task Management SPA', 'HHHH Solution Migration to Single Page Application (SPA)', 'OMT Migration SPA', 'MS Power Automate', 'HHHH Power Automate'] | date-list, temporal |

## Tasks / People / Owners (32)

| ID | Difficulty | Question | Expected | Tags |
|---|---|---|---|---|
| TASK_001 | easy | How many tasks does Stefan Hochhuth have? | COUNT: count = 1795, person=Stefan Hochhuth | person-filter, count |
| TASK_002 | easy | How many tasks does Deepak Trivedi have? | COUNT: count = 1023, person=Deepak Trivedi | person-filter, count |
| TASK_003 | easy | How many tasks does Kamal Darani have? | COUNT: count = 152, person=Kamal Darani | person-filter, count |
| TASK_004 | easy | How many tasks does Pravesh Kumar have? | COUNT: count = 76, person=Pravesh Kumar | person-filter, count |
| TASK_005 | easy | How many tasks does Ankita Pandit have? | COUNT: count = 75, person=Ankita Pandit | person-filter, count |
| TASK_006 | medium | How many tasks does Anshika Chaudhary have? | COUNT: count = 43, person=Anshika Chaudhary | person-filter, count |
| TASK_007 | medium | How many tasks does Robert Ungethuem have? | COUNT: count = 32, person=Robert Ungethuem | person-filter, count |
| TASK_008 | medium | How many tasks does Kristina Kovach have? | COUNT: count = 35, person=Kristina Kovach | person-filter, count |
| TASK_009 | medium | How many tasks does Thordis Jacobs have? | COUNT: count = 27, person=Thordis Jacobs | person-filter, count |
| TASK_010 | medium | How many tasks does Garima Arya have? | COUNT: count = 26, person=Garima Arya | person-filter, count |
| TASK_011 | medium | Does Ranu Trivedi have any overdue tasks? | COUNT: count = 29, person=Ranu Trivedi, overdue=true | person-filter, overdue, count |
| TASK_012 | medium | Does Deepak Trivedi have any overdue tasks? | COUNT: count = 85, person=Deepak Trivedi, overdue=true | person-filter, overdue, count |
| TASK_013 | medium | Does Ankita Pandit have any overdue tasks? | COUNT: count = 43, person=Ankita Pandit, overdue=true | person-filter, overdue, count |
| TASK_014 | medium | How many completed tasks does Ranu Trivedi have? | COUNT: count = 584, person=Ranu Trivedi, status=completed | person-filter, status, count |
| TASK_015 | medium | How many in-progress tasks does Deepak Trivedi have? | COUNT: count = 71, person=Deepak Trivedi, status=in progress | person-filter, status, count |
| TASK_016 | easy | Who is the owner of the "Development - Tasks By Team View" task? | FACT: owner = Ranu Trivedi | owner-lookup, exact-title |
| TASK_017 | easy | Who is working on "Team Management System (Hardware/Software and Licenses)"? | LIST (behavior-checked) | who-works-on |
| TASK_018 | hard | How many tasks does Ranu Trivedi have in Team Management Tools? | COUNT: count = 0, person=Ranu Trivedi, container=Team Management Tools | person-filter, container-filter, count, composition |
| TASK_019 | hard | Does Ranu Trivedi have any overdue tasks in Team Management Tools? | COUNT: count = 0, person=Ranu Trivedi, container=Team Management Tools, overdue=true | person-filter, container-filter, overdue, count, composition |
| TASK_020 | hard | How many tasks does Kamal have? | BEHAVIOR: AMBIGUOUS | ambiguity, person-filter |
| TASK_021 | easy | What tasks are assigned to Kamal Darani? | LIST (behavior-checked) | person-filter, owned-by |
| TASK_022 | medium | What tasks belong to Piyoosh Bhardwaj? | LIST (behavior-checked) | person-filter, owned-by |
| TASK_023 | easy | Whose tasks include "Bug - All Time Entry"? | FACT: owner = Stefan Hochhuth | owner-lookup |
| TASK_024 | medium | Sonal Choudhary's tasks — how many are there? | COUNT: count = 34, person=Sonal Choudhary | person-filter, possessive-phrasing, count |
| TASK_025 | medium | Aditi Mishra's overdue tasks — how many? | COUNT: count = 7, person=Aditi Mishra, overdue=true | person-filter, possessive-phrasing, overdue, count |
| TASK_026 | hard | Which of Satyendra Kumar's tasks are still In QA Review? | COUNT: count = 0, person=Satyendra Kumar, status=In QA Review | person-filter, status, count |
| TASK_027 | easy | Who owns "Excel contact data base + payroll template"? | FACT: owner = Pravesh Kumar | owner-lookup |
| TASK_028 | medium | How many tasks does Divyanshu Kumar currently have? | COUNT: count = 21, person=Divyanshu Kumar | person-filter, count |
| TASK_029 | medium | What tasks are owned by Mattis Hahn? | LIST (behavior-checked) | person-filter, owned-by |
| TASK_030 | hard | How many tasks does Utkarsh Srivastava have that are Acknowledged? | COUNT: count = 12, person=Utkarsh Srivastava, status=Acknowledged | person-filter, status, count |
| TASK_031 | easy | Does Anshu Mishra have any overdue tasks? | COUNT: count = 7, person=Anshu Mishra, overdue=true | person-filter, overdue, count |
| TASK_032 | hard | How many tasks does Priya Malhotra have? | BEHAVIOR: NOT_FOUND (forbidden: ['GLOBAL_COUNT', 'WRONG_ENTITY_GUESS']) | negative, nonexistent-person |

## Counts / Status / Overdue (19)

| ID | Difficulty | Question | Expected | Tags |
|---|---|---|---|---|
| CNT_001 | easy | How many tasks are there in total? | COUNT: count = 14181 | global-count |
| CNT_002 | easy | How many projects are there? | COUNT: count = 746 | global-count |
| CNT_003 | easy | How many portfolios are there? | COUNT: count = 2666 | global-count |
| CNT_004 | easy | How many meetings are there in total? | COUNT: count = 146 | global-count, chunk-inflation-risk |
| CNT_005 | easy | How many time entries are there? | COUNT: count = 6142 | global-count |
| CNT_006 | easy | How many tasks are currently marked "Not Started"? | COUNT: count = 857, status=Not Started | status, count |
| CNT_007 | easy | How many tasks are in "In QA Review"? | COUNT: count = 550, status=In QA Review | status, count |
| CNT_008 | medium | How many tasks have been completed? | COUNT: count = 10082, status=completed | status, count |
| CNT_009 | easy | How many tasks are "Acknowledged"? | COUNT: count = 507, status=Acknowledged | status, count |
| CNT_010 | medium | How many tasks are "Deployment Pending"? | COUNT: count = 117, status=Deployment Pending | status, count |
| CNT_011 | medium | How many tasks are in "Re-Open" status? | COUNT: count = 129, status=Re-Open | status, count |
| CNT_012 | hard | How many tasks are overdue in total? | COUNT: count = 1089, overdue=true | overdue, global-count |
| CNT_013 | medium | How many tasks does Team Management Tools have? | COUNT: count = 53, container=Team Management Tools | container-filter, count, chunk-inflation-risk |
| CNT_014 | hard | How many overdue tasks does Team Management Tools have? | COUNT: count = 9, container=Team Management Tools, overdue=true | container-filter, overdue, count, composition |
| CNT_015 | hard | How many distinct people own at least one task? | COUNT: count = 62 | aggregate, people |
| CNT_016 | medium | How many tasks does "Task Popup - SPFx Issues and Bug fixing" have? | COUNT: count = 279, container=Task Popup - SPFx Issues and Bug fixing | container-filter, count |
| CNT_017 | hard | How many completed tasks does "SharePoint Framework - SPFx Improvement" have? | COUNT: count = 1074, container=SharePoint Framework - SPFx Improvement, status=completed | container-filter, status, count, composition |
| CNT_018 | medium | How many tasks have no due date recorded? | COUNT: count = 7959 | data-quality, count |
| CNT_019 | medium | How many time entries has Ranu Trivedi logged? | COUNT: count = 423, person=Ranu Trivedi | timeentry, person-filter, count |

## Dates / Latest / Sorting (19)

| ID | Difficulty | Question | Expected | Tags |
|---|---|---|---|---|
| DATE_001 | medium | Show the latest 5 projects. | LIST: ['HHHH Solution Migration to Single Page Application (SPA)', 'HHHH Automation', 'MS Power Automate', 'HHHH Power Automate', 'Task Management SPA'] | recency, list, sort |
| DATE_002 | medium | What are the 5 most recently updated portfolios? | LIST: ['Test component 1', 'SPA Shared Packages', 'MCP Server', 'SharePoint Backup Automation', 'Team Management System (Hardware/Software and Licenses)'] | recency, list, sort |
| DATE_003 | hard | Which portfolio was updated most recently? | FACT: timestamp = 2026-08-03T06:42:29Z | recency, single-entity |
| DATE_004 | medium | Which tasks were due yesterday? | LIST (behavior-checked) | due-date, temporal, list |
| DATE_005 | medium | Which tasks are due this week? | LIST: ['Annex SPA UX and navigation improvements', 'Portfolio Profile: Date controls do not open calendars'] | due-date, temporal, list |
| DATE_006 | easy | What tasks are due on 16/06/2026? | LIST: ['Development - Migrate Project Profile from SDC to SP Online'] | due-date, explicit-date, locale |
| DATE_007 | easy | What is the due date of "Development - Tasks By Team View"? | FACT: dueDate = 2023-06-16 | due-date, exact-title |
| DATE_008 | hard | Which overdue task has been overdue the longest? | FACT: dueDate = 2018-01-24T03:30:00.000Z | overdue, sort, hard |
| DATE_009 | hard | What is the most recently updated project? | FACT: answer must mention ['HHHH Solution Migration to Single Page Application (SPA)'] | recency, single-entity, duplicate-phrasing-check |
| DATE_010 | hard | Which project was updated most recently? | FACT: answer must mention ['HHHH Solution Migration to Single Page Application (SPA)'] | recency, single-entity, phrasing-variant |
| DATE_011 | easy | When was "HHHH Automation" last updated? | FACT: timestamp = 2026-08-04T06:44:04Z | date-lookup |
| DATE_012 | medium | Which projects were updated today? | LIST (behavior-checked) | temporal, list |
| DATE_013 | medium | Which portfolios were updated this week? | LIST (behavior-checked) | temporal, list |
| DATE_014 | hard | Which tasks are overdue and due before 01/01/2023? | LIST (behavior-checked) | overdue, date-range, composition |
| DATE_015 | easy | Show the top 3 latest projects. | LIST: ['HHHH Solution Migration to Single Page Application (SPA)', 'HHHH Automation', 'MS Power Automate'] | recency, list, limit |
| DATE_016 | medium | Was the "Design" project created in 2026? | BEHAVIOR: UNSUPPORTED | unsupported-field, hallucination-trap |
| DATE_017 | medium | What tasks are due in 2026? | LIST (behavior-checked) | bare-number, vocabulary-collision |
| DATE_018 | hard | How many tasks were due last month? | COUNT: count = 29 | due-date, temporal, count |
| DATE_019 | medium | What is the earliest due date among Ranu Trivedi's tasks? | FACT: dueDate = 2021-02-25T18:30:00.000Z | person-filter, sort, composition |

## Meetings (20)

| ID | Difficulty | Question | Expected | Tags |
|---|---|---|---|---|
| MEET_001 | easy | When did the "SCRUM - 25/06/2026" meeting happen? | FACT: start = 2026-06-25 | meeting-date, exact-title |
| MEET_002 | easy | Who participated in the "SCRUM - 25/06/2026" meeting? | LIST: ['Prashant Kumar', 'Deepak Trivedi', 'Ranu Trivedi', 'Ankush Das', 'Anshu Mishra', 'Utkarsh Srivastava', 'Kamal Kishore', 'Kamal Singh', 'Atul Kumar', 'Umang Kumar'] | meeting-participants, exact-title |
| MEET_003 | medium | What were the action items from the "SCRUM - 25/06/2026" meeting? | SEMANTIC: Clean up unused properties and fields from time-sheet JSON entries; Test Lovable tool to create a complex component; Prepare a guide for requesting and assigning software licenses | action-items, semantic |
| MEET_004 | medium | Who attended the "Loveable KT" meeting? | LIST: ['Prashant Kumar', 'Ranu Trivedi', 'Deepak Trivedi', 'Vivekanand', 'Utkarsh Srivastava'] | meeting-participants |
| MEET_005 | medium | What was discussed in the "Loveable KT" meeting? | SEMANTIC: Lovable is an AI-powered development platform; connected to SharePoint via GitHub; automated CI/CD pipeline pushing code to the App Catalog | topic, semantic |
| MEET_006 | medium | Who was in the "SPA Shared Packages Discussion" meeting? | LIST: ['Kamal Singh', 'Deepak Trivedi', 'Anshu Mishra', 'Utkarsh Srivastava', 'Nikky Jha', 'Nitin Chauhan', 'Ankush Das', 'Kamal Kishore', 'Vikas Kumar Yadav'] | meeting-participants |
| MEET_007 | hard | What key decisions came out of the "SPA Shared Packages Discussion" meeting? | SEMANTIC: the main solution was divided into six separate packages; using inline CSS only; targeting 80% design match initially | decisions, semantic |
| MEET_008 | easy | Did any meetings happen today? | COUNT: count = 0 | meeting-date, temporal, hallucination-trap |
| MEET_009 | easy | What meeting happened yesterday? | FACT: answer must mention ['Scrum 4/08/2026'] | meeting-date, temporal |
| MEET_010 | medium | How many meetings happened this week? | COUNT: count = 2 | meeting-date, temporal, count, chunk-inflation-risk |
| MEET_011 | medium | How many meetings happened last week? | COUNT: count = 6 | meeting-date, temporal, count, chunk-inflation-risk |
| MEET_012 | medium | What meetings happened last week? | LIST: ['Scrum 28/07/2026', 'SPA Shared Packages Discussion', 'Scrum 31/07/2026', 'Scrum 30/07/2026', 'Scrum 29/07/2026', 'Scrum 27/07/2026'] | meeting-date, temporal, list |
| MEET_013 | easy | What meeting happened on 25/06/2026? | FACT: answer must mention ['SCRUM - 25/06/2026'] | meeting-date, explicit-date, locale |
| MEET_014 | easy | Tell me about the "Scrum 3/08/2026" meeting. | FACT: start = 2026-08-03 | meeting-detail, exact-title |
| MEET_015 | hard | Was Ranu Trivedi at the "Scrum 4/08/2026" meeting? | FACT | attendance, person |
| MEET_016 | hard | Was Stefan Hochhuth at the "Scrum 4/08/2026" meeting? | FACT | attendance, person, hallucination-trap |
| MEET_017 | hard | What did the "SCRUM - 25/06/2026" meeting decide about AI? | SEMANTIC: management mandated that discussions be recorded via transcripts to facilitate better AI context and knowledge retrieval; streamlining the development process by adopting new AI-integrated workflows | topic, ai, semantic |
| MEET_018 | medium | Was there a meeting called "Quarterly Board Strategy Offsite"? | BEHAVIOR: NOT_FOUND (forbidden: ['HALLUCINATION']) | negative, nonexistent-meeting, hallucination-trap |
| MEET_019 | hard | What time did the "SCRUM - 25/06/2026" meeting end? | FACT: end = 2026-06-25T07:15:00Z | meeting-detail, exact-fact |
| MEET_020 | easy | What type of meeting was "Scrum 4/08/2026" — a stand-up, a review, or something else? | FACT: meetingType = Stand-up | meeting-detail |

## Transcript / Semantic Retrieval (20)

| ID | Difficulty | Question | Expected | Tags |
|---|---|---|---|---|
| TRANS_001 | medium | What was the "AWSTesting" meeting about? | SEMANTIC: demonstrate AI-powered meeting transcript analysis and task creation capabilities; automatically generates meeting summaries, extracts action items, and creates tasks with portfolio matching using Claude API | semantic, topic, transcript-beginning |
| TRANS_002 | hard | What data-export problem was raised in the middle of the "AWSTesting" meeting? | SEMANTIC: the export does not include timesheet information or task descriptions; task titles like "Back Operational Management Tools" are not distinguishable when there are ~200 similarly-named tasks | semantic, transcript-middle, hard-region |
| TRANS_003 | hard | Near the end of the "AWSTesting" meeting, what did the team say about the QA agent? | SEMANTIC: when a task reaches 80% completion, the QA agent automatically checks the original requirements; this can be done automatically without anybody doing it manually | semantic, transcript-end, hard-region |
| TRANS_004 | medium | Which API was used in the "AWSTesting" meeting's demo for meeting analysis? | FACT: answer must mention ['Claude API'] | semantic, exact-fact, transcript-beginning |
| TRANS_005 | hard | What did Deepak Trivedi say about AI near the end of the "SCRUM - 25/06/2026" meeting? | SEMANTIC: Deepak Trivedi mentioned AI tools ("development AI") can help with testing; he said he would look into it in more detail and report back | semantic, transcript-end, hard-region, hindi-source |
| TRANS_006 | hard | In the middle of the "SCRUM - 25/06/2026" meeting, what were Anshu Mishra and Deepak Trivedi discussing? | SEMANTIC: they discussed adding task points that had not been entered before; a task related to Stephen and email/licensing needed to be created | semantic, transcript-middle, hindi-source |
| TRANS_007 | medium | What blockers were mentioned in the "Scrum 4/08/2026" meeting? | SEMANTIC: incomplete design verification; hardcoded values in popups; custom CSS classes not properly removed from components | semantic, blockers |
| TRANS_008 | medium | How did the team plan to divide the SPA shared packages work? | SEMANTIC: the main solution was divided into six separate packages to distribute work across developers | semantic, decisions |
| TRANS_009 | hard | What did the AWSTesting meeting say about the AI agent going on a page automatically? | SEMANTIC: the QA agent should go on a page and check whether timesheet data and other details were done | semantic, transcript-end, paraphrase |
| TRANS_010 | hard | Did the "AWSTesting" meeting mention anything about a QA agent checking requirements automatically? What did it say the completion threshold was? | SEMANTIC: 80% completion triggers the QA agent check | semantic, transcript-end, exact-fact |
| TRANS_011 | medium | What comments or feedback exist on the "AWSTesting" meeting record? | SEMANTIC (grounding-checked) | exact-lookup, verbatim |
| TRANS_012 | hard | What did Deepak Trivedi say about AI? | SEMANTIC: Deepak Trivedi discussed AI-integrated workflows and using AI tools for testing across multiple meetings (e.g. SCRUM - 25/06/2026) | semantic, vague-scope, ai |
| TRANS_013 | hard | What did Ranu Trivedi say in the "SCRUM - 25/06/2026" meeting about the timesheet discrepancy? | SEMANTIC: Ranu Trivedi checked the version history and found the user logged time for the 23rd but marked it under the 17th | semantic, person-attribution, hindi-source |
| TRANS_014 | medium | What tool did the team evaluate for automating deployment pipelines in the "SCRUM - 25/06/2026" meeting? | FACT: answer must mention ['Lovable', 'Lovable tool'] | semantic, exact-fact |
| TRANS_015 | hard | Did anyone discuss removing unused JSON properties in any meeting? Which one? | SEMANTIC: the team discussed removing unused JSON properties from time-sheet entries to improve performance and clarity | semantic, cross-meeting-search |
| TRANS_016 | medium | What is the "Content Management and Search" project about? | SEMANTIC (grounding-checked) | semantic, project-summary |
| TRANS_017 | hard | What did the transcript of the "Loveable KT" meeting say Lovable connects to besides SharePoint? | FACT: answer must mention ['GitHub'] | semantic, exact-fact |
| TRANS_018 | hard | What did the "AWSTesting" meeting say about a meeting that never happened? | BEHAVIOR: NOT_FOUND (forbidden: ['HALLUCINATION']) | hallucination-trap, negative |
| TRANS_019 | medium | Summarize the "Webstudio Team Meeting". | SEMANTIC (grounding-checked) | hallucination-trap, sparse-record |
| TRANS_020 | hard | What did Kamal say in the "SPA Shared Packages Discussion" meeting about AI tools? | BEHAVIOR: AMBIGUOUS_OR_QUALIFIED | ambiguity, person-attribution, semantic |

## Hindi / Hinglish (15)

| ID | Difficulty | Question | Expected | Tags |
|---|---|---|---|---|
| HI_001 | hard | Ranu ke overdue tasks kitne hain? | COUNT: count = 29, person=Ranu Trivedi, overdue=true | hinglish, person-filter, overdue, count |
| HI_002 | hard | kal ki meeting me kya discuss hua? | SEMANTIC: team standup and project status meeting covering SharePoint package deployment, design fixes, component verification, and urgent deadline pressures | hinglish, meeting-date, semantic |
| HI_003 | medium | Team Management Tools ka status kya hai? | FACT: status = In Progress | hinglish, status |
| HI_004 | hard | Deepak Trivedi ne SCRUM - 25/06/2026 meeting me AI ke bare me kya bola tha? | SEMANTIC: Deepak Trivedi mentioned AI tools can help with testing near the end of the meeting | hinglish, semantic, transcript-end |
| HI_005 | hard | Stefan Hochhuth ke paas kitne tasks hain? | COUNT: count = 1795, person=Stefan Hochhuth | hinglish, person-filter, count |
| HI_006 | hard | kitni meetings is hafte hui hain? | COUNT: count = 2 | hinglish, meeting-date, count, chunk-inflation-risk |
| HI_007 | medium | kya Ranu Trivedi ke koi overdue tasks hain? | COUNT: count = 29, person=Ranu Trivedi, overdue=true | hinglish, overdue |
| HI_008 | medium | "SharePoint Framework - SPFx Improvement" project me kitne tasks hain? | COUNT: count = 1213, container=SharePoint Framework - SPFx Improvement | hinglish, container-filter, count |
| HI_009 | easy | "HHHH Automation" project ka status kya hai? | FACT: status = In Progress | hinglish, status |
| HI_010 | hard | pichle hafte kitni meetings hui thi? | COUNT: count = 6 | hindi, meeting-date, count, chunk-inflation-risk |
| HI_011 | hard | Ranu Trivedi ke Team Management Tools me kitne tasks hain? | COUNT: count = 0, person=Ranu Trivedi, container=Team Management Tools | hinglish, composition, count |
| HI_012 | medium | total kitne projects hain hamare data me? | COUNT: count = 746 | hinglish, global-count |
| HI_013 | hard | Kamal ke kitne tasks hain? | BEHAVIOR: AMBIGUOUS | hinglish, ambiguity |
| HI_014 | hard | Priya Malhotra ke tasks batao. | BEHAVIOR: NOT_FOUND (forbidden: ['GLOBAL_COUNT', 'WRONG_ENTITY_GUESS']) | hinglish, negative, nonexistent-person |
| HI_015 | medium | SCRUM - 25/06/2026 meeting me kaun kaun tha? | LIST: ['Prashant Kumar', 'Deepak Trivedi', 'Ranu Trivedi', 'Ankush Das', 'Anshu Mishra', 'Utkarsh Srivastava', 'Kamal Kishore', 'Kamal Singh', 'Atul Kumar', 'Umang Kumar'] | hinglish, meeting-participants |

## Typo / Vague Phrasing (10)

| ID | Difficulty | Question | Expected | Tags |
|---|---|---|---|---|
| TYPO_001 | medium | How many tasks does Team Managment Tools have? | COUNT: count = 53, container=Team Management Tools | typo, count, container-filter |
| TYPO_002 | hard | What is happening with portfoilo managment? | BEHAVIOR: HONEST_NOT_FOUND_OR_CLARIFY (forbidden: ['CONFIDENT_WRONG_ENTITY']) | typo, vocabulary-collision, regression-fixture |
| TYPO_003 | medium | Give me the devlopment status of the Team Management System portfolio. | FACT: status = In Progress | typo, status |
| TYPO_004 | medium | What happened in the scrm meeting on 25/06/2026? | FACT: answer must mention ['SCRUM - 25/06/2026'] | typo, meeting-lookup |
| TYPO_005 | medium | How many taks does Ranu Trivedi have? | COUNT: count = 672, person=Ranu Trivedi | typo, count |
| TYPO_006 | hard | whats going on with that thing we talked about | BEHAVIOR: CLARIFY_OR_NOT_FOUND (forbidden: ['CONFIDENT_WRONG_ENTITY']) | vague-phrasing, no-context |
| TYPO_007 | medium | Whats the lattest update on HHHH Automaton? | FACT: timestamp = 2026-08-04T06:44:04Z | typo, date-lookup |
| TYPO_008 | easy | status of hhhh automaton project? | FACT: status = In Progress | typo, vague-phrasing, status |
| TYPO_009 | hard | hows the developmnet team managment system doing | FACT: status = In Progress | typo, vague-phrasing, status |
| TYPO_010 | medium | overdue taks for stefan hochhuth? | COUNT: count = 164, person=Stefan Hochhuth, overdue=true | typo, overdue, count |

## Negative / Fail-Closed (10)

| ID | Difficulty | Question | Expected | Tags |
|---|---|---|---|---|
| NEG_001 | medium | How many tasks does Quantum Marketing Portal have? | BEHAVIOR: NOT_FOUND (forbidden: ['GLOBAL_COUNT', 'WRONG_ENTITY_GUESS']) | negative, nonexistent-project |
| NEG_002 | medium | What is the status of the "Neural Compliance Dashboard" project? | BEHAVIOR: NOT_FOUND (forbidden: ['HALLUCINATION']) | negative, nonexistent-project |
| NEG_003 | hard | Does the "Titan Payroll Bridge" portfolio have any overdue tasks? | BEHAVIOR: NOT_FOUND (forbidden: ['GLOBAL_COUNT', 'WRONG_ENTITY_GUESS']) | negative, nonexistent-container, composition |
| NEG_004 | medium | How many tasks does Priya Malhotra have? | BEHAVIOR: NOT_FOUND (forbidden: ['GLOBAL_COUNT', 'WRONG_ENTITY_GUESS']) | negative, nonexistent-person |
| NEG_005 | hard | What was decided in the "Quarterly Board Strategy Offsite" meeting? | BEHAVIOR: NOT_FOUND (forbidden: ['HALLUCINATION']) | negative, nonexistent-meeting |
| NEG_006 | hard | What is the due date of "Development - Tasks By Team View"'s successor task? | BEHAVIOR: NOT_FOUND (forbidden: ['HALLUCINATION']) | negative, unsupported-relationship |
| NEG_007 | medium | When was "SharePoint Framework - SPFx Improvement" created? | BEHAVIOR: UNSUPPORTED (forbidden: ['HALLUCINATION']) | negative, unsupported-field, hallucination-trap |
| NEG_008 | hard | How many tasks does the "Titan Payroll Bridge" project have in Team Management Tools? | BEHAVIOR: NOT_FOUND (forbidden: ['GLOBAL_COUNT', 'WRONG_ENTITY_GUESS']) | negative, nonexistent-project, composition |
| NEG_009 | medium | What did Priya Malhotra say in the "SCRUM - 25/06/2026" meeting? | BEHAVIOR: NOT_FOUND (forbidden: ['HALLUCINATION']) | negative, nonexistent-person, hallucination-trap |
| NEG_010 | hard | How many meetings happened on 31/02/2026? | BEHAVIOR: UNRESOLVABLE_DATE (forbidden: ['HALLUCINATION']) | negative, invalid-date |

## Comparison / Multi-Entity (5)

| ID | Difficulty | Question | Expected | Tags |
|---|---|---|---|---|
| CMP_001 | hard | Which is more recently updated, Team Management Tools or Development Team Management System? | FACT: answer must mention ['Development Team Management System (Assets Accounts Permissions)'] | comparison, recency, independent-resolution |
| CMP_002 | hard | Which has more tasks, Team Management Tools or Development Team Management System? | FACT: answer must mention ['Development Team Management System (Assets Accounts Permissions)'] | comparison, task-count, independent-resolution, chunk-inflation-risk |
| CMP_003 | medium | Compare "SharePoint Framework - SPFx Improvement" and "Content Management and Search". | LIST (behavior-checked) | comparison, side-by-side |
| CMP_004 | hard | Compare "Team Management Tools" and "Quantum Marketing Portal". | BEHAVIOR: FAIL_CLOSED_ON_UNRESOLVED (forbidden: ['WRONG_ENTITY_GUESS', 'CONFIDENT_WRONG_ENTITY']) | comparison, nonexistent-entity, fail-closed |
| CMP_005 | hard | Compare "Team Management" and "Development Team Management System". | BEHAVIOR: AMBIGUOUS | comparison, ambiguity |

## Multi-Turn Conversation (10 turns across 3 conversations)

### Conversation A

**Turn 1** (`CONV_A_T1`, easy): "Tell me about Team Management Tools."  
Expected: FACT: status = In Progress

**Turn 2** (`CONV_A_T2`, hard): "Who owns it?"  
Expected: LIST: ['Stefan Hochhuth', 'Aditi Mishra', 'Ankush Das']

**Turn 3** (`CONV_A_T3`, hard): "What tasks are pending?"  
Expected: COUNT: count = 12, status=pending

**Turn 4** (`CONV_A_T4`, hard): "Any overdue ones?"  
Expected: COUNT: count = 9, overdue=true

**Turn 5** (`CONV_A_T5`, hard): "What about the other project?"  
Expected: BEHAVIOR: CLARIFY (forbidden: ['CONFIDENT_WRONG_ENTITY'])


### Conversation B

**Turn 1** (`CONV_B_T1`, easy): "What happened in the SCRUM - 25/06/2026 meeting?"  
Expected: SEMANTIC: resolving a time-sheet discrepancy; adopting new AI-integrated workflows

**Turn 2** (`CONV_B_T2`, hard): "Who was there?"  
Expected: LIST: ['Prashant Kumar', 'Deepak Trivedi', 'Ranu Trivedi', 'Ankush Das', 'Anshu Mishra', 'Utkarsh Srivastava', 'Kamal Kishore', 'Kamal Singh', 'Atul Kumar', 'Umang Kumar']

**Turn 3** (`CONV_B_T3`, hard): "What did Deepak say?"  
Expected: SEMANTIC: Deepak Trivedi asked about the resolution of Stephen's timesheet problem; Deepak Trivedi mentioned AI tools can help with testing


### Conversation C

**Turn 1** (`CONV_C_T1`, easy): "How many tasks does Ranu Trivedi have?"  
Expected: COUNT: count = 672, person=Ranu Trivedi

**Turn 2** (`CONV_C_T2`, hard): "How many of those are overdue?"  
Expected: COUNT: count = 29, overdue=true

