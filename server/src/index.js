import './loadEnv.js';
import { createApp } from './app.js';
import { startScheduler } from './notifications/generate.js';
import { syncMail } from './mail/sync.js';

// A stray library event must never take the whole board down: an unobserved ImapFlow 'error' emission
// (after an IMAP connection died) once killed the server for every workspace. Log loudly instead of
// dying; the request that hit the problem still fails with its own error status.
process.on('unhandledRejection', (err) => console.error('unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('uncaught exception:', err));

const PORT = process.env.PORT || 3417;
const HOST = process.env.HOST || '0.0.0.0';

createApp().listen(PORT, HOST, () => {
  console.log(`amb-board server listening on http://${HOST}:${PORT}`);
  startScheduler();
  try { syncMail(); } catch (err) { console.error('mail sync at start failed:', err.message); }   // picks up changes made while the server was down (a deleted workspace)
});
