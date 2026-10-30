// Simulated historical failure for CPU-only HTTP/UI integration tests.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PackageStore } from '../../src/store.mjs';
import { createProductionStore } from '../../src/productions/store.mjs';
import { recoveryFixture, recoveryPackage } from '../../../../packages/jobs/test/recovery-fixture.mjs';

export function seedRecoveryRuntime(runtimeDir) {
  const store = new PackageStore(join(runtimeDir, 'packages'));
  const pkg = store.write(recoveryPackage());
  const runId = 'run_failed_fixture';
  const f = recoveryFixture(join(runtimeDir, 'runs', runId), pkg);
  const productionStore = createProductionStore({ runtimeDir });
  const productionId = 'prod_recoveryfixture';
  productionStore.create({ schema: 'comfyrizz.production/v1', id: productionId, revision: 0,
    conversationId: 'conv_fixture', packageId: pkg.id, intent: 'active', briefVersionId: null, scriptVersionId: null,
    shotIds: [], characterBindings: [], reviewPolicy: { requireUserVerdict: true }, budgetLedgerId: 'ledger_fixture',
    pendingDecisionIds: [], actionIds: ['act_final'], latestDeliveryId: null, lastSequence: 0 });
  const planHash = 'a'.repeat(64);
  productionStore.commit(productionId, { commandId: 'cmd_fixture_history', baseRevision: 0,
    production: productionStore.read(productionId), events: [
      { type: 'plan.approved', data: { planHash, packageRevision: pkg.revision } },
      { type: 'action.state_changed', data: { id: 'act_final', productionId, runId, state: 'failed', kind: 'final', planHash,
        expected: { packageRevision: pkg.revision } } },
    ] });
  const state = { schema: 'comfyrizz.run-record/v1', runId, packageId: pkg.id, productionId, actionId: 'act_final', actionPlanHash: planHash,
    backendId: 'colab', status: 'failed', finished: true, teardown: { state: 'stopped' }, settlement: { kind: 'reservation_unverified', units: 1 }, render: null };
  const statePath = join(runtimeDir, 'runs', runId, 'state.json'); writeFileSync(statePath, JSON.stringify(state));
  return { ...f, runId, state, statePath, productionStore };
}
