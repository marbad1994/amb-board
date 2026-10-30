import { Router } from 'express';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { dirname, join, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, openSync, readSync, closeSync, unlinkSync, existsSync } from 'node:fs';
import { db, nowIso } from '../db.js';
import { projectInWs, can, audit } from '../access.js';
import { goalInWs } from './goals.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dir = join(process.env.AMB_UPLOADS_DIR || join(__dirname, '..', '..', 'uploads'), 'documents');
mkdirSync(dir, { recursive: true });

const MAX_BYTES = 10 * 1024 * 1024;
const upload = multer({ storage: multer.diskStorage({ destination: dir, filename: (req, f, cb) => cb(null, nanoid()) }), limits: { fileSize: MAX_BYTES, files: 1 } });

// Allow-list by extension; the server decides the content type, never the client. Binary types are checked by magic bytes.
const TYPES = {
  pdf: { mime: 'application/pdf', magic: [[0x25, 0x50, 0x44, 0x46]] },
  png: { mime: 'image/png', magic: [[0x89, 0x50, 0x4e, 0x47]], inline: true },
  jpg: { mime: 'image/jpeg', magic: [[0xff, 0xd8, 0xff]], inline: true },
  jpeg: { mime: 'image/jpeg', magic: [[0xff, 0xd8, 0xff]], inline: true },
  gif: { mime: 'image/gif', magic: [[0x47, 0x49, 0x46, 0x38]], inline: true },
  webp: { mime: 'image/webp', magic: [[0x52, 0x49, 0x46, 0x46]], inline: true },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: [[0x50, 0x4b, 0x03, 0x04]] },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: [[0x50, 0x4b, 0x03, 0x04]] },
  txt: { mime: 'text/plain', text: true }, md: { mime: 'text/plain', text: true }, csv: { mime: 'text/csv', text: true },
};

function looksValid(path, type) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, 4096, 0);
    if (n === 0) return false;
    if (type.text) return !buf.subarray(0, n).includes(0);
    return type.magic.some((m) => m.every((b, i) => buf[i] === b));
  } finally { closeSync(fd); }
}

const cleanName = (n) => basename(String(n).replace(/\\/g, '/')).replace(/[\u0000-\u001f"<>|:*?]/g, '').slice(0, 150) || 'file';

// A document is visible if it is workspace-wide, or you uploaded it.
const VISIBLE = "d.workspace_id = ? AND (d.privacy = 'workspace' OR d.uploaded_by = ?)";
const visible = (id, req) => db.prepare(`SELECT d.* FROM documents d WHERE d.id = ? AND ${VISIBLE}`).get(String(id), req.ws.id, req.user.id);
const present = (d, req) => ({ id: d.id, name: d.name, mime_type: d.mime_type, size: d.size, privacy: d.privacy, project_id: d.project_id, project_name: d.project_name ?? null,
  goal_id: d.goal_id, goal_title: d.goal_title ?? null, uploaded_by_name: d.uploader_name, mine: d.uploaded_by === req.user.id, created_at: d.created_at });
const SELECT = `SELECT d.*, u.name AS uploader_name, p.name AS project_name, g.title AS goal_title FROM documents d JOIN users u ON u.id = d.uploaded_by
  LEFT JOIN projects p ON p.id = d.project_id LEFT JOIN goals g ON g.id = d.goal_id`;

const router = Router();

router.get('/', (req, res) => {
  const where = [VISIBLE]; const params = [req.ws.id, req.user.id];
  if (req.query.project) { where.push('d.project_id = ?'); params.push(String(req.query.project)); }
  if (req.query.goal) { where.push('d.goal_id = ?'); params.push(String(req.query.goal)); }
  res.json(db.prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC LIMIT 200`).all(...params).map((d) => present(d, req)));
});

router.post('/', (req, res, next) => upload.single('file')(req, res, (err) => {
  if (err) return err.code === 'LIMIT_FILE_SIZE' ? res.status(413).json({ error: 'file too large (10 MB max)' }) : next(err);
  const reject = (status, msg) => { if (req.file) try { unlinkSync(req.file.path); } catch { /* already gone */ } return res.status(status).json({ error: msg }); };
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  const name = cleanName(req.file.originalname);
  const ext = extname(name).slice(1).toLowerCase();
  const type = Object.hasOwn(TYPES, ext) ? TYPES[ext] : null;
  if (!type) return reject(415, `file type .${ext || '?'} is not allowed (${Object.keys(TYPES).join(', ')})`);
  if (!looksValid(req.file.path, type)) return reject(415, 'file content does not match its type');
  const projectId = req.body.projectId || null; const goalId = req.body.goalId || null;
  if (projectId && !projectInWs(projectId, req.ws.id)) return reject(400, 'invalid project');
  if (goalId && !goalInWs(goalId, req.ws.id)) return reject(400, 'invalid goal');
  const id = nanoid();
  db.prepare(`INSERT INTO documents (id, workspace_id, name, mime_type, size, filename, privacy, project_id, goal_id, uploaded_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, req.ws.id, name, type.mime, req.file.size, req.file.filename, req.body.privacy === 'private' ? 'private' : 'workspace', projectId, goalId, req.user.id, nowIso());
  audit(req, 'document.upload', 'document', id, { name, size: req.file.size });
  res.status(201).json(present(db.prepare(`${SELECT} WHERE d.id = ?`).get(id), req));
}));

router.get('/:id/download', (req, res) => {
  const d = visible(req.params.id, req);
  if (!d) return res.status(404).json({ error: 'not found' });
  const path = join(dir, d.filename);
  if (!existsSync(path)) return res.status(404).json({ error: 'file missing' });
  const inline = !!TYPES[extname(d.name).slice(1).toLowerCase()]?.inline;
  res.setHeader('Content-Type', d.mime_type);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(d.name)}`);
  res.setHeader('Cache-Control', 'private, max-age=0');
  res.sendFile(path);
});

// The uploader, or an owner/admin, may delete.
router.delete('/:id', (req, res) => {
  const d = visible(req.params.id, req);
  if (!d) return res.status(404).json({ error: 'not found' });
  if (d.uploaded_by !== req.user.id && !can(req.ws.role, 'members:manage')) return res.status(403).json({ error: 'only the uploader or an admin can delete this' });
  db.prepare('DELETE FROM documents WHERE id = ?').run(d.id);
  try { unlinkSync(join(dir, d.filename)); } catch { /* already gone */ }
  audit(req, 'document.delete', 'document', d.id, { name: d.name });
  res.status(204).end();
});

export default router;
