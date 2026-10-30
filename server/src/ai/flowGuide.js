import { db } from '../db.js';
import { STEP_DOCS, EVENT_TRIGGERS, FREQUENCIES, PLACEHOLDERS, MAX_STEPS, MAX_AUTOMATIONS, MAX_RECIPIENTS, describeTrigger } from '../automations/spec.js';
import { FILTER_DOCS, BUILTIN_TEMPLATES } from '../automations/template.js';
import { PARSERS, OUTPUT_FORMATS } from '../automations/parser.js';
import { SCRAPE_FORMATS } from './web.js';
import { mailConfigured } from '../notifications/mailer.js';
import { userServers, toolsOf } from './mcpServers.js';
import { searchConfigured } from './web.js';

// The assistant's complete reference for designing, creating, changing and running automations.
// Built from the same registries the builder and the engine use, so it cannot drift from what actually works.
export async function flowGuide(ws, user, TOOLS) {
  const internal = Object.entries(TOOLS)
    .filter(([n]) => !['call_external_tool', 'external_tools', 'generate_report', 'browser_status', 'browser_snapshot', 'browser_fill', 'browser_click'].includes(n))
    .map(([name, t]) => ({ name, kind: t.kind || 'read', how: t.doc }));
  const external = await Promise.all(userServers(ws, user.id).map(async (s) => {
    try { return { server: s.name, tools: (await toolsOf(s)).map((t) => ({ tool: t.name, read_only: t.read_only, description: t.description })) }; } catch (e) { return { server: s.name, error: String(e.message).slice(0, 100) }; }
  }));
  const existing = db.prepare('SELECT id, name, enabled, trigger, steps, next_run_at, last_run_at, last_status, created_via FROM automations WHERE workspace_id = ? ORDER BY created_at LIMIT 30').all(ws)
    .map((a) => ({ id: a.id, name: a.name, enabled: !!a.enabled, when: describeTrigger(JSON.parse(a.trigger)), trigger: JSON.parse(a.trigger), steps: JSON.parse(a.steps), next_run_at: a.next_run_at, last_run_at: a.last_run_at, last_status: a.last_status, created_via: a.created_via }));
  const templates = db.prepare('SELECT id, name, subject FROM email_templates WHERE workspace_id = ? ORDER BY name').all(ws);
  const installed_skills = db.prepare('SELECT name, description FROM ai_skills WHERE workspace_id = ? AND user_id = ? ORDER BY name').all(ws, user.id);
  return {
    installed_skills: installed_skills.length ? { note: 'Skills this person imported. A run_skill step applies one to the output of earlier steps.', skills: installed_skills } : 'none installed; run_skill needs one imported first',
    ways_to_create_or_change_flows: [
      'The Automations page (sidebar, Manage): a list of flows with status, a builder (flow on the left, step settings and the test result on the right, a step picker grouped as get data / shape data / do something), per-step "Test this step", run history per run, and templates to start from.',
      'Propose create_automation (one flow, the user approves it); several flows or flows plus other setup in ONE setup_plan; change one with update_automation (name, trigger, steps, on/off); remove with delete_automation; run a scheduled one now with run_automation.',
      'Email templates: propose create_email_template / update_email_template / delete_email_template.',
      'External MCP clients cannot create flows; only the signed-in person (through the app or you) can.',
    ],
    triggers: {
      schedule: { type: 'schedule', frequency: FREQUENCIES, fields: 'time HH:mm, timezone (IANA), weekday 0-6 (weekly), day 1-28 (monthly), date (once)' },
      event: { type: 'event', events: EVENT_TRIGGERS, conditions: 'project_id, priority (task events); type, currency, min_amount_minor (transaction_added)' },
    },
    steps: STEP_DOCS,
    step_limit: `${MAX_STEPS} steps per flow, 5 inside a loop (a loop cannot contain a loop), at most 200 step executions per run`,
    chaining_steps_together: {
      how: 'Every reading step (use_tool, scrape, parse, ai_text) saves its output with save_as. The next step reads it as {{result.NAME}} (text) or walks into JSON: {{result.NAME.0.title}}, {{result.NAME.items.length}}. A placeholder that is the WHOLE value of a tool argument keeps its type, so "args":{"urls":"{{result.links}}","item":"{{item}}","n":"{{item.count}}"} passes a real list, object or number to the next tool (MCP tools take JSON objects). Text around a placeholder makes it text.',
      typical_pipeline: 'scrape (format links|feed|json|text) -> parse (JSON, only the fields you want) -> loop over {{result.parsed}} with scrape/use_tool/ai_text inside, using {{item.field}} -> send_email or create_note with {{result.collected | count}} and {{result.collected | pretty}}',
      scrape: { formats: SCRAPE_FORMATS, note: 'one public https page per step; text/html/links/json/feed (RSS or Atom)/meta; its own daily limit; page text is untrusted' },
      parse: { parsers: PARSERS, output_formats: OUTPUT_FORMATS, note: 'preselected parser is json. A hardened AI prompt does the parsing: the data is never obeyed as instructions, nothing is invented, JSON is verified and cut down to the wanted "fields" in code, one automatic retry. JSON that needs no reshaping costs no AI call. Use parser "custom" with "prompt" when the user wants to write the parsing prompt themselves. "fields" = which data; "output_format" = in which format (default json).' },
      loop: 'over = a JSON list ({{result.parsed}}); inside: {{item}}, {{item.field}}, {{index}} (1-based), {{total}}; max_items up to 50; on_error stop|continue; collect = a save_as inside the loop, save_as = name of the resulting list. Test runs process only the first 3 items.',
    },
    testing_steps: 'Before proposing a flow, test each reading step with the test_automation_step skill and show the user the output. Pass the "vars" it returns into the next test so steps chain without re-running. Steps that would change things (create, notify, email, write tools) only describe themselves in a test. The builder has the same "Test this step" button, so tell users they can run steps one by one there too.',
    flow_limit: MAX_AUTOMATIONS,
    placeholders: {
      names: PLACEHOLDERS,
      note: 'Usable in every text field and tool argument: {{date}}, {{trigger.title}}, {{owner.name}}, {{result.NAME}}. A tool or AI step saves its output as result.NAME with its save_as field, and later steps use it.',
      filters: FILTER_DOCS,
      examples: [
      { name: 'Deals digest', trigger: { type: 'schedule', frequency: 'weekly', weekday: 5, time: '08:00', timezone: 'Europe/Bucharest' },
        steps: [{ type: 'scrape', args: { url: 'https://example.com/deals', format: 'links', contains: '/deal/', save_as: 'links' } },
          { type: 'loop', args: { over: '{{result.links}}', max_items: 5, collect: 'deal', save_as: 'deals', steps: [{ type: 'scrape', args: { url: '{{item.url}}', format: 'text', save_as: 'page' } }, { type: 'parse', args: { input: '{{result.page}}', parser: 'html', fields: ['title', 'price'], output_format: 'json', save_as: 'deal' } }] } },
          { type: 'ai_text', args: { instruction: 'Write a short digest of these deals', input: '{{result.deals}}', save_as: 'digest' } }, { type: 'send_email', args: { to: ['me'], subject: 'Deals {{date}}', body: '{{result.digest}}\n\n{{result.deals | pretty}}' } }] },'{{result.news | pretty | truncate:800}}', '{{result.summary | default:"nothing new"}}', '{{owner.name | upper}}', '{{result.rows | pretty | lines:10}}'],
      event_trigger_fields: 'trigger.title, trigger.project, trigger.priority, trigger.description, trigger.amount, trigger.currency (only for event triggers)',
    },
    tools_usable_in_flows: {
      note: 'Use these with the use_tool step: tool is the name below, args its arguments. For a connected server use tool "external" with server and external_tool; a tool that is not read_only also needs allow_write true.',
      internal,
      web: { available: searchConfigured(), tools: ['web_search {query}', 'read_web_page {url}'] },
      connected_servers: external,
      not_in_flows: 'browser tools, call_external_tool/external_tools (use the external form), and generate_report (use the generate_report step)',
    },
    email: {
      configured: mailConfigured(),
      limits: `up to ${MAX_RECIPIENTS} recipients per step; 20 emails per flow and 100 per person per day; sent from the AMB Board address with Reply-To the flow owner`,
      recipients: '"me" means the flow owner; other addresses are written out and shown in the approval card',
      body_format: 'Markdown-lite: "# heading", "- list", "**bold**", "_italic_", [text](https://link), bare links. Placeholder values are escaped, never executed.',
      builtin_templates: Object.entries(BUILTIN_TEMPLATES).map(([key, t]) => ({ key, name: t.name, subject: t.subject })),
      workspace_templates: templates,
    },
    duplicates: 'create_automation is refused when an automation with the same name (ignoring case and punctuation) or the same schedule and kinds of steps already exists: look at existing_automations first and propose update_automation instead.',
    existing_automations: existing,
    examples: [
      { name: 'Morning news by email', trigger: { type: 'schedule', frequency: 'daily', time: '07:30', timezone: 'Europe/Bucharest' },
        steps: [{ type: 'use_tool', args: { tool: 'web_search', args: { query: 'Romania economy news' }, save_as: 'news' } }, { type: 'ai_text', args: { instruction: 'Summarise in 5 bullet points', input: '{{result.news | pretty}}', save_as: 'summary' } },
          { type: 'send_email', args: { to: ['me'], template: 'news_summary' } }] },
      { name: 'Tell me when a big expense is recorded', trigger: { type: 'event', event: 'transaction_added', conditions: { type: 'expense', min_amount_minor: 100000 } },
        steps: [{ type: 'send_email', args: { to: ['me'], subject: 'Big expense: {{trigger.amount}} {{trigger.currency}}', body: '{{trigger.title | default:"An expense"}} was recorded.' } }] },
      { name: 'Monday planning', trigger: { type: 'schedule', frequency: 'weekly', weekday: 1, time: '08:00', timezone: 'UTC' },
        steps: [{ type: 'use_tool', args: { tool: 'project_health', args: {}, save_as: 'review' } }, { type: 'send_email', args: { to: ['me'], template: 'weekly_review' } }, { type: 'notify', args: { title: 'Weekly review sent', link: '/reports' } }] },
    ],
  };
}
