---
name: hhhh-design-guidelines
description: HHHH's UI/UX design system rules — buttons, tabs, accordions, icons, tables, filters, and brand identity. Use whenever building, reviewing, or restyling any UI component in this codebase (or generating a design guide/master prompt from it), so output matches the house style instead of generic defaults.
---

# HHHH Design Guidelines

Extracted from HHHHTeams SharePoint's "Design Guide" portfolio (source of truth: Figma UI Kit + these task records). Status of each section below reflects the underlying task's real completion — several are still "For Approval" or in progress, not final sign-off. This skill is a **consolidation checkpoint**, not a replacement for the still-open task ["Prepare for the handover - compile UX knowledge"](taskId:A1445) (Figma↔Perplexity integration + Master Design Guide compilation) — re-run extraction once that task lands real Figma exports.

Source of truth links:
- Figma "Hochhuth Consulting UI-KIT from Zlata" — https://www.figma.com/design/vTkjb37cPsdL4r4Sww5Lhn/
- Figma "HHHH Design Style Guide" — https://www.figma.com/design/BpKOzuoV0Z0C4ICyHZJOLO/ — a **more detailed, more current** master file with its own pages for Color and Typography, Icons, Breadcrumbs, Buttons, Input fields, Checkboxes/Radio Buttons, Toggle, Tabs, Tooltips, Accordions, and Popups. Only the **Popups** page has been extracted into this skill so far (below) — the rest of that file likely supersedes/refines the SharePoint-ticket-derived sections above and is worth a follow-up extraction pass.

## Interactive elements — color

- Interactive elements (buttons, icons, checkboxes, radio buttons, links to other pages/pop-ups) use **site-blue** in default state, everywhere, no exceptions.
- Disabled state: grey, not blue.
- Info and edit icons: blue.

## Buttons *(task A449/A449-W1, status: For Approval — treat as draft, not final)*

- **Primary** (filled): the action users are most likely to take. Only one primary button visible at a time.
- **Secondary** (stroke, no fill): alternative action, less visual weight.
- **Tertiary** (text only): least emphasis, bold/semibold font depending on priority.
- **Pairing order**: primary always placed first (e.g. Save/Cancel, OK/Cancel), secondary second.
- **State rule**: if the page requires minimum user input before an action is valid (e.g. Create Task), the primary button starts **disabled (grey)** and only becomes active (blue) once required inputs are filled. If no input is required, primary starts active (blue).
- Icon buttons: no stroke; same default/disabled color rule as text buttons.
- **Label wording**:
  - Use an active verb + noun ("Save changes", not "Yes/No").
  - Explain the resulting action, not the mechanism.
  - Keep labels short, single line — never wrap.
  - Never use negative/cancel-of-cancel phrasing.
  - Standardize on **"Save"** and **"Submit"** only — rename any "OK" to whichever fits. In a Yes/No confirmation popup, "OK" = "Yes".

## Tabs *(task A?, status: For Approval)*

- Flat (single row): 1px stroke `#B5B3B3`; underneath stroke 2px. Unselected tabs divided by short 30px verticals; selected tab divided by longer 45px verticals.
- Selected tab: accent color text (`#2F5596` HHHH / `#DC0018` E+E) with a 4px accent underline.
- Text: Segoe UI, Regular, 150% line spacing, 16px. Unselected tab text `#0E0E0E`.
- Minimum gap between tabs: 14px.
- **Complex/overflow tabs**: if too many for one row and no sub-tabs exist, wrap to a second row. If sub-tabs (two-level) exist, instead show left/right arrow icons (24×24px) to page through hidden tabs — don't wrap.
- Two-level tabs: sub-tab row sits 12px below the first row, same visual style as flat tabs.

## Accordion *(task T5656, status: Completed — reliable)*

Two types:
1. **Type 1** (structures an array of text, not standalone): arrows left-aligned, semibold headings, no dividing lines (spacing handles separation). Hover → background `#FAFAFA`. Disabled → text `#BDBDBD`, arrow `#E0E0E0`. When expanded: divider line appears under heading; content left-aligned; multiple sections can be open simultaneously.
2. **Type 2** (standalone element, can nest): background `#FAFAFA`, outline `#E4E4E4`, slightly rounded corners. Hover → background turns white. Disabled → outline removed, text `#BDBDBD`, arrow `#E0E0E0`. Nested accordions: white background always, text sized as body text (not heading size). Long accordions get a "close" button at the bottom to collapse.

## Icons *(task A447, status: Task Completed 90% — reliable)*

- Comment icon: **filled** = comments exist, **lined** = no comments, **half-filled** = comments exist elsewhere but not on the current item. Background-dependent: white icon on site-colored background, site-colored icon on white background. Position: right side, next to the cross icon. Tooltip on hover shows the comment content.
- Tag icon: site-colored "+" when untagged, filled site-colored when tagged. Tooltip on hover shows tag name + cross icon to un-tag.
- All interactive icons: blue default, grey disabled — same rule as buttons.

## Tables *(task A560-W2, status: For Approval)*

Team Portfolio table = the reference example.

- All header fields same height, variable width; general checkbox + icons centered horizontally.
- Every field has a sort arrow — grey triangle only, one style, no variants.
- Header level 1 (count, search, action buttons/icons): background `#E9E9E9`, fixed during scroll.
- Header level 2: if a partial selection exists, the header checkbox shows an indeterminate state. Header field widths must match their content column widths.
- Row content: center-aligned; row separators `#EEEEEE` (Shareweb) / `#CCCCCC` (HHHH).
- Hierarchical rows (PX levels): 4 levels, each its own shade — L1 `#DDDDDD`, L2 `#EBEBEB`, L3 `#F7F5F5`, L4 `#FFFFFF`. All levels align on the same vertical line; only color/arrow-presence differs between them.
- Hover: row background → `#F5F5F5`. In color-coded (leveled) tables, **only level 1** changes on hover — other levels stay unchanged.
- Minimum 2 characters must remain visible in any truncated text field.
- Fixed-width fields (Due Date, Created, etc.) must use the **same width across every table** in the app — don't let one table's Due Date column differ in width from another's.
- Title-column truncation rule (from the "Last Modified Views" table task): max 2 rows, then `...`, full text on hover via a dark tooltip positioned below the title.

## SmartSearch filters *(task A450, status: working on it, 10%)*

Three states — super-collapsed, collapsed, expanded:
- Super-collapsed: selected-filter summary lives at the "All Filters" level.
- Collapsed: "All Filters" arrow + text are site-colored, semibold. Other filter arrows: dark grey `#555555`, text `#333333` semibold. No filters selected → show "No filters selected yet. Select the parameters to filter" and disable "Add Smart Favorite".
- Expanded: divider `#BDBDBD` appears under each opened category title. Nested-accordion arrows inside filters: `#999999`. Team-member filters render as bubbles, not a plain list.
- Alignment rule: when two filter groups have an equal checkbox count, their list widths and left-alignment must match exactly (verified example: "Sites" vs "Client Category", both 3 checkboxes).

## Brand identity *(task A448, status: 90% complete — Robert Ungethuem)*

Required elements for any brand-guide artifact: company name, brand story, logo (primary/secondary/sizes/on-background/misuse), color palette (core/base/accent + accessible combos), typography, localized languages, icons, UI-kit components, email signature. Optional: photography, illustration, tone of voice, tagline, grid/spacing.

Reference brand guides used as benchmarks: American Red Cross, Dropbox, Slack, The Guardian, Twitter (links in the source task if needed again).

## Popups / modals *(Figma "HHHH Design Style Guide", page "Popups" — the most detailed, precise spec in either source; treat as authoritative)*

All popups must follow a consistent top-to-bottom structure inside a centered blocking modal: fixed header, tab navigation, scrollable form content, audit/metadata information, and a fixed footer with actions.

**1. Overlay**
- The popup sits above a blocking page overlay so the background is visually suppressed and cannot scroll while the modal is open.
- Color: dark neutral overlay (black/deep gray), low opacity — avoids introducing color cast behind the popup.
- Recommended value: `rgba(0, 0, 0, 0.5)`. Acceptable range: 0.35–0.6 opacity depending on screen density and popup shadow strength.
- Background interaction: disabled — the underlying page must not scroll or receive pointer interaction while the modal is open.

**2. Recommended size**
- Size depends on content — a popup with little content should shrink to fit, not force a fixed large size.
- Max width: **1400px** for large-desktop editing flows, so the modal doesn't become excessively wide on big screens while still supporting form-heavy layouts. (Extends the "~90% of viewport width" rule into a usable desktop ceiling.)
- Min height: **680px** where content allows, so header/body/footer stay proportionate during editing-heavy workflows.

**3. Corner radius and inner padding**
- Corner radius: **16px**.
- Inner padding: header 24px vertical / 24px horizontal; body 24px on all sides; footer 16px padding, right-aligned actions.
- Space between modal edge and first component group in body: 24px.
- Space between major groups inside body: 24px; between a label and its field: 4px.

**4. Header section**
- Fixed at the top of the modal container, stays visible while the body scrolls.
- Contains the popup title aligned left, utility actions (close/menu/contextual icons) aligned right.
- Full width of the modal, separated from the body by a 1px bottom border.

**Tab navigation** (for popups with multiple content sections)
- Sits directly beneath the header, stays visible while the body scrolls.
- Full width, aligned with the body content grid; tabs read left to right in a single horizontal row when space allows.
- Active tab state uses brand color only — no new highlight colors or decorative backgrounds.

**5. Main content**
- Occupies the central scrollable region; use a single primary content column with grouped fields, not competing side-by-side panels (matches the popup's real use case: title, dates, rank, categories, links, task metadata, and selections in a predictable enterprise form layout).
- Begins directly below tab navigation, vertical stacked flow for major sections.
- Labels align consistently to the left edge of the content column; controls appear directly below labels or inline with related controls when they belong to the same input group (e.g. date fields + recurrence options).
- No double scrollbar inside the modal body.

**6. Footer**
- Must remain visible while content scrolls underneath (fixed/sticky within the modal).
- Background `#FAFAFA`, top border 1px solid `#DDDDDD`, 16px padding.
- Buttons on the right: Save = primary (`#2F5596`, white text); Cancel = secondary (white background, `#2F5596` border/text); Disabled = `#DDDDDD` background/border, `#777777` text.
- Footer never scrolls — only the popup body scrolls.

**Audit info (edit popups)**
- Created/Last Modified shown on the **left** side of the footer: `"Created dd/mm/yyyy By User name"`, `"Last modified dd/mm/yyyy By User name"` — the user name styled in site-blue (`#2F5596`).
- "Delete this item" text button can sit on the left side too.
- Vertical stacking order: Created → Modified → Delete.

### Comment box component *(same Figma page — used for comment/reply fields inside popups)*
- Post button: placed below the textarea, aligned right.
- Border: 1px solid `var(--BorderGrey)` (shared input border treatment).
- Text color: `var(--TextBlack)`. Font: Segoe UI, 14px regular for body text; labels Segoe UI 14px regular or semibold depending on whether it's a field label or section title.
- Textarea minimum height: 96–120px, to support multi-line message entry (practical extension of the form-input rules, given the comment field's role).
- Resize behavior: vertical only — layout must stay stable horizontally.
- *(Gap: the first few "Structure" bullets above the Visual rules — likely covering author/timestamp/threading — weren't captured in this pass; worth a follow-up look at that Figma page if needed.)*

## Recurring feedback patterns not yet formalized into a rule

These surfaced repeatedly as one-off tickets (mostly already closed individually) but have **no single consolidated Design Guide entry** — worth promoting to their own rule the next time this skill is regenerated:

- **Date formatting** inconsistency across modules (Categories Weekly Report, Meeting Popup, Edit Contact Popup, HR Recruiting graduation date) — no single canonical date format is documented anywhere in the Design Guide hierarchy itself.
- **Comma spacing** in list/text displays — mentioned as a recurring reviewer note, but no matching ticket found in Qdrant at all; likely only exists as inline PR/task comments, never promoted to a ticket.

## Known gaps (Design Guide items still empty / Not Started)

- **General Design Guide for HHHH** (A1353, owner Kristina Kovach, 0%) — placeholder, no content yet.
- **Design Guide Rules based on exported tasks** (A1354, owner Kristina Kovach, 0%) — the task for exactly the pattern-mining work this skill partially does; not started.
- **Design Guidelines Checklist** (10%) — pre-launch component checklist, still being built.

## AI master-prompt direction (already underway — task A1330 / A1330-W1)

The team's own stated goal for "Design Guide - Master Guides for AI usage": produce 1-3 reusable master prompts per brand theme covering color tokens, typography, spacing scale, radii, shadows, icon style, and core components (buttons/inputs/cards/nav/tables/alerts/modals/tags/forms) — for (1) restyling existing UI/code into house style, (2) generating new on-brand screens, and (3) an optional design-critique prompt. This SKILL.md is a first-pass input toward that deliverable, not a replacement for it — the task itself is still only 10% complete and expects Figma as the canonical source once the handover task (A1445) sets up the Figma↔AI connector.
