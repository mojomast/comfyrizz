// FLUX 3 Image Klein is a distilled model: 16 steps is the consensus final
// setting. 8 steps is inside the documented 4-16 range but is unproven for
// Klein-3, so a draft run is experimental and says so in params._draft_note.
export const KLEIN_STEPS = Object.freeze({ final: 16, draft: 8 });
export const KLEIN_DRAFT_EXPERIMENTAL = true;

const DRAFT_NOTE =
  'experimental: 8 steps is unproven for FLUX 3 Image Klein; final runs use 16';

/** Return a copy of the graph params. Draft mode rewrites only `steps` and adds `_draft_note` (underscore params are skipped by the runner's unknown-param check); it never touches cfg, sampler or scheduler. */
export function applyKleinDraft(params = {}, { draft = false } = {}) {
  const copy = { ...params };
  if (!draft) return copy;
  copy.steps = KLEIN_STEPS.draft;
  copy._draft_note = DRAFT_NOTE;
  return copy;
}
