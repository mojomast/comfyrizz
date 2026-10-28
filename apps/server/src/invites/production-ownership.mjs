import { deterministicProductionId } from '../productions/commands.mjs';

export function createInviteProductionOwnership({ ledger, store } = {}) {
  if (!ledger || typeof ledger.bindResource !== 'function' || typeof ledger.resourceOwner !== 'function'
      || !store || typeof store.read !== 'function') throw new TypeError('invite production ownership requires durable ledger and store');
  function forbidden(message) {
    const error = new Error(message);
    error.code = 'INVITE_RESOURCE_FORBIDDEN';
    error.status = 403;
    throw error;
  }
  function assertOwned(inviteId, kind, id) {
    if (ledger.resourceOwner(kind, id) !== inviteId) forbidden(`${kind} does not belong to this invite`);
  }
  function prepareCreate(context, envelope) {
    const inviteId = context?.inviteId;
    if (!inviteId) return;
    if (!envelope || typeof envelope.commandId !== 'string' || envelope.commandId.length === 0) forbidden('production command id required');
    // The command handler also accepts a nested production object and lets
    // callers select a budget ledger. Neither is safe for guest creation.
    if (!envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)
        || Object.keys(envelope.payload).some(key => !['packageId', 'conversationId'].includes(key))) {
      forbidden('unsupported guest production fields');
    }
    const packageId = envelope.payload?.packageId;
    const conversationId = envelope.payload?.conversationId;
    if (packageId != null) assertOwned(inviteId, 'package', packageId);
    if (conversationId != null) assertOwned(inviteId, 'conversation', conversationId);
    const productionId = deterministicProductionId(envelope.commandId);
    const owner = ledger.resourceOwner('production', productionId);
    if (owner && owner !== inviteId) forbidden('production does not belong to this invite');
    if (!owner && store.read(productionId)) forbidden('existing production is not invite-owned');
    ledger.bindResource(inviteId, 'production', productionId);
  }
  function assertAccess(context, productionId) {
    if (!context?.inviteId) return;
    const invite = ledger.get(context.inviteId);
    if (!invite || invite.status === 'expired' || invite.status === 'revoked') forbidden('invite is not active');
    assertOwned(context.inviteId, 'production', productionId);
  }
  return Object.freeze({ prepareCreate, assertAccess });
}
