import { superEasyBrandMarkup } from './brand.ts';
import { compileTimeline } from '../../../../../packages/planner/dist/src/browser.js';

export interface SuperEasyProposal {
  packageId: string | null;
  title: string;
  logline: string;
  look: string;
  soundtrack: string;
  seconds: number;
  shots: number;
  basePrompt: string;
  revisionNotes: string[];
  narrationWarning?: string;
  narrationReview?: Array<{ id: string; narration: string }>;
  sourceReview?: { brief: string; scenes: Array<{ id: string; narration: string; copy: string; data: string; visual: string }>; datasets: Array<{ id: string; details: string }> };
  revisionChanges?: Array<{ label: string; before: string; after: string }>;
  reviewedPackageRevision?: number;
  hasNarration?: boolean;
  motionModel?: 'auto' | 'h3' | 'ltx' | 'klein';
  comfyContribution?: string;
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function short(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1).trimEnd()}…`;
}

/** Keep the review faithful to native text outside scene.copy as well. */
function sceneTextReview(scene: any, format: any): string {
  const parts: string[] = [];
  const layoutHidden = scene?.drawing ? ' (hidden by drawing)' : scene?.media_only === true ? ' (hidden by media-only mode)' : '';
  if (scene?.copy && Object.keys(scene.copy).length) parts.push(`Layout copy${layoutHidden}: ${JSON.stringify(scene.copy)}`);
  if (scene?.lower_third) parts.push(`Whole-scene lower third${scene?.drawing ? ' (hidden by drawing)' : ''}: ${JSON.stringify(scene.lower_third)}`);
  if (['split', 'compare'].includes(scene?.layout)) {
    const stacked = Number(format?.height) > Number(format?.width) * 1.2;
    const positions = stacked ? ['Top', 'Bottom'] : ['Left', 'Right'];
    for (const [index, plate] of (Array.isArray(scene.media) ? scene.media : []).slice(0, 2).entries()) {
      parts.push(`${positions[index]} panel label${layoutHidden}: ${JSON.stringify(plate?.label ?? '')}`);
    }
  }
  const drawingText = (Array.isArray(scene?.drawing?.elements) ? scene.drawing.elements : [])
    .filter((element: any) => element?.type === 'text').map((element: any) => element.text);
  if (drawingText.length) parts.push(`Drawing text: ${JSON.stringify(drawingText)}`);
  return parts.join('; ');
}

export function proposalForPackage(pkg: any, basePrompt: string, revisionNotes: string[] = [], narrationRevised = false, previousPackage?: any): SuperEasyProposal {
  const scenes = Array.isArray(pkg?.scenes) ? pkg.scenes : [];
  const fps = Number(pkg?.format?.fps) > 0 ? Number(pkg.format.fps) : 30;
  const frames = scenes.reduce((sum: number, scene: any) => sum + (Number(scene?.preferredFrames) > 0 ? Number(scene.preferredFrames) : 0), 0);
  let timeline: ReturnType<typeof compileTimeline> | undefined;
  try { timeline = compileTimeline(pkg); } catch { /* Incomplete drafts still get a proposal. */ }
  const creative = pkg?.proposal && typeof pkg.proposal === 'object' ? pkg.proposal : {};
  const first = scenes[0]?.copy?.headline;
  const last = scenes.at(-1)?.copy?.headline;
  const story = first && last && first !== last ? `From “${first}” to “${last}”.` : text(first, 'A story built from your idea.');
  const overfull = pkg?.voice?.enabled === true && pkg?.voice?.engine !== 'none' && !pkg?.audio?.music?.trim
    ? scenes.flatMap((scene: any) => {
        const line = typeof scene?.narration === 'string' ? scene.narration.trim() : '';
        const compiled = timeline?.scenes.find(item => item.id === scene.id);
        const seconds = compiled ? (compiled.durationInFrames - compiled.transitionOutFrames) / fps : Number(scene?.preferredFrames) / fps;
        if (!line || !Number.isFinite(seconds) || seconds <= 0) return [];
        const words = line.split(/\s+/u).length;
        const target = Math.max(0, Math.floor((seconds - 0.5) * 1.8));
        return words > target ? [`${scene.id}: ${words} words (roughly ${target} for ${seconds.toFixed(1)}s)`] : [];
      }) : [];
  const changes: Array<{ label: string; before: string; after: string }> = [];
  if (previousPackage) {
    const before = previousPackage.proposal?.logline ?? '';
    const after = pkg?.proposal?.logline ?? '';
    if (before !== after) changes.push({ label: 'Logline', before: String(before), after: String(after) });
    for (const [id, dataset] of Object.entries(pkg?.datasets ?? {}) as Array<[string, any]>) {
      const old = previousPackage.datasets?.[id];
      if (old && old.label !== dataset?.label) changes.push({ label: `${id}: Dataset display name`, before: String(old.label ?? ''), after: String(dataset?.label ?? '') });
      if (old && old.note !== dataset?.note) changes.push({ label: `${id}: Dataset source note`, before: String(old.note ?? ''), after: String(dataset?.note ?? '') });
      if (old && JSON.stringify(old.values) !== JSON.stringify(dataset?.values)) changes.push({ label: `${id}: Dataset values`, before: JSON.stringify(old.values ?? []), after: JSON.stringify(dataset?.values ?? []) });
    }
  }
  if (previousPackage && Array.isArray(previousPackage.scenes)) {
    const oldOrder = previousPackage.scenes.map((scene: any) => scene.id).join(' → ');
    const newOrder = scenes.map((scene: any) => scene.id).join(' → ');
    if (oldOrder !== newOrder) changes.push({ label: 'Scene order', before: oldOrder, after: newOrder });
    for (const scene of scenes) {
      const old = previousPackage.scenes.find((item: any) => item.id === scene.id);
      if (!old) continue;
      if (!old.drawing?.source && scene.drawing?.source) {
        let count = 'Source-bound tile wall';
        try { count = `${JSON.parse(scene.drawing.source.description).count} source-bound tiles`; } catch { /* Keep generic description. */ }
        changes.push({ label: `${scene.id}: Tile wall`, before: 'Previous scene visual', after: count });
      }
      if (old.drawing?.source && scene.drawing?.source && JSON.stringify(old.drawing) !== JSON.stringify(scene.drawing)) {
        const summary = (drawing: any) => {
          try { const source = JSON.parse(drawing.source.description); return JSON.stringify({ colors: source.colors, rules: source.rules, require_categories: source.require_categories, label_column: source.label_column ?? null }); }
          catch { return 'Source-backed drawing changed'; }
        };
        changes.push({ label: `${scene.id}: Tile wall categories`, before: summary(old.drawing), after: summary(scene.drawing) });
      }
      for (const [label, before, after] of [
        ['Narration', old.narration ?? '', scene.narration ?? ''],
        ['On-screen copy', sceneTextReview(old, previousPackage.format), sceneTextReview(scene, pkg.format)],
      ]) if (before !== after) changes.push({ label: `${scene.id}: ${label}`, before: String(before), after: String(after) });
    }
  }
  return {
    packageId: typeof pkg?.id === 'string' ? pkg.id : null,
    title: text(pkg?.title, 'Your film'),
    logline: short(text(creative.logline, story), 240),
    look: short(text(creative.look, 'A coherent, stylized look'), 100),
    soundtrack: short(text(creative.soundtrack, 'Sound designed for the story'), 100),
    comfyContribution: (() => {
      const families: Record<string, string> = { 'flux3-klein': 'FLUX 3 Image Klein', ltx25: 'LTX 2.5', 'ltx25-a2v': 'LTX 2.5', 'fasth3-omni': 'MiniMax H3' };
      const uses = scenes.flatMap((scene: any) => [scene.background?.asset, ...(scene.foreground ?? []).map((item: any) => item.asset), ...(scene.media ?? []).map((item: any) => item.asset)].flatMap(id => {
        const asset = pkg.assets?.[id]; const family = families[asset?.gen?.generator];
        return family ? [`${family} in ${scene.id}${asset.status === 'ready' ? ' (generation evidence checked at export)' : ' (generation requires approval)'}`] : [];
      }));
      return [...new Set(uses)].join('; ') || 'A visible ComfyUI model contribution is required before final export.';
    })(),
    seconds: Math.max(1, Math.round((timeline?.durationInFrames ?? frames) / fps)),
    shots: scenes.length,
    basePrompt,
    revisionNotes: [...revisionNotes],
    sourceReview: {
      brief: basePrompt,
      scenes: scenes.map((scene: any) => ({
        id: String(scene?.id ?? 'Scene'),
        narration: typeof scene?.narration === 'string' ? scene.narration : '',
        copy: sceneTextReview(scene, pkg?.format),
        data: scene?.data ? JSON.stringify(scene.data) : '',
        visual: (() => {
          if (!scene?.drawing) return 'No procedural drawing';
          try {
            const source = JSON.parse(scene.drawing.source.description);
            return `Source-bound drawing: ${source.count} tiles; ${source.label_column ? `labels from ${source.label_column}` : 'no per-tile labels'}; ${source.reveal_frames ? `reveals over ${source.reveal_frames} frames` : 'no tile reveal'}.`;
          } catch { return `Procedural drawing: ${scene.drawing.elements?.length ?? 0} elements`; }
        })(),
      })),
      datasets: pkg?.datasets && typeof pkg.datasets === 'object' && !Array.isArray(pkg.datasets)
        ? Object.entries(pkg.datasets).map(([id, dataset]) => ({ id, details: JSON.stringify(dataset) })) : [],
    },
    ...(scenes.some((scene: any) => typeof scene?.narration === 'string' && scene.narration.trim()) ? { hasNarration: true } : {}),
    ...(Number.isSafeInteger(pkg?.revision) ? { reviewedPackageRevision: pkg.revision } : {}),
    ...(previousPackage ? { revisionChanges: changes } : {}),
    ...(narrationRevised ? { narrationReview: scenes.filter((scene: any) => typeof scene?.narration === 'string' && scene.narration.trim()).map((scene: any) => ({ id: String(scene.id), narration: scene.narration })) } : {}),
    ...(overfull.length ? { narrationWarning: `Estimated narration may be too dense: ${overfull.join('; ')}. Transition overlaps can reduce available time. These are rough planning estimates; the voice must be measured.` } : {}),
  };
}

export function renderSuperEasyProposal(proposal: SuperEasyProposal): string {
  const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
  const model = proposal.motionModel === 'h3' ? 'MiniMax H3' : proposal.motionModel === 'ltx' ? 'LTX-2.5' : proposal.motionModel === 'klein' ? 'Klein only: stills + code motion' : 'Auto: Klein + H3 + LTX';
  return `<section class="super-easy-proposal" data-super-easy-proposal>
${superEasyBrandMarkup()}
<p class="super-easy-proposal-eyebrow">Your film proposal</p>
<h1>${escape(proposal.title)}</h1>
<p class="super-easy-proposal-logline">${escape(proposal.logline)}</p>
<ul class="super-easy-proposal-facts"><li>${proposal.shots} shots</li><li>${proposal.seconds} seconds</li><li>${escape(proposal.look)}</li><li>${escape(proposal.soundtrack)}</li><li>${escape(model)}</li></ul>
${proposal.comfyContribution ? `<p data-comfy-contribution>ComfyUI: ${escape(proposal.comfyContribution)}</p>` : ''}
 ${proposal.narrationWarning ? `<p role="status">${escape(proposal.narrationWarning)}</p>` : ''}
 ${proposal.revisionChanges ? `<section aria-label="Proposal changes"><h2>Review proposed changes</h2><p>Check that these changes satisfy your request and agree with your sources. Factual accuracy is not automatically verified.</p><ol>${proposal.revisionChanges.map(change => `<li><strong>${escape(change.label)}</strong><p>Before: ${escape(change.before)}</p><p>After: ${escape(change.after)}</p></li>`).join('')}</ol></section>` : ''}
 ${proposal.sourceReview ? `<details class="super-easy-source-review" open><summary>Review story and sources</summary><p>Check each claim, on-screen text, data and visual against your brief and original sources before approval. Source notes are provided by the draft and are not proof of accuracy. Facts and visual classifications are not automatically verified.</p><h3>Your brief</h3><p>${escape(proposal.sourceReview.brief)}</p>${proposal.revisionNotes.length ? `<h3>Requested changes</h3><ul>${proposal.revisionNotes.map(note => `<li>${escape(note)}</li>`).join('')}</ul>` : ''}<h3>Scene text and data references</h3><ol>${proposal.sourceReview.scenes.map(scene => `<li><strong>${escape(scene.id)}</strong><p>Visual: ${escape(scene.visual)}</p>${scene.narration ? `<p>Narration: ${escape(scene.narration)}</p>` : ''}${scene.copy ? `<p>On-screen copy: ${escape(scene.copy)}</p>` : ''}${scene.data ? `<p>Data reference: ${escape(scene.data)}</p>` : ''}</li>`).join('')}</ol>${proposal.sourceReview.datasets.length ? `<h3>Draft datasets and source notes</h3><ul>${proposal.sourceReview.datasets.map(dataset => `<li><strong>${escape(dataset.id)}</strong>: ${escape(dataset.details)}</li>`).join('')}</ul>` : '<p>No dataset source notes are included in this draft.</p>'}<p>Use Review &amp; edit full plan to inspect visuals and source classifications, including any legends.</p></details>` : ''}
 ${proposal.narrationReview ? `<section aria-label="Narration review"><h2>Review revised narration</h2><p>Check the narration and the existing on-screen text and data against your source before approval. Factual accuracy is not automatically verified; narration timing must be measured again.</p><ol>${proposal.narrationReview.map(scene => `<li><strong>${escape(scene.id)}</strong>: ${escape(scene.narration)}</li>`).join('')}</ol></section>` : ''}
 ${proposal.hasNarration ? `<button type="button" class="btn btn-secondary" data-super-easy-shorten-narration="${proposal.seconds}">Shorten narration for this length</button>` : ''}
<p class="super-easy-proposal-question">Does this sound right, or would you like to change anything?</p>
<div class="super-easy-proposal-actions"><button type="button" class="btn btn-secondary" data-super-easy-review-edit-plan>Review &amp; edit full plan</button><button type="button" class="btn btn-primary" data-super-easy-approve-proposal>Make this film</button></div>
 <form class="super-easy-proposal-revise" data-super-easy-revise-proposal><label for="super-easy-proposal-change">Change the proposal</label><div><textarea id="super-easy-proposal-change" rows="2" placeholder="For example: correct the narration in the second shot"></textarea><button type="submit" class="btn btn-secondary">Revise proposal</button></div><p class="hint">Focused revisions can edit the logline, scene text, dataset display names, categories and notes, or reorder existing scenes. To recompute a dataset from the original CSV, name its dataset ID, source, grouping column and row filters; request other changes separately. Source-bound tile walls can also be corrected or created from the original upload in an existing scene. Name the scene ID or scene number when changing a wall; for dataset labels or notes, include the exact replacement wording in your request; review the original source yourself. For other changes to visuals, timing or assets, use the full plan editor. Model-provider charges may apply to planning and revisions; paid GPU generation starts after you choose Make this film.</p></form>
</section>`;
}
