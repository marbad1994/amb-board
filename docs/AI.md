# AI architecture (Phase 4, first slice)

## What exists
- **Gateway** (`server/src/ai/gateway.js`): provider-independent client for OpenAI-compatible chat APIs. Providers: DeepSeek (`deepseek-chat`), xAI Grok (`grok-4`). Preference order: `AI_PROVIDER`, DeepSeek, Grok. 45 s timeout, one retry on 5xx/429/network errors, fallback to the next provider, non-retryable errors (e.g. 401) are not retried. Every attempt is metered in `ai_usage` (provider, model, purpose, tokens, latency; no prompt content). Per-workspace daily cap `AI_DAILY_LIMIT` (default 100).
- **Facts** (`ai/facts.js`): all numbers (progress, overdue, blocked, schedule assessment) are computed in code. The model only receives facts and writes prose.
- **Summaries** (`ai/summaries.js`): project summary and daily briefing. Stored in `ai_summaries` together with the exact facts used. Unchanged facts reuse the stored text with no provider call; changed facts mark it "stale" in the UI and regenerate on request. Output is parsed as JSON, shape-validated, length-limited and rendered as plain text.
- **Endpoints**: `GET /api/ai/status`, `GET|POST /api/ai/projects/:id/summary`, `GET|POST /api/ai/briefing`. Reading a stored summary needs read access; generating needs write access (viewers cannot spend AI budget).
- The pre-existing Grok task helper and translator (`routes/ai.js`, `routes/translate.js`) are unchanged and still call xAI directly; they are not yet routed through the gateway or metered.

## Safety design
- Prompt structure: fixed system prompt (rules + output schema); user data only inside `<data>` as JSON with `<` escaped so text like `</data>` cannot close the block. The system prompt tells the model the data is untrusted.
- Scope: facts queries are all `workspace_id`-bound; tested that another workspace's text never reaches a prompt.
- The model has no tools and cannot write anything: no action proposals yet, so nothing it says changes data.
- Missing modules are passed as `not_available` so the model is told to say "not tracked yet" instead of guessing.
- Keys live only in `server/.env` (gitignored) and are never sent to the client or put in prompts.

## Data leaves the server
Task titles, descriptions, owner names and project metadata of the active workspace are sent to the configured provider(s) when someone clicks Generate. Journal/notes/finance are not built yet and so are not sent. Add a workspace-level opt-out before opening to other users (TODO).

## Verification status
- Mocked (local fake provider, `server/test/ai.test.js`, E2E step 11): gateway fallback/retry/limits, caching, isolation, injection delimiting, permissions, UI.
- NOT verified live: this sandbox's network policy blocks `api.deepseek.com` and `api.x.ai`, so no real model call has been made from here. Run `npm run ai:check -w server` on your machine, then generate a summary in the app. Output quality from the real models is untested.

## TODO
Assistant chat with tools, action proposals/approval workflow, weekly/monthly/financial summaries, cost caps in currency, per-workspace AI opt-out, routing the legacy helper through the gateway, evaluation set.
