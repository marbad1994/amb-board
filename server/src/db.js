import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, pendingMigrations } from './migrations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// AMB_DB_PATH lets tests use ':memory:' or a temp file.
function resolveDbPath() {
  if (process.env.AMB_DB_PATH) return process.env.AMB_DB_PATH;
  const dataDir = join(__dirname, '..', 'data');
  mkdirSync(dataDir, { recursive: true });
  return join(dataDir, 'board.sqlite');
}

const dbPath = resolveDbPath();
export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

// Existing user data must survive upgrades: before applying schema changes to a database that already
// holds data, write a consistent full copy next to it (board.sqlite.bak-<timestamp>). VACUUM INTO is
// WAL-safe. A failed backup aborts startup rather than risking the data.
function backupIfNeeded() {
  if (dbPath === ':memory:') return;
  const hasData = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get();
  if (!hasData || pendingMigrations(db).length === 0) return;
  const target = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  console.log(`database backed up to ${target} before migrating`);
}
backupIfNeeded();
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
