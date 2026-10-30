import { BarChart3, Bell, Braces, CalendarPlus, CheckSquare, Clock, FileText, Globe, Mail, MessageSquare, Pencil, Plug, Repeat, Search, Sparkles, Wand2, Wallet, Zap } from 'lucide-react';
import { DEFAULT_ARGS, LABEL } from './fields.jsx';

// Which family a step belongs to: it drives the colour, the picker group and the "does it change anything" wording.
export const KIND = {
  use_tool: 'get', scrape: 'get', parse: 'mix', loop: 'mix', ai_text: 'mix', run_skill: 'mix',
  send_email: 'act', notify: 'act', create_task: 'act', update_task: 'act', add_comment: 'act', create_note: 'act', create_event: 'act', create_transaction: 'act', generate_report: 'act',
};
const ICONS = { trigger: Clock, event: Zap, use_tool: Plug, web_search: Search, scrape: Globe, parse: Braces, loop: Repeat, ai_text: Sparkles, run_skill: Wand2, send_email: Mail, notify: Bell, create_task: CheckSquare, update_task: Pencil, add_comment: MessageSquare, create_note: FileText, create_event: CalendarPlus, create_transaction: Wallet, generate_report: BarChart3 };

export function StepIcon({ type, size = 20 }) {
  const Icon = ICONS[type] || Plug;
  return <span className={`ab-ico ab-ico--${type === 'trigger' || type === 'event' ? 'trig' : KIND[type] || 'get'}`}><Icon size={size} aria-hidden="true" /></span>;
}

export const TITLE = {
  ...LABEL, use_tool: 'Use a tool', scrape: 'Scrape a web page', parse: 'Parse data', loop: 'Repeat for every item', ai_text: 'Write text with AI', run_skill: 'Run an installed skill', send_email: 'Send an email',
  update_task: 'Change the triggering task', add_comment: 'Comment on the triggering task',
};
export const stepTitle = (s) => (s.type === 'use_tool' ? (s.args.tool === 'web_search' ? 'Search the web' : s.args.tool === 'read_web_page' ? 'Read a web page' : s.args.tool === 'external' ? 'Use a connected tool' : 'Read your workspace') : TITLE[s.type] || s.type);
export const stepIconType = (s) => (s.type === 'use_tool' && s.args.tool === 'web_search' ? 'web_search' : s.type);

const host = (u) => { try { return new URL(String(u)).host; } catch { return String(u || '').replace(/^https?:\/\//, '').slice(0, 40); } };
const clip = (t, n) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
// One line saying what the step does, for the flow list.
export function describe(s) {
  const a = s.args || {};
  switch (s.type) {
    case 'scrape': return `${a.url ? host(a.url) : 'No address yet'}, get ${({ links: 'links', feed: 'feed items', json: 'JSON', meta: 'title and headings', html: 'cleaned HTML', text: 'readable text' })[a.format] || 'text'}`;
    case 'parse': { const f = a.fieldsText ?? (a.fields || []).join(', '); return `${a.parser === 'custom' ? 'Your prompt' : `${String(a.parser || 'json').toUpperCase()} in`}, keep ${f.trim() || 'everything useful'}, give ${String(a.output_format || 'json').replace('_', ' ')}`; }
    case 'loop': return `Up to ${a.max_items || 20} items of ${clip(a.over, 40) || 'a list'}, ${(a.steps || []).length} step${(a.steps || []).length === 1 ? '' : 's'} each`;
    case 'use_tool': return a.tool === 'web_search' ? clip(a.args?.query, 60) || 'No search yet' : a.tool === 'read_web_page' ? host(a.args?.url) || 'No address yet' : a.tool === 'external' ? `${a.server || 'No server'}: ${a.external_tool || 'choose a tool'}` : a.tool;
    case 'ai_text': return clip(a.instruction, 70) || 'No instruction yet';
    case 'run_skill': return a.skill ? `/${a.skill}${a.instruction ? `: ${clip(a.instruction, 50)}` : ''}` : 'No skill chosen yet';
    case 'send_email': return `To ${clip(a.toText ?? (a.to || ['me']).join(', '), 40)}${a.subject ? `. Subject: ${clip(a.subject, 40)}` : a.template ? '. From a template' : ''}`;
    case 'notify': return clip(a.title, 70) || 'No title yet';
    case 'create_task': return clip(a.title, 70) || 'No title yet';
    case 'create_note': return clip(a.title, 70) || 'No title yet';
    case 'create_event': return `${clip(a.title, 40) || 'No title yet'} at ${a.time || ''}`;
    case 'create_transaction': return `${a.type || 'expense'} ${a.amount || ''} ${a.currency || ''} ${clip(a.description, 30)}`.trim();
    case 'generate_report': return `${String(a.kind || 'overview').replace('_', ' ')} report`;
    case 'update_task': return [a.status && `status ${a.status}`, a.priority && `priority ${a.priority}`].filter(Boolean).join(', ') || 'No change chosen yet';
    case 'add_comment': return clip(a.text, 70) || 'No comment yet';
    default: return '';
  }
}

// The picker. `preset` overrides the default arguments.
export const CATALOG = [
  { group: 'Get data', hint: 'from the web, your connected tools or your workspace', items: [
    { type: 'use_tool', preset: { tool: 'web_search', args: { query: '' } }, name: 'Search the web', desc: 'Look something up and get titles, links and snippets.', gives: 'gives a list' },
    { type: 'scrape', name: 'Scrape a web page', desc: 'Fetch one page as text, links, a feed or JSON.', gives: 'gives text or a list' },
    { type: 'use_tool', preset: { tool: 'external', server: '', external_tool: '', args: {}, argsText: '{}' }, name: 'Use a connected tool', desc: 'Call a tool from a server you connected.', gives: 'gives JSON', needs: 'servers' },
    { type: 'use_tool', preset: { tool: 'list_tasks', args: {}, argsText: '{}' }, name: 'Read your workspace', desc: 'Tasks, spending, project health, workload and more.', gives: 'gives JSON' },
  ] },
  { group: 'Shape data', hint: 'turn it into what the next step needs', items: [
    { type: 'parse', name: 'Parse data', desc: 'Pick the fields you want from JSON, HTML or text, in the format you want.', gives: 'gives JSON, CSV or text' },
    { type: 'loop', name: 'Repeat for every item', desc: 'Run steps once for each item of a list, up to 50.', gives: 'gives a list of results', noLoop: true },
    { type: 'ai_text', name: 'Write text with AI', desc: 'Summarise or rewrite what the earlier steps found.', gives: 'gives text' },
    { type: 'run_skill', name: 'Run an installed skill', desc: 'Apply a skill you imported to what earlier steps found.', gives: 'gives text', needs: 'skills' },
  ] },
  { group: 'Do something', hint: 'changes happen only here, and tests only describe them', items: [
    { type: 'send_email', name: 'Send an email', desc: 'To you or up to 5 people, with a template.' },
    { type: 'notify', name: 'Notify me', desc: 'A notification in AMB Board.' },
    { type: 'create_task', name: 'Create a task', desc: 'In a project, with a due date and priority.' },
    { type: 'create_note', name: 'Write a note', desc: 'Save the result as a note.' },
    { type: 'create_event', name: 'Add a calendar event', desc: 'With a time zone and reminder.' },
    { type: 'create_transaction', name: 'Record a transaction', desc: 'Planned until you confirm it.' },
    { type: 'generate_report', name: 'Generate a report', desc: 'A report with charts under Reports.' },
    { type: 'update_task', name: 'Change the triggering task', desc: 'Status, priority or due date.', needs: 'taskTrigger' },
    { type: 'add_comment', name: 'Comment on the triggering task', desc: 'Add a comment when the flow runs.', needs: 'taskTrigger' },
  ] },
];
export const newStep = (item, over = '') => {
  const base = { ...(DEFAULT_ARGS[item.type] || {}) };
  const args = item.preset ? { ...base, ...item.preset } : base;
  if (item.type === 'loop') return { type: 'loop', args: { ...args, over, steps: [] } };
  if (item.type === 'loop') return { type: 'loop', args };
  return { type: item.type, args: JSON.parse(JSON.stringify(args)) };
};
