import { nanoid } from 'nanoid';
import { DEFAULT_CATEGORIES } from './finance/defaults.js';

// Versioned, forward-only migrations. Each runs once, in a transaction, and is recorded in schema_migrations.

const baseline = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#6366f1',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS columns (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    column_id TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'todo',
    owner TEXT DEFAULT '',
    creator TEXT DEFAULT '',
    labels TEXT DEFAULT '[]',
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    author TEXT DEFAULT '',
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT,
    size INTEGER,
    uploaded_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS idea_notes (
    id TEXT PRIMARY KEY,
    author TEXT DEFAULT '',
    text TEXT NOT NULL,
    color TEXT DEFAULT '#fde68a',
    x REAL DEFAULT 0,
    y REAL DEFAULT 0,
    rotation REAL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_columns_project ON columns(project_id);
  CREATE INDEX IF NOT EXISTS idx_cards_column ON cards(column_id);
  CREATE INDEX IF NOT EXISTS idx_comments_card ON comments(card_id);
  CREATE INDEX IF NOT EXISTS idx_attachments_card ON attachments(card_id);
`;

const foundation = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    disabled_at TEXT
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,               -- sha256 of the opaque token; the token itself is never stored
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    user_agent TEXT DEFAULT '',
    ip TEXT DEFAULT ''
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);

  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('personal','shared')),
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
  );

  CREATE TABLE workspace_members (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
  );
  CREATE INDEX idx_members_user ON workspace_members(user_id);

  CREATE TABLE invitations (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email TEXT NOT NULL COLLATE NOCASE,
    role TEXT NOT NULL CHECK (role IN ('admin','member','viewer')),
    token_hash TEXT NOT NULL UNIQUE,
    invited_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    accepted_at TEXT,
    revoked_at TEXT
  );
  CREATE INDEX idx_invitations_ws ON invitations(workspace_id);

  CREATE TABLE life_areas (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT 'layers',
    position INTEGER NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_life_areas_ws ON life_areas(workspace_id);

  CREATE TABLE life_area_subcategories (
    id TEXT PRIMARY KEY,
    life_area_id TEXT NOT NULL REFERENCES life_areas(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    archived_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_subcats_area ON life_area_subcategories(life_area_id);

  CREATE TABLE audit_log (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    user_id TEXT,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL DEFAULT '',
    entity_id TEXT NOT NULL DEFAULT '',
    meta TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_audit_ws ON audit_log(workspace_id, created_at);

  ALTER TABLE projects ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;
  ALTER TABLE projects ADD COLUMN life_area_id TEXT REFERENCES life_areas(id) ON DELETE SET NULL;
  ALTER TABLE projects ADD COLUMN description TEXT NOT NULL DEFAULT '';
  ALTER TABLE projects ADD COLUMN archived_at TEXT;
  ALTER TABLE projects ADD COLUMN updated_at TEXT;
  ALTER TABLE idea_notes ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;
  CREATE INDEX idx_projects_ws ON projects(workspace_id);
  CREATE INDEX idx_projects_area ON projects(life_area_id);
  CREATE INDEX idx_ideas_ws ON idea_notes(workspace_id);
`;

const coreManagement = `
  ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('todo','in_progress','done'));
  ALTER TABLE projects ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent'));
  ALTER TABLE projects ADD COLUMN start_date TEXT;
  ALTER TABLE projects ADD COLUMN target_date TEXT;
  ALTER TABLE cards ADD COLUMN due_date TEXT;
  ALTER TABLE cards ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent'));
  ALTER TABLE cards ADD COLUMN completed_at TEXT;
  ALTER TABLE idea_notes ADD COLUMN converted_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
  UPDATE cards SET completed_at = updated_at WHERE status = 'done';
  CREATE TABLE subtasks (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE INDEX idx_subtasks_card ON subtasks(card_id);
  CREATE INDEX idx_cards_due ON cards(due_date);
`;

const aiTables = `
  CREATE TABLE ai_usage (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    purpose TEXT NOT NULL,
    status TEXT NOT NULL,              -- ok | error
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    latency_ms INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_ai_usage_ws ON ai_usage(workspace_id, created_at);

  CREATE TABLE ai_summaries (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('project','daily')),
    subject_id TEXT NOT NULL,          -- project id, or user id for a daily briefing
    input_hash TEXT NOT NULL,          -- hash of the facts sent; unchanged facts => cached text is reused
    content TEXT NOT NULL,             -- JSON produced by the model, validated
    facts TEXT NOT NULL,               -- the deterministic facts it was generated from (traceability)
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    UNIQUE (workspace_id, kind, subject_id)
  );
`;

const financeCalendar = `
  ALTER TABLE workspaces ADD COLUMN default_currency TEXT NOT NULL DEFAULT 'EUR';
  ALTER TABLE cards ADD COLUMN recurrence TEXT NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none','daily','weekly','monthly'));
  ALTER TABLE cards ADD COLUMN recurrence_spawned_at TEXT;

  CREATE TABLE financial_accounts (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    currency TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'checking' CHECK (kind IN ('checking','savings','cash','credit','investment')),
    archived_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_fin_accounts_ws ON financial_accounts(workspace_id);

  CREATE TABLE transaction_categories (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    parent_id TEXT REFERENCES transaction_categories(id) ON DELETE SET NULL,
    archived_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_tx_categories_ws ON transaction_categories(workspace_id);

  -- Money is stored as integer minor units (cents). Amounts are always positive; 'type' gives the direction.
  CREATE TABLE transactions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('income','expense','refund','transfer')),
    status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','planned')),
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    currency TEXT NOT NULL,
    date TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    category_id TEXT REFERENCES transaction_categories(id) ON DELETE SET NULL,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    account_id TEXT REFERENCES financial_accounts(id) ON DELETE SET NULL,
    to_account_id TEXT REFERENCES financial_accounts(id) ON DELETE SET NULL,
    external_ref TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    voided_at TEXT
  );
  CREATE UNIQUE INDEX idx_tx_external ON transactions(workspace_id, external_ref) WHERE external_ref IS NOT NULL;
  CREATE INDEX idx_tx_ws_date ON transactions(workspace_id, date);
  CREATE INDEX idx_tx_project ON transactions(project_id);

  CREATE TABLE project_budgets (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    currency TEXT NOT NULL,
    approved_minor INTEGER NOT NULL CHECK (approved_minor >= 0),
    alert_pct INTEGER NOT NULL DEFAULT 80 CHECK (alert_pct BETWEEN 1 AND 100),
    approved_by TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE recurring_expenses (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    currency TEXT NOT NULL,
    category_id TEXT REFERENCES transaction_categories(id) ON DELETE SET NULL,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    frequency TEXT NOT NULL CHECK (frequency IN ('weekly','monthly','yearly')),
    anchor_date TEXT NOT NULL,         -- first occurrence; month-end days are clamped from this
    next_date TEXT NOT NULL,
    is_subscription INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_recurring_ws ON recurring_expenses(workspace_id);

  CREATE TABLE calendar_events (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'appointment' CHECK (kind IN ('appointment','personal')),
    all_day INTEGER NOT NULL DEFAULT 0,
    start_local TEXT NOT NULL,         -- wall-clock time in 'timezone': YYYY-MM-DDTHH:mm (or YYYY-MM-DD when all_day)
    end_local TEXT,
    timezone TEXT NOT NULL,
    recurrence TEXT NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none','daily','weekly','monthly','yearly')),
    recurrence_interval INTEGER NOT NULL DEFAULT 1 CHECK (recurrence_interval BETWEEN 1 AND 52),
    recurrence_until TEXT,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    card_id TEXT REFERENCES cards(id) ON DELETE SET NULL,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_events_ws ON calendar_events(workspace_id, start_local);
`;

export const migrations = [
  { id: '001_baseline', up: (db) => {
    db.exec(baseline);
    // Databases created before the labels column existed.
    const cols = db.prepare('PRAGMA table_info(cards)').all().map((c) => c.name);
    if (!cols.includes('labels')) db.exec("ALTER TABLE cards ADD COLUMN labels TEXT DEFAULT '[]'");
  } },
  { id: '002_foundation', up: (db) => db.exec(foundation) },
  { id: '003_core_management', up: (db) => db.exec(coreManagement) },
  { id: '004_ai', up: (db) => db.exec(aiTables) },
  { id: '005_finance_calendar', up: (db) => {
    db.exec(financeCalendar);
    // existing workspaces get the same default categories new ones receive
    const ins = db.prepare('INSERT INTO transaction_categories (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)');
    const ts = new Date().toISOString();
    for (const { id } of db.prepare('SELECT id FROM workspaces').all()) {
      for (const name of DEFAULT_CATEGORIES) ins.run(nanoid(), id, name, ts);
    }
  } },
];

function appliedIds(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  return new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
}

export function pendingMigrations(db) {
  const applied = appliedIds(db);
  return migrations.filter((m) => !applied.has(m.id));
}

export function migrate(db) {
  const applied = appliedIds(db);
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    db.exec('BEGIN');
    try {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(m.id, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${m.id} failed: ${err.message}`);
    }
  }
}
