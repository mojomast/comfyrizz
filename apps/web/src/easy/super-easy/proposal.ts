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
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function short(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1).trimEnd()}…`;
}

export function proposalForPackage(pkg: any, basePrompt: string, revisionNotes: string[] = []): SuperEasyProposal {
  const scenes = Array.isArray(pkg?.scenes) ? pkg.scenes : [];
  const fps = Number(pkg?.format?.fps) > 0 ? Number(pkg.format.fps) : 30;
  const frames = scenes.reduce((sum: number, scene: any) => sum + (Number(scene?.preferredFrames) > 0 ? Number(scene.preferredFrames) : 0), 0);
  const creative = pkg?.proposal && typeof pkg.proposal === 'object' ? pkg.proposal : {};
  const first = scenes[0]?.copy?.headline;
  const last = scenes.at(-1)?.copy?.headline;
  const story = first && last && first !== last ? `From “${first}” to “${last}”.` : text(first, 'A story built from your idea.');
  return {
    packageId: typeof pkg?.id === 'string' ? pkg.id : null,
    title: text(pkg?.title, 'Your film'),
    logline: short(text(creative.logline, story), 240),
    look: short(text(creative.look, 'A coherent, stylized look'), 100),
    soundtrack: short(text(creative.soundtrack, 'Sound designed for the story'), 100),
    seconds: Math.max(1, Math.round(frames / fps)),
    shots: scenes.length,
    basePrompt,
    revisionNotes: [...revisionNotes],
  };
}

export function renderSuperEasyProposal(proposal: SuperEasyProposal): string {
  const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
  return `<section class="super-easy-proposal" data-super-easy-proposal>
<p class="super-easy-proposal-eyebrow">Your film proposal</p>
<h1>${escape(proposal.title)}</h1>
<p class="super-easy-proposal-logline">${escape(proposal.logline)}</p>
<ul class="super-easy-proposal-facts"><li>${proposal.shots} shots</li><li>${proposal.seconds} seconds</li><li>${escape(proposal.look)}</li><li>${escape(proposal.soundtrack)}</li></ul>
<p class="super-easy-proposal-question">Does this sound right, or would you like to change anything?</p>
<div class="super-easy-proposal-actions"><button type="button" class="btn btn-primary" data-super-easy-approve-proposal>Make this film</button></div>
<form class="super-easy-proposal-revise" data-super-easy-revise-proposal><label for="super-easy-proposal-change">Change the proposal</label><div><textarea id="super-easy-proposal-change" rows="2" placeholder="For example: make it more playful and keep it under 20 seconds"></textarea><button type="submit" class="btn btn-secondary">Revise proposal</button></div><p class="hint">Nothing is generated or charged until you choose Make this film.</p></form>
</section>`;
}
