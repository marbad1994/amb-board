// Browser E2E smoke test. Boots the real server (serving client/dist) on a temp DB and drives Chromium.
// Requires: `npm run build` first, and Playwright available to Node (`require('playwright')`).
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.E2E_PORT || '3471';
const base = `http://127.0.0.1:${PORT}`;
const shots = process.env.E2E_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

// Fake OpenAI-compatible provider so the AI UI can be exercised offline and deterministically (MOCKED).
const fakeAi = createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const msgs = JSON.parse(b).messages;
    if (msgs[0].content.includes('assistant inside AMB Board')) {
      const user = msgs[1].content;
      const out = user.includes('"tool_results":[]')
        ? { type: 'tool', calls: [{ tool: 'list_projects', args: {} }] }
        : { type: 'final', answer: 'Focus on your renovation project today.', proposals: [
            { type: 'create_task', args: { project_id: /"id":"([^"]+)"/.exec(user)[1], title: 'Call the contractor', due_date: '2027-01-15', priority: 'high' } },
            { type: 'delete_project', args: { project_id: 'x' } }] };
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }], usage: {} }));
    }
    const daily = msgs[0].content.includes('"headline"');
    const out = daily
      ? { headline: 'Briefing from fake provider', priorities: ['Finish flooring'], upcoming: [], attention: [], suggested_focus: 'Start early.' }
      : { overview: 'Overview from fake provider', completed: ['Chose flooring'], remaining: [], risks: [], suggestions: ['Order tiles'] };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }], usage: {} }));
  });
});
await new Promise((r) => fakeAi.listen(0, '127.0.0.1', r));

const dir = mkdtempSync(join(tmpdir(), 'amb-e2e-'));
const server = spawn(process.execPath, ['--experimental-sqlite', join(root, 'server/src/index.js')], {
  env: { ...process.env, PORT, HOST: '127.0.0.1', AMB_DB_PATH: join(dir, 'e2e.sqlite'), AMB_UPLOADS_DIR: join(dir, 'up'),
    DEEPSEEK_API_KEY: 'e2e-key', DEEPSEEK_BASE_URL: `http://127.0.0.1:${fakeAi.address().port}`, X_GROK_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => String(d).includes('listening') && resolve());
  server.on('exit', (c) => reject(new Error(`server exited ${c}`)));
});

const results = [];
let lastPage;
const step = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); } catch (err) { results.push(['FAIL', name, err.message.split('\n').slice(0,6).join(' | ')]); throw err; }
};
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true }); };

const browser = await chromium.launch();
let failed = false;
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  lastPage = page;
  const email = `e2e${Date.now()}@example.com`;
  const password = 'correct-horse-battery';

  await step('unauthenticated visitor sees the sign-in screen', async () => {
    await page.goto(base);
    await page.getByRole('heading', { name: 'Welcome back' }).waitFor();
    await shot(page, '01-signin');
  });

  await step('register through the UI lands on the dashboard', async () => {
    await page.getByRole('button', { name: 'New here? Create an account' }).click();
    await page.getByLabel('Your name').fill('Marcus Bader');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('heading', { name: 'Hello, Marcus' }).waitFor();
    await page.locator('.stat-card').nth(3).waitFor();
    assert.equal(await page.locator('.stat-card').count(), 4);
    assert.equal(await page.locator('.stat-card__num').first().innerText(), '0');
    assert.ok((await page.locator('.shell__top').boundingBox()).height >= 56, 'top bar keeps its height');
    await shot(page, '02-dashboard-empty');
  });

  await step('12 default life areas are listed; owner can add a custom one', async () => {
    await page.getByRole('link', { name: 'Life Areas' }).click();
    await page.getByRole('heading', { name: 'Life Areas', level: 1 }).waitFor();
    await page.locator('.area-card').nth(11).waitFor();
    assert.equal(await page.locator('.area-card').count(), 12);
    await page.getByLabel('New life area name').fill('Side Quests');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('heading', { name: 'Side Quests' }).waitFor();
    assert.equal(await page.locator('.area-card').count(), 13);
    await shot(page, '03-life-areas');
  });

  await step('create a project in a life area, open its board, add a task', async () => {
    await page.getByRole('link', { name: 'Projects Board' }).click();
    await page.getByLabel('New project name').fill('Apartment Renovation');
    await page.getByLabel('Life area for new project').selectOption({ label: 'Home & Living' });
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    const card = page.getByRole('link', { name: /Apartment Renovation/ });
    await card.waitFor();
    assert.match(await card.innerText(), /Home & Living/);
    await card.click();
    await page.waitForURL(/\/projects\//);
    await page.getByRole('button', { name: 'Add card' }).first().click();
    await page.getByPlaceholder('Card title').fill('Choose flooring');
    await page.getByPlaceholder('Card title').press('Enter');
    await page.getByText('Choose flooring').waitFor();
    await shot(page, '04-board');
  });

  await step('dashboard reflects the new project; life-area filter works', async () => {
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await page.getByRole('heading', { name: 'Hello, Marcus' }).waitFor();
    await page.locator('.stat-card__num').first().waitFor();
    assert.equal(await page.locator('.stat-card__num').first().innerText(), '1');
    assert.equal(await page.locator('.stat-card__num').nth(1).innerText(), '1', 'one task on boards');
    await page.getByRole('link', { name: /Apartment Renovation/ }).waitFor();
    await page.locator('.area-list a', { hasText: 'Home & Living' }).click();
    await page.getByRole('link', { name: /Apartment Renovation/ }).waitFor();
    await page.getByLabel('Filter by life area').selectOption({ label: 'Finance & Wealth' });
    await page.getByText('No projects here yet.').waitFor();
    await shot(page, '05-dashboard');
  });

  await step('archive hides a project; restore brings it back', async () => {
    await page.getByLabel('Filter by life area').selectOption({ label: 'All' });
    await page.getByRole('button', { name: 'Archive Apartment Renovation' }).click();
    await page.getByText('No projects here yet.').waitFor();
    await page.getByLabel('Show archived').check();
    await page.getByRole('button', { name: 'Restore Apartment Renovation' }).click();
    await page.getByText('No archived projects.').waitFor();
  });

  await step('project board by status: move a project to In Progress; progress shows', async () => {
    await page.getByRole('link', { name: 'Projects Board' }).click();
    await page.getByLabel('Show archived').uncheck();
    await page.getByLabel('Status of Apartment Renovation').selectOption({ label: 'In Progress' });
    await page.locator('section[aria-label="In Progress"]').getByText('Apartment Renovation').waitFor();
    assert.equal(await page.locator('section[aria-label="To Do"] .project-card').count(), 0);
    await page.getByRole('progressbar', { name: 'Apartment Renovation progress' }).waitFor();
  });

  await step('task due date, priority, subtasks; overdue view; completion drives project progress', async () => {
    await page.getByRole('link', { name: /Apartment Renovation/ }).click();
    await page.getByText('Choose flooring').click();
    await page.getByLabel('Due date').fill('2020-01-15');
    await page.getByLabel('Priority').selectOption('urgent');
    await page.getByLabel('New subtask').fill('Measure the room');
    await page.getByRole('button', { name: 'Add subtask' }).click();
    await page.getByRole('checkbox', { name: 'Measure the room' }).check();
    await page.getByText('Subtasks (1/1)').waitFor();
    await page.getByRole('button', { name: 'Close' }).click();
    await page.getByText('(overdue)').first().waitFor();
    await page.getByRole('link', { name: 'Tasks', exact: true }).click();
    await page.getByRole('button', { name: 'Overdue' }).click();
    await page.getByRole('link', { name: 'Choose flooring' }).waitFor();
    await page.getByRole('checkbox', { name: 'Complete Choose flooring' }).check();
    await page.getByText('Nothing here.').waitFor();
    await page.getByRole('button', { name: 'Completed' }).click();
    await page.getByRole('link', { name: 'Choose flooring' }).waitFor();
    await page.getByRole('link', { name: 'Choose flooring' }).click();
    await page.getByRole('button', { name: /Details/ }).filter({ hasText: '100%' }).waitFor();
    await page.getByRole('button', { name: 'Close' }).click(); // task link deep-links into the card
    await shot(page, '04b-board-details');
    await page.getByRole('button', { name: /Details/ }).click();
    await page.getByLabel('Target date').fill('2026-12-31');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('heading', { name: 'Project details' }).waitFor({ state: 'detached' });
  });

  await step('quick add task and global search deep-link to the card', async () => {
    await page.getByRole('button', { name: 'Quick Add Task' }).click();
    await page.getByLabel('Task', { exact: true }).fill('Order tiles');
    await page.getByRole('button', { name: 'Add task', exact: true }).click();
    await page.getByText('Order tiles').waitFor();
    await page.getByLabel('Search projects, tasks and ideas').fill('tiles');
    await page.getByRole('region', { name: 'Search results' }).getByRole('button', { name: /Order tiles/ }).click();
    await page.getByLabel('Title').waitFor();
    assert.equal(await page.getByLabel('Title').inputValue(), 'Order tiles');
    assert.equal(await page.getByLabel('Search projects, tasks and ideas').inputValue(), '', 'search box clears after choosing a result');
    await page.getByRole('button', { name: 'Close' }).click();
  });

  await step('keyboard: skip through sidebar with Tab and activate a link with Enter', async () => {
    await page.getByRole('link', { name: 'Dashboard' }).focus();
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => document.activeElement?.textContent?.trim());
    assert.ok(focused && focused.length > 0, 'a sidebar link receives focus');
    await page.getByRole('link', { name: 'Idea Board' }).focus();
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/ideas/);
    await page.getByText('No ideas yet').waitFor();
    const over = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    assert.ok(over <= 0, `page scrolls vertically by ${over}px on an empty page`);
  });

  await step('project budget: set 12,000, add paid 2,500 and planned 10,000 -> remaining, forecast overrun, dashboard alert', async () => {
    await page.getByRole('link', { name: 'Projects Board' }).click();
    await page.getByRole('link', { name: /Apartment Renovation/ }).click();
    await page.getByRole('button', { name: /Details/ }).click();
    await page.getByText('No budget set.').waitFor();
    await page.getByLabel('Approved budget amount').fill('12000');
    await page.getByLabel('Budget currency').fill('EUR');
    await page.getByRole('button', { name: 'Set budget' }).click();
    await page.getByText('Within budget').waitFor();
    await page.getByLabel('Expense amount').fill('2500');
    await page.getByLabel('Expense description').fill('Sofa');
    await page.getByRole('button', { name: 'Add expense' }).click();
    await page.getByText('Sofa').waitFor();
    const card = page.getByRole('region', { name: 'Project budget' });
    assert.match(await card.innerText(), /Remaining\s*€9,500\.00/);
    await page.getByLabel('Expense amount').fill('10000');
    await page.getByLabel('Expense description').fill('Contractor (committed)');
    await page.getByLabel('Expense status').selectOption('planned');
    await page.getByRole('button', { name: 'Add expense' }).click();
    await page.getByText('Forecast to exceed budget').waitFor();
    assert.match(await card.innerText(), /Forecast overrun\s*€500\.00/);
    assert.match(await card.innerText(), /Approved\s*€12,000\.00/);
    await shot(page, '08-budget');
    await page.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await page.getByRole('heading', { name: 'Budget alerts' }).waitFor();
    await page.getByText(/Forecast over budget: €2,500\.00 of €12,000\.00 spent, forecast overrun €500\.00/).waitFor();
  });

  await step('finance page: month summary per currency, income, CSV export', async () => {
    await page.getByRole('link', { name: 'Finance & Budget' }).click();
    const eur = page.getByRole('region', { name: 'EUR summary' });
    await eur.waitFor();
    assert.match(await eur.innerText(), /Expenses\s*€2,500\.00/);
    assert.match(await eur.innerText(), /Planned\s*€10,000\.00/);
    await page.getByLabel('Type').selectOption('income');
    await page.getByLabel('Amount', { exact: true }).fill('3000');
    await page.getByLabel('Description').first().fill('Salary');
    await page.getByLabel('Category').selectOption({ label: 'Salary' });
    await page.getByRole('button', { name: 'Add', exact: true }).first().click();
    await eur.getByText('€3,000.00').first().waitFor();
    assert.match(await eur.innerText(), /Net cash flow\s*€500\.00/);
    // a second currency is shown separately, never merged
    await page.getByLabel('Type').selectOption('expense');
    await page.getByLabel('Amount', { exact: true }).fill('100');
    await page.getByLabel('Currency', { exact: true }).fill('RON');
    await page.getByRole('button', { name: 'Add', exact: true }).first().click();
    await page.getByRole('region', { name: 'RON summary' }).waitFor();
    assert.match(await eur.innerText(), /Expenses\s*€2,500\.00/, 'EUR total unchanged by RON expense');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()]);
    assert.equal(download.suggestedFilename(), 'transactions.csv');
    await shot(page, '09-finance');
  });

  await step('calendar: project deadline shows, new weekly event repeats, agenda lists it', async () => {
    await page.getByRole('link', { name: 'Calendar' }).click();
    await page.getByRole('heading', { name: 'Calendar', level: 1 }).waitFor();
    await page.getByRole('button', { name: 'Next month' }).click();
    await page.getByRole('button', { name: 'Next month' }).click();
    await page.getByText('Apartment Renovation deadline').waitFor();
    await page.getByRole('button', { name: 'Today' }).click();
    await page.getByRole('button', { name: 'New event' }).click();
    await page.getByLabel('Title').fill('Team sync');
    await page.getByLabel('Repeats').selectOption('weekly');
    await page.getByLabel('Time zone').fill('Europe/Bucharest');
    await page.getByRole('button', { name: 'Add event' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: /Team sync \(repeats\)/ }).first().waitFor();
    assert.ok((await page.getByRole('button', { name: /Team sync \(repeats\)/ }).count()) >= 2, 'weekly event repeats in the month grid (today and next week are both in view)');
    await page.getByRole('button', { name: 'Agenda' }).click();
    await page.getByRole('button', { name: /Team sync/ }).first().waitFor();
    await page.getByLabel('Filter calendar').selectOption('project_deadline');
    assert.equal(await page.getByRole('button', { name: /Team sync/ }).count(), 0, 'filter hides other kinds');
    await shot(page, '10-calendar');
  });

  await step('AI project summary and daily briefing (mocked provider) show facts and labelling', async () => {
    await page.getByRole('link', { name: 'Projects Board' }).click();
    await page.getByRole('link', { name: /Apartment Renovation/ }).click();
    await page.getByRole('button', { name: /Details/ }).click();
    await page.getByText('Nothing generated yet.').waitFor();
    await page.getByRole('button', { name: 'Generate' }).click();
    await page.getByText('Overview from fake provider').waitFor();
    await page.getByText(/AI-generated on/).waitFor();
    await page.getByText('Facts used').click();
    await page.getByText(/tasks done \(\d+%\)/).waitFor();
    await page.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await page.getByRole('button', { name: 'Generate' }).click();
    await page.getByText('Briefing from fake provider').waitFor();
    await shot(page, '07-briefing');
  });

  await step('AI assistant: answers from data, proposes changes, nothing changes until Approve; disallowed proposal discarded', async () => {
    await page.getByRole('link', { name: 'AI Assistant' }).click();
    await page.getByRole('button', { name: 'What should I focus on today?' }).click();
    await page.getByText('Focus on your renovation project today.').waitFor();
    await page.getByText('Looked at: list projects').waitFor();
    await page.getByText('1 suggested change was not allowed').waitFor();
    await page.getByText('Create task "Call the contractor" in project "Apartment Renovation"').waitFor();
    await page.getByRole('link', { name: 'Tasks', exact: true }).click();
    await page.getByRole('link', { name: 'Order tiles' }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Call the contractor' }).count(), 0, 'not created before approval');
    await page.getByRole('link', { name: 'AI Assistant' }).click();
    await page.getByLabel('Conversation').first().selectOption({ index: 1 });
    await page.getByRole('button', { name: 'Approve' }).click();
    await page.getByText('Applied.').waitFor();
    await shot(page, '11-assistant');
    await page.getByRole('link', { name: 'Tasks', exact: true }).click();
    await page.getByRole('link', { name: 'Call the contractor' }).waitFor();
  });

  await step('goals with milestones, habits with streak, challenge progress', async () => {
    await page.getByRole('link', { name: 'Goals & Habits' }).click();
    await page.getByLabel('New goal').fill('Run a marathon');
    await page.getByRole('button', { name: 'Add goal' }).click();
    await page.getByRole('heading', { name: 'Run a marathon' }).waitFor();
    await page.getByLabel('New milestone for Run a marathon').fill('First 10k');
    await page.getByRole('button', { name: 'Add milestone' }).click();
    await page.getByRole('checkbox', { name: /First 10k/ }).check();
    await page.getByText(/100% from milestones/).waitFor();
    await page.getByRole('button', { name: 'Habits', exact: true }).click();
    await page.getByLabel('New habit').fill('Meditate');
    await page.getByRole('button', { name: 'Add habit' }).click();
    await page.getByRole('checkbox', { name: 'Meditate, done today' }).check();
    await page.getByText(/Streak 1 days · best 1/).waitFor();
    await page.getByRole('button', { name: 'Challenges', exact: true }).click();
    await page.getByLabel('Challenge name').fill('30 days of calm');
    await page.getByLabel('Habit for challenge').selectOption({ label: 'Meditate' });
    await page.getByRole('button', { name: 'Start challenge' }).click();
    await page.getByRole('heading', { name: '30 days of calm' }).waitFor();
    await page.getByText(/1 of 30 days/).waitFor();
    await shot(page, '12-goals');
  });

  await step('notes and private journal; documents upload, list and download', async () => {
    await page.getByRole('link', { name: 'Notes & Journal' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill('Paint colours');
    await page.getByRole('textbox', { name: 'Text' }).fill('Matt white for the kitchen');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('heading', { name: 'Paint colours' }).waitFor();
    await page.getByRole('button', { name: 'Journal' }).click();
    await page.getByRole('textbox', { name: 'Entry' }).fill('Good day, finished the flooring plan.');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByText('Good day, finished the flooring plan.').waitFor();
    await page.getByText('Private to you', { exact: true }).waitFor();
    await page.getByLabel('Search notes').fill('flooring');
    await page.getByText('Good day, finished').waitFor();
    await page.getByRole('link', { name: 'Documents' }).click();
    await page.getByLabel('File').setInputFiles({ name: 'lease-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('rent is due on the 1st') });
    await page.getByRole('button', { name: 'Upload' }).click();
    await page.getByText('lease-notes.txt').waitFor();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download lease-notes.txt' }).click()]);
    assert.equal(dl.suggestedFilename(), 'lease-notes.txt');
    await page.getByLabel('File').setInputFiles({ name: 'page.html', mimeType: 'text/html', buffer: Buffer.from('<script>alert(1)</script>') });
    await page.getByRole('button', { name: 'Upload' }).click();
    await page.getByText(/is not allowed/).waitFor();
    await shot(page, '13-documents');
  });

  await step('My Day shows today from real records (habit done, overdue task, budget attention, briefing)', async () => {
    await page.getByRole('link', { name: 'My Day' }).click();
    await page.getByRole('heading', { name: 'My Day', level: 1 }).waitFor();
    await page.getByRole('checkbox', { name: 'Meditate, done today' }).waitFor();
    assert.equal(await page.getByRole('checkbox', { name: 'Meditate, done today' }).isChecked(), true);
    await page.getByRole('heading', { name: 'Overdue' }).waitFor();
    await page.getByText(/Budget attention: Apartment Renovation/).waitFor();
    await page.getByRole('region', { name: 'Daily briefing' }).waitFor();
    await shot(page, '14-my-day');
  });

  await step('idea converts to a project and stays linked', async () => {
    await page.getByRole('link', { name: 'Idea Board' }).click();
    await page.getByRole('button', { name: 'Add idea' }).click();
    await page.getByPlaceholder('Type or dictate an idea').fill('Reading tracker for books');
    await page.waitForTimeout(700); // debounce save
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Convert idea to project' }).click();
    await page.waitForURL(/\/projects\//);
    await page.getByRole('heading', { name: 'Reading tracker for books' }).waitFor();
    await page.getByRole('link', { name: 'Idea Board' }).click();
    await page.getByRole('link', { name: 'Project created' }).waitFor();
  });

  await step('sign out, then sign in again with the same credentials', async () => {
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByRole('heading', { name: 'Welcome back' }).waitFor();
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('wrong-password-here');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByText('invalid email or password').waitFor();
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { name: 'Idea board' }).waitFor(); // session restored on the page we left
    assert.match(page.url(), /\/ideas$/);
  });

  await step('a second user cannot see the first user\'s project', async () => {
    const other = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p2 = await other.newPage();
    await p2.goto(base);
    await p2.getByRole('button', { name: 'New here? Create an account' }).click();
    await p2.getByLabel('Your name').fill('Second User');
    await p2.getByLabel('Email').fill(`second${Date.now()}@example.com`);
    await p2.getByLabel('Password').fill(password);
    await p2.getByRole('button', { name: 'Create account' }).click();
    await p2.getByRole('heading', { name: 'Hello, Second' }).waitFor();
    await p2.getByRole('link', { name: 'Projects Board' }).click();
    await p2.getByText('No projects here yet.').waitFor();
    assert.equal(await p2.getByText('Apartment Renovation').count(), 0);
    await other.close();
  });

  await step('mobile layout: no horizontal overflow, sidebar opens via menu button', async () => {
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const m = await mctx.newPage();
    await m.goto(base);
    await m.getByLabel('Email').fill(email);
    await m.getByLabel('Password').fill(password);
    await m.getByRole('button', { name: 'Sign in' }).click();
    await m.getByRole('heading', { name: 'Hello, Marcus' }).waitFor();
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `horizontal overflow ${overflow}px`);
    assert.equal(await m.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().right <= 0), true, 'sidebar hidden initially');
    await m.getByRole('button', { name: 'Open menu' }).click();
    await m.getByRole('link', { name: 'Life Areas' }).click();
    await m.getByRole('heading', { name: 'Life Areas', level: 1 }).waitFor();
    const overflow2 = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow2 <= 0, `life areas overflow ${overflow2}px`);
    await shot(m, '06-mobile-life-areas');
    await mctx.close();
  });
} catch {
  failed = true;
  if (shots && lastPage) await lastPage.screenshot({ path: join(shots, 'failure.png'), fullPage: true });
} finally {
  await browser.close();
  server.kill();
  fakeAi.close();
  rmSync(dir, { recursive: true, force: true });
  for (const r of results) console.log(r.join('  '));
  console.log(failed ? 'E2E FAILED' : `E2E OK (${results.length} steps)`);
  process.exit(failed ? 1 : 0);
}
