import { Router } from 'express';
import multer from 'multer';
import { db } from '../db.js';
import { requirePermission, audit } from '../access.js';
import { CURRENCY_RE } from '../finance/money.js';
import { MAX_BYTES } from '../finance/csv.js';
import { buildDraft, getDraft, applyDraft } from '../finance/aiBudget.js';
import { AiUnavailableError, AiLimitError, AiFailureError } from '../ai/gateway.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1, fields: 8 } });
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function fail(res, err) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  if (err instanceof AiUnavailableError) return res.status(503).json({ error: err.message });
  if (err instanceof AiLimitError) return res.status(429).json({ error: err.message });
  if (err instanceof AiFailureError) return res.status(502).json({ error: err.message });
  console.error('ai-budget error:', err);
  return res.status(500).json({ error: 'internal error' });
}

// Step 1: build a draft from a prompt and/or a CSV. Nothing real changes. Needs write access (it spends AI budget).
router.post('/ai-budget/draft', (req, res, next) => upload.single('csv')(req, res, async (err) => {
  if (err) return err.code === 'LIMIT_FILE_SIZE' ? res.status(413).json({ error: 'CSV too large (2 MB max)' }) : next(err);
  const prompt = String(req.body.prompt || '').trim().slice(0, 2000);
  const month = String(req.body.month || '');
  const currency = String(req.body.currency || '').toUpperCase();
  const signMode = ['auto', 'negative_is_expense', 'positive_is_expense'].includes(req.body.signMode) ? req.body.signMode : 'auto';
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
  if (!CURRENCY_RE.test(currency)) return res.status(400).json({ error: 'currency must be a 3-letter code' });
  if (!prompt && !req.file) return res.status(400).json({ error: 'Describe what you need and/or attach a CSV file.' });
  let csvText = null;
  if (req.file) {
    if (/\.(xlsx?|pdf|zip)$/i.test(req.file.originalname) || req.file.buffer.subarray(0, 4).toString('hex') === '504b0304') return res.status(415).json({ error: 'Please export the statement as a CSV file.' });
    if (req.file.buffer.includes(0)) return res.status(415).json({ error: 'That does not look like a text CSV file.' });
    csvText = req.file.buffer.toString('utf8');
  }
  try {
    const draft = await buildDraft({ workspaceId: req.ws.id, user: req.user, prompt, csvText, month, currency, signMode });
    audit(req, 'budget.ai_draft', 'budget_draft', draft.id, { source: draft.source, lines: draft.lines.length });
    res.status(201).json(draft);
  } catch (e) { fail(res, e); }
}));

router.get('/ai-budget/drafts/:id', (req, res) => {
  const d = getDraft(req.ws.id, req.user.id, req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  res.json({ id: d.id, month: d.month, currency: d.currency, status: d.status, lines: d.payload.lines, notes: d.payload.notes, importable_transactions: d.payload.rows.length });
});

// Step 2: apply the REVIEWED draft. Budget changes need owner/admin, exactly like setting a budget by hand.
router.post('/ai-budget/drafts/:id/apply', requirePermission('budget:approve'), (req, res) => {
  const d = getDraft(req.ws.id, req.user.id, req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  if (d.status !== 'pending') return res.status(409).json({ error: 'this draft was already applied' });
  if (d.expires_at < new Date().toISOString()) return res.status(410).json({ error: 'this draft has expired; create a new one' });
  try {
    const result = applyDraft({ workspaceId: req.ws.id, userId: req.user.id, draft: d, edited: req.body.lines, importTransactions: !!req.body.importTransactions });
    audit(req, 'budget.ai_applied', 'budget_draft', d.id, result);
    res.json(result);
  } catch (e) { fail(res, e); }
});

export default router;
