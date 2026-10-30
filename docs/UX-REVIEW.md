# UX review, first pass

How it was done: `node e2e/audit.mjs [--out file.json] [--shots dir] [--page /path]` boots the app on a temporary database, seeds sample data, visits every page in light and dark theme at desktop width and in light theme at phone width (390 px), and measures what a machine can measure. Screenshots (`--shots`) were then read by a person (the review notes below).

## What the audit measures

| Check | Rule used |
|---|---|
| Text contrast | WCAG AA: 4.5:1, or 3:1 for text of 24 px or larger (18.66 px bold) |
| Tiny text | below 12 px |
| Touch targets | at least 44 px on a phone, 32 px with a mouse (WCAG 2.2 asks for 24 px) |
| Unnamed buttons and links | no text, aria-label or title |
| Unlabelled fields | no label, aria-label or title |
| Raw identifiers | snake_case words in visible text |
| Horizontal overflow | page scrolls sideways |

## Result of the shared fixes (47 page and theme combinations)

| | before | after |
|---|---|---|
| Contrast failures | 58 | 0 |
| Text below 12 px | 433 | 0 (one icon-only button hides its label on phones on purpose) |
| Targets too small | 192 | 1 |
| Unlabelled fields | 9 | 0 |
| Pages that scroll sideways on a phone | 3 (board, goals, calendar) | 0 |

What changed, once for the whole app: muted text, overdue red and link colours have their own accessible tokens in light and dark; nothing is smaller than 12 px; sidebar rows, tabs, selects, buttons and icon buttons reach 44 px on phones; bars, headers and form rows wrap instead of overflowing; small checkboxes sit in a larger hit area; the board column name has a label; the delete-column icon is neutral until used.

## Page notes from the screenshots

Reviewed by eye (screenshots in light, dark and phone width): every page, in two rounds. Automations and the assistant were reviewed in their own design rounds.

- **Dashboard:** "Needs attention" is now first (it is the actionable part); activity shows "5 min ago" or "Yesterday, 14:05" instead of a full timestamp with seconds; the life-area list shows only areas that have projects (twelve rows of "0" were noise).
- **Workspace and account:** one long page with eleven sections is now five tabs (Workspace, Notifications, Assistant, Connect other AI tools, Security), the address keeps the tab (`?tab=`), and the autonomy checkboxes sit in a grid.
- **Calendar:** month cells no longer repeat "TASK DUE" on every chip (it is still read by screen readers and shown in the tooltip).
- **Tasks:** on phones the date and priority wrap under the title instead of squeezing it.

- **My Day, Dashboard:** with no AI key the large dark "Daily briefing" block is now one quiet line ("Daily briefing is off: no AI key is set on this server.").
- **Life Areas:** twelve cards each carried an input and a lone plus button; now a small "Add subcategory" button opens the input in place.
- **Goals:** the milestone row (title, date, plus) is one row instead of stacked.
- **Notes and Journal:** the compose form no longer sits above the list. Once there are notes, a "New note" or "New entry" button opens it; with an empty list it is open.
- **Idea Board:** an "Add idea" field at the top (type, Enter); the round plus button is only for phones, so desktop no longer shows two floating circles.
- **Finance:** the add-transaction form opens from an "Add transaction" button once the month has transactions (it opens by itself on an empty month and when the assistant prefills one).
- **Projects:** the red trash icon on every card is neutral; it still asks before deleting.
- **Documents, Reports:** checked; no structural problems found (empty states are clear, controls fit one row).

## Closed in pass 3

- **Duplicate automations from the assistant:** `create_automation` is refused when the workspace already has one with the same name (ignoring case and punctuation) or the same schedule and kinds of steps; the reply names the existing one and points to `update_automation`. The automation guide tells the assistant to check `existing_automations` first.
- **Dashboard gap:** panels flow in two balanced columns, so a shorter panel no longer leaves a hole; "Needs attention" still spans the full width on top.
- **Documents:** a search field (name or project) and a Preview button for images and text, CSV, Markdown and JSON files in a dialog; PDFs open in a new tab. Other types (Word, Excel) have no preview.
- **Reports:** a sort control (newest, oldest, title, type) once there is more than one report.

## Still open

1. The eight per-tab questions from the first audit are mostly settled by the three passes; the remaining ones are product choices (default categories, goal target number).
2. The audit measures contrast, size, labels and overflow. It cannot judge wording, hierarchy or flow; those still need a person's eyes after each larger change (`node e2e/audit.mjs --shots dir`).
