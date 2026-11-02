import { dirname, join } from 'node:path';
import { dbPath } from '../db.js';

// Email hosting is off unless MAIL_ENABLED=true (set after the server was prepared with deploy/mail/setup-mail.sh).
// MAIL_WORKSPACE_IDS optionally limits it to some workspaces (comma separated); empty = every workspace's owners and admins.
export const mailConfig = () => ({
  enabled: process.env.MAIL_ENABLED === 'true',
  dir: process.env.MAIL_DIR || join(dirname(dbPath), 'mail'),
  host: (process.env.MAIL_HOST || '').trim().toLowerCase().replace(/\.$/, ''),       // the name of this mail server, for example mail.example.com
  ip: (process.env.MAIL_SERVER_IP || '').trim(),
  maxDomains: Number(process.env.MAIL_MAX_DOMAINS) || 3,
  maxAccounts: Number(process.env.MAIL_MAX_ACCOUNTS) || 25,
  maxAliases: Number(process.env.MAIL_MAX_ALIASES) || 100,
  workspaces: (process.env.MAIL_WORKSPACE_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
});
export const mailAvailable = (wsId) => { const c = mailConfig(); return c.enabled && (c.workspaces.length === 0 || c.workspaces.includes(wsId)); };
