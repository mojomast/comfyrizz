import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createApp } from '../src/app.mjs';
import { createCpuAgentRunner } from '../src/agent-runner.mjs';
import { applyProposalRevision, reviseProposal } from '../src/proposal-revision.mjs';
import { createContextAttachmentStore } from '../src/context-attachments.mjs';
import { replayProvider } from './fake-provider.mjs';

const token = 'proposal-revision-test';
const chat = 'chat_proposal_test01';
function fixture() {
  const pkg = JSON.parse(readFileSync(new URL('../../../packages/schema/fixtures/valid/minimal.json', import.meta.url)));
  pkg.id = 'pkg_proposal_fixture'; pkg.revision = 42;
  pkg.scenes = [
    { ...structuredClone(pkg.scenes[0]), id: 's1', narration: '190 starts without a win.', copy: { headline: '190 starts' }, transitionOut: { type: 'cut', frames: 0 } },
    { ...structuredClone(pkg.scenes[0]), id: 's2', narration: 'Then came a win.', copy: { headline: 'Victory' }, transitionOut: { type: 'cut', frames: 0 } },
  ];
  pkg.datasets = { d_starts: { unit: 'starts', source: 'derived', note: 'starts.csv — row count', values: [{ label: 'Starts', value: 190 }] } };
  return pkg;
}
const edits = { edits: [{ id: 's1', narration: '189 starts without a win.', copy: { headline: '189 starts' } }, { id: 's2', narration: 'The 190th start brought a win.' }] };

test('layout overflow identifies scene and limit, gives the model bounded feedback, and never mutates the base', async () => {
  const pkg = fixture();
  pkg.scenes[0].layout = 'title'; pkg.scenes[1].layout = 'hero'; pkg.scenes[1].variant = 'full-bleed';
  const before = structuredClone(pkg);
  const bad = { edits: [{ id: 's1', copy: { headline: 'a'.repeat(49) } }, { id: 's2', copy: { headline: 'b'.repeat(65) } }] };
  const requests = [];
  const model = { async *stream(request) { requests.push(structuredClone(request)); yield { type: 'tool_call', name: 'proposal_revision', args: bad }; } };
  await assert.rejects(() => reviseProposal({ pkg, note: 'Correct both headlines', model }), error => {
    assert.match(error.message, /Scene s1 .*layout title allows 48 characters.*got 49/);
    assert.match(error.message, /Scene s2 .*layout hero allows 64 characters.*got 65/);
    return true;
  });
  assert.equal(requests.length, 2);
  assert.match(requests[0].messages[0].content, /"title":\{"headline":48/);
  assert.match(requests[1].messages.at(-1).content, /Scene s1 .*allows 48/);
  assert.deepEqual(pkg, before);
  let attempt = 0;
  const repaired = await reviseProposal({ pkg, note: 'Correct both headlines', model: { async *stream() {
    yield { type: 'tool_call', name: 'proposal_revision', args: ++attempt === 1 ? bad : { edits: [{ id: 's1', copy: { headline: 'Short title' } }, { id: 's2', copy: { headline: 'Short hero' } }] } };
  } } });
  assert.equal(attempt, 2);
  assert.equal(repaired.package.scenes[0].copy.headline, 'Short title');
  assert.deepEqual(pkg, before);
});

test('focused proposal patches preserve unrelated fields, source data, assets and ordering', () => {
  const pkg = fixture();
  const result = applyProposalRevision(pkg, edits);
  assert.equal(result.scenes[0].narration, '189 starts without a win.');
  assert.equal(result.scenes[1].narration, 'The 190th start brought a win.');
  const expected = structuredClone(pkg);
  expected.scenes[0].narration = edits.edits[0].narration;
  expected.scenes[0].copy.headline = '189 starts';
  expected.scenes[1].narration = edits.edits[1].narration;
  assert.deepEqual(result, expected);
  assert.deepEqual(applyProposalRevision(pkg, { edits: [], sceneOrder: ['s2', 's1'] }).scenes, [pkg.scenes[1], pkg.scenes[0]]);
  for (const bad of [
    { edits: [{ id: 's1', datasets: {} }] },
    { edits: [{ id: 's1', copy: { headline: 'ok', layout: 'stat' } }] },
    { edits: [{ id: 's1', narration: 'x' }, { id: 's1', narration: 'y' }] },
    { edits: [], sceneOrder: ['s1', 's1'] },
    { edits: [], assets: {} },
  ]) assert.throws(() => applyProposalRevision(pkg, bad), error => error.code === 'PROPOSAL_REVISION_INVALID');
  assert.equal(pkg.scenes[0].narration, '190 starts without a win.');
});

test('focused revision refuses unsupported model responses and requests original source review', async () => {
  const requests = [];
  const model = { async *stream(request) { requests.push(request); yield { type: 'text', delta: 'The full editor is required for the tile wall.' }; } };
  await assert.rejects(() => reviseProposal({ pkg: fixture(), brief: 'Data story', note: 'Change the wall', source: 'starts.csv: 190 rows', model }), /full editor/);
  assert.match(requests[0].system, /do not infer margins, causes/i);
  assert.match(requests[0].messages[1].content, /starts.csv/);
});

test('a mixed malformed-argument and stream error is never retried or applied', async () => {
  const pkg = fixture(); const before = structuredClone(pkg); let count = 0;
  const model = { async *stream() {
    count++;
    yield { type: 'tool_call', name: 'proposal_revision', args: edits };
    yield { type: 'error', code: 'invalid_tool_arguments', message: 'invalid JSON' };
    yield { type: 'error', code: 'incomplete_stream', message: 'stream truncated' };
  } };
  await assert.rejects(() => reviseProposal({ pkg, note: 'Correct counts', model }), error => error.code === 'incomplete_stream');
  assert.equal(count, 1);
  assert.deepEqual(pkg, before);
});

test('logline and user-supplied dataset note corrections preserve numerical data and provenance', () => {
  const pkg = fixture();
  pkg.proposal = { logline: 'Nineteen seasons and three podiums.', look: 'Dark', soundtrack: 'None' };
  pkg.datasets.d_starts.note = 'starts.csv — Counts verified with context.query_csv: 24 DNF.';
  const note = 'Replace the count sentence with "Counts: 18 DNF." and correct the logline.';
  const patch = { edits: [{ id: 's1', copy: { headline: '189 starts' } }], logline: 'Ten seasons and nine podiums.', datasetNotes: [{ id: 'd_starts', find: 'Counts verified with context.query_csv: 24 DNF.', replace: 'Counts: 18 DNF.' }] };
  const revised = applyProposalRevision(pkg, patch, note);
  assert.equal(revised.proposal.logline, patch.logline);
  assert.equal(revised.datasets.d_starts.note, 'starts.csv — Counts: 18 DNF.');
  const expected = structuredClone(pkg);
  expected.proposal.logline = patch.logline;
  expected.datasets.d_starts.note = 'starts.csv — Counts: 18 DNF.';
  expected.scenes[0].copy.headline = '189 starts';
  assert.deepEqual(revised, expected);
  for (const bad of [
    { ...patch, datasetNotes: [{ id: 'd_starts', find: '24 DNF', replace: '18 DNF' }] }, // leaves verification claim
    { ...patch, datasetNotes: [{ id: 'd_starts', find: pkg.datasets.d_starts.note, replace: 'Counts: 19 DNF.' }] }, // not supplied by user
    { ...patch, datasetNotes: [{ id: 'd_starts', find: pkg.datasets.d_starts.note, replace: 'verified by source.csv' }] },
    { ...patch, datasetNotes: [{ id: 'missing', find: 'x', replace: '' }] },
    { ...patch, datasetNotes: [{ id: 'd_starts', find: 'DNF', replace: '', source: 'user' }] },
    { ...patch, logline: 'x'.repeat(241) },
  ]) assert.throws(() => applyProposalRevision(pkg, bad, note), error => error.code === 'PROPOSAL_REVISION_INVALID');
});

test('deterministic provider revises logline and source note through the normal endpoint', async t => {
  const root = mkdtempSync(join(tmpdir(), 'proposal-notes-'));
  const pkg = fixture();
  pkg.proposal = { logline: 'Nineteen seasons and three podiums.', look: 'Dark', soundtrack: 'None' };
  pkg.datasets.d_starts.note = 'starts.csv — 24 DNF.';
  const patch = { edits: [], logline: 'Ten seasons and nine podiums.', datasetNotes: [{ id: 'd_starts', find: '24 DNF', replace: '18 DNF' }] };
  const provider = await replayProvider([{ name: 'proposal_revision', args: patch }]);
  const runner = createCpuAgentRunner({ runtimeDir: root, providers: { custom: { baseUrl: provider.url } } });
  const app = createApp({ root: new URL('../../..', import.meta.url).pathname, runtimeDir: root, token, agentRunner: args => args.proposalRevision ? runner(args) : Promise.resolve({ package: structuredClone(pkg), live: true }) });
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.close(); await new Promise(resolve => server.close(resolve)); await provider.close(); rmSync(root, { recursive: true, force: true }); });
  const port = server.address().port;
  const post = async body => { const response = await fetch(`http://127.0.0.1:${port}/api/agent`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, 'x-comfyrizz-token': token }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  assert.equal((await post({ brief: 'Data story', conversationId: chat })).status, 200);
  const note = 'Correct logline and replace 24 DNF with 18 DNF.';
  const result = await post({ brief: note, conversationId: chat, provider: 'custom', proposalRevision: { packageId: pkg.id, baseRevision: 42, note } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const expected = applyProposalRevision(pkg, patch, note); expected.revision = 43;
  assert.deepEqual(result.body.package, expected);
  assert.equal(provider.calls, 1);
});

test('normal agent endpoint pins proposal revisions, reuses original source and rejects stale approval', async t => {
  const root = mkdtempSync(join(tmpdir(), 'proposal-revision-'));
  const pkg = fixture();
  const docs = createContextAttachmentStore({ rootDir: root, chatId: chat });
  docs.addFile({ bytes: Buffer.from('189 starts before the first win, on the 190th start.'), filename: 'source.txt', mime: 'text/plain' });
  const provider = await replayProvider([{ name: 'proposal_revision', args: edits }]);
  const runner = createCpuAgentRunner({ runtimeDir: root, providers: { custom: { baseUrl: provider.url } } });
  const app = createApp({ root: new URL('../../..', import.meta.url).pathname, runtimeDir: root, token,
    agentRunner: args => args.proposalRevision ? runner(args) : Promise.resolve({ package: structuredClone(pkg), live: true }) });
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.close(); await new Promise(resolve => server.close(resolve)); await provider.close(); rmSync(root, { recursive: true, force: true }); });
  const port = server.address().port;
  const post = async (path, body) => { const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, 'x-comfyrizz-token': token }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  const initial = await post('/api/agent', { brief: 'Tell the data story', conversationId: chat });
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  docs.addFile({ bytes: Buffer.from('Later source'), filename: 'later.txt', mime: 'text/plain' });
  const request = { brief: 'Correct the counts', conversationId: chat, provider: 'custom', proposalRevision: { packageId: pkg.id, baseRevision: 42, note: 'Correct 189 pre-win starts and the 190th start win.' } };
  const wrongSource = await post('/api/agent', { ...request, conversationId: 'chat_other_test01' });
  assert.equal(wrongSource.status, 409);
  assert.equal(provider.calls, 0);
  const revised = await post('/api/agent', request);
  assert.equal(revised.status, 200, JSON.stringify(revised.body));
  const expected = applyProposalRevision(pkg, edits); expected.revision = 43;
  assert.deepEqual(revised.body.package, expected);
  assert.equal(provider.calls, 1);
  const content = provider.requests[0].messages.map(message => message.content).join('\n');
  assert.match(content, /189 starts before/);
  assert.doesNotMatch(content, /Later source/);
  assert.equal((await post('/api/agent', request)).status, 409);
  assert.equal(provider.calls, 1);
  const current = app.store.read(pkg.id); current.title = 'Concurrent change'; app.store.save(pkg.id, current, 43);
  const create = await post('/api/productions', { commandId: 'cmd_review_stale', idempotencyKey: 'cmd_review_stale', kind: 'production.create', expected: { productionRevision: 0, packageRevision: 43 }, payload: { conversationId: chat, packageId: pkg.id } });
  assert.equal(create.status, 409);
});

test('a concurrent save while proposal revision runs is never overwritten', async t => {
  const root = mkdtempSync(join(tmpdir(), 'proposal-cas-'));
  const pkg = fixture();
  let app;
  app = createApp({ root: new URL('../../..', import.meta.url).pathname, runtimeDir: root, token,
    agentRunner: async args => {
      if (!args.proposalRevision) return { package: structuredClone(pkg) };
      const other = structuredClone(pkg); other.title = 'Concurrent edit';
      app.store.save(pkg.id, other, 42);
      return { edits };
    } });
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.close(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  const port = server.address().port;
  const post = async body => { const response = await fetch(`http://127.0.0.1:${port}/api/agent`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, 'x-comfyrizz-token': token }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  assert.equal((await post({ brief: 'Data story' })).status, 200);
  const result = await post({ brief: 'Correct the counts', proposalRevision: { packageId: pkg.id, baseRevision: 42, note: 'Correct the counts.' } });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'REVISION_CONFLICT');
  assert.equal(app.store.read(pkg.id).title, 'Concurrent edit');
  assert.equal(app.store.read(pkg.id).scenes[0].narration, '190 starts without a win.');
});

test('loopback revision repairs completed malformed JSON once, without applying partial calls or losing the pinned source', async t => {
  const root = mkdtempSync(join(tmpdir(), 'proposal-json-'));
  const pkg = fixture();
  const docs = createContextAttachmentStore({ rootDir: root, chatId: chat });
  docs.addFile({ bytes: Buffer.from('Original pinned evidence.'), filename: 'source.txt', mime: 'text/plain' });
  let script = []; const requests = [];
  const provider = createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push(JSON.parse(body));
      const turn = script.shift();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
      send({ choices: [{ delta: { tool_calls: turn.calls.map((args, index) => ({ index, id: `call_${index}`, type: 'function', function: { name: 'proposal_revision', arguments: args } })) }, finish_reason: null }] });
      if (turn.finish) send({ choices: [{ delta: {}, finish_reason: turn.finish }] });
      send({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      res.end('data: [DONE]\n\n');
      turn.after?.();
    });
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const runner = createCpuAgentRunner({ runtimeDir: root, providers: { custom: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1` } } });
  const app = createApp({ root: new URL('../../..', import.meta.url).pathname, runtimeDir: root, token, agentRunner: args => args.proposalRevision ? runner(args) : Promise.resolve({ package: structuredClone(pkg), live: true }) });
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.close(); await new Promise(resolve => server.close(resolve)); await new Promise(resolve => provider.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  const port = server.address().port;
  const post = async body => { const response = await fetch(`http://127.0.0.1:${port}/api/agent`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, 'x-comfyrizz-token': token }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  assert.equal((await post({ brief: 'Data story', conversationId: chat })).status, 200);
  docs.addFile({ bytes: Buffer.from('Later evidence.'), filename: 'later.txt', mime: 'text/plain' });
  const request = revision => ({ brief: 'Correct the counts', conversationId: chat, provider: 'custom', proposalRevision: { packageId: pkg.id, baseRevision: revision, note: 'Correct the counts.' } });
  const malformed = { calls: [JSON.stringify({ edits: [{ id: 's1', narration: 'Must not apply' }] }), '{"edits":'], finish: 'tool_calls' };
  const valid = { calls: [JSON.stringify(edits)], finish: 'tool_calls' };
  script = [malformed, valid];
  const result = await post(request(42));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const expected = applyProposalRevision(pkg, edits); expected.revision = 43;
  assert.deepEqual(result.body.package, expected);
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1].messages), /invalid JSON tool arguments/);
  assert.match(JSON.stringify(requests[1].messages), /No calls from that response were applied/);
  assert.match(JSON.stringify(requests[1].messages), /Original pinned evidence/);
  assert.doesNotMatch(JSON.stringify(requests[1].messages), /Later evidence|Must not apply/);
  assert.equal((await post(request(42))).status, 409);
  assert.equal(requests.length, 2);

  script = [malformed, malformed, valid];
  const repeated = await post(request(43));
  assert.equal(repeated.status, 502, JSON.stringify(repeated.body));
  assert.equal(requests.length, 4);
  assert.deepEqual(app.store.read(pkg.id), expected);

  for (const finish of [undefined, 'length']) {
    script = [{ calls: ['{"edits":'], finish }, valid];
    const before = requests.length;
    const response = await post(request(43));
    assert.equal(response.status, 502, JSON.stringify(response.body));
    assert.equal(requests.length, before + 1);
    assert.deepEqual(app.store.read(pkg.id), expected);
  }

  script = [malformed, { calls: [JSON.stringify({ edits: [{ id: 's1', narration: 'A further correction.' }] })], finish: 'tool_calls', after() { const concurrent = app.store.read(pkg.id); concurrent.title = 'Concurrent edit'; app.store.save(pkg.id, concurrent, 43); } }];
  const conflict = await post(request(43));
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.equal(app.store.read(pkg.id).title, 'Concurrent edit');
  assert.equal(app.store.read(pkg.id).scenes[0].narration, expected.scenes[0].narration);
});
