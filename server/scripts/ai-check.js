// Live connectivity check for the configured AI providers. Run from your own machine:
//   npm run ai:check -w server
// Sends one tiny prompt to each provider that has a key in server/.env. No app data is sent.
import '../src/loadEnv.js';
import { configuredProviders } from '../src/ai/gateway.js';

const providers = configuredProviders();
if (providers.length === 0) {
  console.error('No provider keys found (DEEPSEEK_API_KEY, X_GROK_API_KEY) in server/.env');
  process.exit(1);
}
let failed = false;
for (const p of providers) {
  const started = Date.now();
  try {
    const res = await fetch(`${p.base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${p.key}` },
      body: JSON.stringify({ model: p.model, messages: [{ role: 'user', content: 'Reply with the JSON {"ok":true}' }], response_format: { type: 'json_object' } }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    console.log(`${p.name} (${p.model}): OK in ${Date.now() - started} ms`);
  } catch (err) {
    failed = true;
    console.error(`${p.name} (${p.model}): FAILED - ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
