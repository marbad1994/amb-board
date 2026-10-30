import { db } from '../db.js';
import { projectInWs } from '../access.js';
import { todayUtc, parseDate, escapeLike } from '../validate.js';
import { projectBudgetMetrics } from '../finance/calc.js';
import { occurrences } from '../calendar/recurrence.js';
import { projectFacts } from './facts.js';
import { monthBudget } from '../finance/budget.js';
import { crossReference, analyzeSpending, analyzeWorkload, projectHealth, findGaps } from './analysis.js';
import { generateReport, PRESETS, SECTION_IDS } from '../reports/build.js';

// Read-only tools the model may call. Each runs with the CALLER's workspace and is scoped by workspace_id.
// The model never sees SQL, never chooses a workspace, and cannot call anything not listed here.
// Results are capped so one call cannot flood the prompt.
const cap = (rows, n = 25) => rows.slice(0, n);

// every entry: { kind: 'read'|'analysis'|'report', doc, run(ws, args, user), async? }
export const TOOLS = {
  // ---- analysis skills (deterministic; the model narrates the result) ----
  cross_reference: { kind: 'analysis', doc: 'cross_reference {entity: "project"|"goal"|"task", id} -> everything linked to it: tasks, budget, transactions, events, goals, notes, documents', run: (ws, a, user) => crossReference(ws, a, user?.id) },
  analyze_spending: { kind: 'analysis', doc: 'analyze_spending {months?: 1-12} -> this month vs previous average per category (minor units), unusual categories, top expenses, uncategorised count', run: (ws, a) => analyzeSpending(ws, a) },
  analyze_workload: { kind: 'analysis', doc: 'analyze_workload {days?: 1-31} -> tasks, deadlines and appointments per day, busiest and heavy days', run: (ws, a) => analyzeWorkload(ws, a) },
  project_health: { kind: 'analysis', doc: 'project_health {} -> every active project with progress, schedule, budget status, risk level and reasons', run: (ws, a) => projectHealth(ws, a) },
  find_gaps: { kind: 'analysis', doc: 'find_gaps {} -> data gaps: tasks without due dates, projects without tasks/budget, uncategorised expenses, goals without milestones', run: (ws, a) => findGaps(ws, a) },
  // ---- report skill: creates a standalone HTML report (private to the user), returns where to open it ----
  generate_report: { kind: 'report', async: true,
    doc: `generate_report {kind: ${Object.keys(PRESETS).map((k) => `"${k}"`).join('|')} OR sections: [${SECTION_IDS.join(', ')}], month?: YYYY-MM, project_id?, days?, title?, narrative?: true} -> creates a standalone HTML report with charts; returns report_id (tell the user it is under Reports)`,
    run: async (ws, a, user) => {
      const r = await generateReport({ workspaceId: ws, user, params: a });
      return { report_id: r.id, title: r.title, kind: r.kind, open_in_app: `/reports/${r.id}`, artifact: { type: 'report', id: r.id, title: r.title } };
    } },
  // ---- read skills ----
  list_projects: {
    doc: 'list_projects {status?: "todo"|"in_progress"|"done"} -> active projects with progress, dates, priority',
    run: (ws, args) => {
      const where = ['p.workspace_id = ?', 'p.archived_at IS NULL'];
      const params = [ws];
      if (['todo', 'in_progress', 'done'].includes(args.status)) { where.push('p.status = ?'); params.push(args.status); }
      return cap(db.prepare(`SELECT p.id, p.name, p.status, p.priority, p.start_date, p.target_date, la.name AS life_area,
          (SELECT COUNT(*) FROM cards c JOIN columns col ON col.id = c.column_id WHERE col.project_id = p.id) AS tasks_total,
          (SELECT COUNT(*) FROM cards c JOIN columns col ON col.id = c.column_id WHERE col.project_id = p.id AND c.status = 'done') AS tasks_done
        FROM projects p LEFT JOIN life_areas la ON la.id = p.life_area_id WHERE ${where.join(' AND ')} ORDER BY p.created_at LIMIT 25`).all(...params));
    },
  },
  get_project: {
    doc: 'get_project {project_id} -> full facts for one project (tasks, schedule assessment, budget)',
    run: (ws, args) => {
      const p = projectInWs(args.project_id, ws);
      if (!p) return { error: 'project not found' };
      const f = projectFacts(p, ws);
      return { ...f, tasks: cap(f.tasks, 40) };
    },
  },
  list_tasks: {
    doc: 'list_tasks {view: "open"|"overdue"|"upcoming"|"done", project_id?} -> tasks with ids, due dates, priority, project',
    run: (ws, args) => {
      const today = todayUtc();
      const where = ['p.workspace_id = ?', 'p.archived_at IS NULL'];
      const params = [ws];
      if (args.project_id) { where.push('p.id = ?'); params.push(String(args.project_id)); }
      switch (args.view || 'open') {
        case 'overdue': where.push("c.status <> 'done'", 'c.due_date < ?'); params.push(today); break;
        case 'upcoming': where.push("c.status <> 'done'", 'c.due_date >= ?'); params.push(today); break;
        case 'done': where.push("c.status = 'done'"); break;
        default: where.push("c.status <> 'done'");
      }
      return cap(db.prepare(`SELECT c.id, c.title, c.status, c.priority, c.due_date, c.owner, p.id AS project_id, p.name AS project
        FROM cards c JOIN columns col ON col.id = c.column_id JOIN projects p ON p.id = col.project_id
        WHERE ${where.join(' AND ')} ORDER BY (c.due_date IS NULL), c.due_date LIMIT 25`).all(...params));
    },
  },
  list_events: {
    doc: 'list_events {from: YYYY-MM-DD, to: YYYY-MM-DD (max 62 days)} -> appointments/events incl. repeats (local time + zone)',
    run: (ws, args) => {
      const from = parseDate(args.from); const to = parseDate(args.to);
      if (!from || !to || to < from) return { error: 'from and to must be valid dates' };
      if ((Date.parse(to) - Date.parse(from)) / 86400_000 > 62) return { error: 'range limited to 62 days' };
      const out = [];
      for (const e of db.prepare('SELECT * FROM calendar_events WHERE workspace_id = ?').all(ws)) {
        for (const o of occurrences(e, from, to)) out.push({ id: e.id, title: e.title, kind: e.kind, start_local: o.start_local, end_local: o.end_local, timezone: e.timezone, all_day: !!e.all_day });
      }
      return cap(out.sort((a, b) => a.start_local.localeCompare(b.start_local)), 40);
    },
  },
  budget_metrics: {
    doc: 'budget_metrics {project_id} -> authoritative budget figures in minor units (cents)',
    run: (ws, args) => (projectInWs(args.project_id, ws) ? projectBudgetMetrics(String(args.project_id), ws) : { error: 'project not found' }),
  },
  month_summary: {
    doc: 'month_summary {month: YYYY-MM} -> income/expenses/net per currency (minor units), never mixed across currencies',
    run: (ws, args) => {
      const month = /^\d{4}-\d{2}$/.test(String(args.month)) ? String(args.month) : todayUtc().slice(0, 7);
      const rows = db.prepare(`SELECT currency, type, SUM(amount_minor) AS total FROM transactions WHERE workspace_id = ? AND voided_at IS NULL
        AND status = 'posted' AND type <> 'transfer' AND substr(date, 1, 7) = ? GROUP BY currency, type`).all(ws, month);
      const by = {};
      for (const r of rows) {
        const c = (by[r.currency] ||= { currency: r.currency, income_minor: 0, expenses_minor: 0 });
        if (r.type === 'income') c.income_minor += r.total; else c.expenses_minor += r.type === 'expense' ? r.total : -r.total;
      }
      return { month, currencies: Object.values(by) };
    },
  },
  month_budget: {
    doc: 'month_budget {month: YYYY-MM} -> category budgets vs actual spending for the month (minor units), plus unbudgeted spending',
    run: (ws, args) => monthBudget(ws, /^\d{4}-(0[1-9]|1[0-2])$/.test(String(args.month)) ? String(args.month) : todayUtc().slice(0, 7)),
  },
  list_savings_and_debts: {
    doc: 'list_savings_and_debts {} -> savings goals (balance, target) and debts (remaining), minor units',
    run: (ws) => ({
      savings: db.prepare(`SELECT g.name, g.currency, g.target_minor, g.is_emergency_fund,
          COALESCE((SELECT SUM(CASE kind WHEN 'deposit' THEN amount_minor ELSE -amount_minor END) FROM savings_entries WHERE goal_id = g.id), 0) AS balance_minor
        FROM savings_goals g WHERE g.workspace_id = ? AND g.archived_at IS NULL LIMIT 20`).all(ws),
      debts: db.prepare(`SELECT d.name, d.currency, d.original_minor, MAX(0, d.original_minor - COALESCE((SELECT SUM(amount_minor) FROM debt_payments WHERE debt_id = d.id), 0)) AS remaining_minor
        FROM debts d WHERE d.workspace_id = ? AND d.archived_at IS NULL LIMIT 20`).all(ws),
    }),
  },
  search: {
    doc: 'search {q} -> projects, tasks and ideas matching text',
    run: (ws, args) => {
      const q = String(args.q || '').trim().slice(0, 80);
      if (q.length < 2) return { error: 'query too short' };
      const like = `%${escapeLike(q)}%`;
      return {
        projects: db.prepare("SELECT id, name FROM projects WHERE workspace_id = ? AND archived_at IS NULL AND name LIKE ? ESCAPE '\\' LIMIT 8").all(ws, like),
        tasks: db.prepare(`SELECT c.id, c.title, p.name AS project FROM cards c JOIN columns col ON col.id = c.column_id JOIN projects p ON p.id = col.project_id
          WHERE p.workspace_id = ? AND p.archived_at IS NULL AND c.title LIKE ? ESCAPE '\\' LIMIT 8`).all(ws, like),
        ideas: db.prepare("SELECT id, substr(text, 1, 120) AS text FROM idea_notes WHERE workspace_id = ? AND text LIKE ? ESCAPE '\\' LIMIT 8").all(ws, like),
      };
    },
  },
};

export function runTool(name, args, ws, user = null) {
  const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : null;
  if (!tool) return { error: `unknown tool "${String(name).slice(0, 40)}"` };
  if (tool.async) return { error: 'this skill must be called through the assistant' };
  try {
    return tool.run(ws, args && typeof args === 'object' ? args : {}, user);
  } catch (err) {
    console.error('tool error', name, err);
    return { error: 'tool failed' };
  }
}

// Used by the assistant and the MCP endpoint: handles async skills (reports) too. Never throws.
export async function runSkill(name, args, ws, user) {
  const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : null;
  if (!tool) return { error: `unknown tool "${String(name).slice(0, 40)}"` };
  try {
    return await tool.run(ws, args && typeof args === 'object' ? args : {}, user);
  } catch (err) {
    if (err.status) return { error: err.message };
    console.error('skill error', name, err);
    return { error: 'skill failed' };
  }
}
