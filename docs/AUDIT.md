# AMB Board — Phase 0 Audit

Date: 2026-10-30. Sources: Project Brief PDF v1.0, Standalone HTML mockup ("Interactive Concept", localStorage only), existing repository.

## 1. Current state (existing application, preserved)

| Area | State |
|---|---|
| Stack | Node 22 + Express 4, `node:sqlite`, multer; React 19 + Vite + react-router + dnd-kit + lucide-react; plain CSS |
| Auth | None. Display name in localStorage; every API route is public |
| Data scoping | None. Single global namespace |
| Implemented | Projects (kanban boards), custom columns (reorder), cards (status, owner, creator, labels, comments, attachments, drag/drop), Idea Board (sticky notes), voice dictation (EN/RO/SV) with Grok translation, AI task helper (xAI Grok), mobile-first UI |
| Not implemented | Life Areas, subtasks, due dates/priority/recurrence, goals, calendar, finance, habits, notes/journal, documents, AI assistant/summaries, automations, notifications, accounts, workspaces, billing, tests, CI |
| Security gaps | Public API, public `/uploads`, wildcard CORS, uploads served inline (stored-XSS risk), no validation of ownership on any id |

## 2. Source conflicts and resolutions

| # | Conflict | Resolution |
|---|---|---|
| C1 | Master prompt reference stack is Next.js/Postgres/Prisma; Brief and prompt both say preserve the existing app | Keep Express/SQLite/React for now. Postgres migration deferred; needs approval (see DECISIONS D1) |
| C2 | Master prompt calls cards "Tasks"; app calls them cards inside kanban boards belonging to a "project" | Project = existing board; Task = existing card. Subtasks added in Phase 2 |
| C3 | Mockup uses emoji/unicode glyphs and "Demo mode" localStorage | Not reproduced. Lucide icons only; no demo data in production paths |
| C4 | Brief: statuses To Do / In Progress / Done "preserve existing" | Existing board columns and card statuses untouched |
| C5 | Brief section 14: original screenshots were not supplied | Visual direction taken from the HTML mockup only; no claim of exact reproduction |

## 3. Requirements checklist (status legend: DONE / PARTIAL / TODO / BLOCKED)

Master-prompt sections. Evidence column is filled only for tested items.

| Req | Item | Status | Evidence |
|---|---|---|---|
| 5 | Identity/workspace/membership/role entities | DONE (Phase 1) | `server/test/*.test.js` |
| 5 | Subscription, UserPreferences, NotificationPreferences | TODO | |
| 6 | 12 configurable Life Areas, custom names, subcategories, archive | DONE (Phase 1) | `lifeareas.test.js` |
| 6 | Life Area summaries (goals/finance/docs) | TODO | needs later modules |
| 7 | Project CRUD, archive/restore, linked Life Area, status, priority, start/target dates, derived progress | DONE (Phase 2) | `core.test.js` |
| 7 | Project owner/collaborators, budget, milestones, labels, comments | TODO | |
| 7 | Kanban (task board + project status board) and grid view | DONE | E2E |
| 7 | AI overview | TODO | |
| 8 | Tasks: subtasks, due dates, priority, completion history; views Open/Overdue/Upcoming/Assigned to me/Completed | DONE (Phase 2) | `core.test.js`, E2E |
| 8 | Recurrence, reminders, assignment to members (owner is free text), By Life Area/By Project views, dependencies | TODO | |
| 9 | Project <-> budget <-> transactions <-> calendar linking; deadline/due-date visibility; scheduling pressure flag | DONE (Phase 3) | `finance.test.js`, `calendar.test.js`, E2E |
| 9 | Goals/documents/notes links; calendar events linked to tasks in UI | TODO | API supports card_id on events; no UI |
| 10 | Finance: project budgets, transactions (income/expense/refund/transfer, planned vs posted), categories, accounts, monthly summary per currency, subscriptions/recurring, CSV export, budget alerts | DONE (Phase 3) | `finance.test.js`, E2E |
| 10 | Savings goals, emergency fund, debts, investments, FX conversion, imports, attachments on transactions, category/account management UI | TODO | |
| 11 | Calendar: month + agenda views, events, recurrence, time zones/DST, filters | DONE (Phase 3) | `calendar.test.js`, E2E |
| 11 | Week/day views, reminders, external calendar sync (no provider adapters built) | TODO | |
| 12 | My Day | TODO | |
| 13 | AI summaries: project + daily briefing (grounded, cached, traceable facts) | PARTIAL | mocked tests only; live providers unverified (`docs/AI.md`). Weekly/monthly/financial TODO |
| 14 | AI assistant: chat, read-only tools over authorised data, action proposals with explicit approval, audit | DONE (Phase 4) | `assistant.test.js` (mocked provider), E2E. Live model behaviour unverified |
| 14 | Assistant: weekly/monthly summaries, scheduling suggestions beyond single proposals, automation policies | TODO | |
| 15 | Idea Board + convert to project (idea kept and linked, one-time) | DONE (Phase 2) | `core.test.js`, E2E |
| 15 | Idea labels/AI organisation | TODO | |
| 16 | Habits/Goals/Challenges | TODO | |
| 17 | Notes/Journal/Documents | TODO | card attachments only |
| 18 | Priority/urgency/activity-type attributes | TODO | |
| 19 | UI shell per mockup (navy sidebar, teal accent), responsive, global search, Quick Add Task | PARTIAL | shell, dashboard, life areas, projects board, tasks, settings |
| 20 | AI safety: high-impact actions impossible, approval required for every AI change | DONE | `assistant.test.js` |
| 20 | Auth, sessions, rate limiting, RBAC, server-side scoping, CSRF, headers, secure files | PARTIAL | see SECURITY.md; MFA, email verification, password recovery not implemented |
| 21 | Automations: recurring expenses -> planned transactions and recurring tasks (idempotent, lazy, no scheduler); computed budget alerts | PARTIAL | persisted notifications, scheduler/jobs, rules engine, retries TODO |
| 22 | Billing/entitlements | TODO | |

| 24 | Tests | PARTIAL | 59 API tests (`npm test`; 20 use a mocked AI provider) + 19-step browser E2E (`npm run e2e`). Covered: 1-3, 5-13 (AI mocked), 15, 16, 17, 18, 20-23; partly 14, 19, 24. Not covered: 4 (partly), 25 (backup/restore procedure), live AI |
| 25 | Docs | PARTIAL | this file, DECISIONS, SECURITY |

## 4. Proposed architecture (summary)

- Modular monolith: `server/src/{auth,workspaces,lifeAreas,...}` routers over a repository-free SQLite layer with versioned SQL migrations (`server/src/migrations.js`).
- Every request: session cookie -> user -> workspace (header `x-workspace-id`, membership verified) -> role permission -> handler. Object lookups always join to `workspace_id`; foreign-workspace ids return 404.
- Future AI gateway, jobs and automations plug into the same workspace context (Phase 4).
- Finance maths will be deterministic integer-minor-unit code; AI only explains.

## 5. Blockers / decisions needing the product owner

1. ~~SQLite vs Postgres~~ Resolved: keep stack (D1 approved).
2. LLM providers chosen: DeepSeek + xAI Grok (D11). Still need DeepSeek API key.
3. Email delivery provider (verification, password recovery, invitations) and billing provider/credentials.
4. Mockup toured in a browser 2026-10-30; gaps: project-level To Do/In Progress/Done board with progress and status pills, top-bar search, Quick Add Task (Phase 2).
5. Language strategy (EN/RO labels) is still open in the brief.

## 6. Delivery honesty note

The master prompt describes a multi-month program. This session delivers Phase 0 and Phase 1 only. Everything marked TODO above is not built.
