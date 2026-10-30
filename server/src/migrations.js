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

export const migrations = [
  { id: '001_baseline', up: (db) => {
    db.exec(baseline);
    // Databases created before the labels column existed.
    const cols = db.prepare('PRAGMA table_info(cards)').all().map((c) => c.name);
    if (!cols.includes('labels')) db.exec("ALTER TABLE cards ADD COLUMN labels TEXT DEFAULT '[]'");
  } },
  { id: '002_foundation', up: (db) => db.exec(foundation) },
];

export function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
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
