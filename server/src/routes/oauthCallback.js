import { Router } from 'express';
import { finishOAuth } from '../ai/mcpAuth.js';
import { forgetServer } from '../ai/mcpClient.js';

const router = Router();

// Where the sign-in provider sends the person back to. It needs the session (SameSite=Lax cookies are sent on this
// top-level redirect) but no workspace header; the state value ties it to the connection this person started.
router.get('/mcp/callback', async (req, res) => {
  const back = (q) => res.redirect(`/settings?${new URLSearchParams({ tab: 'assistant', ...q })}`);
  if (req.query.error) return back({ oauth: 'error', message: String(req.query.error_description || req.query.error).replace(/[\u0000-\u001f]/g, ' ').slice(0, 150) });
  try {
    const s = await finishOAuth(req.user.id, String(req.query.code || ''), String(req.query.state || ''));
    forgetServer(s.id);
    back({ oauth: 'ok', name: s.name });
  } catch (err) { back({ oauth: 'error', message: String(err.message).slice(0, 150) }); }
});

export default router;
