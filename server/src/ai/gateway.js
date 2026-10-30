import { nanoid } from 'nanoid';
import { db, nowIso } from '../db.js';

// Provider-independent gateway for OpenAI-compatible chat APIs (DeepSeek, xAI Grok).
// Env is read at call time so tests and key rotation need no restart logic.
const PROVIDERS = {
  deepseek: { keyEnv: 'DEEPSEEK_API_KEY', baseEnv: 'DEEPSEEK_BASE_URL', base: 'https://api.deepseek.com', modelEnv: 'DEEPSEEK_MODEL', model: 'deepseek-chat' },
  grok: { keyEnv: 'X_GROK_API_KEY', baseEnv: 'X_AI_BASE_URL', base: 'https://api.x.ai/v1', modelEnv: 'GROK_MODEL', model: 'grok-4' },
};

export class AiUnavailableError extends Error {}
export class AiLimitError extends Error {}
export class AiFailureError extends Error {}

const TIMEOUT_MS = () => Number(process.env.AI_TIMEOUT_MS) || 45_000;
export const dailyLimit = () => Number(process.env.AI_DAILY_LIMIT) || 100;

// Configured providers in preference order: AI_PROVIDER first, then deepseek, then grok.
export function configuredProviders() {
  const order = [process.env.AI_PROVIDER, 'deepseek', 'grok'].filter((p, i, a) => p && PROVIDERS[p] && a.indexOf(p) === i);
  return order.filter((name) => process.env[PROVIDERS[name].keyEnv]).map((name) => {
    const p = PROVIDERS[name];
    return { name, key: process.env[p.keyEnv], base: (process.env[p.baseEnv] || p.base).replace(/\/$/, ''), model: process.env[p.modelEnv] || p.model };
  });
}

export function usageToday(workspaceId) {
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  return db.prepare('SELECT COUNT(*) AS n FROM ai_usage WHERE workspace_id = ? AND created_at >= ?').get(workspaceId, since.toISOString()).n;
}

function record(ctx, provider, status, usage, started) {
  db.prepare(`INSERT INTO ai_usage (id, workspace_id, user_id, provider, model, purpose, status, prompt_tokens, completion_tokens, latency_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(nanoid(), ctx.workspaceId, ctx.userId ?? null, provider.name, provider.model, ctx.purpose, status,
      usage?.prompt_tokens ?? null, usage?.completion_tokens ?? null, Date.now() - started, nowIso());
}

async function callOnce(provider, messages) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS());
  try {
    const res = await fetch(`${provider.base}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.key}` },
      body: JSON.stringify({ model: provider.model, messages, temperature: 0.2, response_format: { type: 'json_object' } }),
    });
    if (!res.ok) {
      const err = new Error(`provider ${provider.name} returned ${res.status}`);
      err.retryable = res.status >= 500 || res.status === 429;
      throw err;
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw Object.assign(new Error('empty response'), { retryable: true });
    return { text, usage: data.usage };
  } catch (err) {
    if (err.name === 'AbortError') throw Object.assign(new Error(`provider ${provider.name} timed out`), { retryable: true });
    if (err.retryable === undefined) err.retryable = true; // network errors
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ctx: { workspaceId, userId, purpose }. Returns { text, provider, model }. Throws Ai*Error.
// Each provider gets one retry on transient errors; a failed provider falls through to the next.
export async function complete(ctx, { system, user }) {
  const providers = configuredProviders();
  if (providers.length === 0) throw new AiUnavailableError('No AI provider is configured on the server.');
  if (usageToday(ctx.workspaceId) >= dailyLimit()) throw new AiLimitError('The daily AI limit for this workspace has been reached.');
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const failures = [];
  for (const provider of providers) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const started = Date.now();
      try {
        const { text, usage } = await callOnce(provider, messages);
        record(ctx, provider, 'ok', usage, started);
        return { text, provider: provider.name, model: provider.model };
      } catch (err) {
        record(ctx, provider, 'error', null, started);
        failures.push(`${provider.name}: ${err.message}`);
        if (!err.retryable) break;
      }
    }
  }
  console.error('AI gateway: all providers failed:', failures.join('; '));
  throw new AiFailureError('The AI service is temporarily unavailable.');
}

// Models sometimes wrap JSON in fences; accept that, nothing else.
export function parseJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  return JSON.parse(body);
}
