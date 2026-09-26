import './loadEnv.js';
import express from 'express';
import cors from 'cors';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import projectsRouter from './routes/projects.js';
import columnsRouter from './routes/columns.js';
import cardsRouter from './routes/cards.js';
import attachmentsRouter from './routes/attachments.js';
import ideasRouter from './routes/ideas.js';
import translateRouter from './routes/translate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const uploadsDir = join(__dirname, '..', 'uploads');
const clientDist = join(__dirname, '..', '..', 'client', 'dist');

const app = express();
const PORT = process.env.PORT || 3417;
const HOST = process.env.HOST || '0.0.0.0';

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use('/uploads', express.static(uploadsDir));

app.use('/api/projects', projectsRouter);
app.use('/api/projects', columnsRouter);
app.use('/api/cards', cardsRouter);
app.use('/api/cards', attachmentsRouter);
app.use('/api/ideas', ideasRouter);
app.use('/api/translate', translateRouter);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// serve built client in production
app.use(express.static(clientDist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
  res.sendFile(join(clientDist, 'index.html'), (err) => {
    if (err) next();
  });
});

app.listen(PORT, HOST, () => {
  console.log(`amb-board server listening on http://${HOST}:${PORT}`);
});
