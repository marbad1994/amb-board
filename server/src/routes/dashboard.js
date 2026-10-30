import { Router } from 'express';
import { db } from '../db.js';
import { todayUtc } from '../validate.js';
import { budgetAlerts } from '../finance/calc.js';
import { occurrences } from '../calendar/recurrence.js';

const router = Router();

// Real counts only. Modules that do not exist yet (calendar, finance) are deliberately absent.
router.get('/', (req, res) => {
  const ws = req.ws.id;
  const one = (sql) => db.prepare(sql).get(ws).n;
  res.json({
    counts: {
      activeProjects: one('SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ? AND archived_at IS NULL'),
      archivedProjects: one('SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ? AND archived_at IS NOT NULL'),
      tasks: one(`SELECT COUNT(*) AS n FROM cards c JOIN columns col ON col.id = c.column_id JOIN projects p ON p.id = col.project_id
        WHERE p.workspace_id = ? AND p.archived_at IS NULL`),
      openTasks: one(`SELECT COUNT(*) AS n FROM cards c JOIN columns col ON col.id = c.column_id JOIN projects p ON p.id = col.project_id
        WHERE p.workspace_id = ? AND p.archived_at IS NULL AND c.status <> 'done'`),
      overdueTasks: db.prepare(`SELECT COUNT(*) AS n FROM cards c JOIN columns col ON col.id = c.column_id JOIN projects p ON p.id = col.project_id
        WHERE p.workspace_id = ? AND p.archived_at IS NULL AND c.status <> 'done' AND c.due_date < ?`).get(ws, todayUtc()).n,
      ideas: one('SELECT COUNT(*) AS n FROM idea_notes WHERE workspace_id = ?'),
      lifeAreas: one('SELECT COUNT(*) AS n FROM life_areas WHERE workspace_id = ? AND archived_at IS NULL'),
    },
    budgetAlerts: budgetAlerts(ws),
    upcomingEvents: (() => {
      const from = todayUtc();
      const to = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
      const out = [];
      for (const e of db.prepare('SELECT * FROM calendar_events WHERE workspace_id = ?').all(ws)) {
        for (const o of occurrences(e, from, to)) out.push({ id: `${e.id}:${o.date}`, title: e.title, start_local: o.start_local, all_day: !!e.all_day, timezone: e.timezone, kind: e.kind });
      }
      return out.sort((a, b) => a.start_local.localeCompare(b.start_local)).slice(0, 6);
    })(),
    lifeAreas: db.prepare(`SELECT la.id, la.name, la.icon,
        (SELECT COUNT(*) FROM projects p WHERE p.life_area_id = la.id AND p.archived_at IS NULL) AS project_count
      FROM life_areas la WHERE la.workspace_id = ? AND la.archived_at IS NULL ORDER BY la.position ASC`).all(ws),
    recentProjects: db.prepare(`SELECT p.id, p.name, p.color, la.name AS life_area_name,
        (SELECT COUNT(*) FROM cards c JOIN columns col ON col.id = c.column_id WHERE col.project_id = p.id) AS card_count
      FROM projects p LEFT JOIN life_areas la ON la.id = p.life_area_id
      WHERE p.workspace_id = ? AND p.archived_at IS NULL ORDER BY p.created_at DESC LIMIT 5`).all(ws),
    activity: db.prepare(`SELECT a.action, a.entity_type, a.created_at, u.name AS user_name FROM audit_log a
      LEFT JOIN users u ON u.id = a.user_id WHERE a.workspace_id = ? ORDER BY a.created_at DESC LIMIT 10`).all(ws),
  });
});

export default router;
