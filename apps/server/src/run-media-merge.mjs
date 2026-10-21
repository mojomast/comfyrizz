import { isDeepStrictEqual } from 'node:util';

/** Rebase only newly generated media onto the current edit, never an old timeline. */
export function mergeRunMedia({ staged, current, generated }) {
  if (!current) return structuredClone(generated);
  const next = structuredClone(current);
  for (const [id, asset] of Object.entries(generated.assets ?? {})) {
    const before = staged.assets?.[id];
    const live = current.assets?.[id];
    // An edited prompt, replaced file, deleted asset or approved replacement wins.
    // Failed/pending outputs cannot demote media already present in the project.
    if (!before || !live || asset.status !== 'ready'
      || (before.status === 'ready' && (before.file !== asset.file || before.sha256 !== asset.sha256))
      || !asset.file || !isDeepStrictEqual(before, live)) continue;
    next.assets[id] = structuredClone(asset);
  }
  if (Array.isArray(generated.compliance?.backends_used)) {
    next.compliance = { ...next.compliance, backends_used: [...new Set([
      ...(next.compliance?.backends_used ?? []), ...generated.compliance.backends_used,
    ])] };
  }
  return next;
}

/** Copy only accepted outputs, not same-named files belonging to an owner edit. */
export function changedRunMedia(current, merged) {
  return { assets: Object.fromEntries(Object.entries(merged.assets ?? {})
    .filter(([id, asset]) => !isDeepStrictEqual(current?.assets?.[id], asset))) };
}
