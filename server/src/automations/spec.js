// Validation, scheduling maths and templating for automations. No AI is involved at run time: a flow is a fixed list of
// steps chosen by a person (or proposed by the assistant and approved by one), run as that person.
import { db } from '../db.js';
import { wallToUtc, isValidTimeZone } from '../calendar/recurrence.js';
import { addDays } from '../finance/money.js';
import { PRIORITIES, parseDate } from '../validate.js';

export const MAX_STEPS = 10;
export const MAX_AUTOMATIONS = 25;
export const EVENT_TRIGGERS = { task_done: 'A task is completed', task_created: 'A task is created', transaction_added: 'A transaction is recorded' };
export const FREQUENCIES = ['daily', 'weekdays', 'weekly', 'monthly', 'once'];
export const STEP_DOCS = {
  create_task: '{"project_id":"","title":"may use {{placeholders}}","due_in_days":3,"priority":"low|medium|high|urgent"}',
  update_task: '{"task_id":"defaults to the task that triggered the flow","status":"todo|doing|blocked|done","priority":"","due_in_days":2}',
  add_comment: '{"task_id":"defaults to the triggering task","text":"may use {{placeholders}}"}',
  create_transaction: '{"type":"expense|income","amount":25.5,"currency":"EUR","description":"","category":"existing category name","status":"planned|posted"}',
  create_note: '{"title":"","body":""}',
  create_event: '{"title":"","in_days":1,"time":"HH:mm","timezone":"IANA zone","reminder_minutes":30}',
  notify: '{"title":"may use {{placeholders}}","body":"","link":"/tasks"}',
  use_tool: '{"tool":"web_search|read_web_page|<a built-in skill such as list_tasks, analyze_spending, project_health, month_summary>|external","args":{"query":"..."},"server":"(external only) name of a connected server","external_tool":"(external only) tool name","allow_write":false,"save_as":"short_name"} runs the tool; later steps can use its text as {{result.short_name}}. A connected tool that is not read-only needs allow_write true',
  ai_text: '{"instruction":"what to write, e.g. Summarise the news in 3 bullet points","input":"{{result.news}}","save_as":"short_name"} lets the AI write text from the input; use it as {{result.short_name}} (counts against the daily AI limit)',
  generate_report: '{"kind":"overview|monthly_finance|workload|project_status","project_id":""}',
};
export const STEP_TYPES = Object.keys(STEP_DOCS);
export const PLACEHOLDERS = ['result.NAME (from a tool or AI step)', 'date', 'weekday', 'trigger.title', 'trigger.project', 'trigger.priority', 'trigger.description', 'trigger.amount', 'trigger.currency'];

const str = (v, n) => String(v ?? '').trim().slice(0, n);
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// -> { trigger } | { error }
export function validateTrigger(t, role = 'schedule') {
  if (!t || typeof t !== 'object') return { error: 'trigger is required' };
  if (t.type === 'schedule') {
    if (!FREQUENCIES.includes(t.frequency)) return { error: `frequency must be one of ${FREQUENCIES.join(', ')}` };
    if (!TIME_RE.test(String(t.time))) return { error: 'time must be HH:mm' };
    const tz = t.timezone || 'UTC';
    if (!isValidTimeZone(tz)) return { error: 'invalid timezone' };
    const out = { type: 'schedule', frequency: t.frequency, time: t.time, timezone: tz };
    if (t.frequency === 'weekly') { const w = Number(t.weekday); if (!Number.isInteger(w) || w < 0 || w > 6) return { error: 'weekday must be 0 (Sunday) to 6' }; out.weekday = w; }
    if (t.frequency === 'monthly') { const d = Number(t.day); if (!Number.isInteger(d) || d < 1 || d > 28) return { error: 'day must be 1 to 28' }; out.day = d; }
    if (t.frequency === 'once') { const d = parseDate(t.date); if (!d) return { error: 'date must be YYYY-MM-DD' }; out.date = d; }
    return { trigger: out };
  }
  if (t.type === 'event') {
    if (!EVENT_TRIGGERS[t.event]) return { error: `event must be one of ${Object.keys(EVENT_TRIGGERS).join(', ')}` };
    const c = t.conditions && typeof t.conditions === 'object' ? t.conditions : {};
    const cond = {};
    if (c.project_id) cond.project_id = str(c.project_id, 40);
    if (c.priority) { if (!PRIORITIES.includes(c.priority)) return { error: 'invalid priority condition' }; cond.priority = c.priority; }
    if (c.type) { if (!['expense', 'income', 'refund'].includes(c.type)) return { error: 'invalid transaction type condition' }; cond.type = c.type; }
    if (c.currency) cond.currency = str(c.currency, 3).toUpperCase();
    if (c.min_amount_minor != null && c.min_amount_minor !== '') { const m = Number(c.min_amount_minor); if (!Number.isSafeInteger(m) || m < 0) return { error: 'invalid minimum amount' }; cond.min_amount_minor = m; }
    return { trigger: { type: 'event', event: t.event, conditions: cond } };
  }
  return { error: 'trigger.type must be "schedule" or "event"' };
}

// Structural validation at save time. Templated values cannot be fully checked until a run, so ids that must exist are
// checked now and the rest is re-validated by the normal action validators when the flow runs.
// built-in skill names, registered by ai/tools.js (avoids an import cycle)
let toolNames = () => [];
export const registerToolNames = (fn) => { toolNames = fn; };
let externalLookup = () => null;   // (ws, userId, server) -> { name, cached tools or null }
export const registerExternalLookup = (fn) => { externalLookup = fn; };
const NAME_RE = /^[a-z][a-z0-9_]{0,19}$/;
const NOT_IN_FLOWS = new Set(['call_external_tool', 'external_tools', 'generate_report']);   // external tools have their own form; reports their own step

export function validateSteps(steps, ws, trigger, userId = null) {
  if (!Array.isArray(steps) || steps.length === 0) return { error: 'at least one step is required' };
  if (steps.length > MAX_STEPS) return { error: `at most ${MAX_STEPS} steps` };
  const out = [];
  for (const [i, s] of steps.entries()) {
    const type = s?.type; const a = s?.args && typeof s.args === 'object' ? s.args : {};
    const at = `step ${i + 1}`;
    if (!STEP_TYPES.includes(type)) return { error: `${at}: unknown step type` };
    const taskTrigger = trigger?.type === 'event' && trigger.event !== 'transaction_added';
    if (type === 'create_task') {
      if (!db.prepare('SELECT 1 FROM projects WHERE id = ? AND workspace_id = ?').get(str(a.project_id, 40), ws)) return { error: `${at}: unknown project` };
      if (!str(a.title, 200)) return { error: `${at}: title required` };
      if (a.priority != null && !PRIORITIES.includes(a.priority)) return { error: `${at}: invalid priority` };
      out.push({ type, args: { project_id: str(a.project_id, 40), title: str(a.title, 200), due_in_days: a.due_in_days == null || a.due_in_days === '' ? null : Math.max(0, Math.min(3650, Math.round(Number(a.due_in_days)))), priority: a.priority || 'medium' } });
    } else if (type === 'update_task' || type === 'add_comment') {
      if (!taskTrigger && !a.task_id) return { error: `${at}: needs a task trigger or a task` };
      if (type === 'add_comment') { if (!str(a.text, 2000)) return { error: `${at}: text required` }; out.push({ type, args: { task_id: str(a.task_id, 40), text: str(a.text, 2000) } }); } else {
        if (a.status != null && a.status !== '' && !['todo', 'doing', 'blocked', 'done'].includes(a.status)) return { error: `${at}: invalid status` };
        if (a.priority != null && a.priority !== '' && !PRIORITIES.includes(a.priority)) return { error: `${at}: invalid priority` };
        out.push({ type, args: { task_id: str(a.task_id, 40), status: a.status || '', priority: a.priority || '', due_in_days: a.due_in_days == null || a.due_in_days === '' ? null : Math.max(0, Math.min(3650, Math.round(Number(a.due_in_days)))) } });
      }
    } else if (type === 'create_transaction') {
      const amt = Number(a.amount);
      if (!Number.isFinite(amt) || amt <= 0 || amt > 1e9) return { error: `${at}: amount must be a positive number` };
      if (!/^[A-Za-z]{3}$/.test(String(a.currency ?? ''))) return { error: `${at}: currency must be a 3-letter code` };
      if (!['expense', 'income'].includes(a.type)) return { error: `${at}: type must be expense or income` };
      out.push({ type, args: { type: a.type, amount: amt, currency: String(a.currency).toUpperCase(), description: str(a.description, 200), category: str(a.category, 60), status: a.status === 'posted' ? 'posted' : 'planned' } });
    } else if (type === 'create_note') {
      if (!str(a.title, 200)) return { error: `${at}: title required` };
      out.push({ type, args: { title: str(a.title, 200), body: str(a.body, 10000) } });
    } else if (type === 'create_event') {
      if (!str(a.title, 200)) return { error: `${at}: title required` };
      if (!TIME_RE.test(String(a.time))) return { error: `${at}: time must be HH:mm` };
      if (!isValidTimeZone(a.timezone || 'UTC')) return { error: `${at}: invalid timezone` };
      out.push({ type, args: { title: str(a.title, 200), in_days: Math.max(0, Math.min(3650, Math.round(Number(a.in_days) || 0))), time: a.time, timezone: a.timezone || 'UTC', reminder_minutes: a.reminder_minutes == null || a.reminder_minutes === '' ? null : Math.max(0, Math.min(10080, Math.round(Number(a.reminder_minutes)))) } });
    } else if (type === 'notify') {
      if (!str(a.title, 200)) return { error: `${at}: title required` };
      const link = str(a.link, 200);
      if (link && !link.startsWith('/')) return { error: `${at}: link must be an app path such as /tasks` };
      out.push({ type, args: { title: str(a.title, 200), body: str(a.body, 500), link } });
    } else if (type === 'use_tool') {
      const tool = str(a.tool, 60);
      const saveAs = str(a.save_as, 20).toLowerCase();
      if (saveAs && !NAME_RE.test(saveAs)) return { error: `${at}: save_as must be a short lower-case name (letters, digits, underscore)` };
      const args = a.args && typeof a.args === 'object' && !Array.isArray(a.args) ? a.args : {};
      if (JSON.stringify(args).length > 2000) return { error: `${at}: arguments too large` };
      const base = { tool, args, save_as: saveAs };
      if (tool === 'external') {
        const info = externalLookup(ws, userId, a.server);
        if (!info) return { error: `${at}: unknown connected server (connect it first under Workspace & account)` };
        const t = info.tools?.find((x) => x.name === str(a.external_tool, 80));
        if (!info.tools) return { error: `${at}: list that server's tools first (the builder does this; the assistant uses the external_tools skill)` };
        if (!t) return { error: `${at}: unknown tool on that server` };
        if (!t.read_only && a.allow_write !== true) return { error: `${at}: "${t.name}" may change data outside AMB Board, so the step needs allow_write to confirm it` };
        out.push({ type, args: { ...base, server: info.name, external_tool: t.name, allow_write: !t.read_only && a.allow_write === true } });
      } else {
        if (!toolNames().includes(tool) || NOT_IN_FLOWS.has(tool)) return { error: `${at}: unknown tool "${tool}"` };
        out.push({ type, args: base });
      }
    } else if (type === 'ai_text') {
      const instruction = str(a.instruction, 1000); if (!instruction) return { error: `${at}: instruction required` };
      const saveAs = str(a.save_as, 20).toLowerCase(); if (!NAME_RE.test(saveAs)) return { error: `${at}: save_as is required (a short lower-case name)` };
      out.push({ type, args: { instruction, input: str(a.input, 4000), save_as: saveAs } });
    } else if (type === 'generate_report') {
      if (!['overview', 'monthly_finance', 'workload', 'project_status'].includes(a.kind)) return { error: `${at}: unknown report kind` };
      if (a.kind === 'project_status' && !db.prepare('SELECT 1 FROM projects WHERE id = ? AND workspace_id = ?').get(str(a.project_id, 40), ws)) return { error: `${at}: unknown project` };
      out.push({ type, args: { kind: a.kind, project_id: a.kind === 'project_status' ? str(a.project_id, 40) : '' } });
    }
  }
  return { steps: out };
}

// Next UTC instant (ISO) strictly after `now` for a schedule trigger, or null (a finished one-off).
export function nextRunAt(t, now = new Date()) {
  if (t.type !== 'schedule') return null;
  const today = now.toISOString().slice(0, 10);
  for (let i = -1; i <= 400; i += 1) {
    const date = addDays(today, i);
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
    const ok = t.frequency === 'daily' || (t.frequency === 'weekdays' && dow >= 1 && dow <= 5) || (t.frequency === 'weekly' && dow === t.weekday)
      || (t.frequency === 'monthly' && Number(date.slice(8)) === t.day) || (t.frequency === 'once' && date === t.date);
    if (!ok) continue;
    const at = wallToUtc(date, t.time, t.timezone);
    if (Date.parse(at) > now.getTime()) return at;
    if (t.frequency === 'once') return null;
  }
  return null;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export function describeTrigger(t) {
  if (t.type === 'event') {
    const c = t.conditions || {}; const bits = [];
    if (c.priority) bits.push(`priority ${c.priority}`); if (c.project_id) bits.push('in one project'); if (c.type) bits.push(c.type);
    if (c.min_amount_minor) bits.push(`at least ${(c.min_amount_minor / 100).toFixed(2)}${c.currency ? ` ${c.currency}` : ''}`);
    return `${EVENT_TRIGGERS[t.event]}${bits.length ? ` (${bits.join(', ')})` : ''}`;
  }
  const when = { daily: 'Every day', weekdays: 'Every weekday', weekly: `Every ${WEEKDAYS[t.weekday]}`, monthly: `On day ${t.day} of every month`, once: `Once on ${t.date}` }[t.frequency];
  return `${when} at ${t.time} (${t.timezone})`;
}

export function fill(text, ctx) {
  return String(text ?? '').replace(/\{\{\s*([a-z0-9_.]+)\s*\}\}/g, (_, k) => String(ctx[k] ?? ''));
}

import { nanoid } from 'nanoid';
import { nowIso } from '../db.js';
export function insertAutomation(ws, userId, { name, trigger, steps, enabled = true }, via = 'user') {
  const id = nanoid(); const ts = nowIso();
  db.prepare(`INSERT INTO automations (id, workspace_id, user_id, name, enabled, trigger, steps, next_run_at, created_via, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, ws, userId, name, enabled ? 1 : 0, JSON.stringify(trigger), JSON.stringify(steps), enabled ? nextRunAt(trigger) : null, via, ts, ts);
  return id;
}
export const automationCount = (ws) => db.prepare('SELECT COUNT(*) AS n FROM automations WHERE workspace_id = ?').get(ws).n;
