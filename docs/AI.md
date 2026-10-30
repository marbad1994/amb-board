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

## Skills, the dock, reports and MCP
Everything the assistant can do is a **skill** in one registry (`ai/tools.js` for read/analysis/report skills, `ai/actions.js` for write skills). The assistant prompt, the Assistant page ("What it can do") and the MCP endpoint are all generated from that registry, so they cannot drift apart.
- **Read skills:** list_projects, get_project, list_tasks, list_events, budget_metrics, month_summary, month_budget, list_savings_and_debts, search.
- **Analysis skills (deterministic code, the model only narrates):** cross_reference (everything linked to a project/goal/task), analyze_spending (this month vs prior average, unusual categories, uncategorised count), analyze_workload (load per day, heavy days), project_health (risk level and reasons per project), find_gaps (data-quality gaps).
- **Report skill:** generate_report builds a standalone HTML report from section builders (`reports/build.js`): inline CSS, inline SVG charts, no scripts and no external resources, CSP meta tag, every dynamic string HTML-escaped. Private to the user who generated it; previewed in a sandboxed iframe; downloadable. Optional AI commentary is labelled and separate; figures never come from the model.
- **Write skills (always proposals):** create_task, update_task, reschedule_task, add_subtask, add_comment, create_event, create_project, create_transaction, categorize_transaction, create_goal, add_milestone, create_note, create_habit. Each has a validator (against current workspace data), a server-generated description and an executor that runs only after approval. For tasks, events and transactions the UI also offers "Edit first", which rejects the proposal and opens the real form pre-filled.
- **Never available:** budgets, deletions, members/roles/permissions, journal writes, transfers, sending messages.
- **Dock:** a button on every page opens a panel that sends the current page (and project) as verified context, shows proactive suggestions and chats. Suggestions (`ai/suggestions.js`) are plain rules over your data (overdue work, at-risk projects, budget alerts, heavy days, missing plans/milestones/categories, habits): free, explained ("why"), dismissible, role-aware (viewers only get navigation links).
- **MCP:** `POST /api/mcp` (JSON-RPC 2.0: initialize, tools/list, tools/call) with a personal access token (Settings, "Connect other AI tools"). A token is bound to one workspace, stored hashed, shown once, rate limited, and re-checks its owner's current membership and role on every call. Read, analysis and report tools run immediately; `propose_*` tools only create pending proposals that the token owner approves in the app. Browser origins are blocked by the global Origin check; MCP clients are non-browser.

## Workspace awareness, setup plans and automations
- **Awareness:** every assistant request carries a bounded snapshot of the workspace with ids (`ai/digest.js`): counts, projects, life areas, goals, your own habits, expense categories, shared notes, next events, automations. Journal entries and other people's habits are never included. Extra read skills: workspace_overview, list_goals, list_habits, list_automations.
- **setup_plan:** one proposal holding up to 20 ordered steps of any write type. A step may name itself (`ref`) and later steps use `@ref` for the id it created. At proposal time the whole plan is dry-run inside a transaction that is always rolled back (so a bad step rejects the plan and nothing is left behind); on approval it runs in one transaction, re-validating every step, all or nothing.
- **Automations** (`automations/`): a flow is a trigger plus up to 10 steps, saved by a person or proposed by the assistant (`create_automation`, needs approval) and run as that person. Triggers: schedule (daily, weekdays, weekly, monthly, once; wall-clock time in an IANA zone, DST-safe) or event (task completed, task created, transaction recorded, with simple conditions). Steps: create task, change/comment on the triggering task, record a transaction, write a note, add an event, notify, generate a report. Text fields accept a few placeholders (`{{date}}`, `{{trigger.title}}` ...) that are plain text substitution, never code. No AI call happens when a flow runs.
- **Safety:** each (flow, slot) runs once (UNIQUE), a slot missed by more than 24 h is skipped, event flows are capped at 50 runs a day, flows never trigger other flows, the owner's write access is re-checked on every run (a demoted owner's flow is skipped and logged), and every step goes through the same validators as manual changes. Not available to flows: deleting anything, budgets, members, sending messages to anyone else.

## Create budget with AI (prompt and/or bank CSV)
`POST /api/finance/ai-budget/draft` (multipart: `csv`, `prompt`, `month`, `currency`, `signMode`) then `POST /api/finance/ai-budget/drafts/:id/apply`.
- **CSV path:** parsed by code (`finance/csv.js`: delimiter detection, quotes, English/Romanian headers, 1.234,56 vs 1,234.56, DD.MM.YYYY, debit/credit columns or signed amounts). The model receives ONLY de-duplicated merchant texts (dates, amounts and 4+ digit runs removed, top 150 by spend) plus existing category names, and returns an id-to-category mapping. It is never given and never outputs a number. Limits = monthly average of the file per category, rounded up, computed in code. Unknown ids are ignored, names are sanitised, at most 25 new categories (overflow goes to Other).
- **Prompt path:** the model proposes categories and limits; each limit is labelled "A figure you stated" if the number appears in the user's text, otherwise "AI estimate". Invalid or out-of-range numbers are dropped.
- **Both:** the CSV drives the numbers; the prompt only guides category naming.
- **Nothing is created by drafting.** A draft is stored privately (24 h). The user reviews and edits every line, then applies it; apply is owner/admin only (like setting a budget by hand), re-validates all values, creates missing categories (with parents), sets the month's category limits, and optionally imports the file's transactions (idempotent: re-importing the same file creates no duplicates; identical rows within one file stay distinct).
- **Without a working AI provider** a CSV draft still works (categories matched by name, rest in Other) and says so; a prompt-only draft returns 503.
- Data sent to the provider: the description and merchant texts only; this is stated in the dialog before sending.

## Reviews
`GET|POST /api/ai/review/weekly|monthly[?date=YYYY-MM-DD]` builds deterministic facts (`ai/reviews.js`: completed and incomplete tasks, project progress, posted finance per currency, the requesting user's habits, appointments, upcoming deadlines; monthly adds completed projects, goals, category budget performance, previous-month comparison, savings and debts) and asks the model only to phrase them. Cached per user and period; flagged stale when facts change; in-progress periods say so. Journal and notes are excluded.

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
