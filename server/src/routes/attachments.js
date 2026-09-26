import { Router } from 'express';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { db, nowIso } from '../db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const uploadsDir = join(__dirname, '..', '..', 'uploads');
mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${nanoid()}${extname(file.originalname)}`),
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
});

const router = Router();

router.post('/:cardId/attachments', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  const id = nanoid();
  db.prepare(`INSERT INTO attachments (id, card_id, filename, original_name, mime_type, size, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.params.cardId, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, nowIso());
  res.status(201).json(db.prepare('SELECT * FROM attachments WHERE id = ?').get(id));
});

router.delete('/:cardId/attachments/:id', (req, res) => {
  const attachment = db.prepare('SELECT * FROM attachments WHERE id = ? AND card_id = ?')
    .get(req.params.id, req.params.cardId);
  if (attachment) {
    const filePath = join(uploadsDir, attachment.filename);
    if (existsSync(filePath)) unlinkSync(filePath);
    db.prepare('DELETE FROM attachments WHERE id = ?').run(req.params.id);
  }
  res.status(204).end();
});

export default router;
export { uploadsDir };
