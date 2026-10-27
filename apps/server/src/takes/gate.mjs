// TR09: the final-render gate. A clip is only approved when its selected take's
// verdict is approved (and that take still matches the asset's current gen). This
// module is pure: the caller supplies the package, the takes sidecar and the clips.

import { listClips } from './clips.mjs';
import { deriveClipState } from './model.mjs';

// Generators that run without a GPU. `rg "generator: '" packages/agent/src`
// finds `llm-svg` (CPU) and `flux3-klein` (GPU). Kokoro is a voice engine, not
// a generator string in that tree, so it is not in this set.
export const CPU_GENERATORS = new Set(['llm-svg', 'procedural-audio']);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Evaluate every reviewable clip against its selected take.
 *
 * A CPU clip with zero takes is approved without a review (`autoApproved`).
 * A ready uploaded or stock still image with zero takes is too: it is already
 * the chosen source. Ready uploaded or stock video and audio are not, and a
 * ready LTX presenter clip is not. Those, a CPU clip that has takes, and every
 * other clip are judged by `deriveClipState`.
 *
 * @param {object} pkg package document
 * @param {object|null} takeDoc `comfyrizz.takes/v1` sidecar
 * @param {Array<{clipId: string, assetId: string}>} [clips] clips from TR03;
 *   derived from the package when omitted
 * @param {{references?: object|Map|Array|Function|null}} [options] reference index for
 *   freshness; defaults to the package, whose assets are the direct/transitive inputs
 * @returns {{ok: boolean, approved: number, total: number, blocking: Array<{clipId: string, state: string}>, autoApproved: number}}
 */
export function finalGate(pkg, takeDoc, clips, options = {}) {
  const list = Array.isArray(clips) ? clips : listClips(isObject(pkg) ? pkg : {});
  const refs = isObject(options) && options.references !== undefined ? options.references : pkg;
  const blocking = [];
  let approved = 0;
  let autoApproved = 0;

  for (const clip of list) {
    if (!isObject(clip) || typeof clip.clipId !== 'string') continue;
    const assetId = typeof clip.assetId === 'string' ? clip.assetId : null;
    const entry = assetId && isObject(takeDoc?.clips?.[assetId]) ? takeDoc.clips[assetId] : null;
    const asset = assetId && isObject(pkg?.assets?.[assetId]) ? pkg.assets[assetId] : null;
    const takes = Array.isArray(entry?.takes) ? entry.takes : [];
    const generator = isObject(asset?.gen) && typeof asset.gen.generator === 'string'
      ? asset.gen.generator
      : null;
    // A ready uploaded or stock still (a character portrait, a supplied chart)
    // is already the chosen source. Video and audio from those origins, and
    // ready LTX presenter clips, still need an approved take.
    const importedStill = isObject(asset)
      && asset.kind === 'image'
      && asset.status === 'ready'
      && (asset.origin === 'upload' || asset.origin === 'stock');
    if (takes.length === 0 && (importedStill || (generator && CPU_GENERATORS.has(generator)))) {
      approved += 1;
      autoApproved += 1;
      continue;
    }
    const state = deriveClipState({
      clip: isObject(asset) ? asset : clip,
      takes: isObject(entry) ? entry : { selected: null, takes: [] },
      assetGen: isObject(asset?.gen) ? asset.gen : undefined,
      refs,
    });
    if (state === 'approved') approved += 1;
    else blocking.push({ clipId: clip.clipId, state });
  }

  return { ok: blocking.length === 0, approved, total: list.length, blocking, autoApproved };
}

export default finalGate;
