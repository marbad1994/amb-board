import { db } from '../db.js';
import { listTools } from './mcpClient.js';

// A person's own connected servers (private to them: a connection carries their credentials).
export const findServer = (ws, userId, nameOrId) => db.prepare('SELECT * FROM mcp_servers WHERE workspace_id = ? AND user_id = ? AND (id = ? OR lower(name) = lower(?))').get(ws, userId, String(nameOrId ?? ''), String(nameOrId ?? ''));
export const userServers = (ws, userId) => db.prepare('SELECT * FROM mcp_servers WHERE workspace_id = ? AND user_id = ? ORDER BY created_at').all(ws, userId);

// Tool lists are cached after the external_tools skill has run; proposals are validated against that list.
const seen = new Map();
export const cachedTools = (id) => seen.get(id) ?? null;
export async function toolsOf(server) { const t = await listTools(server); seen.set(server.id, t); return t; }
export const forget = (id) => seen.delete(id);
