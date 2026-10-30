# Assistant assessment (chatbot design framework)

Scope: `server/src/ai/assistant.js`, `actions*.js`, `tools.js`, `skills.js`, `client/src/components/AssistantChat.jsx`. Read from code and tests; not measured against the live models, so quality statements are design judgements.

## Verdict against "intent first, response second"

There is no explicit intent layer. One model call per round chooses between calling a skill and giving a final answer with proposals, with about 30 skills and 45 proposal types in one prompt. Deterministic routing exists only for `/slash` skills, `/stop` and the plain-words "create an automation" trigger.

Strong: proposal allowlist, workspace-scoped id validation, approval for every write, destructive types never auto-approved, untrusted-data handling, workspace digest on every request, guided skills.
Weak: intent routing is unmeasured; slot filling exists only in `/create-automation`; fallbacks were generic (addressed below); no quality metrics (addressed below).

## Intent catalog (derived from the code)

| Group | Intents | Surface | Priority |
|---|---|---|---|
| Understand | overview, overdue, workload, project health, spending, gaps, cross-reference, search | read and analysis skills | High |
| Plan and change work | create, update, move, reschedule, complete, delete task, project, goal, habit, event, note | proposal types | High |
| Money | categorise, create, void, delete category, monthly budget, transaction | proposals | High |
| Build flows | create, update, test, run, delete automation, email template | skills, `/create-automation` | High |
| Multi-step setup | setup_plan, copy to workspace | proposals | Medium |
| Outside world | web search, read page, MCP tools, browser fill | skills | Medium |
| Meta | /skills, /stop, "what can you do" | deterministic | Medium |

## Dialogue flows

| Pattern | State |
|---|---|
| Single-turn Q and A | Good (digest means few clarifying questions) |
| Multi-turn slot filling | `/create-automation`, `/add-transaction`, `/add-task`, `/add-event` |
| Confirmation | Excellent (approval cards state the exact effect; red warning on deletes) |
| Branching | Suggestion chips; now guaranteed server-side (see below) |
| Handoff | Not applicable (single user). The analogue is "I cannot do that, here is where to click" and it is not designed yet |

## Fallback strategy

Before: an unreadable model reply was a hard 502; an exhausted tool budget produced a canned "try rephrasing"; dropped proposals were only a small note.
Now: one automatic retry on unreadable JSON, then plain prose is shown as it is, and only a broken JSON fragment becomes "could not read my own answer" with three options. Exhausted steps say so and offer options. A turn with no model suggestions gets derived chips: options after a fallback, "Try again / Tell me what to change" after dropped proposals, "Go on / stop" inside a skill, "Yes / No / Something else" after a question.

## Metrics

| Metric | Source now | Target |
|---|---|---|
| Intent accuracy | NOT measured; needs a golden set (recommendation 3) | greater than 85% |
| Containment | Use "proposal approved" rate (`ai_action_proposals`) | greater than 70% |
| CSAT | Thumbs on every answer (`ai_messages.feedback`) | greater than 4.0 / 5 equivalent |
| Fallback rate | `ai_turns.outcome` (parse_error, budget_exhausted) | less than 15% |
| Resolution time | not recorded | less than 2 minutes |

The summary is under Workspace and account, "How the assistant is doing for you", and in `GET /api/ai/assistant/quality`. It only counts the signed-in person's own conversations.

## Recommendations

1. Record outcomes and feedback. DONE (thumbs, `ai_turns`, quality summary).
2. Fix the fallbacks. DONE (retry, prose fallback, option chips, no dead 502).
3. Golden set: 64 utterances with the expected skill or proposal type in `server/eval/golden.json`; `server/eval/run.mjs` runs them against the real model and prints accuracy per group and every miss. BUILT, NOT YET RUN (needs a model key; run `cd server; and env DEEPSEEK_API_KEY=... node --experimental-sqlite eval/run.mjs --out eval/last.json`). The harness itself was checked against a fake model only.
4. Guarantee next steps. DONE (derived chips).
5. Slot filling for the top write flows: built-in guided skills `/add-transaction`, `/add-task`, `/add-event` (ask only for missing slots, with clickable options). DONE; they start from the slash menu, not from plain words.
6. Raise limits: the message cap is now 12000 characters (was 2000) and memory is 8 messages of 1000 characters (12 of 1600 inside a skill). PARTLY DONE: old turns are still dropped, not summarised, and there is no file attachment.
