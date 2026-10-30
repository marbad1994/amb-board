import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Boots the real app on an ephemeral port with an isolated database and uploads dir.
// Env must be set before the app modules are imported (db.js opens the DB at import).
export async function startServer() {
  const dir = mkdtempSync(join(tmpdir(), 'amb-test-'));
  process.env.AMB_DB_PATH = join(dir, 'test.sqlite');
  process.env.AMB_UPLOADS_DIR = join(dir, 'uploads');
  delete process.env.X_GROK_API_KEY;
  process.env.REGISTER_RATE_MAX = '1000'; // tests create many accounts from one IP
  const { createApp } = await import('../src/app.js');
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: () => { server.close(); server.closeAllConnections?.(); rmSync(dir, { recursive: true, force: true }); },
  };
}

// Minimal cookie-jar HTTP client.
export function client(base) {
  let cookie = '';
  let workspaceId = null;
  async function call(method, path, body, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    if (cookie) headers.cookie = cookie;
    if (workspaceId && !headers['x-workspace-id']) headers['x-workspace-id'] = workspaceId;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + path, { method, headers, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    let json = null;
    const text = await res.text();
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  return {
    get: (p, h) => call('GET', p, undefined, h),
    post: (p, b, h) => call('POST', p, b ?? {}, h),
    patch: (p, b, h) => call('PATCH', p, b ?? {}, h),
    put: (p, b, h) => call('PUT', p, b ?? {}, h),
    del: (p, h) => call('DELETE', p, undefined, h),
    useWorkspace: (id) => { workspaceId = id; },
    get cookie() { return cookie; },
    setCookie: (c) => { cookie = c; },
  };
}

let counter = 0;
export async function signUp(base, name = 'User') {
  counter += 1;
  const c = client(base);
  const email = `${name.toLowerCase()}${counter}@example.com`;
  const res = await c.post('/api/auth/register', { email, name, password: 'correct-horse-battery' });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${res.text}`);
  const personal = res.json.workspaces.find((w) => w.kind === 'personal');
  return { c, email, user: res.json.user, personalId: personal.id };
}
