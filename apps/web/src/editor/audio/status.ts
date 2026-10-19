/** Take / alignment / presenter freshness. Matches the section 7 invalidation table. */
import { conditioningHash, narrationInputFingerprint, textFingerprint } from './speech.ts';
import type { EditorPackage, EditorScene, ProjectDoc, SceneFreshness } from '../types.ts';

export function sceneUsesPresenter(pkg: EditorPackage, scene: EditorScene): boolean {
  if (scene.presenter === 'off') return false;
  if (scene.presenter === 'pip' || scene.presenter === 'split') return true;
  if (scene.presenter_asset) return true;
  const presenter = pkg.presenter;
  if (!presenter?.enabled) return false;
  const coverage = presenter.scenes ?? 'bookends';
  if (coverage === 'all') return true;
  if (Array.isArray(coverage)) return coverage.includes(scene.id);
  const ids = pkg.scenes.map(item => item.id);
  return scene.id === ids[0] || scene.id === ids[ids.length - 1];
}

export function sceneStatus(doc: ProjectDoc, sceneId: string): SceneFreshness {
  const scene = doc.pkg.scenes.find(item => item.id === sceneId);
  if (!scene) return { take: 'missing', alignment: 'missing', presenter: 'unused' };
  const expected = narrationInputFingerprint(scene, doc.pkg.voice);
  const take = doc.takes[sceneId];
  const takeStatus = !take ? 'missing' : take.inputFingerprint === expected ? 'fresh' : 'stale';
  const align = doc.alignment[sceneId];
  let alignment: SceneFreshness['alignment'] = 'missing';
  if (align) {
    const textOk = align.textFingerprint === textFingerprint(scene.narration ?? '');
    const hashOk = Boolean(take) && align.sourceHash === take.sourceHash;
    alignment = textOk && hashOk && takeStatus === 'fresh' ? 'fresh' : 'stale';
  }
  const clip = doc.presenterClips[sceneId];
  const used = sceneUsesPresenter(doc.pkg, scene);
  let presenter: SceneFreshness['presenter'] = 'unused';
  if (!used && !clip) presenter = 'unused';
  else if (!clip) presenter = 'missing';
  else if (takeStatus !== 'fresh' || !take) presenter = 'stale';
  else presenter = clip.conditioningHash === conditioningHash(take) ? 'fresh' : 'stale';
  return { take: takeStatus, alignment, presenter };
}

/** Only the rows the narration-text/voice edit is allowed to mark. */
export function staleWork(doc: ProjectDoc): string[] {
  const out: string[] = [];
  for (const scene of doc.pkg.scenes) {
    const status = sceneStatus(doc, scene.id);
    if (status.take === 'stale') out.push(`take:${scene.id}`);
    if (status.alignment === 'stale') out.push(`alignment:${scene.id}`);
    if (status.presenter === 'stale') out.push(`presenter:${scene.id}`);
  }
  return out;
}

/** Presenter assets only. Music, stills and plates are not listed. */
export function staleAssets(doc: ProjectDoc): string[] {
  const out: string[] = [];
  for (const scene of doc.pkg.scenes) {
    if (sceneStatus(doc, scene.id).presenter !== 'stale') continue;
    const clip = doc.presenterClips[scene.id];
    if (clip && !out.includes(clip.assetId)) out.push(clip.assetId);
  }
  return out;
}
