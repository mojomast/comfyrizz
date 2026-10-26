import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import {
  MUTATION_REFUSAL_CODES,
  SCOPE_ID_KINDS,
  SCOPE_ID_PATTERNS,
  TARGET_SET_MODES,
  TargetSetError,
  diffDraft,
  normalizeTargetSet,
  remainingStageCapacity,
  scopeIdKind,
  targetSetAllows,
  targetSetFromIterationScope,
  checkDraftChange,
  intersectTargetSets,
} from '../src/mutation-policy.js';

const SERVER = '../../../../apps/server';
const fixture = JSON.parse(readFileSync(fileURLToPath(new URL(`${SERVER}/test/fixtures/ux00/scope.json`, import.meta.url)), 'utf8'));

test('UX09 mirror: scopeIdKind classifies every UX00 fixture id identically', () => {
  for (const row of fixture.ids) assert.equal(scopeIdKind(row.id), row.kind, `id ${JSON.stringify(row.id)}`);
});

test('UX09 mirror: normalizeTargetSet and targetSetAllows pass every UX00 target-set fixture', () => {
  for (const row of fixture.targetSets) {
    if (row.error !== undefined) {
      assert.throws(() => normalizeTargetSet(row.value), (error: unknown) => error instanceof TargetSetError && error.field === row.error, row.name);
      continue;
    }
    const set = normalizeTargetSet(row.absent ? undefined : row.value);
    assert.equal(set.mode, row.mode, row.name);
    for (const check of row.allows) assert.equal(targetSetAllows(set, check.target), check.expected, `${row.name}: ${JSON.stringify(check.target)}`);
  }
});

test('UX09 mirror: null is absent, and the vocabulary, id patterns and modes equal the server module', async () => {
  assert.equal(normalizeTargetSet(null).mode, 'unscoped');
  const server: any = await import(pathToFileURL(fileURLToPath(new URL(`${SERVER}/src/productions/iteration-scope.mjs`, import.meta.url))).href);
  assert.deepEqual([...MUTATION_REFUSAL_CODES], [...server.MUTATION_REFUSAL_CODES]);
  assert.deepEqual([...TARGET_SET_MODES], [...server.TARGET_SET_MODES]);
  assert.deepEqual([...SCOPE_ID_KINDS], [...server.SCOPE_ID_KINDS]);
  for (const kind of SCOPE_ID_KINDS) assert.equal(SCOPE_ID_PATTERNS[kind].source, server.SCOPE_ID_PATTERNS[kind].source, kind);
});

test('UX09: an iteration scope becomes a whole-shot, line or clip-shot target set, never a wider one', () => {
  const base = { packageId: 'pkg_ux09_demo' };
  const shot = targetSetFromIterationScope({ target: { ...base, shotId: 's_intro' }, element: 'background', note: 'x', preserve: [] });
  assert.deepEqual({ mode: shot.set.mode, shotIds: shot.set.shotIds, lineIds: shot.set.lineIds }, { mode: 'scoped', shotIds: ['s_intro'], lineIds: [] });

  const line = targetSetFromIterationScope({ target: { ...base, shotId: 's_intro' }, element: 'voice_line', elementRef: { lineId: 's_intro:l2' }, note: 'x', preserve: [] });
  assert.deepEqual({ shotIds: line.set.shotIds, lineIds: line.set.lineIds }, { shotIds: [], lineIds: ['s_intro:l2'] });

  const clip = targetSetFromIterationScope({ target: { ...base, clipId: 's_intro:a_logo' }, element: 'other', note: 'x', preserve: [] });
  assert.deepEqual(clip.set.shotIds, ['s_intro']);

  const lone = targetSetFromIterationScope({ target: { ...base, takeId: 'tk_0123456789ab' }, element: 'other', note: 'x', preserve: [] });
  assert.equal(lone.set.mode, 'empty');
  assert.equal(lone.unresolved, 'target');

  const mismatch = targetSetFromIterationScope({ target: { ...base, shotId: 's_outro' }, element: 'voice_line', elementRef: { lineId: 's_intro:l2' }, note: 'x', preserve: [] });
  assert.equal(mismatch.set.mode, 'empty');
  assert.equal(mismatch.unresolved, 'elementRef.lineId');
});

test('UX09: remaining capacity is takes x rounds minus used and never negative', () => {
  const policy = { stages: { video: { takes: 2, rounds: 2 }, voice: { takes: 1, rounds: 1 } }, shotOverrides: { s2: { stages: { video: { takes: 1, rounds: 1 } } } } };
  assert.equal(remainingStageCapacity(policy, undefined, 's1', 'video'), 4);
  assert.equal(remainingStageCapacity(policy, { s1: { video: 3 } }, 's1', 'video'), 1);
  assert.equal(remainingStageCapacity(policy, { s1: { video: 9 } }, 's1', 'video'), 0);
  assert.equal(remainingStageCapacity(policy, undefined, 's2', 'video'), 1);
  assert.equal(remainingStageCapacity(policy, undefined, 's1', 'voice'), 1);
});

const draft = (scenes: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({ title: 'T', brief: 'B', scenes, ...extra }) as any;
const scene = (id: string, headline: string) => ({ id, layout: 'title', headline, narration: `Line for ${id}.`, seconds: 4 });

test('UX09: diffDraft names changed shots and flags structural or project-wide changes', () => {
  const before = draft([scene('s1', 'A'), scene('s2', 'B')]);
  assert.deepEqual(diffDraft(before, draft([scene('s1', 'A2'), scene('s2', 'B')])), { shotIds: ['s1'], structural: false, global: false });
  assert.deepEqual(diffDraft(before, draft([scene('s1', 'A'), scene('s2', 'B')])), { shotIds: [], structural: false, global: false });
  assert.deepEqual(diffDraft(before, draft([scene('s2', 'B'), scene('s1', 'A')])), { shotIds: [], structural: true, global: false });
  assert.deepEqual(diffDraft(before, draft([scene('s1', 'A'), scene('s2', 'B'), scene('s3', 'C')])), { shotIds: ['s3'], structural: true, global: false });
  assert.deepEqual(diffDraft(before, draft([scene('s1', 'A')])), { shotIds: ['s2'], structural: true, global: false });
  assert.deepEqual(diffDraft(before, draft([scene('s1', 'A'), scene('s2', 'B')], { title: 'New' })), { shotIds: [], structural: false, global: true });
  assert.deepEqual(diffDraft(null, draft([scene('s1', 'A')])), { shotIds: ['s1'], structural: true, global: true });
});

test('UX09: checkDraftChange applies one policy: unscoped passes, empty and scoped refuse with shared codes', () => {
  const shots = [{ id: 's1', lines: ['s1:l1'] }, { id: 's2', lines: ['s2:l1'] }];
  const change = (shotIds: string[], extra: Partial<{ structural: boolean; global: boolean }> = {}) => ({ shotIds, structural: false, global: false, ...extra });
  const state = (targets: unknown, extra: Record<string, unknown> = {}) => ({ intent: 'active', shots, targets: normalizeTargetSet(targets), lockedShotIds: [] as string[], ...extra }) as any;

  assert.equal(checkDraftChange(state(undefined), change(['s1', 's2'], { global: true })), undefined);
  assert.equal(checkDraftChange(state({ shotIds: [] }), change(['s1']))?.code, 'SCOPE_EMPTY');
  assert.equal(checkDraftChange(state({ shotIds: ['s1'] }), change(['s1'])), undefined);
  assert.equal(checkDraftChange(state({ shotIds: ['s1'] }), change(['s2']))?.code, 'SCOPE_EXPANSION');
  assert.equal(checkDraftChange(state({ shotIds: ['s1'] }), change(['s1'], { global: true }))?.code, 'SCOPE_EXPANSION');
  assert.equal(checkDraftChange(state({ shotIds: ['s1'] }), change(['s1'], { structural: true }))?.code, 'SCOPE_EXPANSION');
  assert.equal(checkDraftChange(state({ lineIds: ['s1:l1'] }), change(['s1']))?.code, 'SCOPE_EXPANSION');
  assert.equal(checkDraftChange(state({ shotIds: ['s9'] }), change(['s9']))?.code, 'SCOPE_UNRESOLVED');
  assert.equal(checkDraftChange(state(undefined, { intent: 'paused' }), change(['s1']))?.code, 'PRODUCTION_NOT_ACTIVE');
  assert.equal(checkDraftChange(state(undefined, { lockedShotIds: ['s2'] }), change(['s2']))?.code, 'ITERATION_SHOT_LOCKED');
  assert.equal(checkDraftChange(state(undefined, { lockedShotIds: ['s2'] }), change(['s1'])), undefined);
  for (const code of ['SCOPE_EMPTY', 'SCOPE_EXPANSION', 'SCOPE_UNRESOLVED', 'PRODUCTION_NOT_ACTIVE', 'ITERATION_SHOT_LOCKED']) {
    assert.ok((MUTATION_REFUSAL_CODES as readonly string[]).includes(code), code);
  }
});

test('UX09: intersecting target sets keeps only what both permit and never widens', () => {
  const set = (raw: unknown) => normalizeTargetSet(raw);
  const view = (value: ReturnType<typeof intersectTargetSets>) => ({ mode: value.mode, shotIds: [...value.shotIds], lineIds: [...value.lineIds] });
  assert.deepEqual(view(intersectTargetSets(set(undefined), set({ shotIds: ['s1'] }))), { mode: 'scoped', shotIds: ['s1'], lineIds: [] });
  assert.deepEqual(view(intersectTargetSets(set({ shotIds: ['s1'] }), set({ lineIds: ['s1:l2'] }))), { mode: 'scoped', shotIds: [], lineIds: ['s1:l2'] });
  assert.deepEqual(view(intersectTargetSets(set({ shotIds: ['s1', 's2'] }), set({ shotIds: ['s2', 's3'] }))), { mode: 'scoped', shotIds: ['s2'], lineIds: [] });
  assert.equal(intersectTargetSets(set({ shotIds: ['s1'] }), set({ shotIds: ['s2'] })).mode, 'empty');
  assert.equal(intersectTargetSets(set({ lineIds: ['s1:l1'] }), set({ lineIds: ['s1:l2'] })).mode, 'empty');
  assert.equal(intersectTargetSets(set({ shotIds: [], lineIds: [] }), set(undefined)).mode, 'empty');
});
