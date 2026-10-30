import test from 'node:test';
import assert from 'node:assert/strict';
import { guestGenerationStatus } from '../../src/invites/generation-status.mjs';
import { guestProductionResult } from '../../src/invites/guest-result.mjs';

const fixture = () => ({ runId: 'pipe_example', packageId: 'pkg_example', origin: { productionId: 'prod_example', actionId: 'act_final' },
  status: 'running', currentStage: 'media', startedAt: '2026-10-30T05:00:00Z', updatedAt: '2026-10-30T05:00:20Z',
  tasks: { one: { stageId: 'media', id: 'one.still', status: 'completed' }, two: { stageId: 'media', id: 'two.plate', status: 'running', generator: 'ltx25', prompt: 'private prompt', file: '/private/source.png' },
    audio: { stageId: 'narration', id: 'narration', status: 'running' } },
  error: { message: 'token=PRIVATE_SECRET /private/path https://private.invalid' },
  runtimes: { media: { ownership: 'managed', state: 'running', session: 'private-session', accountBalance: 200 } },
});

test('guest activity reports actual media tasks and known model without raw worker data', () => {
  const value = guestGenerationStatus(fixture());
  assert.equal(value.status, 'running'); assert.equal(value.stage, 'media');
  assert.equal(value.totalJobs, 2); assert.equal(value.completedJobs, 1);
  assert.deepEqual(value.currentJob, { id: 'two.plate', model: 'LTX 2.5' });
  assert.equal(value.stopState, 'not_confirmed');
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_SECRET|private|accountBalance|prompt|session/);
});

test('terminal status, shutdown and unknown usage are independent facts', () => {
  const run = fixture(); run.status = 'failed'; run.currentStage = 'render';
  run.runtimes.media = { ownership: 'managed', state: 'stopped', shutdownVerified: true };
  const value = guestGenerationStatus(run, { units: 3, accounting: { status: 'unresolved', actualSpendCu: 0, shutdownVerified: true } });
  assert.equal(value.currentJob, null); assert.equal(value.stopState, 'stopped');
  assert.match(value.error, /render stage failed/);
  assert.deepEqual(value.accounting, { status: 'unresolved', reservedEstimateCu: 3, actualSpendCu: null, shutdownVerified: true });
  run.runtimes.narration = { ownership: 'managed', state: 'stop_unconfirmed', shutdownVerified: false };
  assert.equal(guestGenerationStatus(run).stopState, 'stop_unconfirmed');
});

test('guest result checks production ownership before exposing run activity', () => {
  const run = fixture();
  const ledger = { get: () => ({ status: 'active' }), resourceOwner: () => 'invite_owner', actionReservation: () => ({ units: 3 }) };
  const pipelines = { list: () => [run] };
  assert.equal(guestProductionResult({ inviteId: 'invite_other', productionId: 'prod_example', ledger, pipelines }), null);
  const value = guestProductionResult({ inviteId: 'invite_owner', productionId: 'prod_example', ledger, pipelines });
  assert.equal(value.runId, run.runId); assert.equal(value.completedJobs, 1);
  ledger.get = () => ({ status: 'revoked' });
  assert.equal(guestProductionResult({ inviteId: 'invite_owner', productionId: 'prod_example', ledger, pipelines }), null);
});
