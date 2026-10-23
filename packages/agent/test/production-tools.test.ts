import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_COMMAND_KINDS,
  APPROVAL_COMMANDS,
  DECISION_COMMANDS,
  FORBIDDEN_AGENT_COMMANDS,
  PRODUCTION_RULES,
  PRODUCTION_TOOLS,
  PRODUCTION_TOOL_NAMES,
  SPEND_COMMANDS,
  isProductionToolName,
  productionToolsFor,
  runProductionTool,
  type ProductionCommandAttribution,
  type ProductionCommandEnvelope,
  type ProductionToolContext,
} from '../src/production-tools.js';

const ALLOWED = [
  'plan.propose',
  'stage.advance',
  'artifact.attach',
  'take.request',
  'render.request',
  'production.pause',
];

const NEVER_ALLOWED = [
  'production.resume',
  'production.cancel',
  'production.archive',
  'action.cancel',
];

interface Dispatched {
  envelope: ProductionCommandEnvelope;
  attribution: ProductionCommandAttribution;
}

type FakeContext = ProductionToolContext & { dispatched: Dispatched[] };

function fakeContext(overrides: Partial<ProductionToolContext> = {}): FakeContext {
  const dispatched: Dispatched[] = [];
  const context: FakeContext = {
    productionId: 'prod_1',
    userEventId: 'ue_1',
    turnId: 'turn_1',
    read: () => ({
      production: { id: 'prod_1', revision: 4, intent: 'active' },
      revision: 4,
      lastSequence: 10,
    }),
    command: (envelope, attribution) => {
      dispatched.push({ envelope, attribution });
      return { revision: envelope.expected.productionRevision + 1, production: { id: envelope.productionId } };
    },
    dispatched,
    ...overrides,
  };
  return context;
}

function assertJsonSchemaNode(node: any, path: string): void {
  assert.equal(typeof node, 'object', `${path} must be a schema object`);
  assert.ok(node && !Array.isArray(node), `${path} must be an object`);
  assert.ok(
    ['object', 'array', 'string', 'integer', 'number', 'boolean'].includes(node.type),
    `${path}.type is a JSON Schema type`,
  );
  if (node.type === 'object') {
    assert.equal(typeof node.properties, 'object', `${path}.properties must exist`);
    assert.ok(!Array.isArray(node.properties), `${path}.properties must be an object`);
    if (node.required !== undefined) {
      assert.ok(Array.isArray(node.required), `${path}.required must be an array`);
      for (const key of node.required) {
        assert.ok(Object.prototype.hasOwnProperty.call(node.properties, key), `${path}.required names ${key}`);
      }
    }
    for (const [key, value] of Object.entries(node.properties)) {
      assertJsonSchemaNode(value, `${path}.${key}`);
    }
  }
}

test('IP35: the agent command vocabulary is exactly the non-approval set', () => {
  assert.deepEqual(AGENT_COMMAND_KINDS, ALLOWED);
  for (const kind of NEVER_ALLOWED) {
    assert.equal((AGENT_COMMAND_KINDS as readonly string[]).includes(kind), false, `${kind} must not be callable by the agent`);
    assert.equal(FORBIDDEN_AGENT_COMMANDS.includes(kind as any), true, `${kind} must be explicitly forbidden`);
  }
  for (const kind of APPROVAL_COMMANDS) {
    assert.equal((AGENT_COMMAND_KINDS as readonly string[]).includes(kind), false, `${kind} is a human approval`);
  }
  for (const kind of SPEND_COMMANDS) {
    assert.equal((AGENT_COMMAND_KINDS as readonly string[]).includes(kind), false, `${kind} spends money`);
  }
  for (const kind of DECISION_COMMANDS) {
    assert.equal((AGENT_COMMAND_KINDS as readonly string[]).includes(kind), false, `${kind} is a user decision`);
  }
});

test('IP35: tool schemas are valid JSON Schema and cannot name forbidden commands', () => {
  assert.deepEqual(PRODUCTION_TOOL_NAMES, [
    'production_read',
    'production_propose_plan',
    'production_command',
  ]);

  for (const tool of PRODUCTION_TOOLS) {
    assert.equal(tool.name, tool.name.trim());
    assert.match(tool.description, /\S/);
    assertJsonSchemaNode(tool.parameters, tool.name);
    assert.equal((tool.parameters as any).type, 'object');
    assert.equal((tool.parameters as any).additionalProperties, false);
  }

  const byName = new Map(PRODUCTION_TOOLS.map(tool => [tool.name, tool.parameters as any]));
  assert.deepEqual(byName.get('production_read')!.required, undefined);
  assert.deepEqual(byName.get('production_propose_plan')!.required, ['plan', 'expected_revision']);
  assert.deepEqual(byName.get('production_command')!.required, ['kind', 'expected_revision']);
  assert.deepEqual(byName.get('production_command')!.properties.kind.enum, ALLOWED);
  assert.equal(byName.get('production_propose_plan')!.properties.expected_revision.type, 'integer');
  assert.equal(byName.get('production_propose_plan')!.properties.expected_revision.minimum, 0);
  assert.equal(byName.get('production_command')!.properties.expected_revision.type, 'integer');
  assert.equal(byName.get('production_command')!.properties.expected_revision.minimum, 0);

  const commandJson = JSON.stringify(byName.get('production_command'));
  for (const kind of FORBIDDEN_AGENT_COMMANDS) {
    assert.equal(commandJson.includes(`"${kind}"`), false, `${kind} must not appear in the command enum`);
  }
  for (const name of PRODUCTION_TOOL_NAMES) assert.equal(isProductionToolName(name), true);
  assert.equal(isProductionToolName('production_approve'), false);
  assert.equal(isProductionToolName('production_resume'), false);
});

test('IP35: rules say propose, never approve, and never spend', () => {
  assert.match(PRODUCTION_RULES, /production_read/);
  assert.match(PRODUCTION_RULES, /expected_revision/);
  assert.match(PRODUCTION_RULES, /propose/i);
  assert.match(PRODUCTION_RULES, /never approve|may not approve|cannot approve/i);
  assert.match(PRODUCTION_RULES, /spend/i);
  assert.match(PRODUCTION_RULES, /user/i);
  assert.match(PRODUCTION_RULES, /pause/i);
});

test('IP35: the tool list is capability-gated', () => {
  assert.deepEqual(productionToolsFor(null), []);

  const readOnly = fakeContext({ command: undefined });
  assert.deepEqual(productionToolsFor(readOnly).map(tool => tool.name), ['production_read']);

  const commandOnly = fakeContext({ read: undefined });
  assert.deepEqual(productionToolsFor(commandOnly).map(tool => tool.name), [
    'production_propose_plan',
    'production_command',
  ]);

  const full = fakeContext();
  assert.deepEqual(productionToolsFor(full).map(tool => tool.name), PRODUCTION_TOOL_NAMES);

  const limited = fakeContext({ capabilities: { allowedCommands: ['stage.advance', 'production.pause'] } });
  const commandTool = productionToolsFor(limited).find(tool => tool.name === 'production_command')!;
  assert.deepEqual((commandTool.parameters as any).properties.kind.enum, ['stage.advance', 'production.pause']);
  assert.deepEqual(
    (PRODUCTION_TOOLS.find(tool => tool.name === 'production_command')!.parameters as any).properties.kind.enum,
    ALLOWED,
  );

  const noCommands = fakeContext({ capabilities: { allowedCommands: [] } });
  assert.deepEqual(productionToolsFor(noCommands).map(tool => tool.name), ['production_read', 'production_propose_plan']);

  const noRead = fakeContext({ capabilities: { read: false } });
  assert.deepEqual(productionToolsFor(noRead).map(tool => tool.name), [
    'production_propose_plan',
    'production_command',
  ]);

  const noProposal = fakeContext({ capabilities: { proposePlan: false } });
  assert.deepEqual(productionToolsFor(noProposal).map(tool => tool.name), ['production_read', 'production_command']);
});

test('IP35: production_read returns the only snapshot source and its revision', async () => {
  const seen: string[] = [];
  const ctx = fakeContext({
    read: (productionId: string) => {
      seen.push(productionId);
      return { production: { id: productionId, revision: 7, intent: 'paused' }, revision: 7, lastSequence: 22 };
    },
  });

  const result = await runProductionTool({ name: 'production_read', args: {} }, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'read');
  assert.equal(result.revision, 7);
  assert.equal(result.production?.id, 'prod_1');
  assert.equal(result.production?.intent, 'paused');
  assert.equal(result.lastSequence, 22);
  assert.deepEqual(seen, ['prod_1']);

  const raw = await runProductionTool({ name: 'production_read', args: { production_id: 'prod_raw' } }, fakeContext({
    read: () => ({ id: 'prod_raw', revision: 0, intent: 'active' }),
  }));
  assert.equal(raw.ok, true);
  assert.equal(raw.revision, 0);

  const missing = await runProductionTool({ name: 'production_read', args: {} }, fakeContext({ read: () => null }));
  assert.equal(missing.ok, false);
  assert.match(String(missing.error), /unknown production/i);

  const noRevision = await runProductionTool({ name: 'production_read', args: {} }, fakeContext({
    read: () => ({ production: { id: 'prod_1' } }),
  }));
  assert.equal(noRevision.ok, false);
  assert.match(String(noRevision.error), /revision/i);
});

test('IP35: production_read ignores context revision and snapshots', async () => {
  const ctx = fakeContext({ revision: 99, snapshot: { id: 'prod_1', revision: 98 }, read: undefined } as any);
  const listed = productionToolsFor(ctx).map(tool => tool.name);
  assert.equal(listed.includes('production_read'), false);

  const result = await runProductionTool({ name: 'production_read', args: {} }, ctx);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /read.*not available/i);
});

test('IP35: propose requires the revision the agent actually read', async () => {
  const ctx = fakeContext();
  const missing = await runProductionTool({
    name: 'production_propose_plan',
    args: { plan: { planId: 'plan_1', revision: 0, reservationCeiling: 2, requiredDecisions: [], actions: [] } },
  }, ctx);
  assert.equal(missing.ok, false);
  assert.match(String(missing.error), /expected_revision/);
  assert.equal(ctx.dispatched.length, 0);

  for (const value of ['4', 4.5, -1, null]) {
    const invalid = await runProductionTool({
      name: 'production_propose_plan',
      args: {
        expected_revision: value,
        plan: { planId: 'plan_1', revision: 0, reservationCeiling: 2, requiredDecisions: [], actions: [] },
      },
    }, ctx);
    assert.equal(invalid.ok, false, `expected_revision ${JSON.stringify(value)} must be refused`);
    assert.match(String(invalid.error), /expected_revision/);
  }
  assert.equal(ctx.dispatched.length, 0);

  const explicitZero = await runProductionTool({
    name: 'production_propose_plan',
    args: {
      expected_revision: 0,
      plan: { planId: 'plan_1', revision: 0, reservationCeiling: 0, requiredDecisions: [], actions: [] },
    },
  }, fakeContext({ read: () => ({ production: { id: 'prod_1', revision: 4 }, revision: 4 }) }));
  assert.equal(explicitZero.ok, true);
  assert.equal(explicitZero.command?.expected.productionRevision, 0);
});

test('IP35: propose records one plan.propose with server attribution and no approval', async () => {
  const ctx = fakeContext();
  const plan = {
    planId: 'plan_1',
    revision: 2,
    reservationCeiling: 12,
    collectAndStopReserve: 1,
    requiredDecisions: [{ kind: 'action_spend' }],
    actions: [{ id: 'slot_a', upperBound: 5, label: 'Draft take' }],
  };

  const result = await runProductionTool({
    name: 'production_propose_plan',
    args: { plan, expected_revision: 4 },
  }, ctx);

  assert.equal(result.ok, true);
  assert.equal(result.status, 'proposed');
  assert.equal(result.applied, false);
  assert.match(String(result.message), /approve/i);
  assert.equal(ctx.dispatched.length, 1);
  const { envelope, attribution } = ctx.dispatched[0];
  assert.equal(envelope.kind, 'plan.propose');
  assert.equal(envelope.productionId, 'prod_1');
  assert.deepEqual(envelope.expected, { productionRevision: 4 });
  assert.deepEqual(envelope.payload, plan);
  assert.match(envelope.commandId, /^cmd_[0-9a-f]{24}$/);
  assert.match(envelope.idempotencyKey, /^key_[0-9a-f]{32}$/);
  assert.deepEqual(attribution, { actor: 'agent', userEventId: 'ue_1' });
  assert.equal(JSON.stringify(envelope).includes('plan.approve'), false);
});

test('IP35: propose refuses server-owned plan identity (hash, execution id, allocation)', async () => {
  for (const key of ['planHash', 'contentHash', 'executionId', 'allocation']) {
    const ctx = fakeContext();
    const result = await runProductionTool({
      name: 'production_propose_plan',
      args: {
        plan: { planId: 'plan_1', revision: 0, reservationCeiling: 1, requiredDecisions: [], actions: [{ id: 'a', upperBound: 1 }], [key]: 'forged' },
        expected_revision: 4,
      },
    }, ctx);
    assert.equal(result.ok, false, `${key} must be refused`);
    assert.equal(result.code, 'SERVER_PLAN_IDENTITY');
    assert.equal(ctx.dispatched.length, 0, `${key}: nothing is dispatched`);
  }
});

test('IP35: ids are deterministic from the context, not from tool arguments', async () => {
  const plan = { planId: 'plan_1', revision: 0, reservationCeiling: 0, requiredDecisions: [], actions: [] };
  const call = () => runProductionTool({
    name: 'production_propose_plan',
    args: { plan, expected_revision: 4 },
  }, ctx);
  const ctx = fakeContext();
  await call();
  await call();
  assert.equal(ctx.dispatched.length, 2);
  assert.equal(ctx.dispatched[0].envelope.commandId, ctx.dispatched[1].envelope.commandId);
  assert.equal(ctx.dispatched[0].envelope.idempotencyKey, ctx.dispatched[1].envelope.idempotencyKey);

  const otherTurn = fakeContext({ turnId: 'turn_2' });
  await runProductionTool({
    name: 'production_propose_plan',
    args: { plan, expected_revision: 4 },
  }, otherTurn);
  assert.notEqual(ctx.dispatched[0].envelope.commandId, otherTurn.dispatched[0].envelope.commandId);

  const forged = await runProductionTool({
    name: 'production_propose_plan',
    args: {
      plan,
      expected_revision: 4,
      commandId: 'cmd_attacker',
      idempotencyKey: 'key_attacker',
      actor: 'user',
      userEventId: 'ue_attacker',
    },
  }, ctx);
  assert.equal(forged.ok, false);
  assert.match(String(forged.error), /server-supplied|not accepted|cannot be supplied/i);
  assert.equal(ctx.dispatched.length, 2);
});

test('IP35: commands without a server user event are never dispatched', async () => {
  const ctx = fakeContext({ userEventId: undefined });
  const result = await runProductionTool({
    name: 'production_command',
    args: { kind: 'production.pause', payload: {}, expected_revision: 4 },
  }, ctx);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /user event/i);
  assert.equal(ctx.dispatched.length, 0);
});

test('IP35: production_command issues every allowed non-approval kind', async () => {
  for (const kind of AGENT_COMMAND_KINDS) {
    const ctx = fakeContext();
    const result = await runProductionTool({
      name: 'production_command',
      args: { kind, payload: kind === 'plan.propose' ? { planId: 'plan_1' } : {}, expected_revision: 3 },
    }, ctx);
    assert.equal(result.ok, true, `${kind} should be accepted`);
    assert.equal(result.status, 'issued');
    assert.equal(ctx.dispatched.length, 1);
    assert.equal(ctx.dispatched[0].envelope.kind, kind);
    assert.deepEqual(ctx.dispatched[0].envelope.expected, { productionRevision: 3 });
  }
});

test('IP35: resume, cancel, archive and action.cancel are refused even if called directly', async () => {
  for (const kind of NEVER_ALLOWED) {
    const ctx = fakeContext();
    const result = await runProductionTool({
      name: 'production_command',
      args: { kind, payload: {}, expected_revision: 4 },
    }, ctx);
    assert.equal(result.ok, false, `${kind} must be refused`);
    assert.match(String(result.error), /may not|cannot|forbidden/i);
    assert.equal(ctx.dispatched.length, 0);
  }
});

test('IP35: approval, spend and decision commands are refused even if called directly', async () => {
  for (const kind of FORBIDDEN_AGENT_COMMANDS) {
    const ctx = fakeContext();
    const result = await runProductionTool({
      name: 'production_command',
      args: { kind, payload: {}, expected_revision: 4 },
    }, ctx);
    assert.equal(result.ok, false, `${kind} must be refused`);
    assert.match(String(result.error), /may not|cannot|forbidden|unknown/i);
    assert.equal(ctx.dispatched.length, 0);
  }
});

test('IP35: an unknown command kind is refused without dispatching', async () => {
  const ctx = fakeContext();
  const result = await runProductionTool({
    name: 'production_command',
    args: { kind: 'production.self_destruct', payload: {}, expected_revision: 4 },
  }, ctx);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /unknown/i);
  assert.equal(ctx.dispatched.length, 0);
});

test('IP35: commands require expected_revision and never read it implicitly', async () => {
  const ctx = fakeContext();
  const missing = await runProductionTool({
    name: 'production_command',
    args: { kind: 'render.request', payload: {} },
  }, ctx);
  assert.equal(missing.ok, false);
  assert.match(String(missing.error), /expected_revision/);
  assert.equal(ctx.dispatched.length, 0);

  const explicit = await runProductionTool({
    name: 'production_command',
    args: { kind: 'render.request', payload: { deliveryId: 'del_1' }, expected_revision: 0 },
  }, fakeContext({ read: () => ({ production: { id: 'prod_1', revision: 9 }, revision: 9 }) }));
  assert.equal(explicit.ok, true);
  assert.deepEqual(explicit.command?.expected, { productionRevision: 0 });
});

test('IP35: capability restrictions are enforced at dispatch time', async () => {
  const ctx = fakeContext({ capabilities: { allowedCommands: ['stage.advance'] } });
  const paused = await runProductionTool({
    name: 'production_command',
    args: { kind: 'production.pause', payload: {}, expected_revision: 4 },
  }, ctx);
  assert.equal(paused.ok, false);
  assert.equal(ctx.dispatched.length, 0);

  const readOnly = fakeContext({ capabilities: { read: false } });
  const read = await runProductionTool({ name: 'production_read', args: {} }, readOnly);
  assert.equal(read.ok, false);

  const noProposal = fakeContext({ capabilities: { proposePlan: false } });
  const proposed = await runProductionTool({
    name: 'production_propose_plan',
    args: { plan: { planId: 'plan_1', revision: 0, reservationCeiling: 0, requiredDecisions: [], actions: [] }, expected_revision: 4 },
  }, noProposal);
  assert.equal(proposed.ok, false);
  assert.equal(noProposal.dispatched.length, 0);
});

test('IP35: a command backend failure is returned as a tool error, never thrown', async () => {
  const ctx = fakeContext({
    command: () => {
      throw Object.assign(new Error('revision conflict'), { code: 'REVISION_CONFLICT' });
    },
  });
  const result = await runProductionTool({
    name: 'production_command',
    args: { kind: 'artifact.attach', payload: { artifactId: 'art_1' }, expected_revision: 4 },
  }, ctx);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /could not|rejected|failed/i);
  assert.equal(result.code, 'REVISION_CONFLICT');
});

test('IP35: unknown tools and malformed arguments return errors', async () => {
  const ctx = fakeContext();
  const unknown = await runProductionTool({ name: 'production_approve', args: {} }, ctx);
  assert.equal(unknown.ok, false);
  assert.match(String(unknown.error), /unknown production tool/i);

  const badArgs = await runProductionTool({ name: 'production_command', args: [] }, ctx);
  assert.equal(badArgs.ok, false);

  const missingPlan = await runProductionTool({
    name: 'production_propose_plan',
    args: { expected_revision: 4 },
  }, ctx);
  assert.equal(missingPlan.ok, false);
  assert.match(String(missingPlan.error), /plan/i);
  assert.equal(ctx.dispatched.length, 0);

  const badPayload = await runProductionTool({
    name: 'production_command',
    args: { kind: 'stage.advance', payload: [], expected_revision: 4 },
  }, ctx);
  assert.equal(badPayload.ok, false);
  assert.match(String(badPayload.error), /payload/i);
  assert.equal(ctx.dispatched.length, 0);
});
