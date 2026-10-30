// Public model attribution contains names and roles, never provider credentials
// or private workflow paths. Planned models are explicitly distinct from used.
export function packageModels(pkg, { completed = false } = {}) {
  const rows = new Map();
  for (const asset of Object.values(pkg?.assets ?? {})) {
    if (typeof asset?.gen?.generator !== 'string' || !asset.gen.generator) continue;
    if (completed && asset.status !== 'ready') continue;
    const role = asset.kind === 'video' ? 'video' : asset.kind === 'image' ? 'image' : asset.kind === 'audio' ? 'audio' : 'graphics';
    const name = asset.gen.model || asset.gen.generator;
    rows.set(`${role}:${name}`, { role, name, generator: asset.gen.generator });
  }
  if (pkg?.voice?.enabled && pkg.voice.engine && pkg.voice.engine !== 'none') {
    rows.set(`narration:${pkg.voice.engine}`, { role: 'narration', name: pkg.voice.engine });
  }
  return [...rows.values()];
}

export function completedModels(pkg, contribution) {
  const verified = new Map();
  for (const { assetId, receipt } of (contribution?.contribution ?? contribution)?.evidence ?? []) {
    if (!receipt?.family || !receipt.checkpoint || receipt.status !== 'succeeded') continue;
    const role = pkg.assets?.[assetId]?.kind === 'video' ? 'video' : 'image';
    verified.set(`${role}:${receipt.checkpoint}`, { role, name: receipt.family,
      checkpoint: receipt.checkpoint, generator: receipt.generator, evidence: 'verified_workflow' });
  }
  const verifiedGenerators = new Set([...verified.values()].map(model => model.generator));
  return [...verified.values(), ...packageModels(pkg, { completed: true })
    .filter(model => !verifiedGenerators.has(model.generator))
    .map(model => ({ ...model, evidence: 'completed_package' }))];
}
