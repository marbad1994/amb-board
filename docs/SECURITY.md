# Security and permissions (Phase 1)

## Implemented (each covered by `server/test/*.test.js` unless noted)
- Passwords: scrypt (N=16384, r=8, p=1), per-user salt, constant-time compare, 10-200 char policy. Timing equalised for unknown accounts; identical error for unknown email and wrong password.
- Sessions: 32-byte random token in an HttpOnly, SameSite=Lax cookie (`Secure` when `NODE_ENV=production` or `COOKIE_SECURE=true`). Only the SHA-256 is stored. 30-day absolute expiry. Logout, logout-all, and password change revoke server-side.
- Throttling: 5 failed logins per email per 15 min lock the account (429, even with the right password); registration capped per IP (`REGISTER_RATE_MAX`, default 10/h). In-memory, single process.
- CSRF: SameSite=Lax plus rejection of state-changing requests whose `Origin` host differs from `Host` (`ALLOWED_ORIGINS` to extend). CORS is off unless `CORS_ORIGIN` is set.
- Headers: CSP (self only), nosniff, X-Frame-Options DENY, Referrer-Policy, HSTS when `COOKIE_SECURE=true`.
- Authorization: roles owner/admin/member/viewer. Reads need membership; writes need owner/admin/member; life areas and members need admin; workspace rename needs owner. Admin grants and admin changes need owner.
- Isolation: every object lookup joins to `workspace_id`; foreign ids return 404 (tested across 18 routes/verbs). A non-member `x-workspace-id` returns 404. Cards cannot be moved into foreign columns; projects cannot reference foreign life areas.
- Invitations: single-use random token (hash stored), 7-day expiry, bound to the invitee's email, revocable, not allowed for personal workspaces.
- Files: uploads only for cards in the caller's workspace; downloads via authenticated endpoint; non-raster types forced to `application/octet-stream` + attachment; 25 MB limit; random on-disk names.
- Audit log rows for registration/login/password/workspace/member/invitation/project/life-area events.
- Browser E2E (`npm run e2e`): sign-in, 12 areas, project/task, isolation between two users, mobile layout, keyboard focus.

## Not implemented yet
MFA, email verification, password recovery, OAuth, per-session management UI, file-type allow-list/antivirus, encryption at rest, backup/restore procedure (test scenario 25), dependency scanning, CI, subscription entitlements, AI privacy controls (no AI gateway yet; the legacy Grok helper sends task text to xAI when `X_GROK_API_KEY` is set), data export/retention.

## Known limitations
- Rate limiter and sessions' cleanup are per-process; expired sessions are rejected but not yet purged.
- `PATCH /cards/:id` accepts free-text `owner`; it is not tied to workspace members yet.
- First-account adoption of legacy data (DECISIONS D4) assumes the first registrant is the legitimate owner; register on a fresh deployment before exposing it publicly.
