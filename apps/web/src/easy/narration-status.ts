/** A script is not narration audio. File availability is checked by delivery preflight. */
export function narrationPending(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const pkg = value as any;
  if (pkg.audio?.music?.trim || pkg.voice?.enabled !== true || pkg.voice?.engine === 'none') return false;
  const scenes = Array.isArray(pkg.scenes) ? pkg.scenes.filter((scene: any) => typeof scene?.narration === 'string' && scene.narration.trim()) : [];
  return scenes.some((scene: any) => {
    const asset = pkg.assets?.[scene.narration_asset];
    return asset?.kind !== 'audio' || asset?.status !== 'ready' || typeof asset?.file !== 'string' || !asset.file;
  });
}
