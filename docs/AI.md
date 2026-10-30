# AI architecture (Phase 4)

## What exists
- **Gateway** (`server/src/ai/gateway.js`): provider-independent client for OpenAI-compatible chat APIs. Providers: DeepSeek (`deepseek-chat`), xAI Grok (`grok-4`). Preference order: `AI_PROVIDER`, DeepSeek, Grok. 45 s timeout, one retry on 5xx/429/network errors, fallback to the next provider, non-retryable errors (e.g. 401) are not retried. Every attempt is metered in `ai_usage` (provider, model, purpose, tokens, latency; no prompt content). Per-workspace daily cap `AI_DAILY_LIMIT` (default 100).
- **Facts** (`ai/facts.js`): all numbers (progress, overdue, blocked, schedule assessment) are computed in code. The model only receives facts and writes prose.
- **Summaries** (`ai/summaries.js`): project summary and daily briefing. Stored in `ai_summaries` together with the exact facts used. Unchanged facts reuse the stored text with no provider call; changed facts mark it "stale" in the UI and regenerate on request. Output is parsed as JSON, shape-validated, length-limited and rendered as plain text.
- **Endpoints**: `GET /api/ai/status`, `GET|POST /api/ai/projects/:id/summary`, `GET|POST /api/ai/briefing`. Reading a stored summary needs read access; generating needs write access (viewers cannot spend AI budget).
- The pre-existing Grok task helper and translator (`routes/ai.js`, `routes/translate.js`) are unchanged and still call xAI directly; they are not yet routed through the gateway or metered.

## Assistant (chat) and action proposals
- `POST /api/ai/assistant/chat` runs up to 3 rounds of **read-only tools** (`ai/tools.js`: list_projects, get_project, list_tasks, list_events, budget_metrics, month_summary, search), then a final answer. Tools run server-side with the caller's workspace; the model never sees SQL or chooses a workspace; unknown tool names are rejected; results are capped and labelled when truncated.
- The model can only **propose** changes: `create_task`, `reschedule_task`, `create_event`, `create_project` (`ai/actions.js`). Any other type (budgets, deletes, members/roles/permissions, external messages) is dropped at proposal time and has no executor.
- Each proposal is validated against current data when made, stored as `pending`, and described by a sentence the **server generates from the validated payload** (the model's own wording is not shown as the action). It expires after 24 h.
- `POST /api/ai/assistant/proposals/:id/approve` is the only way data changes. It requires the conversation owner, re-checks their CURRENT role (a demoted user cannot approve), re-validates the target (deleted/archived targets fail with 422 and status `failed`), claims the proposal atomically so it executes once, and writes an audit entry (`ai.action_executed`). Reject is also audited.
- Conversations and proposals are private to the user who created them, even inside a shared workspace. Viewers cannot chat (it spends AI budget) and cannot approve.
- Every turn is metered like other AI calls (up to 4 provider calls per message) against `AI_DAILY_LIMIT`.

## Safety design
- Prompt structure: fixed system prompt (rules + output schema); user data only inside `<data>` as JSON with `<` escaped so text like `</data>` cannot close the block. The system prompt tells the model the data is untrusted.
- Scope: facts queries are all `workspace_id`-bound; tested that another workspace's text never reaches a prompt.
- The summary endpoints give the model no tools. The assistant gives it read-only tools plus proposals that need human approval; it has no write path of its own.
- Missing modules are passed as `not_available` so the model is told to say "not tracked yet" instead of guessing.
- Keys live only in `server/.env` (gitignored) and are never sent to the client or put in prompts.

## Data leaves the server
Task titles, descriptions, owner names and project metadata of the active workspace are sent to the configured provider(s) when someone clicks Generate. Journal/notes/finance are not built yet and so are not sent. Add a workspace-level opt-out before opening to other users (TODO).

## Verification status
- Mocked (local fake provider; `server/test/ai.test.js`, `server/test/assistant.test.js`, browser E2E): gateway fallback/retry/limits, caching, isolation, injection delimiting, tool loop, proposal/approval flow, permissions, UI.
- NOT verified live: this sandbox's network policy blocks `api.deepseek.com` and `api.x.ai`, so no real model call has been made from here. Run `npm run ai:check -w server` on your machine, then generate a summary in the app. Output quality from the real models is untested.

## TODO
Native function-calling (the loop uses JSON replies for provider independence), weekly/monthly/financial summaries, user-defined automation policies that pre-authorise narrow actions, streaming responses, cost caps in currency, per-workspace AI opt-out, routing the legacy helper through the gateway, evaluation set.
