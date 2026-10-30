import { inflateRawSync } from 'node:zlib';
import { nanoid } from 'nanoid';
import { db, nowIso } from '../db.js';
import { BUILTIN_SKILLS } from './skillLibrary.js';

export const MAX_SKILLS = 30;
export const MAX_BODY = 30_000;
const MAX_ZIP = 2_000_000;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const RESERVED = new Set(['stop', 'cancel', 'exit', 'help', 'skills']);

export class SkillError extends Error { constructor(m, status = 400) { super(m); this.status = status; } }

// Reads SKILL.md out of a .skill / .zip archive. Only the first SKILL.md at depth <= 1 is read; sizes are capped.
export function readSkillZip(buf) {
  if (buf.length > MAX_ZIP) throw new SkillError('that file is too large (2 MB max)');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70_000); i -= 1) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new SkillError('not a valid .skill file (zip archive expected)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10); const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28); const extraLen = buf.readUInt16LE(p + 30); const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!/^([^/]+\/)?SKILL\.md$/.test(name)) continue;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new SkillError('damaged .skill file');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    try { return (method === 0 ? data : inflateRawSync(data, { maxOutputLength: MAX_BODY * 4 })).toString('utf8'); }
    catch { throw new SkillError('could not read SKILL.md inside the file (too large or damaged)'); }
  }
  throw new SkillError('no SKILL.md found in that file');
}

// "---\nname: x\ndescription: y\n---\nbody" -> { name, description, body }
export function parseSkillText(text, fallbackName = '') {
  let t = String(text ?? '').replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
  const meta = {};
  const m = t.match(/^---\n([\s\S]*?)\n---\n?/);
  if (m) {
    t = t.slice(m[0].length).trim();
    const lines = m[1].split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const kv = lines[i].match(/^([A-Za-z_-]+):\s*(.*)$/); if (!kv) continue;
      let v = kv[2].trim();
      if (v === '>' || v === '|' || v === '>-' || v === '|-') { const parts = []; while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim()); v = parts.join(' '); }
      meta[kv[1].toLowerCase()] = v.replace(/^["']|["']$/g, '');
    }
  }
  const name = String(meta.name || fallbackName).toLowerCase().replace(/\.(skill|md|zip)$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  if (!NAME_RE.test(name)) throw new SkillError('the skill needs a name (letters, numbers and dashes)');
  if (RESERVED.has(name)) throw new SkillError(`"${name}" is reserved`);
  if (BUILTIN_SKILLS.some((s) => s.name === name)) throw new SkillError(`"${name}" is a built-in skill; rename yours`);
  if (!t) throw new SkillError('the skill has no instructions');
  if (t.length > MAX_BODY) throw new SkillError(`the skill is too long (${MAX_BODY} characters max)`);
  return { name, description: String(meta.description || t.split('\n').find((l) => l.trim() && !l.startsWith('#')) || '').slice(0, 400), body: t };
}

export function importSkill(ws, userId, { content, zipBase64, filename }) {
  let text = content;
  if (zipBase64) text = readSkillZip(Buffer.from(String(zipBase64), 'base64'));
  if (!text || !String(text).trim()) throw new SkillError('nothing to import');
  const s = parseSkillText(text, String(filename || '').replace(/^.*[\\/]/, ''));
  if (db.prepare('SELECT 1 FROM ai_skills WHERE workspace_id = ? AND user_id = ? AND name = ?').get(ws, userId, s.name)) throw new SkillError(`you already have a skill called "${s.name}"; delete it first to replace it`, 409);
  if (db.prepare('SELECT COUNT(*) n FROM ai_skills WHERE workspace_id = ? AND user_id = ?').get(ws, userId).n >= MAX_SKILLS) throw new SkillError(`at most ${MAX_SKILLS} skills`, 409);
  const id = nanoid();
  db.prepare('INSERT INTO ai_skills (id, workspace_id, user_id, name, description, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, ws, userId, s.name, s.description, s.body, nowIso());
  return { id, name: s.name, description: s.description, builtin: false };
}

export function listSkills(ws, userId) {
  return [
    ...BUILTIN_SKILLS.map((s) => ({ id: `builtin:${s.name}`, name: s.name, description: s.description, builtin: true })),
    ...db.prepare('SELECT id, name, description FROM ai_skills WHERE workspace_id = ? AND user_id = ? ORDER BY name').all(ws, userId).map((s) => ({ ...s, builtin: false })),
  ];
}

export function findSkill(ws, userId, name) {
  const n = String(name || '').toLowerCase();
  const b = BUILTIN_SKILLS.find((s) => s.name === n);
  if (b) return b;
  return db.prepare('SELECT name, description, body FROM ai_skills WHERE workspace_id = ? AND user_id = ? AND name = ?').get(ws, userId, n) ?? null;
}

// "/name rest of the message" -> { name, rest }
export function parseSlash(message) {
  const m = String(message).match(/^\/([A-Za-z0-9][A-Za-z0-9-]{0,39})(?:\s+([\s\S]*))?$/);
  return m ? { name: m[1].toLowerCase(), rest: (m[2] || '').trim() } : null;
}

// Plain-language requests to build a flow start the guided interview without a slash command.
const AUTOMATION_INTENT = /\b(create|make|build|set ?up|add|design|write)\b[^.?!]{0,40}\b(automation|flow|scheduler|scheduled (task|job|report))\b/i;
export const wantsAutomation = (message) => AUTOMATION_INTENT.test(message);
