import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationPlanSchema, runConversationTurn } from '../src/conversation.js';
import type { ConversationPlan } from '../src/conversation.js';
import type { ProductionToolContext } from '../src/production-tools.js';
import type { ChatChunk, ChatModel } from '../src/types.js';

const SHOTS = [
  { id: 's_intro', lines: ['s_intro:l1', 's_intro:l2'] },
  { id: 's_outro', lines: ['s_outro:l1', 's_outro:l2'] },
];

const draft = (): ConversationPlan => conversationPlanSchema.parse({
  title: 'Orbit', brief: 'Meet Orbit.', audience: 'Testers', aspect: '16:9', stylePreset: 'cinematic-dark',
  scenes: [
    { id: 's_intro', layout: 'title', headline: 'Meet Orbit', narration: 'First intro line. Second intro line.', seconds: 4, visual: 'A calm backdrop' },
    { id: 's_outro', layout: 'title', headline: 'Goodbye', narration: 'First outro line. Second outro line.', seconds: 4, visual: 'A calm backdrop' },
  ],
});

function scripted(steps: ChatChunk[][]) {
  let index = 0;
  const model: ChatModel = {
    id: 'ux09',
    async *stream() { yield* steps[index++] ?? [{ type: 'text', delta: 'Done.' } as ChatChunk]; },
  };
  return model;
}
const call = (name: string, args: unknown): ChatChunk => ({ type: 'tool_call', id: `call-${name}-${Math.random()}`, name, args });

function bound(options: { intent?: string; state?: Record<string, unknown>; revision?: number; read?: () => unknown; builtPlan?: unknown } = {}) {
  const intent = options.intent ?? 'active';
  const revision = options.revision ?? 5;
  const dispatched: unknown[] = [];
  const ctx: ProductionToolContext = {
    productionId: 'prod_ux09',
    userEventId: 'ue_ux09',
    turnId: 'turn_ux09',
    read: (options.read ?? (() => ({ production: { id: 'prod_ux09', revision, intent, shotIds: SHOTS.map(shot => shot.id) }, revision, lastSequence: revision }))) as ProductionToolContext['read'],
    command: envelope => { dispatched.push(envelope); return { ok: true }; },
    capabilities: { read: true, proposePlan: true, commands: true },
    productionState: { intent, shots: SHOTS, ...(options.state ?? {}) } as ProductionToolContext['productionState'],
    ...(options.builtPlan !== undefined ? { builtPlan: options.builtPlan } : {}),
  };
  return { ctx, dispatched };
}

async function run(steps: ChatChunk[][], production: ProductionToolContext | undefined, plan: ConversationPlan | null = draft()) {
  const built: ConversationPlan[] = [];
  const result = await runConversationTurn({
    model: scripted(steps),
    plan,
    messages: [{ role: 'user', content: 'Improve the intro.' }],
    sessionId: 'ux09-conversation-policy',
    signal: AbortSignal.timeout(5000),
    ...(production ? { production } : {}),
    build: async candidate => { built.push(candidate); return { packageId: 'pkg_ux09', revision: 2 }; },
  });
  return { result, built, tool: (name: string) => result.trace.tools.filter(entry => entry.name === name) };
}

const patch = (id: string, changes: Record<string, unknown>) => call('project_patch_plan', { scenePatches: [{ id, changes }] });
const read = () => call('production_read', {});
const build = () => call('project_build', {});

test('UX09: an unbound turn keeps the ordinary tools unrestricted', async () => {
  const { result, built } = await run([[patch('s_outro', { headline: 'Bye' }), build()]], undefined);
  assert.equal(built.length, 1);
  assert.equal(result.plan?.scenes[1].headline, 'Bye');
});

test('UX09: a bound unscoped turn may patch and build after reading', async () => {
  const { ctx } = bound();
  const { result, built } = await run([[read(), patch('s_outro', { headline: 'Bye' }), build()]], ctx);
  assert.equal(result.trace.tools.every(entry => entry.ok), true, JSON.stringify(result.trace.tools));
  assert.equal(built.length, 1);
});

test('UX09: build before production_read is refused, nothing is built and the draft edit stays a draft', async () => {
  const { ctx } = bound();
  const { result, built, tool } = await run([[patch('s_intro', { headline: 'Meet Orbit again' }), build()]], ctx);
  assert.equal(built.length, 0);
  assert.equal(tool('project_patch_plan')[0].ok, true);
  assert.equal(tool('project_build')[0].ok, false);
  assert.equal((tool('project_build')[0] as any).code, 'READ_REQUIRED');
  assert.equal(result.built, false);
});

test('UX09: a paused production refuses draft edits and builds with PRODUCTION_NOT_ACTIVE', async () => {
  const { ctx } = bound({ intent: 'paused' });
  const before = draft();
  const { result, built, tool } = await run([[read(), patch('s_intro', { headline: 'Changed' }), build()]], ctx, before);
  assert.equal(built.length, 0);
  assert.equal((tool('project_patch_plan')[0] as any).code, 'PRODUCTION_NOT_ACTIVE');
  assert.equal((tool('project_build')[0] as any).code, 'PRODUCTION_NOT_ACTIVE');
  assert.deepEqual(result.plan, before);
});

test('UX09: a patch to an unrelated shot is refused under a shot scope and the draft is unchanged', async () => {
  const { ctx } = bound({ state: { targets: { shotIds: ['s_intro'] } } });
  const before = draft();
  const { result, built, tool } = await run([[read(), patch('s_outro', { headline: 'Unrelated rewrite' }), build()]], ctx, before);
  assert.equal((tool('project_patch_plan')[0] as any).code, 'SCOPE_EXPANSION');
  assert.deepEqual(result.plan, before);
  assert.ok(built.every(candidate => JSON.stringify(candidate) === JSON.stringify(before)), 'a build may only publish the draft as it was');
});

test('UX09: a patch to the requested shot passes and the build is limited to it', async () => {
  const { ctx } = bound({ state: { targets: { shotIds: ['s_intro'] } }, builtPlan: draft() });
  const { result, built } = await run([[read(), patch('s_intro', { headline: 'Meet Orbit, warmer' }), build()]], ctx);
  assert.equal(result.trace.tools.every(entry => entry.ok), true, JSON.stringify(result.trace.tools));
  assert.equal(built.length, 1);
});

test('UX09: a build is refused when the draft already differs from the built plan outside the scope', async () => {
  const drifted = draft();
  drifted.scenes[1].headline = 'Earlier unbuilt edit';
  const { ctx } = bound({ state: { targets: { shotIds: ['s_intro'] } }, builtPlan: draft() });
  const { built, tool } = await run([[read(), patch('s_intro', { headline: 'Meet Orbit, warmer' }), build()]], ctx, drifted);
  assert.equal(tool('project_patch_plan')[0].ok, true);
  assert.equal((tool('project_build')[0] as any).code, 'SCOPE_EXPANSION');
  assert.equal(built.length, 0);
});

test('UX09: an explicit empty target list refuses every draft edit and build', async () => {
  const { ctx } = bound({ state: { targets: { shotIds: [], lineIds: [] } } });
  const { built, tool } = await run([[read(), patch('s_intro', { headline: 'x' }), build()]], ctx);
  assert.equal((tool('project_patch_plan')[0] as any).code, 'SCOPE_EMPTY');
  assert.equal((tool('project_build')[0] as any).code, 'SCOPE_EMPTY');
  assert.equal(built.length, 0);
});

test('UX09: a line-only scope refuses a whole-shot draft edit and names production_propose_plan', async () => {
  const { ctx } = bound({ state: { targets: { lineIds: ['s_intro:l2'] } } });
  const { result, tool } = await run([[read(), patch('s_intro', { narration: 'First intro line. Warmer second line.' })]], ctx);
  const refused = tool('project_patch_plan')[0] as any;
  assert.equal(refused.code, 'SCOPE_EXPANSION');
  assert.match(refused.error, /production_propose_plan/);
  assert.equal(result.plan?.scenes[0].narration, 'First intro line. Second intro line.');
});

test('UX09: a full rewrite with project_update_plan follows the same policy', async () => {
  const rewrite = draft();
  rewrite.scenes[1].headline = 'Rewritten';
  const scoped = bound({ state: { targets: { shotIds: ['s_intro'] } } });
  const a = await run([[read(), call('project_update_plan', rewrite)]], scoped.ctx);
  assert.equal((a.tool('project_update_plan')[0] as any).code, 'SCOPE_EXPANSION');
  const paused = bound({ intent: 'paused' });
  const b = await run([[read(), call('project_update_plan', rewrite)]], paused.ctx);
  assert.equal((b.tool('project_update_plan')[0] as any).code, 'PRODUCTION_NOT_ACTIVE');
  const open = bound();
  const c = await run([[call('project_update_plan', rewrite)]], open.ctx);
  assert.equal(c.tool('project_update_plan')[0].ok, true);
});

test('UX09: a locked shot cannot be edited by an ordinary tool', async () => {
  const { ctx } = bound({ state: { lockedShotIds: ['s_outro'] } });
  const { result, tool } = await run([[read(), patch('s_outro', { headline: 'x' }), patch('s_intro', { headline: 'ok' })]], ctx);
  assert.equal((tool('project_patch_plan')[0] as any).code, 'ITERATION_SHOT_LOCKED');
  assert.equal(tool('project_patch_plan')[1].ok, true);
  assert.equal(result.plan?.scenes[0].headline, 'ok');
});

test('UX09: the build refuses when the production moved after the read', async () => {
  let revision = 5;
  const { ctx } = bound({ read: () => ({ production: { id: 'prod_ux09', revision, intent: 'active', shotIds: ['s_intro', 's_outro'] }, revision, lastSequence: revision }) });
  const steps: ChatChunk[][] = [[read()], [patch('s_intro', { headline: 'x' })], [build()]];
  let index = 0;
  const model: ChatModel = { id: 'ux09', async *stream() { if (index === 2) revision = 6; yield* steps[index++] ?? [{ type: 'text', delta: 'Done.' } as ChatChunk]; } };
  const built: ConversationPlan[] = [];
  const result = await runConversationTurn({
    model, plan: draft(), messages: [{ role: 'user', content: 'Go.' }], sessionId: 'ux09', signal: AbortSignal.timeout(5000), production: ctx,
    build: async candidate => { built.push(candidate); return { packageId: 'pkg_ux09', revision: 2 }; },
  });
  const refused = result.trace.tools.find(entry => entry.name === 'project_build') as any;
  assert.equal(refused.code, 'REVISION_CONFLICT');
  assert.equal(built.length, 0);
});

test('UX09: a refused tool call does not use up the repair budget, so the turn ends with a reply, not an error', async () => {
  const { ctx } = bound({ intent: 'paused' });
  const calls = [read(), patch('s_intro', { headline: 'a' }), patch('s_intro', { headline: 'b' }), patch('s_intro', { headline: 'c' }), patch('s_intro', { headline: 'd' })];
  const { result } = await run([calls], ctx);
  assert.equal(result.reply, 'Done.');
  assert.equal(result.trace.repairs, 0);
});
