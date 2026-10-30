import { Router } from 'express';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { db, nowIso } from '../db.js';
import { cardInWs } from '../access.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const uploadsDir = process.env.AMB_UPLOADS_DIR || join(__dirname, '..', '..', 'uploads');
mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  // random name; only a short, sanitised extension is kept
  filename: (req, file, cb) => cb(null, `${nanoid()}${extname(file.originalname).replace(/[^.\w]/g, '').slice(0, 10)}`),
});

const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

// Mounted at /api/cards: routes carry :cardId
export const cardAttachments = Router();
cardAttachments.param('cardId', (req, res, next, id) => {
  if (!cardInWs(id, req.ws.id)) return res.status(404).json({ error: 'not found' });
  next();
});

// the :cardId param check runs before multer, so nothing is written for foreign cards
cardAttachments.post('/:cardId/attachments', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  const id = nanoid();
  db.prepare(`INSERT INTO attachments (id, card_id, filename, original_name, mime_type, size, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.params.cardId, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, nowIso());
  res.status(201).json(db.prepare('SELECT * FROM attachments WHERE id = ?').get(id));
});

cardAttachments.delete('/:cardId/attachments/:id', (req, res) => {
  const attachment = db.prepare('SELECT * FROM attachments WHERE id = ? AND card_id = ?')
    .get(req.params.id, req.params.cardId);
  if (attachment) {
    const filePath = join(uploadsDir, attachment.filename);
    if (existsSync(filePath)) unlinkSync(filePath);
    db.prepare('DELETE FROM attachments WHERE id = ?').run(req.params.id);
  }
  res.status(204).end();
});

// Access-controlled download. Only raster images render inline; everything else is forced to download
// so uploaded HTML/SVG can never execute in the app's origin.
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const attachmentDownload = Router();
attachmentDownload.get('/:id/download', (req, res) => {
  const att = db.prepare(`SELECT a.* FROM attachments a
    JOIN cards ON cards.id = a.card_id JOIN columns c ON c.id = cards.column_id JOIN projects p ON p.id = c.project_id
    WHERE a.id = ? AND p.workspace_id = ?`).get(req.params.id, req.ws.id);
  if (!att) return res.status(404).json({ error: 'not found' });
  const filePath = join(uploadsDir, att.filename);
  if (!existsSync(filePath)) return res.status(404).json({ error: 'file missing' });
  const inline = INLINE_TYPES.has(att.mime_type);
  res.setHeader('Content-Type', inline ? att.mime_type : 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(att.original_name)}`);
  res.setHeader('Cache-Control', 'private, max-age=0');
  res.sendFile(filePath);
});

export { uploadsDir };
