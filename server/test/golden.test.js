// The golden set must stay valid: every expected name is a real skill or proposal type. (The live evaluation is eval/run.mjs.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startServer } from './helpers.js';

test('golden set: well formed, names exist, covers every group', async () => {
  const srv = await startServer();
  try {
    const { TOOLS } = await import('../src/ai/tools.js'); const { ACTION_TYPES } = await import('../src/ai/actions.js');
    const golden = JSON.parse(readFileSync(new URL('../eval/golden.json', import.meta.url), 'utf8'));
    assert.ok(golden.length >= 60, 'about 60 cases');
    const known = new Set([...Object.keys(TOOLS), ...ACTION_TYPES, 'none']);
    for (const g of golden) {
      assert.ok(g.text && g.group && Array.isArray(g.expect) && g.expect.length, JSON.stringify(g));
      for (const e of g.expect) assert.ok(known.has(e), `${g.text}: unknown name ${e}`);
    }
    assert.deepEqual([...new Set(golden.map((g) => g.group))].sort(), ['flows', 'meta', 'money', 'negative', 'setup', 'understand', 'web', 'work']);
    assert.equal(new Set(golden.map((g) => g.text)).size, golden.length, 'no duplicate utterances');
  } finally { srv.close(); }
});
