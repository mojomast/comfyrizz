import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createOpenAICompatibleModel } from '../../../packages/llm/dist/src/index.js';
import { createToolset, runAgent, runCpuSlice } from '../../../packages/agent/dist/src/index.js';
import { createAgentProgress } from '../src/agent-progress.mjs';

const text = readFileSync(new URL('./fixtures/data-story-190.csv', import.meta.url), 'utf8');
const id = 'ctx_0123456789abcdef';
const hash = createHash('sha256').update(text).digest('hex');
const csvAttachments = [{ id, label: 'starts.csv', contentHash: hash, text }];
const filters = [{ column: 'classification', op: 'eq', values: ['DNF'] }];
const brief = 'Make a data story about retirements in the supplied starts.csv. Do not infer causes.';

async function provider(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', part => raw += part);
    req.on('end', () => {
      const body = JSON.parse(raw); requests.push(body);
      const call = handler(body, requests.length);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = call ? { tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: call.name.replaceAll('.', '_'), arguments: JSON.stringify(call.args) } }] } : { content: 'Draft ready.' };
      res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const model = createOpenAICompatibleModel({ name: 'custom', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'loopback', apiKey: 'test', status: 'baseline', maxRetries: 0 });
  return { model, requests, close: () => new Promise(resolve => server.close(resolve)) };
}

test('repeating source exploration is staged into a scoped, source-bound proposal', async t => {
  const p = await provider((body, turn) => {
    const names = body.tools.map(tool => tool.function.name);
    if (turn <= 2) return { name: 'context.query_csv', args: { id, filters, group_by: 'classification' } };
    if (turn === 3) {
      assert.deepEqual(names, ['storyboard_propose']);
      const results = body.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
      assert.equal(results[0].sha256, hash);
      assert.deepEqual(results[0].filters, filters);
      assert.equal(results[0].count, results[0].groups[0].count);
      return { name: 'storyboard.propose', args: { brief, title: 'Retirements', proposal: { logline: 'Explore recorded retirements in the supplied starts.', look: 'Simple tiles.', soundtrack: 'Quiet pulse.' }, scenes: [{ id: 's1', layout: 'hero', preferredFrames: 90, copy: { headline: 'Recorded retirements' } }] } };
    }
    assert.ok(names.includes('context_query_csv'));
    if (turn === 4) return { name: 'context.query_csv', args: { id, filters, group_by: 'retirement_reason' } };
    if (turn === 5) return { name: 'storyboard.csv_tile_wall', args: { scene_id: 's1', id, filters, category_column: 'classification', colors: [{ value: 'DNF', color: '#ff0000' }], require_categories: ['DNF'], default_color: '#ffffff', background: '#000000', columns: 10 } };
    return null;
  });
  t.after(p.close);
  const result = await runCpuSlice({ model: p.model, brief, csvAttachments, maxSteps: 16 });
  assert.equal(result.result.stopped, 'final');
  assert.equal(p.requests.length, 6);
  const queries = result.result.toolCalls.filter(call => call.name === 'context.query_csv');
  assert.equal(queries.length, 3);
  const count = queries[0].result.count;
  assert.ok(count > 0 && count < 190);
  assert.equal(result.package.scenes[0].drawing.elements.length, count);
  assert.equal(result.package.scenes[0].drawing.source.sha256, hash);
  assert.doesNotMatch(JSON.stringify(result.package.proposal), /\b(?:190|189|win|caused)\b/i);
});

test('a non-cooperating provider hits the original step budget with explicit progress and error', async t => {
  const p = await provider(() => ({ name: 'context.query_csv', args: { id, filters } }));
  t.after(p.close);
  const progress = createAgentProgress('budget');
  await assert.rejects(runCpuSlice({ model: p.model, brief, csvAttachments, maxSteps: 4, onEvent: event => progress.update(event) }), /max_steps: agent step limit \(4\) reached/);
  assert.equal(p.requests.length, 4);
  const snapshot = progress.snapshot();
  assert.equal(snapshot.maxSteps, 4);
  assert.match(snapshot.message, /step limit \(4\)/);
  assert.equal(snapshot.recentEvents.at(-1).code, 'max_steps');
});

test('batched exploration is capped and rejects out-of-conversation source ids', async () => {
  const requests = [];
  const model = { id: 'batch', async *stream(request) {
    requests.push(request);
    if (requests.length === 1) {
      for (let i = 0; i < 10; i++) yield { type: 'tool_call', id: `q${i}`, name: 'context.query_csv', args: { id: i === 0 ? 'ctx_0000000000000000' : id, filters } };
    } else if (requests.length === 2) {
      assert.deepEqual(request.tools.map(tool => tool.name), ['storyboard.propose']);
      yield { type: 'tool_call', id: 'draft', name: 'storyboard.propose', args: { brief, scenes: [{ id: 's1', layout: 'hero', preferredFrames: 90 }] } };
    } else yield { type: 'text', delta: 'Done.' };
  } };
  const result = await runAgent({ model, brief, tools: createToolset({ csvAttachments }), maxSteps: 5 });
  assert.equal(result.stopped, 'final');
  const queries = result.toolCalls.filter(call => call.name === 'context.query_csv');
  assert.match(queries[0].error, /not found in this conversation/);
  assert.equal(queries.filter(call => call.ok).length, 7);
  assert.equal(queries.filter(call => call.error === 'draft_required').length, 2);
  assert.ok(result.toolCalls.some(call => call.name === 'storyboard.propose' && call.ok));
});
