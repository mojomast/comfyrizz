import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runProductionTool,
  type IterationScope,
  type ProductionToolContext,
} from '../src/production-tools.js';
import { MUTATION_REFUSAL_CODES } from '../src/mutation-policy.js';
import { planProductionTurn, scopeFromState, scopeViolations } from '../src/production-planner.js';

const SHOTS = [
  { id: 's_intro', lines: ['s_intro:l1', 's_intro:l2'] },
  { id: 's_outro', lines: ['s_outro:l1', 's_outro:l2'] },
  { id: 's1', lines: ['s1:l1'] },
];

interface Options {
  intent?: string;
  iterationScope?: IterationScope;
  state?: Record<string, unknown>;
  production?: Record<string, unknown>;
}

function context(options: Options = {}) {
  const dispatched: any[] = [];
  const ctx: ProductionToolContext & { dispatched: any[] } = {
    productionId: 'prod_ux09',
    userEventId: 'ue_ux09',
    turnId: 'turn_ux09',
    iterationScope: options.iterationScope,
    productionState: { intent: options.intent ?? 'active', shots: SHOTS, ...(options.state ?? {}) } as any,
    read: () => ({
      production: { id: 'prod_ux09', revision: 7, intent: options.intent ?? 'active', shotIds: SHOTS.map(shot => shot.id), ...(options.production ?? {}) },
      revision: 7,
      lastSequence: 7,
    }),
    command: (envelope: unknown) => { dispatched.push(envelope); return { ok: true }; },
    dispatched,
  };
  return ctx;
}

const readFirst = (ctx: ProductionToolContext) => runProductionTool({ name: 'production_read', args: {} }, ctx);
const plan = (shotId: string, lineId: string, extra: Record<string, unknown> = {}) => ({
  edits: [{ shotId, lineId, instruction: `Improve ${lineId}.` }], actions: [], summary: `Improve ${lineId}.`, ...extra,
});
const propose = (ctx: ProductionToolContext, body: Record<string, unknown>, revision = 7) =>
  runProductionTool({ name: 'production_propose_plan', args: { expected_revision: revision, plan: body } }, ctx);
const scope = (extra: Partial<IterationScope> = {}): IterationScope => ({
  target: { packageId: 'pkg_ux09_demo', shotId: 's_intro' }, element: 'voice_line', elementRef: { lineId: 's_intro:l2' }, note: 'warmer', preserve: ['character', 'background'], ...extra,
}) as IterationScope;

test('UX09: named scene and line ids resolve against the production, with no requested ids at all', async () => {
  const ctx = context();
  await readFirst(ctx);
  const result = await propose(ctx, plan('s_outro', 's_outro:l1'));
  assert.equal(result.ok, true, String(result.error));
  assert.equal(ctx.dispatched.length, 1);
});

test('UX09: a viewer iteration scope is the turn scope: its own line passes, expansion is refused with a shared code', async () => {
  const ctx = context({ iterationScope: scope() });
  await readFirst(ctx);
  const ok = await propose(ctx, plan('s_intro', 's_intro:l2', { actions: [{ id: 'a1', kind: 'audition', targetId: 's_intro:l2', upperBound: 0 }] }));
  assert.equal(ok.ok, true, String(ok.error));
  assert.deepEqual((ok.command as any).payload.scope, scope());

  for (const [shotId, lineId, code] of [['s_outro', 's_outro:l1', 'SCOPE_EXPANSION'], ['s_intro', 's_intro:l1', 'SCOPE_EXPANSION']] as const) {
    const fresh = context({ iterationScope: scope() });
    await readFirst(fresh);
    const refused = await propose(fresh, plan(shotId, lineId));
    assert.equal(refused.ok, false);
    assert.equal(refused.code, code, `${lineId}: ${refused.error}`);
    assert.ok((MUTATION_REFUSAL_CODES as readonly string[]).includes(String(refused.code)));
    assert.equal(fresh.dispatched.length, 0);
  }
});

test('UX09: an iteration scope that names no resolvable shot refuses every mutation as SCOPE_UNRESOLVED', async () => {
  const ctx = context({ iterationScope: scope({ target: { packageId: 'pkg_ux09_demo', takeId: 'tk_0123456789ab' }, element: 'other', elementRef: undefined }) });
  await readFirst(ctx);
  const refused = await propose(ctx, plan('s_intro', 's_intro:l1'));
  assert.equal(refused.code, 'SCOPE_UNRESOLVED');
  assert.equal(ctx.dispatched.length, 0);
});

test('UX09: absent targets are unscoped; an explicit empty target list means nothing may change', async () => {
  const unscoped = context();
  await readFirst(unscoped);
  assert.equal((await propose(unscoped, plan('s1', 's1:l1'))).ok, true);

  const emptyTargets = context({ state: { targets: { shotIds: [], lineIds: [] } } });
  await readFirst(emptyTargets);
  assert.equal((await propose(emptyTargets, plan('s1', 's1:l1'))).code, 'SCOPE_EMPTY');
  assert.equal((await propose(emptyTargets, { edits: [], actions: [], summary: 'Nothing named.' })).code, 'SCOPE_EMPTY');
  const advance = await runProductionTool({ name: 'production_command', args: { kind: 'stage.advance', payload: { stage: 'script' }, expected_revision: 7 } }, emptyTargets);
  assert.equal(advance.code, 'SCOPE_EMPTY');
  assert.equal(emptyTargets.dispatched.length, 0);

  const legacyEmpty = context({ state: { requestedShotIds: [], requestedLineIds: [] } });
  await readFirst(legacyEmpty);
  assert.equal((await propose(legacyEmpty, plan('s1', 's1:l1'))).code, 'SCOPE_EMPTY');

  const legacyAbsent = context({ state: {} });
  await readFirst(legacyAbsent);
  assert.equal((await propose(legacyAbsent, plan('s1', 's1:l1'))).ok, true);
});

test('UX09: an empty target list still permits reads and the pause safety stop', async () => {
  const ctx = context({ state: { targets: { shotIds: [], lineIds: [] } } });
  assert.equal((await readFirst(ctx)).ok, true);
  const pause = await runProductionTool({ name: 'production_command', args: { kind: 'production.pause', payload: { reason: 'Stop.' }, expected_revision: 7 } }, ctx);
  assert.equal(pause.ok, true, String(pause.error));
});

test('UX09: shot targets permit every line of those shots and nothing else', async () => {
  const ctx = context({ state: { targets: { shotIds: ['s_intro'] } } });
  await readFirst(ctx);
  assert.equal((await propose(ctx, plan('s_intro', 's_intro:l1'))).ok, true);
  const other = context({ state: { targets: { shotIds: ['s_intro'] } } });
  await readFirst(other);
  assert.equal((await propose(other, plan('s_outro', 's_outro:l1'))).code, 'SCOPE_EXPANSION');
});

test('UX09: a target that is not a shot or line of the production is SCOPE_UNRESOLVED, and a malformed target list is refused', async () => {
  const missing = context({ state: { targets: { shotIds: ['s9'] } } });
  await readFirst(missing);
  assert.equal((await propose(missing, plan('s_intro', 's_intro:l1'))).code, 'SCOPE_UNRESOLVED');

  const malformed = context({ state: { targets: { shotIds: ['not a shot'] } } });
  await readFirst(malformed);
  assert.equal((await propose(malformed, plan('s_intro', 's_intro:l1'))).code, 'SCOPE_UNRESOLVED');
});

test('UX09: a structured id that the production does not have is SCOPE_UNRESOLVED, one outside the scope is SCOPE_EXPANSION', async () => {
  const ctx = context({ state: { targets: { shotIds: ['s_intro'] } } });
  await readFirst(ctx);
  assert.equal((await propose(ctx, plan('s_nope', 's_nope:l1'))).code, 'SCOPE_UNRESOLVED');
  assert.equal(ctx.dispatched.length, 0);
});

test('UX09: a named id mentioned in free text is checked, so a summary cannot widen the scope', () => {
  const state = { intent: 'active', shots: SHOTS, targets: { shotIds: ['s_intro'] } } as any;
  assert.deepEqual(scopeViolations({ summary: 'Warmer intro, leave s_outro alone.' }, state), ['s_outro']);
  assert.deepEqual(scopeViolations({ summary: 'Warmer s_intro:l2.' }, state), []);
  assert.deepEqual(scopeViolations({ summary: 'The s_introduction is fine.' }, state), []);
});

test('UX09: scopeFromState reads absent as unscoped and targets as the whole-shot or line permission', () => {
  const unscoped = scopeFromState({ shots: SHOTS } as any);
  assert.equal(unscoped.scopeShots.size, 3);
  assert.equal(unscoped.scopeLines, null);
  const empty = scopeFromState({ shots: SHOTS, targets: { shotIds: [], lineIds: [] } } as any);
  assert.equal(empty.scopeShots.size, 0);
  const lines = scopeFromState({ shots: SHOTS, targets: { lineIds: ['s_intro:l2'] } } as any);
  assert.deepEqual([...lines.scopeShots], ['s_intro']);
  assert.deepEqual([...(lines.scopeLines ?? [])], ['s_intro:l2']);
});

test('UX09: refusals before and after the read carry shared codes and change nothing', async () => {
  const blind = context();
  const early = await propose(blind, plan('s1', 's1:l1'));
  assert.equal(early.code, 'READ_REQUIRED');

  const stale = context();
  await readFirst(stale);
  assert.equal((await propose(stale, plan('s1', 's1:l1'), 3)).code, 'REVISION_CONFLICT');

  const paused = context({ intent: 'paused' });
  await readFirst(paused);
  assert.equal((await propose(paused, plan('s1', 's1:l1'))).code, 'PRODUCTION_NOT_ACTIVE');
  const pausedCommand = await runProductionTool({ name: 'production_command', args: { kind: 'stage.advance', payload: { stage: 'script' }, expected_revision: 7 } }, paused);
  assert.equal(pausedCommand.code, 'PRODUCTION_NOT_ACTIVE');
  assert.equal(blind.dispatched.length + stale.dispatched.length + paused.dispatched.length, 0);
});

test('UX09: a locked shot refuses text edits and paid slots with ITERATION_SHOT_LOCKED', async () => {
  const production = { iteration: { level: 'balanced', policy: { level: 'balanced', stages: { video: { takes: 2, rounds: 1 }, voice: { takes: 1, rounds: 1 } }, reviewDepth: 'standard' } }, lockedShotIds: ['s_outro'] };
  const text = context({ production });
  await readFirst(text);
  assert.equal((await propose(text, plan('s_outro', 's_outro:l1'))).code, 'ITERATION_SHOT_LOCKED');

  const slot = context({ production });
  await readFirst(slot);
  const paid = await propose(slot, { edits: [], actions: [{ id: 'a1', kind: 'render', targetId: 's_outro', upperBound: 0 }], summary: 'Render s_outro.' });
  assert.equal(paid.code, 'ITERATION_SHOT_LOCKED');
  assert.match(String(paid.error), /locked shot s_outro/);

  const free = context({ production });
  await readFirst(free);
  assert.equal((await propose(free, plan('s_intro', 's_intro:l1'))).ok, true);
});

test('UX09: an exhausted stage refuses a slot as ITERATION_EXCEEDED while remaining capacity still passes', async () => {
  const production = {
    iteration: {
      level: 'draft',
      policy: { level: 'draft', stages: { video: { takes: 2, rounds: 1 }, voice: { takes: 1, rounds: 1 } }, reviewDepth: 'standard' },
      used: { s_intro: { video: 1 } },
    },
  };
  const slot = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `a${i + 1}`, kind: 'render', targetId: 's_intro', upperBound: 0 }));
  const fits = context({ production });
  await readFirst(fits);
  assert.equal((await propose(fits, { edits: [], actions: slot(1), summary: 'One take of s_intro.' })).ok, true);
  const over = context({ production });
  await readFirst(over);
  assert.equal((await propose(over, { edits: [], actions: slot(2), summary: 'Two takes of s_intro.' })).code, 'ITERATION_EXCEEDED');
  assert.equal(over.dispatched.length, 0);
});

test('UX09: the planner shares remaining capacity, so a take it proposes is never one the guard refuses', () => {
  const policy = { level: 'draft', stages: { video: { takes: 2, rounds: 1 }, voice: { takes: 1, rounds: 1 } } };
  const used = { s_intro: { video: 1 } };
  const base = { shots: SHOTS, iteration: { policy, used } };
  const asksTwo = planProductionTurn({ userMessage: 'Render two takes of s_intro.', requestedShotIds: ['s_intro'], ...base });
  assert.equal(asksTwo.proposal, undefined);
  assert.match(asksTwo.reply, /at most 1/);
  const asksOne = planProductionTurn({ userMessage: 'Render one take of s_intro.', requestedShotIds: ['s_intro'], ...base });
  assert.equal(asksOne.proposal?.actions.length, 1);
  const across = planProductionTurn({ userMessage: 'Render four takes across the shots.', requestedShotIds: ['s_intro', 's_outro'], ...base });
  assert.equal(across.proposal, undefined);
  assert.match(across.reply, /at most 3/);
});

test('UX09: the planner refuses a scoped take on a locked shot and for an exhausted stage', () => {
  const policy = { level: 'draft', stages: { video: { takes: 1, rounds: 1 }, voice: { takes: 1, rounds: 1 } } };
  const sc = { target: { packageId: 'pkg_ux09_demo', shotId: 's_intro' }, element: 'background', note: 'x', preserve: [] };
  const locked = planProductionTurn({ userMessage: 'Warmer background.', shots: SHOTS, iterationScope: sc, iteration: { policy, lockedShotIds: ['s_intro'] } });
  assert.equal(locked.proposal, undefined);
  assert.match(locked.reply, /locked/);
  const spent = planProductionTurn({ userMessage: 'Warmer background.', shots: SHOTS, iterationScope: sc, iteration: { policy, used: { s_intro: { video: 1 } } } });
  assert.equal(spent.proposal, undefined);
  assert.match(spent.reply, /\?$/);
  const open = planProductionTurn({ userMessage: 'Warmer background.', shots: SHOTS, iterationScope: sc, iteration: { policy } });
  assert.equal(open.proposal?.actions.length, 1);
});

test('UX09: an element scope refuses slots that would change a preserved element', async () => {
  const background = scope({ element: 'background', elementRef: undefined, target: { packageId: 'pkg_ux09_demo', shotId: 's_intro' }, preserve: ['voice', 'timing'] });
  const voiceSlot = context({ iterationScope: background });
  await readFirst(voiceSlot);
  const audition = await propose(voiceSlot, { edits: [], actions: [{ id: 'a1', kind: 'audition', targetId: 's_intro:l1', upperBound: 0 }], summary: 'Audition.' });
  assert.equal(audition.code, 'PRESERVE_VIOLATION');

  const visual = context({ iterationScope: background });
  await readFirst(visual);
  const render = await propose(visual, { edits: [], actions: [{ id: 'a1', kind: 'render', targetId: 's_intro', upperBound: 0 }], summary: 'Render s_intro.' });
  assert.equal(render.ok, true, String(render.error));
});
