import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { audit } from '../access.js';
import { validateTrigger, validateSteps, nextRunAt, insertAutomation, automationCount, MAX_AUTOMATIONS, STEP_DOCS, EVENT_TRIGGERS, PLACEHOLDERS } from '../automations/spec.js';
import { findServer, toolsOf, userServers } from '../ai/mcpServers.js';
import { TOOLS } from '../ai/tools.js';
import { BUILTIN_TEMPLATES, render as renderText, emailDocument, placeholdersIn, FILTER_DOCS } from '../automations/template.js';
import { nanoid } from 'nanoid';
import { mailConfigured } from '../notifications/mailer.js';
import { listAutomations, readAutomation, listRuns, runNow } from '../automations/engine.js';

const router = Router();
const name80 = (v) => String(v ?? '').trim().slice(0, 80);

// What the builder UI needs to render: step kinds, trigger kinds and the placeholders a text field may use.
router.get('/meta', (req, res) => res.json({ steps: Object.keys(STEP_DOCS), events: EVENT_TRIGGERS, placeholders: PLACEHOLDERS, max_automations: MAX_AUTOMATIONS, email_configured: mailConfigured(), filters: FILTER_DOCS }));

router.get('/', (req, res) => res.json(listAutomations(req.ws.id).map((a) => ({ ...a, runs: listRuns(a.id, 3) }))));

// The tool lists of connected servers are fetched first so save-time validation can tell read-only tools from the rest.
async function warmExternal(req, steps = req.body.steps) {
  for (const s of Array.isArray(steps) ? steps : []) {
    if (s?.type === 'use_tool' && s.args?.tool === 'external') { const srv = findServer(req.ws.id, req.user.id, s.args.server); if (srv) await toolsOf(srv).catch(() => {}); }
  }
}

// ---- email templates (reusable subject + body with {{placeholders | filters}}) ----
const MAX_TEMPLATES = 30;
const tplInput = (b) => ({ name: String(b.name ?? '').trim().slice(0, 60), subject: String(b.subject ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200), body: String(b.body ?? '').replace(/\r/g, '').trim().slice(0, 20000) });
router.get('/templates', (req, res) => res.json({
  builtin: Object.entries(BUILTIN_TEMPLATES).map(([key, t]) => ({ key, ...t })),
  custom: db.prepare('SELECT id, name, subject, body, user_id, updated_at FROM email_templates WHERE workspace_id = ? ORDER BY name').all(req.ws.id),
  filters: FILTER_DOCS,
}));
router.post('/templates', (req, res) => {
  const t = tplInput(req.body);
  if (!t.name || !t.subject || !t.body) return res.status(400).json({ error: 'name, subject and body are required' });
  if (db.prepare('SELECT COUNT(*) AS n FROM email_templates WHERE workspace_id = ?').get(req.ws.id).n >= MAX_TEMPLATES) return res.status(409).json({ error: `at most ${MAX_TEMPLATES} templates` });
  const id = nanoid(); const ts = nowIso();
  db.prepare('INSERT INTO email_templates (id, workspace_id, user_id, name, subject, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, req.ws.id, req.user.id, t.name, t.subject, t.body, ts, ts);
  audit(req, 'email_template.create', 'email_template', id, { name: t.name });
  res.status(201).json(db.prepare('SELECT id, name, subject, body, user_id, updated_at FROM email_templates WHERE id = ?').get(id));
});
const ownTemplate = (req) => db.prepare('SELECT * FROM email_templates WHERE id = ? AND workspace_id = ?').get(req.params.id, req.ws.id);
router.patch('/templates/:id', (req, res) => {
  const cur = ownTemplate(req); if (!cur) return res.status(404).json({ error: 'not found' });
  if (cur.user_id !== req.user.id && !['owner', 'admin'].includes(req.ws.role)) return res.status(403).json({ error: 'only the author or an admin can change it' });
  const t = tplInput({ name: req.body.name ?? cur.name, subject: req.body.subject ?? cur.subject, body: req.body.body ?? cur.body });
  if (!t.name || !t.subject || !t.body) return res.status(400).json({ error: 'name, subject and body cannot be empty' });
  db.prepare('UPDATE email_templates SET name = ?, subject = ?, body = ?, updated_at = ? WHERE id = ?').run(t.name, t.subject, t.body, nowIso(), cur.id);
  res.json(db.prepare('SELECT id, name, subject, body, user_id, updated_at FROM email_templates WHERE id = ?').get(cur.id));
});
router.delete('/templates/:id', (req, res) => {
  const cur = ownTemplate(req); if (!cur) return res.status(404).json({ error: 'not found' });
  if (cur.user_id !== req.user.id && !['owner', 'admin'].includes(req.ws.role)) return res.status(403).json({ error: 'only the author or an admin can delete it' });
  const used = listAutomations(req.ws.id).filter((a) => a.steps.some((s) => s.type === 'send_email' && s.args.template === cur.id)).map((a) => a.name);
  if (used.length) return res.status(409).json({ error: `used by: ${used.join(', ')}` });
  db.prepare('DELETE FROM email_templates WHERE id = ?').run(cur.id);
  res.status(204).end();
});

// Renders a subject and body with sample values so the person (or the assistant) can see what the email will look like.
router.post('/email-preview', (req, res) => {
  const tpl = req.body.template ? (BUILTIN_TEMPLATES[req.body.template] || db.prepare('SELECT subject, body FROM email_templates WHERE id = ? AND workspace_id = ?').get(String(req.body.template), req.ws.id)) : null;
  const subject = String(req.body.subject || tpl?.subject || '').slice(0, 200); const body = String(req.body.body || tpl?.body || '').slice(0, 20000);
  const today = new Date().toISOString().slice(0, 10);
  const ctx = { date: today, weekday: new Date(`${today}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }), 'owner.name': req.user.name, 'owner.email': req.user.email,
    'workspace.name': db.prepare('SELECT name FROM workspaces WHERE id = ?').get(req.ws.id)?.name ?? '' };
  for (const p of [...placeholdersIn(subject), ...placeholdersIn(body)]) if (!(p in ctx)) ctx[p] = req.body.sample?.[p] ?? `[sample ${p}]\nsecond line of sample text`;
  const text = renderText(body, ctx);
  res.json({ subject: renderText(subject, ctx).replace(/[\r\n]+/g, ' ').slice(0, 200), text, html: emailDocument({ bodyText: text, footer: `Sent by the AMB Board automation "(preview)" for ${req.user.name}. Reply to this email to reach ${req.user.name}.` }), placeholders: [...new Set([...placeholdersIn(subject), ...placeholdersIn(body)])] });
});

// What the builder offers for "use a tool": built-in skills and the tools of the person's connected servers (fetched on demand).
router.get('/tools', async (req, res) => {
  const internal = Object.entries(TOOLS).filter(([n]) => !['call_external_tool', 'external_tools', 'generate_report', 'browser_status', 'browser_snapshot', 'browser_fill', 'browser_click'].includes(n)).map(([name, t]) => ({ name, kind: t.kind || 'read', doc: t.doc.slice(0, 160) }));
  const servers = await Promise.all(userServers(req.ws.id, req.user.id).map(async (s) => { try { return { name: s.name, tools: (await toolsOf(s)).map((t) => ({ name: t.name, read_only: t.read_only, description: t.description })) }; } catch (e) { return { name: s.name, tools: [], error: String(e.message).slice(0, 100) }; } }));
  res.json({ internal, servers });
});

function parseBody(req) {
  const name = name80(req.body.name);
  if (!name) return { error: 'name is required' };
  const t = validateTrigger(req.body.trigger);
  if (t.error) return { error: t.error };
  const s = validateSteps(req.body.steps, req.ws.id, t.trigger, req.user.id);
  if (s.error) return { error: s.error };
  return { name, trigger: t.trigger, steps: s.steps };
}

router.post('/', async (req, res) => {
  await warmExternal(req);
  if (automationCount(req.ws.id) >= MAX_AUTOMATIONS) return res.status(409).json({ error: `a workspace can have at most ${MAX_AUTOMATIONS} automations` });
  const b = parseBody(req);
  if (b.error) return res.status(400).json({ error: b.error });
  const id = insertAutomation(req.ws.id, req.user.id, { ...b, enabled: req.body.enabled !== false });
  audit(req, 'automation.create', 'automation', id, { name: b.name });
  res.status(201).json(readAutomation(req.ws.id, id));
});

router.get('/:id', (req, res) => {
  const a = readAutomation(req.ws.id, req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  res.json({ ...a, runs: listRuns(a.id, 20) });
});

// Only the person who owns a flow (it runs as them) or a workspace owner/admin may change it.
function editable(req, a) { return a.user_id === req.user.id || ['owner', 'admin'].includes(req.ws.role); }

router.patch('/:id', async (req, res) => {
  const a = readAutomation(req.ws.id, req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  if (!editable(req, a)) return res.status(403).json({ error: 'only the flow owner or an admin can change it' });
  let { name, trigger, steps } = a;
  await warmExternal(req, req.body.steps ?? a.steps);
  if (req.body.name !== undefined || req.body.trigger !== undefined || req.body.steps !== undefined) {
    const b = parseBody({ ...req, body: { name: req.body.name ?? a.name, trigger: req.body.trigger ?? a.trigger, steps: req.body.steps ?? a.steps } });
    if (b.error) return res.status(400).json({ error: b.error });
    ({ name, trigger, steps } = b);
  }
  const enabled = req.body.enabled === undefined ? a.enabled : !!req.body.enabled;
  db.prepare('UPDATE automations SET name = ?, trigger = ?, steps = ?, enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
    .run(name, JSON.stringify(trigger), JSON.stringify(steps), enabled ? 1 : 0, enabled ? nextRunAt(trigger) : null, nowIso(), a.id);
  audit(req, 'automation.update', 'automation', a.id, { enabled });
  res.json(readAutomation(req.ws.id, a.id));
});

router.delete('/:id', (req, res) => {
  const a = readAutomation(req.ws.id, req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  if (!editable(req, a)) return res.status(403).json({ error: 'only the flow owner or an admin can delete it' });
  db.prepare('DELETE FROM automations WHERE id = ?').run(a.id);
  audit(req, 'automation.delete', 'automation', a.id, { name: a.name });
  res.status(204).end();
});

// "Run now" is a real run of a scheduled flow, as its owner. Event flows run when their event happens.
router.post('/:id/run', async (req, res) => {
  const a = readAutomation(req.ws.id, req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  if (a.user_id !== req.user.id) return res.status(403).json({ error: 'only the flow owner can run it' });
  if (a.trigger.type !== 'schedule') return res.status(400).json({ error: 'event flows run when their event happens' });
  const result = await runNow(a);
  audit(req, 'automation.run', 'automation', a.id, { status: result.status });
  res.json({ ...result, automation: readAutomation(req.ws.id, a.id), runs: listRuns(a.id, 5) });
});

export default router;
