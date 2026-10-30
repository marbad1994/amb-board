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

const assistantTables = `
  CREATE TABLE ai_conversations (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_ai_conv_user ON ai_conversations(workspace_id, user_id, updated_at);

  CREATE TABLE ai_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content TEXT NOT NULL,
    tool_trace TEXT NOT NULL DEFAULT '[]',   -- which read tools the model used (names + args), for transparency
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_ai_msg_conv ON ai_messages(conversation_id, created_at);

  -- The model can only PROPOSE. Nothing here is applied until the owner of the conversation approves.
  CREATE TABLE ai_action_proposals (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL REFERENCES ai_messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    target TEXT NOT NULL,                    -- JSON {entity, id|null}
    payload TEXT NOT NULL,                   -- JSON, validated values
    description TEXT NOT NULL,               -- generated by the server from the payload, never taken from the model
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','failed','expired')),
    result TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    decided_at TEXT,
    decided_by TEXT
  );
  CREATE INDEX idx_ai_prop_conv ON ai_action_proposals(conversation_id);
`;

const lifeTables = `
  CREATE TABLE goals (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    life_area_id TEXT REFERENCES life_areas(id) ON DELETE SET NULL,
    target_date TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','achieved','archived')),
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_goals_ws ON goals(workspace_id);
  CREATE TABLE goal_milestones (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    due_date TEXT,
    done INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_milestones_goal ON goal_milestones(goal_id);
  CREATE TABLE goal_projects (
    goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    PRIMARY KEY (goal_id, project_id)
  );

  -- Habits are personal: only their creator sees them, even in a shared workspace.
  CREATE TABLE habits (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    frequency TEXT NOT NULL CHECK (frequency IN ('daily','weekly')),
    target_per_week INTEGER NOT NULL DEFAULT 7 CHECK (target_per_week BETWEEN 1 AND 7),
    goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
    archived_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_habits_user ON habits(workspace_id, user_id);
  CREATE TABLE habit_entries (
    habit_id TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (habit_id, date)
  );
  CREATE TABLE challenges (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    habit_id TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- Journal entries are ALWAYS private to their author. Notes are workspace-visible unless marked private.
  CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('note','journal')),
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    entry_date TEXT,
    privacy TEXT NOT NULL DEFAULT 'workspace' CHECK (privacy IN ('private','workspace')),
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_notes_ws ON notes(workspace_id, kind, updated_at);

  CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    filename TEXT NOT NULL,
    privacy TEXT NOT NULL DEFAULT 'workspace' CHECK (privacy IN ('private','workspace')),
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
    uploaded_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_documents_ws ON documents(workspace_id, created_at);
`;

const depthTables = `
  ALTER TABLE calendar_events ADD COLUMN reminder_minutes INTEGER CHECK (reminder_minutes IS NULL OR reminder_minutes BETWEEN 0 AND 10080);

  CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    link TEXT NOT NULL DEFAULT '',
    dedupe_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    read_at TEXT,
    UNIQUE (user_id, dedupe_key)               -- generating the same notification twice is a no-op
  );
  CREATE INDEX idx_notifications_user ON notifications(user_id, workspace_id, created_at);

  CREATE TABLE notification_preferences (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    event_reminders INTEGER NOT NULL DEFAULT 1,
    task_due INTEGER NOT NULL DEFAULT 1,
    budget_alerts INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE monthly_budgets (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    month TEXT NOT NULL,
    category_id TEXT NOT NULL REFERENCES transaction_categories(id) ON DELETE CASCADE,
    currency TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
    PRIMARY KEY (workspace_id, month, category_id, currency)
  );

  CREATE TABLE savings_goals (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    currency TEXT NOT NULL,
    target_minor INTEGER NOT NULL CHECK (target_minor > 0),
    target_date TEXT,
    is_emergency_fund INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE savings_entries (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL REFERENCES savings_goals(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('deposit','withdrawal')),
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    date TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_savings_entries_goal ON savings_entries(goal_id);

  CREATE TABLE debts (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    currency TEXT NOT NULL,
    original_minor INTEGER NOT NULL CHECK (original_minor > 0),
    interest_rate_bps INTEGER CHECK (interest_rate_bps IS NULL OR interest_rate_bps BETWEEN 0 AND 100000),
    min_payment_minor INTEGER CHECK (min_payment_minor IS NULL OR min_payment_minor > 0),
    archived_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE debt_payments (
    id TEXT PRIMARY KEY,
    debt_id TEXT NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    date TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_debt_payments_debt ON debt_payments(debt_id);

  -- weekly and monthly reviews join the summary kinds (SQLite cannot alter a CHECK, so rebuild the table)
  CREATE TABLE ai_summaries_new (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('project','daily','weekly','monthly')),
    subject_id TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    content TEXT NOT NULL,
    facts TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    UNIQUE (workspace_id, kind, subject_id)
  );
  INSERT INTO ai_summaries_new SELECT * FROM ai_summaries;
  DROP TABLE ai_summaries;
  ALTER TABLE ai_summaries_new RENAME TO ai_summaries;
`;

const budgetDrafts = `
  -- A draft is what the AI/CSV pipeline proposes. Nothing in it touches real data until it is applied.
  CREATE TABLE ai_budget_drafts (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    month TEXT NOT NULL,
    currency TEXT NOT NULL,
    payload TEXT NOT NULL,                 -- JSON: lines, parsed rows with their suggested category, notes
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied')),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    applied_at TEXT
  );
  CREATE INDEX idx_budget_drafts_user ON ai_budget_drafts(workspace_id, user_id);
`;

const assistantPlatform = `
  -- Standalone HTML reports. Private to the user who generated them (they can contain workspace data).
  CREATE TABLE reports (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    html TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_reports_user ON reports(workspace_id, user_id, created_at);

  CREATE TABLE suggestion_dismissals (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    until TEXT NOT NULL,
    PRIMARY KEY (user_id, workspace_id, key)
  );

  -- Personal access tokens for the MCP endpoint. Bound to ONE workspace; only a hash is stored.
  CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );
  CREATE INDEX idx_api_tokens_user ON api_tokens(user_id);
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
  { id: '006_assistant', up: (db) => db.exec(assistantTables) },
  { id: '007_life', up: (db) => db.exec(lifeTables) },
  { id: '008_depth', up: (db) => db.exec(depthTables) },
  { id: '009_budget_drafts', up: (db) => db.exec(budgetDrafts) },
  { id: '010_assistant_platform', up: (db) => db.exec(assistantPlatform) },
  { id: '011_automations', up: (db) => db.exec(automationsTables) },
  { id: '012_email_notifications', up: (db) => db.exec(emailNotifications) },
  { id: '013_column_settings', up: (db) => db.exec(columnSettings) },
  { id: '014_assistant_connections', up: (db) => db.exec(assistantConnections) },
  { id: '015_browser_assistant', up: (db) => db.exec(browserTables) },
  { id: '016_email_flows', up: (db) => db.exec(emailFlows) },
  { id: '017_assistant_skills', up: (db) => db.exec(assistantSkills) },
];

const automationsTables = `
CREATE TABLE automations (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, trigger TEXT NOT NULL, steps TEXT NOT NULL,
  next_run_at TEXT, last_run_at TEXT, last_status TEXT, created_via TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_automations_ws ON automations (workspace_id);
CREATE INDEX idx_automations_due ON automations (enabled, next_run_at);
CREATE TABLE automation_runs (
  id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, workspace_id TEXT NOT NULL, slot TEXT NOT NULL,
  status TEXT NOT NULL, log TEXT NOT NULL DEFAULT '[]', started_at TEXT NOT NULL, finished_at TEXT,
  UNIQUE (automation_id, slot),
  FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE CASCADE
);
CREATE INDEX idx_automation_runs ON automation_runs (automation_id, started_at);
`;

const emailNotifications = `
ALTER TABLE notification_preferences ADD COLUMN email INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notification_preferences ADD COLUMN email_enabled_at TEXT;
ALTER TABLE notifications ADD COLUMN emailed_at TEXT;
CREATE INDEX idx_notifications_unsent ON notifications (emailed_at, created_at);
`;

const columnSettings = `
ALTER TABLE columns ADD COLUMN status TEXT CHECK (status IS NULL OR status IN ('todo','doing','blocked','done'));
ALTER TABLE columns ADD COLUMN card_limit INTEGER CHECK (card_limit IS NULL OR (card_limit BETWEEN 1 AND 999));
-- existing boards: the three default columns keep their meaning, everything else stays free-form
UPDATE columns SET status = 'todo' WHERE lower(trim(name)) IN ('backlog', 'to do', 'todo');
UPDATE columns SET status = 'doing' WHERE lower(trim(name)) IN ('in progress', 'doing');
UPDATE columns SET status = 'done' WHERE lower(trim(name)) = 'done';
`;

const assistantConnections = `
CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, url TEXT NOT NULL, auth_enc TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, last_ok_at TEXT, last_error TEXT
);
CREATE INDEX idx_mcp_servers_user ON mcp_servers (workspace_id, user_id);
CREATE TABLE ai_user_settings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  auto_approve TEXT NOT NULL DEFAULT '[]', PRIMARY KEY (user_id, workspace_id)
);
`;

const browserTables = `
CREATE TABLE browser_pairings (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT, last_seen_at TEXT,
  shared_origin TEXT, shared_title TEXT, shared_at TEXT, last_snapshot TEXT
);
CREATE INDEX idx_browser_pairings_user ON browser_pairings (user_id, workspace_id);
CREATE TABLE browser_commands (
  id TEXT PRIMARY KEY, pairing_id TEXT NOT NULL REFERENCES browser_pairings(id) ON DELETE CASCADE, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
  kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', result TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, done_at TEXT
);
CREATE INDEX idx_browser_commands_pending ON browser_commands (pairing_id, status, created_at);
`;

const assistantSkills = `
CREATE TABLE ai_skills (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (workspace_id, user_id, name)
);
ALTER TABLE ai_conversations ADD COLUMN active_skill TEXT;
`;

const emailFlows = `
CREATE TABLE email_templates (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_email_templates_ws ON email_templates (workspace_id);
CREATE TABLE email_sends (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, automation_id TEXT, recipients INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX idx_email_sends_user ON email_sends (user_id, created_at);
CREATE INDEX idx_email_sends_auto ON email_sends (automation_id, created_at);
`;

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
