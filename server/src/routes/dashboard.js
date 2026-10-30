import { Router } from 'express';
import { dashboardData } from '../dashboard/data.js';
import { getPlan, refreshPlan, PlanLimitError } from '../dashboard/plan.js';

const router = Router();

router.get('/', (req, res) => res.json(dashboardData(req.ws.id, req.user)));

// Which parts of the dashboard get more or less room today. Chosen by the AI once a day (rules when the AI is unavailable),
// adjusted live when something appears or empties, and the person can ask for a fresh arrangement a few times a day.
router.get('/plan', async (req, res) => res.json(await getPlan(req.ws, req.user)));
router.post('/plan/refresh', async (req, res) => {
  try { res.json(await refreshPlan(req.ws, req.user)); } catch (err) {
    if (err instanceof PlanLimitError) return res.status(429).json({ error: err.message });
    throw err;
  }
});

export default router;
