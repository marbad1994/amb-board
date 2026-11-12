#!/usr/bin/env node
// Watches the git checkout of a project on this server and emails the tester what to test whenever its code has changed.
// Started every minute by push-notes.timer (see install.sh). It remembers the last commit it told about, so it never mails twice, and if the
// mail cannot be sent it keeps that memory unchanged and tries again at the next run.
//
//   PUSH_NOTES_REPO     the checkout to watch, for example /home/marcus/makketing      (required)
//   PUSH_NOTES_BRANCH   the branch (default main)
//   PUSH_NOTES_FETCH    true = also fetch from GitHub each run, so the email goes out when the code is PUSHED; false (default) = when it
//                       arrives in the checkout, that is when it is pulled or deployed
//   TEST_NOTES_TO       who gets the email                                                  (required)
//   ANTHROPIC_API_KEY   writes the summary; without it the email lists the commits only
//   SMTP_*              the mail account; read from AMB Board's server/.env (PUSH_NOTES_ENV) unless set here
//   --resend[=N]        send the notes for the latest N commits (default 1) now, without changing what is remembered
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { collect, git, readPulls, renderEmail, send, summarize } from './notes-core.mjs';

const env = process.env;
const fail = (msg) => { console.error(`push-notes: ${msg}`); process.exit(1); };

// The SMTP settings AMB Board already uses, so the mail password is not kept in a second place. Values already in the environment win.
function loadDotenv(file, keys) {
  if (!file || !existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('='); if (eq < 0) continue;
    const key = t.slice(0, eq).trim(); let value = t.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (keys.includes(key) && env[key] === undefined) env[key] = value;
  }
}

const readState = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const writeState = (file, last) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(`${file}.tmp`, JSON.stringify({ last, at: new Date().toISOString() })); renameSync(`${file}.tmp`, file); };

function repoName(cwd) {
  try { const m = git(cwd, ['remote', 'get-url', 'origin']).trim().match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/); if (m) return m[1]; } catch { /* no remote */ }
  return basename(cwd);
}

async function main() {
  const repoDir = env.PUSH_NOTES_REPO ? resolve(env.PUSH_NOTES_REPO) : null;
  if (!repoDir) fail('PUSH_NOTES_REPO is not set');
  if (!env.TEST_NOTES_TO) fail('TEST_NOTES_TO is not set');
  try { git(repoDir, ['rev-parse', '--git-dir']); } catch { fail(`${repoDir} is not a git checkout`); }
  loadDotenv(env.PUSH_NOTES_ENV || '/opt/amb-board3/server/.env', ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']);
  const name = repoName(repoDir); const branch = env.PUSH_NOTES_BRANCH || 'main'; const fetching = env.PUSH_NOTES_FETCH === 'true';
  // the sender: given, or the address of AMB Board's mail account under a name that says what this is
  if (!env.PUSH_NOTES_FROM) { const addr = (env.SMTP_FROM || '').match(/<([^>]+)>/)?.[1] || env.SMTP_USER || ''; if (addr) env.PUSH_NOTES_FROM = `${name.split('/').pop()} test notes <${addr}>`; }
  if (env.PUSH_NOTES_FROM) env.SMTP_FROM = env.PUSH_NOTES_FROM;

  if (fetching) { try { git(repoDir, ['fetch', '--quiet', 'origin', branch]); } catch (e) { fail(`git fetch failed: ${String(e.message).split('\n')[0]}`); } }
  const target = fetching ? `origin/${branch}` : 'HEAD';
  let head; try { head = git(repoDir, ['rev-parse', '--verify', `${target}^{commit}`]).trim(); } catch { fail(`${target} does not exist in ${repoDir}`); }

  const resend = process.argv.find((a) => a.startsWith('--resend'));
  const stateFile = join(env.PUSH_NOTES_STATE || '/var/lib/push-notes', `${basename(repoDir)}-${createHash('sha1').update(`${repoDir}\n${branch}\n${fetching}`).digest('hex').slice(0, 8)}.json`);
  const state = readState(stateFile);
  let base;
  if (resend) { const n = Math.max(1, Number(resend.split('=')[1]) || 1); base = `${head}~${n}`; }
  else if (!state) { writeState(stateFile, head); console.log(`push-notes: watching ${repoDir} (${target}) from ${head.slice(0, 7)}; the next change will be mailed`); return; }
  else if (state.last === head) return;
  else base = state.last;

  const push = collect({ cwd: repoDir, base, head, repo: name, branch, compare: /^[\w.-]+\/[\w.-]+$/.test(name) && !resend && /^[0-9a-f]{40}$/.test(base) ? `https://github.com/${name}/compare/${base.slice(0, 12)}...${head.slice(0, 12)}` : '' });
  let notes = null; let why = '';
  try {
    if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) throw new Error('ANTHROPIC_API_KEY is not set');
    notes = await summarize(push, await readPulls(push));
  } catch (err) { why = `The summary could not be written (${String(err.message).slice(0, 200)}).`; console.error(`push-notes: ${why}`); }
  await send(renderEmail(push, notes, why));            // throws when the mail cannot be sent: what is remembered stays, the next run tries again
  if (!resend) writeState(stateFile, head);
  console.log(`push-notes: mailed ${push.commits.length} commit${push.commits.length === 1 ? '' : 's'} of ${name} (${head.slice(0, 7)}) to ${env.TEST_NOTES_TO}`);
}

main().catch((err) => fail(err.message));
