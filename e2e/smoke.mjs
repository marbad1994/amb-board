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
      if (/<question>[^<]*automation/i.test(user)) {
        res.setHeader('content-type', 'application/json');
        const guided = msgs[0].content.includes('ACTIVE SKILL /create-automation');
        return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ type: 'final', answer: guided ? 'When should it run?' : 'NOT GUIDED', suggestions: ['Every Monday at 08:00', 'Every weekday at 09:00'], proposals: [] }) } }], usage: {} }));
      }
      if (/<question>[^<]*Every Monday at 08:00/.test(user)) {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ type: 'final', answer: 'Scheduled for Mondays. All set.', done: true, proposals: [] }) } }], usage: {} }));
      }
      const wantsPlan = /<question>[^<]*plan my move/i.test(user);
      if (wantsPlan) {
        // the whole-workspace snapshot must reach the model
        const sawWorkspace = user.includes('"workspace":{') && user.includes('Apartment Renovation');
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ type: 'final', answer: sawWorkspace ? 'Here is a setup for the move.' : 'NO WORKSPACE SNAPSHOT', proposals: [{ type: 'setup_plan', args: { title: 'Move plan', steps: [
          { ref: 'p', type: 'create_project', args: { name: 'Move plan project' } },
          { type: 'create_task', args: { project_id: '@p', title: 'Sign the lease', priority: 'high' } },
          { type: 'create_task', args: { project_id: '@p', title: 'Book movers' } }] } }] }) } }], usage: {} }));
      }
      const wantsReport = /<question>[^<]*report/i.test(user);
      const out = wantsReport
        ? (user.includes('"tool_results":[]') ? { type: 'tool', calls: [{ tool: 'generate_report', args: { kind: 'overview', title: 'E2E overview' } }] } : { type: 'final', answer: 'Report is ready under Reports.', proposals: [] })
        : user.includes('"tool_results":[]')
        ? { type: 'tool', calls: [{ tool: 'list_projects', args: {} }] }
        : { type: 'final', answer: 'Focus on your renovation project today.', proposals: [
            { type: 'create_task', args: { project_id: /"projects":\[\{"id":"([^"]+)"/.exec(user)[1], title: 'Call the contractor', due_date: '2027-01-15', priority: 'high' } },
            { type: 'delete_project', args: { project_id: 'x' } }] };
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }], usage: {} }));
    }
    if (msgs[0].content.includes('merchant/description texts')) {
      const items = JSON.parse(msgs[1].content.match(/<data>(.*)<\/data>/s)[1]).descriptions;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ assignments: items.map((d) => ({ id: d.id, category: d.text.includes('netflix') ? 'Streaming' : 'Groceries', parent: d.text.includes('netflix') ? 'Subscriptions' : '' })) }) } }], usage: {} }));
    }
    if (msgs[0].content.includes('monthly personal budget')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ categories: [{ name: 'Rent', monthly_limit: 2500 }, { name: 'Utilities', monthly_limit: 300 }], notes: 'Assumed a couple.' }) } }], usage: {} }));
    }
    if (msgs[0].content.includes('"accomplishments"')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ headline: 'Weekly review from fake provider', accomplishments: ['Chose flooring'], suggestions: ['Rest'] }) } }], usage: {} }));
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
    SMTP_USER: 'admin@example.test', SMTP_PASS: 'e2e-not-used', DEEPSEEK_API_KEY: 'e2e-key', DEEPSEEK_BASE_URL: `http://127.0.0.1:${fakeAi.address().port}`, X_GROK_API_KEY: '' },
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
    await page.getByRole('link', { name: 'Projects', exact: true }).click();
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
    await page.getByRole('link', { name: 'Projects', exact: true }).click();
    await page.getByLabel('Show archived').uncheck();
    // default view lists every project; each project opens its own board
    await page.locator('.project-grid .project-card', { hasText: 'Apartment Renovation' }).getByText('Open board').waitFor();
    await page.getByRole('button', { name: 'By status' }).click();
    // drag the project card into the In Progress column
    const src = await page.locator('.status-col .project-card', { hasText: 'Apartment Renovation' }).boundingBox();
    const dst = await page.locator('section[aria-label="In Progress"]').boundingBox();
    await page.mouse.move(src.x + 40, src.y + 20); await page.mouse.down();
    await page.mouse.move(src.x + 60, src.y + 30, { steps: 5 });
    await page.mouse.move(dst.x + dst.width / 2, dst.y + 80, { steps: 15 });
    await page.mouse.up();
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
    await page.getByRole('link', { name: 'Projects', exact: true }).click();
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
    await page.getByLabel('Category', { exact: true }).selectOption({ label: 'Salary' });
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
    await page.getByRole('link', { name: 'Projects', exact: true }).click();
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
    await page.getByText(/1 suggested change was discarded because it did not match your data/).waitFor();
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

  await step('finance depth: category budget, emergency fund, debt payments', async () => {
    await page.getByRole('link', { name: 'Finance & Budget' }).click();
    await page.getByRole('button', { name: 'Monthly budget' }).click();
    await page.getByLabel('Budget currency').fill('EUR');
    await page.getByLabel('Limit for Food').fill('500');
    await page.getByRole('button', { name: 'Save budget' }).click();
    await page.getByText('Budget saved.').waitFor();
    await page.getByRole('img', { name: /Budget versus spent per category in EUR: Food/ }).waitFor();
    // category manager: add a sub-category and give it a limit through the builder
    await page.getByLabel('New category name').fill('Coffee');
    await page.getByLabel('Parent category').selectOption({ label: 'Inside Food' });
    await page.getByRole('button', { name: 'Add category' }).click();
    await page.getByLabel('Limit for Coffee').waitFor();
    // ...and remove it again (confirmation shows what happens to its entries)
    await page.getByRole('button', { name: 'Remove category Coffee' }).click();
    await page.getByRole('alertdialog', { name: 'Remove category Coffee' }).waitFor();
    await page.getByRole('button', { name: 'Remove category', exact: true }).click();
    await page.getByText('Removed category "Coffee".').waitFor();
    await page.getByLabel('Limit for Coffee').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Copy from previous month' }).click();
    await page.getByText(/No EUR budget found for/).waitFor();
    // Create with AI: prompt only. Figures the user typed are labelled as theirs, the rest as AI estimates
    await page.getByRole('button', { name: 'Create with AI' }).click();
    await page.getByLabel('Describe what you need').fill('Budget for a couple. Rent is 2500 EUR, utilities about 300 EUR.');
    await page.getByRole('button', { name: 'Generate draft' }).click();
    await page.getByRole('table', { name: 'Proposed budget lines' }).waitFor();
    await page.getByText('A figure you stated').first().waitFor();
    assert.equal(await page.getByLabel('Limit for Rent').inputValue(), '2500.00');
    await page.getByLabel('Limit for Rent').fill('2600');
    await page.getByLabel('Use Utilities').uncheck();
    await shot(page, '17-ai-budget-review');
    await page.getByRole('button', { name: /Create budget \(1 categories\)/ }).click();
    await page.getByText('Budget created for').waitFor();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Limit for Rent"]')?.value === '2600.00', null, { timeout: 15000 }); // the reviewed figure (not the AI draft) was saved
    assert.equal(await page.getByLabel('Limit for Utilities').count(), 0, 'unticked line was not created at all');
    // Create with AI: CSV statement, with transaction import
    const d = (n) => { const x = new Date(); x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() - n); return x.toISOString().slice(0, 8); };
    const csv = ['Date,Description,Amount', `${d(1)}05,KAUFLAND 12345678,-300.00`, `${d(1)}12,Netflix.com,-15.00`, `${d(2)}06,KAUFLAND 87654321,-340.00`, `${d(2)}28,ACME PAYROLL,2500.00`].join('\n');
    await page.getByRole('button', { name: 'Create with AI' }).click();
    await page.getByLabel('Or add a bank statement (CSV)').setInputFiles({ name: 'statement.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.getByRole('button', { name: 'Generate draft' }).click();
    await page.getByText(/4 of 4 rows read/).waitFor();
    await page.getByText(/negative amounts are expenses/).waitFor();
    assert.equal(await page.getByLabel('Limit for Groceries').inputValue(), '320.00', 'average of 300 and 340 over two months');
    await page.getByLabel(/Also import the 4 transactions/).check();
    await page.getByRole('button', { name: /Create budget/ }).click();
    await page.getByText('Budget created for').waitFor();
    await page.getByText('Transactions imported').waitFor();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByLabel('Limit for Groceries').waitFor();
    await page.getByRole('button', { name: 'Overview' }).click();
    await page.getByRole('img', { name: /Spending by category in EUR/ }).first().waitFor();
    await page.getByRole('img', { name: /Income and expenses per month in EUR/ }).first().waitFor();
    const label = await page.getByRole('img', { name: /Income and expenses per month in EUR/ }).first().getAttribute('aria-label');
    assert.match(label, /expenses €315\.00/, 'last month: Kaufland 300 + Netflix 15 from the imported statement');
    assert.match(label, /income €2,500\.00, expenses €340\.00/, 'two months ago: payroll and Kaufland');
    await shot(page, '18-finance-charts');
    await page.getByRole('link', { name: 'Finance & Budget' }).click();
    await page.getByRole('button', { name: 'Savings' }).click();
    await page.getByLabel('Savings goal name').fill('Emergency fund');
    await page.getByLabel('Savings target').fill('3000');
    await page.getByLabel('Savings currency').fill('EUR');
    await page.getByLabel('Emergency fund').check();
    await page.getByRole('button', { name: 'Add goal' }).click();
    await page.getByLabel('Amount for Emergency fund').fill('600');
    await page.getByRole('button', { name: 'Deposit' }).click();
    await page.getByText('(20%)').waitFor();
    await page.getByLabel('Amount for Emergency fund').fill('999999');
    await page.getByRole('button', { name: 'Withdraw' }).click();
    await page.getByText('withdrawal exceeds the current balance').waitFor();
    await page.getByRole('button', { name: 'Debts' }).click();
    await page.getByLabel('Debt name').fill('Car loan');
    await page.getByLabel('Original amount').fill('10000');
    await page.getByLabel('Debt currency').fill('EUR');
    await page.getByRole('button', { name: 'Add debt' }).click();
    await page.getByLabel('Payment for Car loan').fill('2500');
    await page.getByRole('button', { name: 'Record payment' }).click();
    await page.getByText(/€7,500\.00/).first().waitFor();
    await page.getByText(/25% paid/).waitFor();
    await shot(page, '15-finance-depth');
  });

  await step('calendar week and day views; event reminder reaches the notification bell', async () => {
    await page.getByRole('link', { name: 'Calendar' }).click();
    await page.getByRole('button', { name: 'Week', exact: true }).click();
    assert.equal(await page.getByRole('gridcell', { name: /timeline$/ }).count(), 7, 'seven day columns on an hour grid');
    await page.getByRole('button', { name: 'Day', exact: true }).click();
    assert.equal(await page.getByRole('gridcell', { name: /timeline$/ }).count(), 1);
    const soon = new Date(Date.now() + 5 * 60_000);
    const hhmm = soon.toISOString().slice(11, 16);
    await page.getByRole('button', { name: 'New event' }).click();
    await page.getByLabel('Title').fill('Standup reminder');
    await page.getByLabel('Starts').fill(hhmm);
    await page.getByLabel('Time zone').fill('UTC');
    await page.getByLabel('Reminder').selectOption('10');
    await page.getByRole('button', { name: 'Add event', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: /Standup reminder/ }).first().waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.getByRole('button', { name: /Notifications, [1-9]\d* unread/ }).waitFor();
    await page.getByRole('button', { name: /Notifications/ }).click();
    await page.getByRole('region', { name: 'Notifications' }).getByText('Standup reminder starts in 10 min').waitFor();
    await shot(page, '16-bell');
    await page.getByRole('button', { name: 'Mark all read' }).click();
    await page.getByRole('button', { name: 'Notifications, 0 unread' }).waitFor();
    await page.keyboard.press('Escape');
  });

  await step('assistant weekly review (mocked provider) states its period and facts', async () => {
    await page.getByRole('link', { name: 'AI Assistant' }).click();
    await page.getByRole('button', { name: 'Weekly review' }).click();
    await page.getByRole('button', { name: 'Generate' }).click();
    await page.getByText('Weekly review from fake provider').waitFor();
    await page.getByText(/Covers \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}/).waitFor();
    await page.getByText('Facts used').click();
    await page.getByText(/tasks completed/).waitFor();
  });

  await step('assistant dock on every page: context, suggestions, report artifact, Edit first prefills the real form', async () => {
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await page.getByRole('button', { name: /Open assistant/ }).click();
    const dock = page.getByRole('complementary', { name: 'AI assistant' });
    await dock.getByText('Looking at: Dashboard').waitFor();
    await dock.getByRole('region', { name: 'Suggested next steps' }).waitFor();
    const before = await dock.getByRole('region', { name: 'Suggested next steps' }).locator('li').count();
    await dock.getByRole('button', { name: /Hide suggestion/ }).first().click();
    await page.waitForFunction((n) => document.querySelectorAll('[aria-label="Suggested next steps"] li').length < n, before);
    await dock.getByLabel('Message').fill('Make me a report of everything');
    await dock.getByRole('button', { name: 'Send' }).click();
    await dock.getByText('Report is ready under Reports.').waitFor();
    await dock.getByRole('link', { name: /Report ready: E2E overview/ }).click();
    await page.getByRole('heading', { name: 'E2E overview', level: 1 }).waitFor();
    const frame = page.frameLocator('iframe.report-frame');
    await frame.getByRole('heading', { name: 'E2E overview' }).waitFor();
    await frame.getByRole('heading', { name: 'At a glance' }).waitFor();
    assert.equal(await page.locator('iframe.report-frame').getAttribute('sandbox'), '', 'report preview is sandboxed (no scripts)');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download HTML' }).click()]);
    assert.match(dl.suggestedFilename(), /^E2E[ -]overview\.html$/);
    await shot(page, '19-report');
    // the dock follows you: on a project board it knows which project you are looking at
    await page.getByRole('link', { name: 'Projects', exact: true }).click();
    await page.getByRole('link', { name: /Apartment Renovation/ }).click();
    await page.getByRole('button', { name: /Open assistant/ }).click();
    await page.getByRole('complementary', { name: 'AI assistant' }).getByText('Looking at: A project board').waitFor();
    await page.getByLabel('Message').fill('What should I focus on?');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByRole('button', { name: 'Edit first' }).first().click();
    await page.getByRole('dialog', { name: 'Quick add task' }).waitFor();
    assert.equal(await page.getByLabel('Task', { exact: true }).inputValue(), 'Call the contractor', 'the proposed values are in the real form');
    assert.equal(await page.getByLabel('Due date').inputValue(), '2027-01-15');
    await page.getByRole('dialog', { name: 'Quick add task' }).getByRole('button', { name: 'Close' }).click();
    await shot(page, '20-dock');
  });

  await step('assistant drives a guided skill with clickable suggestions; stop and import skills', async () => {
    await page.getByRole('button', { name: /Open assistant/ }).click();
    await page.getByLabel('Message').fill('help me create an automation');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByText('When should it run?').waitFor();
    await page.getByText(/Running \/create-automation/).waitFor();
    await page.getByRole('button', { name: 'Every Monday at 08:00' }).click();
    await page.getByText('Scheduled for Mondays. All set.').waitFor();
    await page.getByText(/Running \/create-automation/).waitFor({ state: 'detached' });
    await page.getByLabel('Message').fill('/amb');
    await page.getByRole('option', { name: /amb-workflow/ }).waitFor();
    await page.getByLabel('Message').fill('');
    await page.getByRole('button', { name: 'Close assistant' }).click();
    await page.getByRole('link', { name: 'Workspace' }).click();
    await page.getByLabel('Or paste a skill (SKILL.md text)').fill('---\nname: friday-tidy\ndescription: tidy up on Fridays\n---\nList overdue tasks first.');
    await page.getByRole('button', { name: 'Add skill' }).click();
    await page.getByText('Added /friday-tidy.').waitFor();
    await page.getByRole('button', { name: 'Delete skill friday-tidy' }).click();
    await page.getByRole('button', { name: 'Delete skill friday-tidy' }).waitFor({ state: 'detached' });
  });

  await step('MCP: create a token in settings; an external client reads, analyses and proposes; approval happens in the app', async () => {
    await page.getByRole('link', { name: 'Workspace' }).click();
    await page.getByLabel('Token name').fill('e2e-client');
    await page.getByRole('button', { name: 'Create token' }).click();
    const token = await page.getByLabel('New token').inputValue();
    assert.match(token, /^amb_pat_/);
    const rpc = async (method, params) => (await fetch(`${base}/api/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
    const tools = (await rpc('tools/list', {})).result.tools.map((t) => t.name);
    assert.ok(tools.includes('generate_report') && tools.includes('analyze_spending') && tools.includes('propose_create_task'));
    const projects = JSON.parse((await rpc('tools/call', { name: 'list_projects', arguments: {} })).result.content[0].text);
    assert.ok(projects.some((p) => p.name === 'Apartment Renovation'));
    const pid = projects.find((p) => p.name === 'Apartment Renovation').id;
    const prop = JSON.parse((await rpc('tools/call', { name: 'propose_create_task', arguments: { project_id: pid, title: 'Proposed over MCP', due_date: '2027-02-01' } })).result.content[0].text);
    assert.equal(prop.status, 'pending_approval');
    await page.getByRole('link', { name: 'AI Assistant' }).click();
    await page.getByLabel('Conversation').first().selectOption({ label: 'External assistant (MCP)' });
    await page.getByText('Create task "Proposed over MCP" in project').last().waitFor();
    await page.getByRole('button', { name: 'Approve' }).click();
    await page.getByText('Applied.').waitFor();
    await page.getByRole('link', { name: 'Tasks', exact: true }).click();
    await page.getByRole('link', { name: 'Proposed over MCP' }).waitFor();
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

  await step('assistant sees the whole workspace and proposes a multi-step plan; one approval creates it all', async () => {
    await page.getByRole('link', { name: 'AI Assistant' }).click();
    await page.getByLabel('Message').fill('Please plan my move');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByText('Here is a setup for the move.').waitFor();
    await page.getByText('Setup plan: 3 steps, approved together').waitFor();
    await page.getByText(/2\. Create task "Sign the lease" in project "Move plan project"/).waitFor();
    await page.getByRole('button', { name: 'Approve' }).first().click();
    await page.getByText('Applied.').waitFor();
    await page.getByRole('link', { name: 'Projects', exact: true }).click();
    await page.locator('.project-card', { hasText: 'Move plan project' }).first().waitFor();
    assert.match(await page.locator('.project-card', { hasText: 'Move plan project' }).first().innerText(), /2 tasks/);
  });

  await step('automations: build a scheduled flow, run it now, see the log; toggle it off', async () => {
    await page.getByRole('link', { name: 'Automations' }).click();
    await page.getByRole('button', { name: 'New automation' }).click();
    await page.getByLabel('Automation name').fill('Weekly planning');
    await page.getByLabel('Step 1 action').selectOption({ label: 'Create a task' });
    await page.locator('.flow-step').first().getByLabel('Project').selectOption({ label: 'Move plan project' });
    await page.locator('.flow-step').first().getByLabel('Title').fill('Plan the week of {{date}}');
    await page.getByRole('button', { name: 'Add a step' }).click();
    await page.getByLabel('Step 2 action').selectOption({ label: 'Send me a notification' });
    await page.locator('.flow-step').nth(1).getByLabel('Title').fill('Weekly plan is ready');
    await page.getByText(/Summary:.*create a task, then send me a notification/i).waitFor();
    await shot(page, '21-automation-builder');
    await page.getByRole('button', { name: 'Save automation' }).click();
    const card = page.getByRole('article', { name: 'Weekly planning' });
    await card.getByText(/Every Monday at 08:00/).waitFor();
    await card.getByRole('button', { name: 'Run now' }).click();
    await card.getByText('Last run: ok').waitFor();
    await card.getByText(/Notification sent/).waitFor();
    await card.getByRole('checkbox', { name: 'Weekly planning enabled' }).click();
    await card.getByText('Off', { exact: true }).waitFor();
    await shot(page, '22-automations');
    await page.getByRole('link', { name: 'Projects', exact: true }).click();
    assert.match(await page.locator('.project-card', { hasText: 'Move plan project' }).first().innerText(), /3 tasks/, 'the flow created a task');
  });

  await step('board columns: a column holds a status and a card limit; a full column refuses more cards', async () => {
    await page.getByRole('link', { name: 'Projects', exact: true }).click();
    await page.locator('.project-card', { hasText: 'Move plan project' }).first().click();
    await page.locator('button[aria-label="Settings for column In Progress"]').click();
    await page.getByLabel('Most cards it can hold').fill('1');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByLabel('0 cards, limit 1').waitFor();
    await page.getByText('Holds: Doing').waitFor();
    const drag = async (title) => {
      const src = await page.locator('.card', { hasText: title }).first().boundingBox();
      const dst = await page.locator('.column').nth(1).boundingBox();
      await page.mouse.move(src.x + 40, src.y + 20); await page.mouse.down();
      await page.mouse.move(src.x + 60, src.y + 30, { steps: 5 });
      await page.mouse.move(dst.x + dst.width / 2, dst.y + 100, { steps: 15 });
      await page.mouse.up();
    };
    await drag('Sign the lease');
    await page.getByLabel('1 cards, limit 1').waitFor();
    await page.locator('.column').nth(1).locator('.card', { hasText: 'Sign the lease' }).getByText('DOING', { exact: false }).waitFor();   // status followed the column
    await drag('Book movers');
    await page.locator('.column').nth(0).locator('.card', { hasText: 'Book movers' }).waitFor();   // it snapped back
    await page.getByRole('button', { name: 'Add card' }).nth(1).isDisabled();
    await shot(page, '23-column-limit');
  });

  await step('copy a project to another workspace; the original stays', async () => {
    const made = await page.request.post(`${base}/api/workspaces`, { data: { name: 'E2E Team' } });
    assert.equal(made.status(), 201);
    await page.reload();   // the app learns about the new workspace
    await page.getByRole('link', { name: 'Projects', exact: true }).click();
    await page.getByRole('button', { name: 'Copy Move plan project to another workspace' }).first().click();
    await page.getByLabel(/Copy "Move plan project" to/).selectOption({ label: 'E2E Team' });
    await page.getByRole('button', { name: 'Copy', exact: true }).click();
    await page.getByText(/Copied "Move plan project" to/).waitFor();
    await page.getByText(/3 columns/).waitFor();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.locator('.project-card', { hasText: 'Move plan project' }).first().waitFor();
  });

  await step('automations: an email template with placeholders, previewed with sample data, then used by a "Send an email" step', async () => {
    await page.getByRole('link', { name: 'Automations' }).click();
    await page.getByRole('button', { name: 'New template' }).click();
    await page.getByLabel('Name', { exact: true }).fill('E2E note');
    await page.getByLabel('Subject', { exact: true }).fill('Hello {{owner.name}}');
    await page.getByLabel('Message', { exact: true }).fill('# News\n\n{{result.news | pretty | truncate:300}}');
    await page.getByRole('button', { name: 'Preview' }).click();
    await page.getByText(/Subject: Hello /).waitFor();
    await page.frameLocator('iframe[title="Template preview"]').getByText('News').first().waitFor();
    await page.getByRole('button', { name: 'Save template' }).click();
    await page.getByRole('list', { name: 'Email templates list' }).getByText('E2E note').waitFor();
    await page.getByRole('button', { name: 'New automation' }).click();
    await page.getByLabel('Automation name').fill('Mail me the news');
    await page.getByLabel('Step 1 action').selectOption({ label: 'Send an email' });
    await page.locator('.flow-step').first().getByLabel('Template').selectOption({ label: 'E2E note' });
    await page.getByRole('button', { name: 'Preview with sample data' }).click();
    await page.frameLocator('iframe[title="Email preview"]').getByText('News').first().waitFor();
    await page.getByRole('button', { name: 'Save automation' }).click();
    const card = page.getByRole('article', { name: 'Mail me the news' });
    await card.getByText('1. Send an email').waitFor();
    await shot(page, '24-email-flow');
  });

  await step('automation builder: parse a JSON list, test the step, loop over it and test the whole flow without saving anything', async () => {
    await page.getByRole('button', { name: 'New automation' }).click();
    await page.getByLabel('Automation name').fill('Pipeline demo');
    await page.getByLabel('Step 1 action').selectOption({ label: 'Parse data (JSON, HTML, CSV or your own prompt)' });
    await page.getByLabel('Data to parse').fill('[{"t":"alpha","n":1},{"t":"beta","n":2}]');
    await page.getByLabel('Which data do you want? (comma separated, optional)').fill('t');
    await page.getByLabel('Save the result as').fill('list');
    await page.locator('.flow-step').first().getByRole('button', { name: 'Test this step' }).click();
    await page.getByText('Test result:').first().waitFor();
    await page.locator('.flow-test__out').first().getByText('"alpha"').waitFor();
    await page.getByRole('button', { name: 'Add a step' }).click();
    await page.getByLabel('Step 2 action').selectOption({ label: 'Repeat for every item in a list' });
    await page.getByLabel('Go through this list').fill('{{result.list}}');
    await page.getByLabel('Loop step 1 action').selectOption({ label: 'Write a note' });
    await page.locator('.flow-step--inner').getByLabel('Title').fill('Note for {{item.t}}');
    await page.getByRole('button', { name: 'Test the whole loop (first 3 items)' }).click();
    await page.getByText(/Looped over 2 items/).waitFor();
    await page.getByText(/Would: .*Note for beta/).first().waitFor();
    await page.getByRole('button', { name: 'Test all steps in order' }).click();
    await page.getByText('Step 2').first().waitFor();
    await shot(page, '25-pipeline');
    await page.getByRole('button', { name: 'Save automation' }).click();
    await page.getByRole('article', { name: 'Pipeline demo' }).getByText('2. Repeat for every item in a list').waitFor();
  });

  await step('settings: let the assistant auto-apply routine changes; connect a tool (private addresses refused)', async () => {
    await page.getByRole('link', { name: 'Workspace', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Create tasks' }).check();
    await page.getByRole('checkbox', { name: 'Create tasks' }).waitFor();
    await page.reload();
    assert.equal(await page.getByRole('checkbox', { name: 'Create tasks' }).isChecked(), true, 'the choice is saved');
    await page.getByRole('checkbox', { name: 'Create tasks' }).uncheck();
    await page.getByLabel('Name', { exact: true }).fill('Notes');
    await page.getByLabel('Server address').fill('https://127.0.0.1/mcp');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByText(/private network/).waitFor();
    // browser assistant: pair a browser, token shown once, revoke
    await page.getByLabel('Name of this browser').fill('E2E laptop');
    await page.getByRole('button', { name: 'Create pairing token' }).click();
    await page.getByText(/Pairing token for "E2E laptop" \(shown once\): amb_br_/).waitFor();
    await page.getByRole('list', { name: 'Paired browsers' }).getByText('E2E laptop').waitFor();
    await page.getByRole('button', { name: 'Remove E2E laptop' }).click();
    await page.getByRole('list', { name: 'Paired browsers' }).waitFor({ state: 'detached' });
    await page.getByRole('link', { name: 'Projects', exact: true }).click();
    await page.getByRole('heading', { name: 'Projects', level: 1 }).waitFor();
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
    await page.getByRole('heading', { name: 'Projects', level: 1 }).waitFor(); // session restored on the page we left
    assert.match(page.url(), /\/projects$/);
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
    await p2.getByRole('link', { name: 'Projects', exact: true }).click();
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
