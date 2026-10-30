# Decision log

| ID | Decision | Rationale | Status |
|---|---|---|---|
| D1 | Keep Express + node:sqlite + React/Vite instead of Next.js + Postgres + Prisma | Brief: build on the existing app, do not rebuild without a clear reason. SQLite is adequate for the single-node first release; all SQL is behind plain modules and versioned migrations to ease a later move | APPROVED by owner 2026-10-30 |
| D2 | Own session auth: scrypt password hashes, opaque random session tokens stored as SHA-256, HttpOnly SameSite=Lax cookie | No new heavy dependency; mature primitives from `node:crypto` | Implemented |
| D3 | Workspace context via `x-workspace-id` header, membership checked server-side every request | Supports multiple workspaces per user without per-route ids | Implemented |
| D4 | Legacy rows (pre-auth projects/ideas) are adopted by the first registered account's personal workspace. Owner requirement: existing data must stay intact. A full database backup (`board.sqlite.bak-<timestamp>`, VACUUM INTO) is written before any pending migration touches a database that already has data | Preserves existing data; later registrants cannot see it. Verified by `server/test/upgrade.test.js` | Implemented |
| D5 | Invitations use a one-time secret token shown to the inviter; accepted by a logged-in user whose email matches | No email delivery configured; avoids auto-granting access by unverified email | Implemented |
| D6 | Project = existing kanban board; Task = existing card | Preserves existing model and UI | Implemented |
| D7 | Not-in-workspace objects return 404, not 403 | Prevents id enumeration across workspaces | Implemented |
| D8 | Uploads: authenticated download endpoint, `nosniff`, forced attachment except raster images | Prevent stored XSS and unauthenticated access | Implemented |
| D9 | Lucide icons, system sans-serif font, no emoji, no monospace | Owner preferences + mockup direction | Implemented |
| D10 | Rate limiting is in-process memory | Single node; replace with shared store when scaling | Known limitation |
| D11 | AI providers: DeepSeek and xAI Grok, behind a provider-independent gateway (Phase 4). Existing Grok helper stays | Owner choice 2026-10-30. API keys still needed (`X_GROK_API_KEY`, DeepSeek key) | Approved, not built |
| D12 | Button teal darkened for contrast (`#0b7a70`); bright teal `#15baa9` for accents on navy | Owner OK 2026-10-30 | Implemented |
| D13 | Money = integer minor units, positive amounts, direction by type; 2-decimal currencies only | Avoid float error; JPY-style zero-decimal currencies unsupported for now | Implemented |
| D14 | Budget maths in `finance/calc.js` (actual = posted expenses - refunds, planned separate, forecast = actual + planned); other currencies reported separately, never converted | Spec section 9/10; no FX source chosen | Implemented |
| D15 | Budget approval/change requires owner or admin; members may record spending | Spec: AI/members must not silently change approved budgets | Implemented |
| D16 | Calendar feed is derived (events + task due dates + project dates) rather than copied into events | One source of truth; rescheduling a task/project updates the calendar with no sync step | Implemented |
| D17 | Recurring expenses and tasks materialise lazily (on summary read / on completion), idempotent via external_ref / spawned marker | No scheduler yet; deterministic and testable | Implemented; replace with jobs in hardening |
| D18 | Event times stored as wall-clock + IANA zone; occurrences keep wall time across DST | Matches how people schedule; UTC instant computed per occurrence | Implemented |
| D19 | Voiding a transaction (not deleting) | Audit trail; excluded from all totals | Implemented |
