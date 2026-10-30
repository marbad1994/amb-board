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
| 7 | Project CRUD, archive/restore, owner, linked Life Area | PARTIAL | life area link + archive done; dates/budget/priority TODO |
| 7 | Kanban view | DONE (pre-existing) | manual |
| 7 | List view, milestones, AI overview | TODO | |
| 8 | Tasks with subtasks, due dates, recurrence, views | TODO | cards exist; none of the extras |
| 9 | Project/budget/calendar linking | TODO | |
| 10 | Finance | TODO | |
| 11 | Calendar | TODO | |
| 12 | My Day | TODO | |
| 13 | AI summaries | TODO | |
| 14 | AI assistant | TODO | existing AI task helper preserved |
| 15 | Idea Board + convert to project | PARTIAL | board preserved, now workspace-scoped; conversion TODO |
| 16 | Habits/Goals/Challenges | TODO | |
| 17 | Notes/Journal/Documents | TODO | card attachments only |
| 18 | Priority/urgency/activity-type attributes | TODO | |
| 19 | UI shell per mockup (navy sidebar, teal accent), responsive | PARTIAL | shell, dashboard, life areas, settings |
| 20 | Auth, sessions, rate limiting, RBAC, server-side scoping, CSRF, headers, secure files | PARTIAL | see SECURITY.md; MFA, email verification, password recovery not implemented |
| 21 | Automations/notifications | TODO | |
| 22 | Billing/entitlements | TODO | |

| 24 | Tests | PARTIAL | 14 API tests (`npm test`, scenarios 1-3, 17, 18, 20 partial) + 10-step browser E2E (`npm run e2e`); scenarios 4-16, 19, 21-25 not built |
| 25 | Docs | PARTIAL | this file, DECISIONS, SECURITY |

## 4. Proposed architecture (summary)

- Modular monolith: `server/src/{auth,workspaces,lifeAreas,...}` routers over a repository-free SQLite layer with versioned SQL migrations (`server/src/migrations.js`).
- Every request: session cookie -> user -> workspace (header `x-workspace-id`, membership verified) -> role permission -> handler. Object lookups always join to `workspace_id`; foreign-workspace ids return 404.
- Future AI gateway, jobs and automations plug into the same workspace context (Phase 4).
- Finance maths will be deterministic integer-minor-unit code; AI only explains.

## 5. Blockers / decisions needing the product owner

1. Approve staying on SQLite for the first release vs. moving to Postgres now (D1).
2. Provide an LLM provider key and choice for Phase 4 (existing app uses xAI Grok).
3. Email delivery provider (verification, password recovery, invitations) and billing provider/credentials.
4. Brief section 14 screenshots, if exact reproduction is required.
5. Language strategy (EN/RO labels) is still open in the brief.

## 6. Delivery honesty note

The master prompt describes a multi-month program. This session delivers Phase 0 and Phase 1 only. Everything marked TODO above is not built.
