import { realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { safeMediaPath } from '../media-range.mjs';

// Only the pipeline recorded as originating from this invite's production can
// produce a guest result. The opaque media ticket is checked again on every
// request, including byte-range requests, so revocation and file replacement
// cannot turn an old ticket into access to another file.
export function guestProductionResult({ inviteId, productionId, ledger, pipelines, tickets, runId = null, authorizeViewer = () => true }) {
  const invite = ledger.get(inviteId);
  if (!invite || ['expired', 'revoked'].includes(invite.status)
      || ledger.resourceOwner('production', productionId) !== inviteId) return null;
  const run = pipelines.list().filter(item => item.origin?.productionId === productionId && (!runId || item.runId === runId))
    .sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')))[0];
  if (!run) return { status: 'pending' };
  if (run.status !== 'completed') {
    return { status: ['failed', 'cancelled', 'interrupted'].includes(run.status) ? 'failed' : 'running' };
  }
  if (!run.result?.files?.some(item => item.name === 'video.mp4')) return { status: 'failed' };
  const directory = pipelines.directory(run.runId);
  if (!directory || typeof run.packageId !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(run.packageId)) return { status: 'failed' };
  const exportRoot = resolve(directory, 'exports', run.packageId);
  const target = safeMediaPath(exportRoot, 'video.mp4');
  const authorize = () => {
    const current = ledger.get(inviteId);
    const currentRun = pipelines.get(run.runId);
    if (!authorizeViewer() || !current || ['expired', 'revoked'].includes(current.status)
        || ledger.resourceOwner('production', productionId) !== inviteId
        || currentRun?.status !== 'completed' || currentRun.origin?.productionId !== productionId
        || currentRun.packageId !== run.packageId
        || !currentRun.result?.files?.some(item => item.name === 'video.mp4') || !target) return false;
    try {
      const realDirectory = realpathSync(directory);
      const realRoot = realpathSync(exportRoot);
      const realTarget = realpathSync(target);
      return realRoot.startsWith(realDirectory + sep) && realTarget.startsWith(realRoot + sep) && statSync(realTarget).isFile();
    } catch { return false; }
  };
  if (!authorize()) return { status: 'failed' };
  const ticket = tickets.mint(target, { authorize });
  return { status: 'completed', url: ticket.url, expiresAt: ticket.expiresAt };
}
