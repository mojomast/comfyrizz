import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyCassette, requestKey } from './format.mjs';
import { diffCassettes, renderDiffMarkdown, toolCallSummary, textChanged } from './diff.mjs';

const entry = ({ messages, body }) => ({
  key: requestKey({ model: 'model-a', messages }),
  request: { model: 'model-a', messages },
  response: { status: 200, body },
});

const assistantBody = ({ content, toolCalls, args = '{}' }) => ({
  choices: [
    {
      finish_reason: toolCalls ? 'tool_calls' : 'stop',
      message: {
        role: 'assistant',
        content,
        ...(toolCalls !== undefined && {
          tool_calls: toolCalls.map((call, index) => ({
            id: `call_${index}`,
            type: 'function',
            function: { name: call.name, arguments: call.args ?? args },
          })),
        }),
      },
    },
  ],
});

const baseMessages = (text = 'Make a 20s product intro.') => [
  { role: 'system', content: 'You are a launch-video agent.' },
  { role: 'user', content: text },
];

test('identical cassettes produce no changes', () => {
  const messages = baseMessages();
  const a = emptyCassette({ model: 'model-a', provider: 'free' });
  const b = emptyCassette({ model: 'model-b', provider: 'paid' });
  a.entries.push(entry({ messages, body: assistantBody({ content: 'OK.' }) }));
  b.entries.push(entry({ messages, body: assistantBody({ content: 'OK.' }) }));
  const diff = diffCassettes(a, b);
  assert.deepEqual(diff.sameKeys, [requestKey({ messages })]);
  assert.equal(diff.onlyA.length, 0);
  assert.equal(diff.onlyB.length, 0);
  assert.equal(diff.changed.length, 0);
});

test('different tool call names are detected', () => {
  const messages = baseMessages();
  const a = emptyCassette();
  const b = emptyCassette();
  a.entries.push(entry({ messages, body: assistantBody({ content: null, toolCalls: [{ name: 'plan_storyboard' }] }) }));
  b.entries.push(entry({ messages, body: assistantBody({ content: null, toolCalls: [{ name: 'script_scene' }] }) }));
  const diff = diffCassettes(a, b);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].toolCallsA[0].name, 'plan_storyboard');
  assert.equal(diff.changed[0].toolCallsB[0].name, 'script_scene');
  assert.equal(diff.changed[0].toolCallsChanged, true);
  assert.equal(diff.changed[0].textChanged, false);
});

test('changed arg keys count as a tool call change', () => {
  const messages = baseMessages();
  const a = emptyCassette();
  const b = emptyCassette();
  a.entries.push(
    entry({ messages, body: assistantBody({ content: null, toolCalls: [{ name: 'plan_storyboard' }], args: '{"theme":"rocket"}' }) }),
  );
  b.entries.push(
    entry({ messages, body: assistantBody({ content: null, toolCalls: [{ name: 'plan_storyboard' }], args: '{"tone":"bold"}' }) }),
  );
  const diff = diffCassettes(a, b);
  assert.equal(diff.changed.length, 1);
  assert.deepEqual(diff.changed[0].toolCallsA[0].argKeys, ['theme']);
  assert.deepEqual(diff.changed[0].toolCallsB[0].argKeys, ['tone']);
});

test('same tool calls but changed assistant text is reported', () => {
  const messages = baseMessages();
  const a = emptyCassette();
  const b = emptyCassette();
  a.entries.push(entry({ messages, body: assistantBody({ content: 'Here you go.' }) }));
  b.entries.push(entry({ messages, body: assistantBody({ content: 'Here is the intro.' }) }));
  const diff = diffCassettes(a, b);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].textChanged, true);
  assert.equal(diff.changed[0].toolCallsChanged, false);
});

test('onlyA and onlyB list keys missing from the other cassette', () => {
  const a = emptyCassette();
  const b = emptyCassette();
  a.entries.push(entry({ messages: baseMessages('Create a launch brief.'), body: assistantBody({ content: 'Done.' }) }));
  b.entries.push(entry({ messages: baseMessages('Create a launch brief, tighter.'), body: assistantBody({ content: 'Done.' }) }),);
  const diff = diffCassettes(a, b);
  assert.equal(diff.sameKeys.length, 0);
  assert.equal(diff.onlyA.length, 1);
  assert.equal(diff.onlyB.length, 1);
  assert.equal(diff.changed.length, 2);
  assert.equal(diff.changed.every((item) => item.toolCallsA === null || item.toolCallsB === null), true);
});

test('keys are stable across model choice, so the same session compares', () => {
  const messages = baseMessages();
  const a = { schema: 'comfyrizz.cassette/v1', createdAt: 'x', model: 'model-a', provider: 'p1', entries: [] };
  const b = { schema: 'comfyrizz.cassette/v1', createdAt: 'y', model: 'model-b', provider: 'p2', entries: [] };
  a.entries.push({
    key: requestKey({ messages }),
    request: { model: 'model-a', messages },
    response: { status: 200, body: assistantBody({ content: 'same' }) },
  });
  b.entries.push({
    key: requestKey({ messages }),
    request: { model: 'model-b', messages },
    response: { status: 200, body: assistantBody({ content: 'same' }) },
  });
  assert.deepEqual(diffCassettes(a, b).changed, []);
});

test('toolCallSummary sorts calls and reports arg keys', () => {
  const summary = toolCallSummary({
    request: { model: 'm', messages: [] },
    response: {
      status: 200,
      body: assistantBody({
        content: null,
        toolCalls: [{ name: 'zeta_tool' }, { name: 'alpha_tool', args: '{"b":1,"a":2}' }],
      }),
    },
  });
  assert.deepEqual(
    summary.map((call) => [call.name, call.argKeys]),
    [
      ['alpha_tool', ['a', 'b']],
      ['zeta_tool', []],
    ],
  );
});

test('textChanged is false for equal content and true otherwise', () => {
  const base = { request: { model: 'm', messages: baseMessages() }, response: { status: 200, body: null } };
  assert.equal(
    textChanged({ ...base, response: { status: 200, body: assistantBody({ content: ' hi ' }) } }, { ...base, response: { status: 200, body: assistantBody({ content: 'hi' }) } }),
    false,
  );
  assert.equal(
    textChanged({ ...base, response: { status: 200, body: assistantBody({ content: 'hi' }) } }, { ...base, response: { status: 200, body: assistantBody({ content: 'hi!' }) } }),
    true,
  );
});

test('markdown has one row per changed key and a summary header', () => {
  const a = emptyCassette({ model: 'deepseek-v4.1-flash', provider: 'flash' });
  const b = emptyCassette({ model: 'free-pool', provider: 'free' });
  a.entries.push(
    entry({ messages: baseMessages(), body: assistantBody({ content: null, toolCalls: [{ name: 'plan_storyboard' }] }) }),
    entry({ messages: baseMessages('Now script scene one.'), body: assistantBody({ content: 'All set.' }) }),
  );
  b.entries.push(
    entry({ messages: baseMessages(), body: assistantBody({ content: null, toolCalls: [{ name: 'script_scene', args: '{"scene":1}' }] }) }),
    entry({ messages: baseMessages('Now script scene one.'), body: assistantBody({ content: 'Ready.' }) }),
  );
  const diff = diffCassettes(a, b);
  assert.equal(diff.changed.length, 2);
  const markdown = renderDiffMarkdown(diff, { labelA: 'deepseek-v4.1-flash', labelB: 'free-pool' });
  const rows = markdown.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| turn') && line !== '| --- | --- | --- |');
  assert.equal(rows.length, 2);
  assert.match(markdown, /model A vs model B|deepseek-v4\.1-flash vs free-pool/i);
  assert.match(rows[1], /deepseek-v4\.1-flash: plan_storyboard\(\)/);
  assert.match(rows[1], /free-pool: script_scene\(scene\)/);
  assert.match(markdown, /text changed/);
});

test('markdown previews are capped and redaction-safe', () => {
  const long = 'brief '.repeat(40);
  const a = emptyCassette();
  const b = emptyCassette();
  a.entries.push(entry({ messages: baseMessages(long), body: assistantBody({ content: 'x' }) }));
  b.entries.push(entry({ messages: baseMessages(long), body: assistantBody({ content: 'y' }) }));
  const markdown = renderDiffMarkdown(diffCassettes(a, b));
  const rows = markdown.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| turn'));
  const previewCell = rows[0].split('|')[1].trim();
  assert.ok(previewCell.length <= 80 + 1, `preview too long: ${previewCell.length}`);
  assert.equal(previewCell.includes('\n'), false);
  assert.equal(markdown.includes('sk-'), false);
});
