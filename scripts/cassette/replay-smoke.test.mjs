import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runReplay } from './replay-smoke.mjs';
import { validateCassette } from './format.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, 'fixtures', 'launch-brief.cassette.json');

function loadFixture() {
  const raw = readFileSync(fixturePath, 'utf8');
  return JSON.parse(raw);
}

test('fixture replays with 0 misses', async () => {
  const cassette = loadFixture();
  const result = await runReplay(cassette);
  assert.ok(result);
  assert.ok(Array.isArray(result.turns));
  assert.ok(result.turns.length > 0);
  // All entries replayed successfully with 0 misses (if any miss occurred, runReplay would throw)
});

test('tool calls parsed', async () => {
  const cassette = loadFixture();
  const result = await runReplay(cassette);
  assert.ok(Array.isArray(result.toolCalls));
  assert.ok(result.toolCalls.length > 0, 'Expected tool calls to be present');
  
  for (const call of result.toolCalls) {
    assert.ok(typeof call.name === 'string' && call.name.length > 0);
    assert.ok(typeof call.arguments === 'string');
    // Verify arguments parse as JSON
    const parsed = JSON.parse(call.arguments);
    assert.ok(typeof parsed === 'object');
  }
});

test('each assistant turn is valid JSON-shaped with finish_reason present', async () => {
  const cassette = loadFixture();
  const result = await runReplay(cassette);
  
  for (const turn of result.turns) {
    assert.ok(typeof turn.index === 'number');
    assert.ok(typeof turn.finish_reason === 'string');
    assert.ok(turn.finish_reason.length > 0);
    assert.ok(typeof turn.hasToolCalls === 'boolean');
    assert.ok(typeof turn.toolCallCount === 'number');
  }
});

test('corrupted fixture -> clear error', async () => {
  const cassette = loadFixture();
  const corrupted = JSON.parse(JSON.stringify(cassette));
  // Corrupt the response body to invalid JSON
  corrupted.entries[0].response.body = { choices: [{ message: { content: null, tool_calls: [] }, finish_reason: 'tool_calls' }] };
  // Make it so the JSON is invalid when stringified in a bad way - easier to just corrupt the structure
  corrupted.entries[0].response.body = 'not json at all';
  
  await assert.rejects(
    async () => {
      await runReplay(corrupted);
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.length > 0);
      return true;
    }
  );
});

test('corrupted fixture with missing finish_reason -> clear error', async () => {
  const cassette = loadFixture();
  const corrupted = JSON.parse(JSON.stringify(cassette));
  // Corrupt: remove finish_reason
  delete corrupted.entries[0].response.body.choices[0].finish_reason;
  
  await assert.rejects(
    async () => {
      await runReplay(corrupted);
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('finish_reason') || err.message.includes('Invalid'));
      return true;
    }
  );
});

test('corrupted fixture with unparseable tool arguments -> clear error', async () => {
  const cassette = loadFixture();
  const corrupted = JSON.parse(JSON.stringify(cassette));
  // Corrupt: tool arguments not valid JSON
  corrupted.entries[0].response.body.choices[0].message.tool_calls[0].function.arguments = '{invalid json}';
  
  await assert.rejects(
    async () => {
      await runReplay(corrupted);
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('JSON') || err.message.includes('arguments'));
      return true;
    }
  );
});
