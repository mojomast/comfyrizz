// IL11: the production agent reads the iteration policy and never raises it.
//
// The server owns the policy (IL03). production_read exposes the effective
// policy from the production snapshot: the level, the base policy, and the
// effective policy for every shot. The agent may follow that policy, but it
// may never change it; `iteration.set` is a user command.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORBIDDEN_AGENT_COMMANDS,
  PRODUCTION_RULES,
  PRODUCTION_TOOLS,
  runProductionTool,
  type ProductionCommandAttribution,
  type ProductionCommandEnvelope,
  type ProductionToolContext,
} from '../src/production-tools.js';

const SHOT_IDS = ['s1', 's2', 's3'];

function stage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { takes: 1, rounds: 1, auditions: 0, pick: 'auto', ...overrides };
}

function voiceStage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return stage({ linesPerVoice: 1, ...overrides });
}

function balancedPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    level: 'balanced',
    stages: {
      script: stage(),
      voice: voiceStage({ auditions: 2 }),
      keyframe: stage({ auditions: 2 }),
      video: stage({ takes: 2, pick: 'hero' }),
    },
    reviewDepth: 'standard',
    shotOverrides: {},
    ...overrides,
  };
}

interface Dispatched {
  envelope: ProductionCommandEnvelope;
  attribution: ProductionCommandAttribution;
}

type FakeContext = ProductionToolContext & { dispatched: Dispatched[] };

function fakeContext(
  production: Record<string, unknown>,
  overrides: Partial<ProductionToolContext> = {},
): FakeContext {
  const dispatched: Dispatched[] = [];
  const context: FakeContext = {
    productionId: 'prod_1',
    userEventId: 'ue_1',
    turnId: 'turn_1',
    read: () => ({
      production: { id: 'prod_1', revision: 4, intent: 'active', shotIds: SHOT_IDS, ...production },
      revision: 4,
      lastSequence: 10,
    }),
    command: (envelope, attribution) => {
      dispatched.push({ envelope, attribution });
      return { revision: envelope.expected.productionRevision + 1 };
    },
    dispatched,
    ...overrides,
  };
  return context;
}

async function read(ctx: ProductionToolContext) {
  const result = await runProductionTool({ name: 'production_read', args: {} }, ctx);
  assert.equal(result.ok, true, String(result.error));
  return result;
}

test('IL11: production_read exposes the snapshot iteration policy and per-shot effective policy', async () => {
  const policy = balancedPolicy() as any;
  const ctx = fakeContext({
    iteration: {
      policy,
      level: 'balanced',
      setAt: '2026-10-23T10:35:00.000Z',
      revision: 4,
    },
  });

  const result = await read(ctx);
  const iteration = result.iteration as any;
  assert.ok(iteration, 'production_read must expose iteration');
  assert.equal(iteration.level, 'balanced');
  assert.deepEqual(iteration.policy, policy);
  assert.deepEqual(Object.keys(iteration.perShot).sort(), [...SHOT_IDS].sort());

  for (const shotId of SHOT_IDS) {
    const effective = iteration.perShot[shotId];
    assert.equal(effective.level, 'balanced', shotId);
    assert.equal(effective.reviewDepth, 'standard', shotId);
    assert.deepEqual(effective.stages, policy.stages, shotId);
  }

  // Reading never rewrites the snapshot's policy.
  assert.deepEqual(policy, balancedPolicy());
});

test('IL11: per-shot effective policy merges a shot override without touching other shots', async () => {
  const policy: any = balancedPolicy({
    level: 'custom',
    shotOverrides: {
      s2: {
        stages: {
          video: { takes: 4, rounds: 3, pick: 'ask' },
          voice: { auditions: 0 },
        },
      },
    },
  });
  const ctx = fakeContext({
    iteration: { policy, level: 'custom', setAt: '2026-10-23T10:40:00.000Z', revision: 4 },
  });

  const result = await read(ctx);
  const iteration = result.iteration as any;
  assert.equal(iteration.level, 'custom');
  assert.deepEqual(iteration.policy, policy);

  assert.deepEqual(iteration.perShot.s1.stages, policy.stages);
  assert.deepEqual(iteration.perShot.s3.stages, policy.stages);
  assert.equal(iteration.perShot.s1.level, 'custom');
  assert.equal(iteration.perShot.s1.reviewDepth, 'standard');

  const overridden = iteration.perShot.s2;
  assert.equal(overridden.level, 'custom');
  assert.equal(overridden.reviewDepth, 'standard');
  assert.deepEqual(overridden.stages.video, { takes: 4, rounds: 3, auditions: 0, pick: 'ask' });
  assert.deepEqual(overridden.stages.voice, {
    takes: 1,
    rounds: 1,
    auditions: 0,
    pick: 'auto',
    linesPerVoice: 1,
  });
  assert.deepEqual(overridden.stages.script, policy.stages.script);
  assert.deepEqual(overridden.stages.keyframe, policy.stages.keyframe);
});

test('IL11: production_read does not invent iteration when the snapshot has none', async () => {
  const result = await read(fakeContext({}));
  assert.equal(result.iteration, undefined);
});

test('IL11: rule 11 tells the agent to follow, never raise, and ask before more takes', () => {
  const rule = PRODUCTION_RULES.match(/^11\. .*$/m)?.[0] ?? '';
  assert.match(rule, /iteration policy/i);
  assert.match(rule, /never raise/i);
  assert.match(rule, /more takes/i);
  assert.match(rule, /ask whether to change the level/i);
  assert.match(rule, /propose nothing/i);
  assert.match(PRODUCTION_RULES, /^10\. /m, 'the existing rules stay in place');
});

test('IL11: iteration.set is forbidden to the agent and never dispatched', async () => {
  assert.equal((FORBIDDEN_AGENT_COMMANDS as readonly string[]).includes('iteration.set'), true);

  const commandTool = PRODUCTION_TOOLS.find(tool => tool.name === 'production_command')!;
  const commandJson = JSON.stringify(commandTool.parameters);
  assert.equal(commandJson.includes('"iteration.set"'), false, 'iteration.set must not be in the tool enum');

  const ctx = fakeContext({});
  const result = await runProductionTool({
    name: 'production_command',
    args: { kind: 'iteration.set', expected_revision: 4, payload: { policy: balancedPolicy() } },
  }, ctx);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /may not|cannot|forbidden|unknown/i);
  assert.equal(ctx.dispatched.length, 0);

  // Even a misconfigured capability list cannot make iteration.set callable.
  const misconfigured = fakeContext({}, {
    capabilities: { allowedCommands: ['iteration.set'] as any },
  });
  const again = await runProductionTool({
    name: 'production_command',
    args: { kind: 'iteration.set', expected_revision: 4, payload: { policy: balancedPolicy() } },
  }, misconfigured);
  assert.equal(again.ok, false);
  assert.equal(misconfigured.dispatched.length, 0);
});
