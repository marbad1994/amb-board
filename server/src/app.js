import express from 'express';
import cors from 'cors';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { securityHeaders, originCheck } from './security.js';
import { requireAuth, requireWorkspace, methodPermission } from './access.js';
import authRouter from './routes/auth.js';
import workspacesRouter, { invitationsRouter } from './routes/workspaces.js';
import lifeAreasRouter from './routes/lifeAreas.js';
import dashboardRouter from './routes/dashboard.js';
import financeRouter, { projectFinanceRouter } from './routes/finance.js';
import calendarRouter from './routes/calendar.js';
import goalsRouter, { projectGoalsRouter } from './routes/goals.js';
import habitsRouter from './routes/habits.js';
import notesRouter from './routes/notes.js';
import documentsRouter from './routes/documents.js';
import myDayRouter from './routes/myday.js';
import financeExtraRouter from './routes/financeExtra.js';
import financeAiRouter from './routes/financeAi.js';
import automationsRouter from './routes/automations.js';
import transferRouter from './routes/transfer.js';
import { pairingsRouter, extRouter } from './routes/browser.js';
import mcpRouter, { tokensRouter } from './routes/mcp.js';
import reportsRouter from './routes/reports.js';
import notificationsRouter from './routes/notifications.js';
import tasksRouter, { searchRouter } from './routes/tasks.js';
import projectsRouter from './routes/projects.js';
import columnsRouter from './routes/columns.js';
import cardsRouter from './routes/cards.js';
import { cardAttachments, attachmentDownload } from './routes/attachments.js';
import ideasRouter from './routes/ideas.js';
import translateRouter from './routes/translate.js';
import aiRouter from './routes/ai.js';
import aiInsightsRouter from './routes/aiInsights.js';
import aiAssistantRouter from './routes/aiAssistant.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientDist = join(__dirname, '..', '..', 'client', 'dist');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY === 'true');

  app.use(securityHeaders);
  // Credentialed cross-origin access is opt-in (dev proxies are same-origin and need none).
  if (process.env.CORS_ORIGIN) app.use(cors({ origin: process.env.CORS_ORIGIN.split(','), credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', originCheck);

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRouter);
  // MCP authenticates with its own bearer token, not the session cookie (and is exempt from the Origin check: no cookies involved).
  app.use('/api/mcp', mcpRouter);
  // the browser extension: bearer pairing token, no cookies
  app.use('/api/browser-ext', extRouter);

  // Everything below requires a session.
  app.use('/api', requireAuth);
  app.use('/api/workspaces', workspacesRouter);
  app.use('/api/invitations', invitationsRouter);

  // Notifications: workspace-scoped, but every member (viewers too) manages their own.
  app.use('/api/notifications', requireWorkspace, notificationsRouter);

  // Everything below is scoped to one workspace and permission-checked by HTTP method.
  app.use('/api', requireWorkspace, methodPermission);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/life-areas', lifeAreasRouter);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/automations', automationsRouter);
  app.use('/api/transfer', transferRouter);
  app.use('/api/browser/pairings', pairingsRouter);
  app.use('/api/tokens', tokensRouter);
  app.use('/api/finance', financeRouter);
  app.use('/api/finance', financeExtraRouter);
  app.use('/api/finance', financeAiRouter);
  app.use('/api/calendar', calendarRouter);
  app.use('/api/goals', goalsRouter);
  app.use('/api/habits', habitsRouter);
  app.use('/api/notes', notesRouter);
  app.use('/api/documents', documentsRouter);
  app.use('/api/my-day', myDayRouter);
  app.use('/api/projects', projectGoalsRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api/projects', projectFinanceRouter);
  app.use('/api/projects', columnsRouter);
  app.use('/api/cards', cardsRouter);
  app.use('/api/cards', cardAttachments);
  app.use('/api/attachments', attachmentDownload);
  app.use('/api/ideas', ideasRouter);
  app.use('/api/translate', translateRouter);
  app.use('/api/ai', aiInsightsRouter);
  app.use('/api/ai/assistant', aiAssistantRouter);
  app.use('/api/ai', aiRouter);

  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    res.sendFile(join(clientDist, 'index.html'), (err) => { if (err) next(); });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'file too large' });
    console.error('unhandled error:', err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
