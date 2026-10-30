import { nanoid } from 'nanoid';
import { db, nowIso, tx } from '../db.js';
import { applyValidated, validateProposal } from '../ai/actions.js';
import { generateReport } from '../reports/build.js';
import { membershipRole, can } from '../access.js';
import { addDays } from '../finance/money.js';
import { todayUtc } from '../validate.js';
import { nextRunAt, fill, describeTrigger } from './spec.js';

const MISSED_AFTER_MS = 24 * 3600_000;   // a schedule missed by more than a day (server was down) is skipped, not replayed
const EVENT_RUNS_PER_DAY = 50;           // runaway guard per flow

const present = (a) => ({ ...a, enabled: !!a.enabled, trigger: JSON.parse(a.trigger), steps: JSON.parse(a.steps), summary: describeTrigger(JSON.parse(a.trigger)) });
export const readAutomation = (ws, id) => { const a = db.prepare('SELECT * FROM automations WHERE id = ? AND workspace_id = ?').get(String(id), ws); return a ? present(a) : null; };
export const listAutomations = (ws) => db.prepare('SELECT * FROM automations WHERE workspace_id = ? ORDER BY created_at').all(ws).map(present);
export const listRuns = (id, limit = 15) => db.prepare('SELECT id, slot, status, log, started_at, finished_at FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?').all(id, limit).map((r) => ({ ...r, log: JSON.parse(r.log) }));

function mapStep(step, ctx, today) {
  const a = step.args; const f = (t) => fill(t, ctx);
  const due = (days) => (days == null ? null : addDays(today, days));
  switch (step.type) {
    case 'create_task': return ['create_task', { project_id: a.project_id, title: f(a.title), due_date: due(a.due_in_days), priority: a.priority }];
    case 'update_task': {
      const p = { task_id: a.task_id || ctx.task_id };
      if (a.status) p.status = a.status; if (a.priority) p.priority = a.priority; if (a.due_in_days != null) p.due_date = due(a.due_in_days);
      return ['update_task', p];
    }
    case 'add_comment': return ['add_comment', { task_id: a.task_id || ctx.task_id, text: f(a.text) }];
    case 'create_transaction': return ['create_transaction', { type: a.type, amount: a.amount, currency: a.currency, date: today, description: f(a.description), category: a.category, status: a.status }];
    case 'create_note': return ['create_note', { title: f(a.title), body: f(a.body) }];
    case 'create_event': return ['create_event', { title: f(a.title), start_local: `${addDays(today, a.in_days)}T${a.time}`, timezone: a.timezone, reminder_minutes: a.reminder_minutes ?? undefined }];
    default: return null;
  }
}

// Runs one flow. Never throws. Steps run as the flow's owner and only if that person can still write to the workspace.
async function execute(auto, slot, trigCtx, now = new Date()) {
  const runId = nanoid(); const started = nowIso();
  const ins = db.prepare("INSERT OR IGNORE INTO automation_runs (id, automation_id, workspace_id, slot, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)").run(runId, auto.id, auto.workspace_id, slot, started);
  if (!Number(ins.changes)) return { status: 'duplicate' };
  const log = []; let status = 'ok';
  const finish = () => {
    db.prepare('UPDATE automation_runs SET status = ?, log = ?, finished_at = ? WHERE id = ?').run(status, JSON.stringify(log), nowIso(), runId);
    db.prepare('UPDATE automations SET last_run_at = ?, last_status = ?, updated_at = updated_at WHERE id = ?').run(nowIso(), status, auto.id);
    return { status, log, run_id: runId };
  };
  const user = db.prepare('SELECT id, name FROM users WHERE id = ?').get(auto.user_id);
  const role = user ? membershipRole(auto.user_id, auto.workspace_id) : null;
  if (!user || !can(role, 'content:write')) { status = 'skipped'; log.push({ step: 0, ok: false, message: 'The flow owner no longer has write access to this workspace.' }); return finish(); }
  const today = now.toISOString().slice(0, 10);
  const ctx = { date: today, weekday: new Date(`${today}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }), ...trigCtx };
  for (const [i, step] of auto.steps.entries()) {
    try {
      if (step.type === 'notify') {
        db.prepare('INSERT OR IGNORE INTO notifications (id, workspace_id, user_id, kind, title, body, link, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(nanoid(), auto.workspace_id, user.id, 'automation', fill(step.args.title, ctx).slice(0, 200), fill(step.args.body, ctx).slice(0, 500), step.args.link || '/automations', `auto:${auto.id}:${slot}:${i}`, nowIso());
        log.push({ step: i + 1, type: step.type, ok: true, message: 'Notification sent' });
      } else if (step.type === 'generate_report') {
        const r = await generateReport({ workspaceId: auto.workspace_id, user, params: { kind: step.args.kind, project_id: step.args.project_id || undefined } });
        log.push({ step: i + 1, type: step.type, ok: true, message: `Report saved: ${r.title || r.id}`, link: `/reports/${r.id}` });
      } else {
        const [type, args] = mapStep(step, ctx, today);
        const v = validateProposal(type, args, auto.workspace_id, user);
        if (v.error) throw new Error(v.error);
        tx(() => applyValidated(type, v.payload, auto.workspace_id, user, nowIso()));
        log.push({ step: i + 1, type: step.type, ok: true, message: v.description });
      }
    } catch (err) {
      status = 'failed'; log.push({ step: i + 1, type: step.type, ok: false, message: String(err.message).slice(0, 300) }); break;
    }
  }
  return finish();
}

export async function runNow(auto) {
  return execute(auto, `manual:${nanoid(8)}`, {});
}

// Called by the scheduler tick. Idempotent per (flow, slot) so several processes or repeated ticks run a slot once.
export async function runDue(now = new Date()) {
  const due = db.prepare("SELECT * FROM automations WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?").all(now.toISOString()).map(present);
  let ran = 0;
  for (const auto of due) {
    const slot = auto.next_run_at;
    const missed = now.getTime() - Date.parse(slot) > MISSED_AFTER_MS;
    if (missed) {
      db.prepare("INSERT OR IGNORE INTO automation_runs (id, automation_id, workspace_id, slot, status, log, started_at, finished_at) VALUES (?, ?, ?, ?, 'skipped', ?, ?, ?)")
        .run(nanoid(), auto.id, auto.workspace_id, slot, JSON.stringify([{ step: 0, ok: false, message: 'Missed while the server was not running; skipped.' }]), nowIso(), nowIso());
    } else { await execute(auto, slot, {}, now); ran += 1; }
    const next = nextRunAt(auto.trigger, now);
    db.prepare('UPDATE automations SET next_run_at = ?, enabled = ? WHERE id = ?').run(next, next ? 1 : (auto.trigger.frequency === 'once' ? 0 : 1), auto.id);
  }
  return ran;
}

const matches = (cond, e) => (!cond.project_id || cond.project_id === e.project_id) && (!cond.priority || cond.priority === e.priority)
  && (!cond.type || cond.type === e.type) && (!cond.currency || cond.currency === e.currency) && (!cond.min_amount_minor || (e.amount_minor ?? 0) >= cond.min_amount_minor);

// Event hook, called by the routes after a change is saved. Fire-and-forget: a failing flow never affects the request.
export function emit(workspaceId, event, e) {
  try {
    const autos = db.prepare("SELECT * FROM automations WHERE workspace_id = ? AND enabled = 1 AND json_extract(trigger, '$.type') = 'event' AND json_extract(trigger, '$.event') = ?").all(workspaceId, event).map(present);
    for (const auto of autos) {
      if (!matches(auto.trigger.conditions || {}, e)) continue;
      const today = db.prepare("SELECT COUNT(*) AS n FROM automation_runs WHERE automation_id = ? AND slot NOT LIKE 'manual:%' AND started_at >= ?").get(auto.id, `${todayUtc()}T00:00:00.000Z`).n;
      if (today >= EVENT_RUNS_PER_DAY) continue;
      execute(auto, `${event}:${e.entity_id}:${e.stamp || ''}`, {
        task_id: e.entity_id, 'trigger.title': e.title, 'trigger.project': e.project_name, 'trigger.priority': e.priority, 'trigger.description': e.title,
        'trigger.amount': e.amount_minor != null ? (e.amount_minor / 100).toFixed(2) : '', 'trigger.currency': e.currency,
      }).catch((err) => console.error('automation failed', auto.id, err));
    }
  } catch (err) { console.error('automation hook failed', err); }
}
