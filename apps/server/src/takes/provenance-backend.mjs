// Schema package-v1 accepts only these gen.backend tags (see package-v1.schema.json).
// The run controller's factory id is bare "colab"; H-FIX7 taught applyManifestToPackage
// to stamp colab:<hardware> via appliedBackendId. Take ingest and take selection must
// use the same compliance tag — otherwise selectTake fails with
// `selected take would not validate: .../gen/backend: must match pattern ...`.

import { COMFYRIZZ_RUNTIME } from '../../../../packages/backends/src/colab-plan.mjs';

export const PROVENANCE_BACKEND_RE = /^(colab:[A-Za-z0-9]+|byo-comfyui(:v2)?|cpu)$/;

/**
 * Pick the first schema-valid provenance backend from candidates.
 * Bare factory id `"colab"` maps to the configured accelerator (`colab:G4`).
 * ComfyUI URLs and other non-tags are skipped.
 *
 * @param {...unknown} candidates
 * @returns {string | undefined}
 */
export function provenanceBackend(...candidates) {
  for (const value of candidates) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    const trimmed = value.trim();
    if (PROVENANCE_BACKEND_RE.test(trimmed)) return trimmed;
    if (trimmed === 'colab') return COMFYRIZZ_RUNTIME.id;
  }
  return undefined;
}
