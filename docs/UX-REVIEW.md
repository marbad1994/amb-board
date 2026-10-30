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

Reviewed by eye: Dashboard, Project board, Finance, Tasks, Calendar, Workspace and account. Not yet reviewed by eye: My Day, Life Areas, Goals and Habits, Notes, Idea Board, Documents, Reports, Projects list, Assistant page.

- **Dashboard:** "Needs attention" is now first (it is the actionable part); activity shows "5 min ago" or "Yesterday, 14:05" instead of a full timestamp with seconds; the life-area list shows only areas that have projects (twelve rows of "0" were noise).
- **Workspace and account:** one long page with eleven sections is now five tabs (Workspace, Notifications, Assistant, Connect other AI tools, Security), the address keeps the tab (`?tab=`), and the autonomy checkboxes sit in a grid.
- **Calendar:** month cells no longer repeat "TASK DUE" on every chip (it is still read by screen readers and shown in the tooltip).
- **Tasks:** on phones the date and priority wrap under the title instead of squeezing it.

## Still open (design decisions, not defects)

1. Finance: the add-transaction form sits above the transaction list and takes more room than the list. Collapse it behind an "Add transaction" button?
2. Dashboard: with no AI key the "Daily briefing" block is a large dark box saying it is not configured. Hide it for non-admins, or make it a one-line notice?
3. Assistant: a near-duplicate automation suggested by the assistant is not detected (only the editor checks for equal names).
4. The eight per-tab questions from the first audit (dashboard goals view, briefing duplication, default categories, goal target number, life areas count, notes form collapse, documents preview and search, idea board button) were never answered.
5. The remaining pages listed above need the same by-eye pass.
