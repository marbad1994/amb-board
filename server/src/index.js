import './loadEnv.js';
import { createApp } from './app.js';
import { startScheduler } from './notifications/generate.js';
import { syncMail } from './mail/sync.js';

const PORT = process.env.PORT || 3417;
const HOST = process.env.HOST || '0.0.0.0';

createApp().listen(PORT, HOST, () => {
  console.log(`amb-board server listening on http://${HOST}:${PORT}`);
  startScheduler();
  try { syncMail(); } catch (err) { console.error('mail sync at start failed:', err.message); }   // picks up changes made while the server was down (a deleted workspace)
});
