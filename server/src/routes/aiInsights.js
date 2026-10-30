import { Router } from 'express';
import { projectInWs, audit } from '../access.js';
import { configuredProviders, usageToday, dailyLimit, AiUnavailableError, AiLimitError, AiFailureError } from '../ai/gateway.js';
import { projectFacts, dailyFacts } from '../ai/facts.js';
import { generate, getCached } from '../ai/summaries.js';
import { reviewFacts, periodFor } from '../ai/reviews.js';
import { parseDate, todayUtc } from '../validate.js';

const router = Router();

function handle(res, err) {
  if (err instanceof AiUnavailableError) return res.status(503).json({ error: err.message });
  if (err instanceof AiLimitError) return res.status(429).json({ error: err.message });
  if (err instanceof AiFailureError) return res.status(502).json({ error: err.message });
  console.error('ai route error:', err);
  return res.status(500).json({ error: 'internal error' });
}

router.get('/status', (req, res) => {
  const providers = configuredProviders().map((p) => p.name);
  res.json({ available: providers.length > 0, providers, usedToday: usageToday(req.ws.id), dailyLimit: dailyLimit() });
});

// GET returns the stored summary (readable by viewers); POST generates/refreshes (needs write access, enforced by methodPermission).
router.get('/projects/:id/summary', (req, res) => {
  const project = projectInWs(req.params.id, req.ws.id);
  if (!project) return res.status(404).json({ error: 'not found' });
  res.json({ summary: getCached(req.ws.id, 'project', project.id, projectFacts(project, req.ws.id)) });
});

router.post('/projects/:id/summary', async (req, res) => {
  const project = projectInWs(req.params.id, req.ws.id);
  if (!project) return res.status(404).json({ error: 'not found' });
  try {
    const summary = await generate({ workspaceId: req.ws.id, userId: req.user.id, kind: 'project', subjectId: project.id,
      facts: projectFacts(project, req.ws.id), force: !!req.body.refresh });
    if (!summary.cached) audit(req, 'ai.project_summary', 'project', project.id, { provider: summary.provider });
    res.json({ summary });
  } catch (err) { handle(res, err); }
});

router.get('/briefing', (req, res) => {
  res.json({ summary: getCached(req.ws.id, 'daily', req.user.id, dailyFacts(req.ws.id, req.user)) });
});

router.post('/briefing', async (req, res) => {
  try {
    const summary = await generate({ workspaceId: req.ws.id, userId: req.user.id, kind: 'daily', subjectId: req.user.id,
      facts: dailyFacts(req.ws.id, req.user), force: !!req.body.refresh });
    res.json({ summary });
  } catch (err) { handle(res, err); }
});

// Weekly / monthly reviews. ?date=YYYY-MM-DD picks the period (default: today's). Habit data is personal, so each
// user gets their own cached review (subject = user + period start).
function reviewCtx(req, res) {
  const period = req.params.period;
  if (!['weekly', 'monthly'].includes(period)) { res.status(404).json({ error: 'not found' }); return null; }
  const date = req.query.date ? parseDate(req.query.date) : todayUtc();
  if (!date) { res.status(400).json({ error: 'date must be a valid YYYY-MM-DD date' }); return null; }
  return { period, subjectId: `${req.user.id}:${periodFor(period, date).start}`, facts: reviewFacts(period, req.ws.id, req.user, date) };
}

router.get('/review/:period', (req, res) => {
  const c = reviewCtx(req, res); if (!c) return;
  res.json({ summary: getCached(req.ws.id, c.period, c.subjectId, c.facts) });
});

router.post('/review/:period', async (req, res) => {
  const c = reviewCtx(req, res); if (!c) return;
  try {
    const summary = await generate({ workspaceId: req.ws.id, userId: req.user.id, kind: c.period, subjectId: c.subjectId, facts: c.facts, force: !!req.body.refresh });
    if (!summary.cached) audit(req, `ai.${c.period}_review`, 'user', req.user.id, { provider: summary.provider });
    res.json({ summary });
  } catch (err) { handle(res, err); }
});

export default router;
