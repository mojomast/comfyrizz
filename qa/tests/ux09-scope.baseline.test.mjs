// UX09: authoritative scope across agent tools (regressions; these began as the
// UX20 pre-fix baselines and were unwrapped when UX09 landed).
//
// Mounted: the real `/api/agent/chat` route over HTTP, a production-bound
// package, and a scripted model speaking the OpenAI-compatible SSE protocol on
// loopback. Assertions read the production journal and the stored package, never
// the model's reply.
//
// Audit findings now guarded (P1):
//   - a viewer `iterationScope` is validated but not passed into the production
//     tool context, so an in-scope edit is refused;
//   - an empty requested-id list means "nothing is allowed" rather than
//     "unspecified"; named scene ids such as `s_intro` are never recognised;
//   - ordinary project tools (`project_patch_plan`, `project_build`) mutate a
//     bound package while the production is paused and outside the scope.
// CONTROL tests prove the harness can see the guard working.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startQaApp } from '../lib/app-fixture.mjs';
import { draftPlanArgs, lineChip, namedScenePackage, proposal, seedConversation, sendChat } from '../lib/chat-fixture.mjs';

const CONVERSATION = 'chat_qa_scope_0001';

async function boundChat(t, sceneIds) {
  const pkg = namedScenePackage('pkg_qa_scope_0001', sceneIds);
  const qa = await startQaApp(t, { packages: [pkg], provider: { finalText: 'Done.' } });
  const productionId = qa.bindProduction(pkg.id, { shotIds: sceneIds, conversationId: CONVERSATION });
  seedConversation(qa, { conversationId: CONVERSATION, pkg });
  const proposals = () => qa.productionStore.readEvents(productionId).filter(event => event.type === 'plan.proposed');
  const tools = response => response.body?.conversation?.trace?.tools ?? [];
  return { qa, pkg, productionId, proposals, tools };
}

const readThen = (...calls) => [{ tool: 'production_read', args: {} }, ...calls.map(args => ({ tool: 'production_propose_plan', args }))];

test('CONTROL: a chip-scoped proposal for another shot is refused and the journal is unchanged', async t => {
  const { qa, productionId, proposals, tools } = await boundChat(t, ['s1', 's2']);
  qa.scripted.script(readThen({ expected_revision: 1, plan: proposal('s2', 's2:l1') }));
  const response = await sendChat(qa, { conversationId: CONVERSATION, message: 'Improve s1 line 2.', chips: lineChip('s1:l2') });
  assert.equal(tools(response).find(tool => tool.name === 'production_propose_plan')?.ok, false);
  assert.equal(proposals().length, 0);
  assert.equal(qa.productionStore.read(productionId).revision, 1);
});

test('CONTROL: a chip-scoped proposal for the requested line commits exactly once', async t => {
  const { qa, proposals, tools } = await boundChat(t, ['s1', 's2']);
  qa.scripted.script(readThen({ expected_revision: 1, plan: proposal('s1', 's1:l2') }));
  const response = await sendChat(qa, { conversationId: CONVERSATION, message: 'Improve s1 line 2.', chips: lineChip('s1:l2') });
  assert.equal(tools(response).find(tool => tool.name === 'production_propose_plan')?.ok, true);
  assert.equal(proposals().length, 1);
});

test('CONTROL: a production mutation before production_read is refused', async t => {
  const { qa, productionId, proposals, tools } = await boundChat(t, ['s1', 's2']);
  qa.scripted.script([{ tool: 'production_command', args: { kind: 'stage.advance', payload: { stage: 'script' }, expected_revision: 1 } }]);
  const response = await sendChat(qa, { conversationId: CONVERSATION, message: 'Go.' });
  assert.match(tools(response)[0].error, /production_read/);
  assert.equal(proposals().length, 0);
  assert.equal(qa.productionStore.read(productionId).revision, 1);
});

test('UX09: a viewer iterationScope accepts its own line and refuses scope expansion', async t => {
  const { qa, pkg, proposals, tools } = await boundChat(t, ['s_intro', 's_outro']);
  qa.scripted.script(readThen(
    { expected_revision: 1, plan: proposal('s_intro', 's_intro:l2') },
    { expected_revision: 1, plan: proposal('s_outro', 's_outro:l1') },
  ));
  const response = await sendChat(qa, {
    conversationId: CONVERSATION,
    message: 'Make the second intro line warmer.',
    scope: { target: { packageId: pkg.id, shotId: 's_intro' }, element: 'voice_line', elementRef: { lineId: 's_intro:l2' }, note: 'warmer' },
  });
  const [inScope, expansion] = tools(response).filter(tool => tool.name === 'production_propose_plan');
  assert.equal(inScope?.ok, true, `in-scope line refused: ${inScope?.error}`);
  assert.equal(expansion?.ok, false, 'scope expansion to s_outro must be refused');
  assert.deepEqual(proposals().map(event => event.data.edits.map(edit => edit.lineId)), [['s_intro:l2']]);
});

test('UX09: structured scene ids such as s_intro resolve against the real production', async t => {
  const { qa, proposals, tools } = await boundChat(t, ['s_intro', 's_outro']);
  qa.scripted.script(readThen({ expected_revision: 1, plan: proposal('s_intro', 's_intro:l2') }));
  const response = await sendChat(qa, { conversationId: CONVERSATION, message: 'Fix intro line 2.', chips: lineChip('s_intro:l2') });
  assert.equal(tools(response).find(tool => tool.name === 'production_propose_plan')?.ok, true, 'a legal named-scene edit was refused');
  assert.equal(proposals().length, 1);
});

test('UX09: ordinary project tools cannot mutate a paused bound production', async t => {
  const { qa, pkg, productionId } = await boundChat(t, ['s1', 's2']);
  qa.scripted.script([{ tool: 'project_update_plan', args: draftPlanArgs(['s1', 's2']) }], 'Drafted.');
  await sendChat(qa, { conversationId: CONVERSATION, message: 'Draft it.', mode: 'build' });
  qa.command(productionId, 'production.pause');
  const before = qa.readPackage(pkg.id);
  qa.scripted.script([
    { tool: 'project_patch_plan', args: { scenePatches: [{ id: 's2', changes: { headline: 'Unrelated rewrite' } }] } },
    { tool: 'project_build', args: {} },
  ]);
  await sendChat(qa, { conversationId: CONVERSATION, message: 'Improve s1 line 2.', chips: lineChip('s1:l2') });
  const after = qa.readPackage(pkg.id);
  assert.equal(after.revision, before.revision, 'package revision moved while the production was paused');
  assert.equal(after.scenes[1].copy.headline, before.scenes[1].copy.headline, 'an unrelated scene was rewritten');
});

test('UX09: an unrelated patch outside the requested scope does not change an active bound package', async t => {
  const { qa, pkg } = await boundChat(t, ['s1', 's2']);
  qa.scripted.script([{ tool: 'project_update_plan', args: draftPlanArgs(['s1', 's2']) }], 'Drafted.');
  await sendChat(qa, { conversationId: CONVERSATION, message: 'Draft it.', mode: 'build' });
  const before = qa.readPackage(pkg.id);
  qa.scripted.script([
    { tool: 'project_patch_plan', args: { scenePatches: [{ id: 's2', changes: { headline: 'Unrelated rewrite' } }] } },
    { tool: 'project_build', args: {} },
  ]);
  await sendChat(qa, { conversationId: CONVERSATION, message: 'Improve s1 line 2.', chips: lineChip('s1:l2') });
  assert.equal(qa.readPackage(pkg.id).scenes[1].copy.headline, before.scenes[1].copy.headline);
});

const targetsTurn = (qa, body) => qa.json('/api/agent/chat', {
  conversationId: CONVERSATION,
  baseRevision: 1,
  turnId: `qa-targets-${Math.random().toString(16).slice(2, 10)}`,
  message: 'Change something.',
  provider: 'custom',
  model: 'scripted',
  mode: 'plan',
  ...body,
});

test('UX09: an explicit empty targets list changes nothing and the refusal uses the shared code', async t => {
  const { qa, productionId, proposals, tools } = await boundChat(t, ['s_intro', 's_outro']);
  qa.scripted.script(readThen({ expected_revision: 1, plan: proposal('s_intro', 's_intro:l1') }));
  const response = await targetsTurn(qa, { targets: { shotIds: [], lineIds: [] } });
  assert.equal(response.status, 200);
  const refused = tools(response).find(tool => tool.name === 'production_propose_plan');
  assert.equal(refused?.ok, false);
  assert.equal(refused?.code, 'SCOPE_EMPTY');
  assert.equal(proposals().length, 0);
  assert.equal(qa.productionStore.read(productionId).revision, 1);
});

test('UX09: malformed targets are a 400 before any model call', async t => {
  const { qa } = await boundChat(t, ['s_intro', 's_outro']);
  const response = await targetsTurn(qa, { targets: { shotIds: ['s_intro:l1'] } });
  assert.equal(response.status, 400);
  assert.equal(response.body?.code, 'INVALID_TARGETS');
});

test('UX09: build before production_read and a paused build are refused with shared codes and move no revision', async t => {
  const { qa, pkg, productionId, tools } = await boundChat(t, ['s1', 's2']);
  qa.scripted.script([{ tool: 'project_update_plan', args: draftPlanArgs(['s1', 's2']) }], 'Drafted.');
  await sendChat(qa, { conversationId: CONVERSATION, message: 'Draft it.', mode: 'build' });
  const before = qa.readPackage(pkg.id);

  qa.scripted.script([{ tool: 'project_build', args: {} }]);
  const early = await sendChat(qa, { conversationId: CONVERSATION, message: 'Build it.' });
  assert.equal(tools(early).find(tool => tool.name === 'project_build')?.code, 'READ_REQUIRED');

  qa.command(productionId, 'production.pause');
  qa.scripted.script([{ tool: 'production_read', args: {} }, { tool: 'project_build', args: {} }]);
  const paused = await sendChat(qa, { conversationId: CONVERSATION, message: 'Build it.' });
  assert.equal(tools(paused).find(tool => tool.name === 'project_build')?.code, 'PRODUCTION_NOT_ACTIVE');
  assert.equal(qa.readPackage(pkg.id).revision, before.revision);
});
