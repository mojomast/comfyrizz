import assert from 'node:assert/strict';
import test from 'node:test';
import { runConversationTurn } from '../src/conversation.js';
import type { ProductionToolContext } from '../src/production-tools.js';
import type { ChatChunk, ChatModel } from '../src/types.js';

const saved = {
  id: 'pkg_drawing', revision: 7, title: 'Saved drawing',
  scenes: [{ id: 's1', drawing: { labels: ['Original'] } }, { id: 's2' }],
};
const element = { type: 'text', x: 100, y: 100, text: 'Changed', color: '#ffffff', size: 30, start: 0, end: 1 };
const call = (name: string, args: unknown = {}): ChatChunk => ({ type: 'tool_call', id: name, name, args });
const edit = (scene = 's1') => call('project_edit_drawing', { scene_id: scene, replacements: [{ index: 0, element }] });
const read = () => call('production_read');
const build = () => call('project_build');

function bound(state: Record<string, unknown> = {}) {
  let revision = 5;
  const ctx: ProductionToolContext = {
    productionId: 'prod_drawing', userEventId: 'ue_drawing', turnId: 'turn_drawing',
    read: () => ({ production: { id: 'prod_drawing', revision, intent: state.intent ?? 'active', shotIds: ['s1', 's2'] }, revision, lastSequence: revision }),
    command: () => ({ ok: true }),
    capabilities: { read: true, commands: true },
    productionState: { intent: 'active', shots: [{ id: 's1', lines: ['s1:l1'] }, { id: 's2' }], ...state },
    // An incompatible draft baseline must not turn a local saved edit into a
    // structural/global draft rewrite, or be overwritten by the drawing guard.
    builtPlan: { title: 'Older draft', scenes: [] },
  };
  return { ctx, move: () => { revision++; } };
}

async function run(steps: ChatChunk[][], options: { production?: ProductionToolContext; pending?: boolean; editError?: Error; buildError?: Error; beforeStep?: (index: number) => void } = {}) {
  let index = 0;
  const model: ChatModel = { id: 'saved-drawing-test', async *stream() {
    options.beforeStep?.(index);
    yield* steps[index++] ?? [];
  } };
  const edits: unknown[] = [];
  let builds = 0;
  const result = await runConversationTurn({
    model, plan: null, projectContext: saved, production: options.production,
    messages: [{ role: 'user', content: 'Change the drawing label and save.' }],
    sessionId: 'saved-drawing-test', signal: AbortSignal.timeout(5000),
    drawing: {
      read: () => ({ drawing: saved.scenes[0].drawing }),
      edit: (sceneId, replacements) => {
        if (options.editError) throw options.editError;
        edits.push({ sceneId, replacements });
        return { ok: true, staged: true };
      },
    },
    packageEditor: {
      tool: { name: 'project_edit_package', description: 'Edit saved fields', parameters: { type: 'object' } },
      pending: options.pending ?? false, stage: async () => ({ staged: true }),
      build: async () => {
        if (options.buildError) throw options.buildError;
        builds++;
        return { packageId: saved.id, revision: saved.revision + 1 };
      },
    },
    build: async () => { throw new Error('Saved drawings must not recompile a draft'); },
  });
  return { result, edits, builds };
}

test('a saved drawing without a draft uses the saved-package build and an honest fallback summary', async () => {
  const { result, edits, builds } = await run([[edit(), build()]]);
  assert.equal(result.built, true);
  assert.equal(result.plan, null);
  assert.equal(builds, 1);
  assert.deepEqual(edits, [{ sceneId: 's1', replacements: [{ index: 0, element }] }]);
  assert.equal(result.reply, 'The drawing edits were saved to the existing project.');
  assert.ok(result.trace.tools.every(tool => tool.ok));
});

test('a saved drawing build retains production read memory and allows only the targeted shot', async () => {
  const { ctx } = bound({ targets: { shotIds: ['s1'] } });
  const baseline = ctx.builtPlan;
  const { result, builds } = await run([[read(), edit(), build()]], { production: ctx });
  assert.equal(result.built, true, JSON.stringify(result.trace));
  assert.equal(builds, 1);
  assert.equal(ctx.builtPlan, baseline);
});

for (const [name, state, code] of [
  ['empty targets', { targets: { shotIds: [], lineIds: [] } }, 'SCOPE_EMPTY'],
  ['sibling targets', { targets: { shotIds: ['s2'] } }, 'SCOPE_EXPANSION'],
  ['line targets', { targets: { lineIds: ['s1:l1'] } }, 'SCOPE_EXPANSION'],
  ['locked shot', { lockedShotIds: ['s1'] }, 'ITERATION_SHOT_LOCKED'],
  ['paused production', { intent: 'paused' }, 'PRODUCTION_NOT_ACTIVE'],
] as const) {
  test(`saved drawing refuses ${name} before staging`, async () => {
    const { ctx } = bound(state);
    const baseline = ctx.builtPlan;
    const { result, edits, builds } = await run([[read(), edit(), build()], [{ type: 'text', delta: 'Done' }]], { production: ctx });
    assert.equal(result.trace.tools.find(tool => tool.name === 'project_edit_drawing')?.code, code);
    assert.equal(result.built, false);
    assert.equal(builds, 0);
    assert.deepEqual(edits, []);
    assert.equal(ctx.builtPlan, baseline);
    assert.match(result.reply, /not applied/);
  });
}

test('saved drawing build still requires a same-turn production read', async () => {
  const { ctx } = bound();
  const { result, builds } = await run([[edit(), build()], [{ type: 'text', delta: 'Done' }]], { production: ctx });
  assert.equal(result.trace.tools.find(tool => tool.name === 'project_build')?.code, 'READ_REQUIRED');
  assert.equal(builds, 0);
  assert.equal(result.built, false);
});

test('saved drawing build rejects a production revision changed after reading', async () => {
  const { ctx, move } = bound();
  const baseline = ctx.builtPlan;
  const { result, builds } = await run([[read(), edit()], [build()], [{ type: 'text', delta: 'Done' }]], {
    production: ctx, beforeStep: index => { if (index === 1) move(); },
  });
  assert.equal(result.trace.tools.find(tool => tool.name === 'project_build')?.code, 'REVISION_CONFLICT');
  assert.equal(builds, 0);
  assert.equal(ctx.builtPlan, baseline);
});

test('saved drawing build propagates host CAS conflicts', async () => {
  const conflict = Object.assign(new Error('Package changed'), { status: 409 });
  await assert.rejects(run([[edit(), build()]], { buildError: conflict }), error => error === conflict);
});

test('a failed drawing replacement blocks building earlier staged replacements', async () => {
  const { result, builds } = await run([[edit(), edit('s_missing'), build()], [{ type: 'text', delta: 'Done' }]]);
  assert.equal(builds, 0);
  assert.equal(result.built, false);
  assert.match(result.reply, /not applied/);
});

test('saved drawing cannot be mixed into pending reviewed package edits', async () => {
  const { result, edits, builds } = await run([[edit(), build()], [{ type: 'text', delta: 'Done' }]], { pending: true });
  assert.deepEqual(edits, []);
  assert.equal(builds, 0);
  assert.equal(result.built, false);
});
