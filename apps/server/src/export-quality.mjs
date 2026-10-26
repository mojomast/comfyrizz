import { buildReceipt } from '../../../scripts/quality/receipt.mjs';
import { checkCaptionQuality } from '../../renderer/scripts/caption-quality.mjs';

/** Review evidence belongs to an exact rendered input set, including source bytes,
 * selected ranges, captions and composition. A changed cut invalidates its review.
 * This reports quality separately from container/export success; drafts still ship.
 */
export function exportQuality({ fingerprint, timeline, pkg, review }) {
  const current = review?.schema === 'comfyrizz.export-review/v1' &&
    typeof fingerprint === 'string' && /^[a-f0-9]{64}$/.test(fingerprint) && review.renderFingerprint === fingerprint;
  const findings = checkCaptionQuality({ timeline, pkg });
  const inputs = current && review.inputs && typeof review.inputs === 'object' ? review.inputs : {};
  const receipt = buildReceipt(inputs);
  if (findings.length) {
    receipt.states.captionReadability = 'failed';
    receipt.failures.push(...findings.map(f => ({ axis: 'captionReadability', code: f.code, message: f.message })));
  }
  // Automatic readability diagnostics may disprove a pass, never establish an
  // audible/semantic pass. Keep the full receipt's independent review dimensions.
  return { schema: 'comfyrizz.export-quality/v1', renderFingerprint: fingerprint,
    reviewBinding: current ? 'current' : review ? 'stale_or_invalid' : 'not_reviewed',
    captionFindings: findings, receipt,
    note: 'Technical delivery success is separate from story, action and audible performance review.' };
}
