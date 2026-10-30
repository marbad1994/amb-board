import { Router } from 'express';
import { db } from '../db.js';
import { audit } from '../access.js';
import { generateReport, PRESETS, SECTION_IDS } from '../reports/build.js';
import { AiUnavailableError, AiLimitError, AiFailureError } from '../ai/gateway.js';

const router = Router();
const mine = (req) => db.prepare('SELECT * FROM reports WHERE id = ? AND workspace_id = ? AND user_id = ?').get(req.params.id, req.ws.id, req.user.id);

router.get('/', (req, res) => {
  res.json({ presets: Object.keys(PRESETS), sections: SECTION_IDS,
    items: db.prepare('SELECT id, kind, title, created_at, length(html) AS size FROM reports WHERE workspace_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50').all(req.ws.id, req.user.id) });
});

router.post('/', async (req, res) => {
  try {
    const r = await generateReport({ workspaceId: req.ws.id, user: req.user, params: req.body });
    audit(req, 'report.generate', 'report', r.id, { kind: r.kind });
    res.status(201).json(r);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (err instanceof AiUnavailableError || err instanceof AiLimitError || err instanceof AiFailureError) return res.status(502).json({ error: err.message });
    console.error('report error', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// JSON with the html, for the in-app preview (rendered inside a sandboxed iframe with no scripts).
router.get('/:id', (req, res) => {
  const r = mine(req);
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json({ id: r.id, kind: r.kind, title: r.title, created_at: r.created_at, html: r.html });
});

router.get('/:id/download', (req, res) => {
  const r = mine(req);
  if (!r) return res.status(404).json({ error: 'not found' });
  const name = `${r.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'report'}.html`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
  res.send(r.html);
});

router.delete('/:id', (req, res) => {
  const r = mine(req);
  if (!r) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM reports WHERE id = ?').run(r.id);
  res.status(204).end();
});

export default router;
