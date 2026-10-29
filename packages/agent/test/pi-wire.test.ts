import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { runAgent } from '../src/agent.js';
import { createOpenAICompatibleModel } from '@comfyrizz/llm';

for (const thinking of ['enabled', 'disabled'] as const) {
  test(`Pi real wire adapter preserves ${thinking} thinking, schemas, cache usage and repaired multi-turn results`, async () => {
    const requests: any[] = [], operations: string[] = [];
    const definition = { name: 'asset.edit', description: 'Retain source ID and exact duration.', parameters: { type: 'object', required: ['frames', 'source'], properties: { frames: { type: 'integer', minimum: 1 }, source: { type: 'string' } }, additionalProperties: false } };
    const model = createOpenAICompatibleModel({ name: 'custom', baseUrl: 'https://provider.invalid/v1', modelsUrl: 'https://provider.invalid/v1/models', apiKey: 'dummy-test-only', model: 'configured-model', status: 'baseline', headers: { 'x-custom-header': 'kept' }, sessionHeader: 'x-session-id', thinking, reasoningEffort: 'high', maxTokens: 2048, maxRetries: 0,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)); requests.push(body);
        assert.equal((init?.headers as Record<string, string>)['x-session-id'], 'stable-test-session');
        assert.equal((init?.headers as Record<string, string>)['x-custom-header'], 'kept');
        const turn = requests.length;
        const chunks = turn < 3 ? [
          { choices: [{ delta: { reasoning_content: `continuation-${turn}` } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${turn}`, function: { name: 'asset_edit', arguments: '{"source":"original-source",' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: `"frames":${turn === 1 ? '0' : '150'}}` } }] }, finish_reason: 'tool_calls' }] },
        ] : [{ choices: [{ delta: { content: 'Done' }, finish_reason: 'stop' }] }];
        chunks.push({ usage: { prompt_tokens: 20, completion_tokens: 4, prompt_cache_hit_tokens: 9, completion_tokens_details: { reasoning_tokens: 2 } }, choices: [] } as any);
        return new Response(chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const result = await runAgent({ model, brief: 'Edit from the original source', sessionId: 'stable-test-session', tools: { [definition.name]: { definition, schema: z.object({ frames: z.number().int().min(1), source: z.string() }).strict(), run: (args, context) => { operations.push(context!.operationId!); return { sourceId: args.source, frames: args.frames, revision: 2 }; } } } });
    assert.equal(result.ok, true);
    assert.deepEqual(operations, ['call-2']);
    assert.deepEqual(result.usage, { input: 60, output: 12, cacheRead: 27, reasoningTokens: 6 });
    for (const request of requests) {
      assert.deepEqual(request.thinking, { type: thinking });
      assert.equal(request.reasoning_effort, 'high'); assert.equal(request.max_tokens, 2048);
      assert.deepEqual(request.tools[0].function.parameters, definition.parameters);
      assert.equal(request.tools[0].function.description, definition.description);
    }
    assert.equal(requests[1].messages.find((m: any) => m.role === 'assistant').reasoning_content, 'continuation-1');
    assert.match(requests[1].messages.find((m: any) => m.role === 'tool').content, /invalid_arguments/);
    assert.match(requests[2].messages.filter((m: any) => m.role === 'tool').at(-1).content, /original-source/);
    assert.equal(result.text, 'Done');
  });
}

test('unknown tools receive normalized errors and cannot execute a service', async () => {
  let turn = 0;
  const result = await runAgent({ brief: 'go', tools: {}, model: { id: 'test', async *stream(request) {
    if (++turn === 1) yield { type: 'tool_call', id: 'unknown', name: 'not.declared', args: {} };
    else { assert.match(request.messages.find(m => m.role === 'tool')?.content ?? '', /unknown_tool/); yield { type: 'text', delta: 'Cannot use that tool.' }; }
  } } });
  assert.equal(result.toolCalls[0].ok, false); assert.equal(result.ok, true);
});

test('raw non-object arguments reach application repairs and Zod defaults/refinements remain authoritative', async () => {
  let turn = 0;
  const executed: unknown[] = [];
  const result = await runAgent({ brief: 'go', tools: {
    edit: { definition: { name: 'edit', description: 'Validated mutation', parameters: { type: 'object', properties: { frames: { type: 'number' } } } },
      schema: z.object({ frames: z.number().default(150) }).refine(args => args.frames % 30 === 0, 'whole seconds required'),
      run: args => { executed.push(args); return { ok: true }; } },
  }, model: { id: 'raw-arguments', async *stream(request) {
    if (++turn === 1) yield { type: 'tool_call', id: 'invalid', name: 'edit', args: null };
    else if (turn === 2) {
      assert.match(request.messages.find(m => m.role === 'tool')?.content ?? '', /invalid_arguments/);
      yield { type: 'tool_call', id: 'corrected', name: 'edit', args: {} };
    } else yield { type: 'text', delta: 'Done' };
  } } });
  assert.equal(result.ok, true); assert.deepEqual(executed, [{ frames: 150 }]);
  assert.equal(result.toolCalls[0].error, 'invalid_arguments');
});
