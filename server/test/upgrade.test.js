import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Builds a database exactly as the pre-auth app created it (original schema, no labels migration needed),
// fills it, then boots the new server on it and checks that every row is intact.
const dir = mkdtempSync(join(tmpdir(), 'amb-upgrade-'));
const dbFile = join(dir, 'board.sqlite');
let srv;

const LEGACY_SCHEMA = `
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT DEFAULT '#6366f1', created_at TEXT NOT NULL);
  CREATE TABLE columns (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL, position INTEGER NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE cards (id TEXT PRIMARY KEY, column_id TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE, title TEXT NOT NULL, description TEXT DEFAULT '', status TEXT DEFAULT 'todo', owner TEXT DEFAULT '', creator TEXT DEFAULT '', position INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE comments (id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE, author TEXT DEFAULT '', text TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE attachments (id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE, filename TEXT NOT NULL, original_name TEXT NOT NULL, mime_type TEXT, size INTEGER, uploaded_at TEXT NOT NULL);
  CREATE TABLE idea_notes (id TEXT PRIMARY KEY, author TEXT DEFAULT '', text TEXT NOT NULL, color TEXT DEFAULT '#fde68a', x REAL DEFAULT 0, y REAL DEFAULT 0, rotation REAL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
`;
const TABLES = ['projects', 'columns', 'cards', 'comments', 'attachments', 'idea_notes'];

let before_;
before(async () => {
  const old = new DatabaseSync(dbFile);
  old.exec(LEGACY_SCHEMA);
  const t = '2025-03-01T10:00:00.000Z';
  old.prepare("INSERT INTO projects VALUES ('p1','Kitchen','#10b981',?)").run(t);
  old.prepare("INSERT INTO columns VALUES ('c1','p1','Backlog',0,?)").run(t);
  old.prepare("INSERT INTO cards (id,column_id,title,description,status,owner,creator,position,created_at,updated_at) VALUES ('k1','c1','Buy paint','Matt white','todo','Marcus','Marcus',0,?,?)").run(t, t);
  old.prepare("INSERT INTO comments VALUES ('m1','k1','Marcus','2 litres',?)").run(t);
  old.prepare("INSERT INTO attachments VALUES ('a1','k1','abc.txt','receipt.txt','text/plain',5,?)").run(t);
  old.prepare("INSERT INTO idea_notes VALUES ('i1','Marcus','Reading tracker','#fde68a',10,20,3,?,?)").run(t, t);
  old.close();
  // legacy rows, including an attachment file on disk
  const uploads = join(dir, 'uploads');
  (await import('node:fs')).mkdirSync(uploads);
  writeFileSync(join(uploads, 'abc.txt'), 'hello');
  process.env.AMB_DB_PATH = dbFile;
  process.env.AMB_UPLOADS_DIR = uploads;
  process.env.REGISTER_RATE_MAX = '1000';
  const { createApp } = await import('../src/app.js');
  srv = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
});
after(() => { srv.close(); srv.closeAllConnections?.(); rmSync(dir, { recursive: true, force: true }); });

test('upgrade writes a backup that still holds the original rows', () => {
  const baks = readdirSync(dir).filter((f) => f.includes('.bak-'));
  assert.equal(baks.length, 1, 'exactly one backup taken');
  const bak = new DatabaseSync(join(dir, baks[0]));
  assert.equal(bak.prepare('SELECT title FROM cards').get().title, 'Buy paint');
  assert.equal(bak.prepare("SELECT name FROM sqlite_master WHERE name = 'users'").get(), undefined, 'backup is pre-migration');
  bak.close();
});

test('every legacy row survives the migration and registration with identical content', async () => {
  const base = `http://127.0.0.1:${srv.address().port}`;
  const reg = await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.com', name: 'Marcus', password: 'correct-horse-battery' }),
  });
  assert.equal(reg.status, 201);
  const cookie = reg.headers.get('set-cookie').split(';')[0];
  const get = async (p) => (await fetch(base + p, { headers: { cookie } })).json();

  const projects = await get('/api/projects');
  assert.equal(projects.length, 1);
  assert.equal(projects[0].id, 'p1');
  assert.equal(projects[0].name, 'Kitchen');
  assert.equal(projects[0].color, '#10b981');
  assert.equal(projects[0].created_at, '2025-03-01T10:00:00.000Z');

  const cols = await get('/api/projects/p1/columns');
  assert.equal(cols[0].id, 'c1');
  const card = (await get('/api/cards/k1'));
  assert.equal(card.title, 'Buy paint');
  assert.equal(card.description, 'Matt white');
  assert.equal(card.owner, 'Marcus');
  assert.deepEqual(card.labels, []);
  assert.equal(card.comments[0].text, '2 litres');
  assert.equal(card.attachments[0].original_name, 'receipt.txt');

  const dl = await fetch(`${base}/api/attachments/a1/download`, { headers: { cookie } });
  assert.equal(dl.status, 200);
  assert.equal(await dl.text(), 'hello', 'legacy file on disk is still served');

  const ideas = await get('/api/ideas');
  assert.equal(ideas[0].text, 'Reading tracker');
  assert.equal(ideas[0].x, 10);

  // row counts equal the originals, nothing orphaned (workspace_id never NULL)
  const { db } = await import('../src/db.js');
  for (const t of ['projects', 'idea_notes']) {
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE workspace_id IS NULL`).get().n, 0, `${t} fully adopted`);
  }
  const counts = Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));
  assert.deepEqual(counts, { projects: 1, columns: 1, cards: 1, comments: 1, attachments: 1, idea_notes: 1 });
  assert.ok(existsSync(join(dir, 'uploads', 'abc.txt')));
});
