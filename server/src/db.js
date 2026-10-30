import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from './migrations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// AMB_DB_PATH lets tests use ':memory:' or a temp file.
function resolveDbPath() {
  if (process.env.AMB_DB_PATH) return process.env.AMB_DB_PATH;
  const dataDir = join(__dirname, '..', 'data');
  mkdirSync(dataDir, { recursive: true });
  return join(dataDir, 'board.sqlite');
}

export const db = new DatabaseSync(resolveDbPath());
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
migrate(db);

export function parseLabels(row) {
  try {
    const labels = JSON.parse(row.labels || '[]');
    return Array.isArray(labels) ? labels : [];
  } catch {
    return [];
  }
}

export function nowIso() {
  return new Date().toISOString();
}

// Runs fn inside a transaction; rolls back on throw.
export function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
