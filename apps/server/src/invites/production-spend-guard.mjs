// Guard the server-owned outbox path, which can allocate compute independently
// of the browser's /api/run request. Reservations are persisted before the
// adapter is permitted to dispatch and are deliberately retained after an
// uncertain failure or process crash.
import { planPipeline } from '../pipeline-contract.mjs';
export function createInviteProductionSpendGuard({ adapter, ledger, spendEnabled = () => false } = {}) {
  if (!adapter || typeof adapter.admit !== 'function' || !ledger
      || typeof ledger.resourceOwner !== 'function' || typeof ledger.reserveAction !== 'function') {
    throw new TypeError('production spend guard requires an adapter and durable invite ledger');
  }
  function refuse(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }
  return Object.freeze({
    ...adapter,
    async admit(args = {}) {
      const { productionId, actionId, input } = args;
      if (input?.backendId !== 'cpu' && !spendEnabled()) refuse('INVITE_SPEND_DISABLED', 'Google Colab spend is disabled');
      const inviteId = ledger.resourceOwner('production', productionId);
      if (!inviteId) refuse('INVITE_OWNERSHIP_REQUIRED', 'production is not bound to an invite');
      if (input?.backendId === 'cpu') {
        const invite = ledger.get(inviteId);
        if (!invite || ['expired', 'revoked'].includes(invite.status)
            || ledger.resourceOwner('package', args.pkg?.id) !== inviteId) refuse('INVITE_OWNERSHIP_REQUIRED', 'project unavailable');
        const plan = planPipeline(args.pkg, input);
        if (input.budgetUnits !== 0 || input.narrationRuntime === 'colab' || input.renderLocation === 'colab'
            || input.comfyuiUrl || !plan.ready || plan.remoteVoice || plan.gpuMedia || plan.remoteRender) {
          refuse('INVITE_CPU_ONLY', 'CPU work must reuse ready media and cannot allocate remote compute');
        }
        return adapter.admit(args);
      }
      if (!spendEnabled()) refuse('INVITE_SPEND_DISABLED', 'Google Colab spend is disabled');
      if (input?.backendId !== 'colab') refuse('INVITE_COLAB_ONLY', 'invite productions require Google Colab');
      const reservation = ledger.reserveAction({ inviteId, productionId, actionId, backendId: input.backendId, units: input.budgetUnits });
      if (!reservation.ok) refuse('INVITE_BUDGET_REFUSED', `invite ${reservation.reason}`);
      return adapter.admit(args);
    },
  });
}
