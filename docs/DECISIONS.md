# Decision log

| ID | Decision | Rationale | Status |
|---|---|---|---|
| D1 | Keep Express + node:sqlite + React/Vite instead of Next.js + Postgres + Prisma | Brief: build on the existing app, do not rebuild without a clear reason. SQLite is adequate for the single-node first release; all SQL is behind plain modules and versioned migrations to ease a later move | Needs owner approval |
| D2 | Own session auth: scrypt password hashes, opaque random session tokens stored as SHA-256, HttpOnly SameSite=Lax cookie | No new heavy dependency; mature primitives from `node:crypto` | Implemented |
| D3 | Workspace context via `x-workspace-id` header, membership checked server-side every request | Supports multiple workspaces per user without per-route ids | Implemented |
| D4 | Legacy rows (pre-auth projects/ideas) are adopted by the first registered account's personal workspace | Preserves existing data; later registrants cannot see it | Implemented |
| D5 | Invitations use a one-time secret token shown to the inviter; accepted by a logged-in user whose email matches | No email delivery configured; avoids auto-granting access by unverified email | Implemented |
| D6 | Project = existing kanban board; Task = existing card | Preserves existing model and UI | Implemented |
| D7 | Not-in-workspace objects return 404, not 403 | Prevents id enumeration across workspaces | Implemented |
| D8 | Uploads: authenticated download endpoint, `nosniff`, forced attachment except raster images | Prevent stored XSS and unauthenticated access | Implemented |
| D9 | Lucide icons, system sans-serif font, no emoji, no monospace | Owner preferences + mockup direction | Implemented |
| D10 | Rate limiting is in-process memory | Single node; replace with shared store when scaling | Known limitation |
