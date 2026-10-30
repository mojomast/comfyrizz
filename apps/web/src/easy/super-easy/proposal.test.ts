import assert from 'node:assert/strict';
import test from 'node:test';
import { proposalForPackage, renderSuperEasyProposal } from './proposal.ts';

test('the initial proposal offers a complete edit review before any paid generation', () => {
  const html = renderSuperEasyProposal({
    packageId: 'pkg_1', title: 'A test film', logline: 'A skater learns.',
    look: 'Photorealistic', soundtrack: 'Percussion', seconds: 12, shots: 2,
    basePrompt: 'A short film', revisionNotes: [],
  });
  assert.match(html, /class="super-easy-brand" aria-label="Comfyrizz"/u);
  assert.match(html, /class="super-easy-brand-name">Comfyrizz<\/span>/u);
  assert.match(html, /data-super-easy-review-edit-plan/u);
  assert.match(html, /Review &amp; edit full plan/u);
  assert.match(html, /data-super-easy-approve-proposal/u);
  assert.match(html, /Model-provider charges may apply to planning and revisions; paid GPU generation starts after you choose Make this film/u);
});

test('a 45 second narrated explainer shows provisional per-scene density warnings', () => {
  const pkg = { title: 'History', format: { fps: 30 }, voice: { enabled: true, engine: 'kokoro' }, scenes: Array.from({ length: 9 }, (_, index) => ({ id: `s${index + 1}`, preferredFrames: 150, narration: 'One two three four five six seven eight nine ten eleven twelve thirteen.' })) };
  const proposal = proposalForPackage(pkg, 'Explain the history in 45 seconds');
  assert.equal(proposal.seconds, 45);
  assert.match(proposal.narrationWarning!, /s1: 13 words \(roughly 8 for 5\.0s\)/);
  assert.match(renderSuperEasyProposal(proposal), /voice must be measured/);
  pkg.voice.enabled = false;
  assert.equal(proposalForPackage(pkg, 'silent').narrationWarning, undefined);
});

test('proposal uses the compiled exact target and allocated narration slots', () => {
  const pkg = {
    format: { fps: 30 }, duration: { mode: 'target', targetFrames: 1350, exact: true },
    voice: { enabled: true, engine: 'kokoro' },
    scenes: Array.from({ length: 7 }, (_, index) => ({ id: `s${index + 1}`, preferredFrames: 120, narration: 'One two three four five six seven eight nine ten.' })),
  };
  const proposal = proposalForPackage(pkg, '45 seconds');
  assert.equal(proposal.seconds, 45);
  assert.equal(proposal.narrationWarning, undefined);
});

test('source review exposes brief, scene claims and dataset provenance without asserting verification', () => {
  const proposal = proposalForPackage({
    scenes: [{ id: 's1', preferredFrames: 90, narration: 'Nine podiums.', copy: { headline: '<Nine>' }, data: { dataset: 'podiums', display: 'number' } }],
    datasets: { podiums: { source: 'derived', note: 'results.csv — P2 and P3 counts', values: [{ label: 'Podiums', value: 9 }] } },
  }, 'Use results.csv', ['Correct the count']);
  const html = renderSuperEasyProposal(proposal);
  assert.match(html, /Use results\.csv/);
  assert.match(html, /Correct the count/);
  assert.match(html, /Nine podiums\./);
  assert.match(html, /&lt;Nine&gt;/);
  assert.match(html, /results\.csv — P2 and P3 counts/);
  assert.match(html, /not automatically verified/);
  assert.match(html, /inspect visuals and source classifications/);
  assert.doesNotMatch(html, /<Nine>/);
});

test('review shows logline and dataset note changes without claiming verification', () => {
  const old = { scenes: [], proposal: { logline: 'Three podiums' }, datasets: { d: { note: '24 DNF' } } };
  const current = { scenes: [], proposal: { logline: 'Nine podiums' }, datasets: { d: { note: '18 DNF' } } };
  const html = renderSuperEasyProposal(proposalForPackage(current, 'Brief', [], false, old));
  assert.match(html, /Logline<\/strong><p>Before: Three podiums<\/p><p>After: Nine podiums/);
  assert.match(html, /d: Dataset source note<\/strong><p>Before: 24 DNF<\/p><p>After: 18 DNF/);
  assert.match(html, /exact replacement wording/);
  assert.match(html, /not automatically verified/);
});

test('comparison review exposes whole-scene overlays versus panel labels and their revision', () => {
  const old = { format: { width: 1920, height: 1080 }, scenes: [{ id: 's1', layout: 'compare', preferredFrames: 360,
    copy: { headline: 'BEFORE' }, lower_third: { text: 'AFTER' }, media: [{ asset: 'left' }, { asset: 'right' }] }] };
  const original = renderSuperEasyProposal(proposalForPackage(old, 'BEFORE left; AFTER right'));
  assert.match(original, /Whole-scene lower third:.*AFTER/);
  assert.match(original, /Left panel label: &quot;&quot;; Right panel label: &quot;&quot;/);
  const corrected = structuredClone(old);
  corrected.scenes[0] = { ...corrected.scenes[0], copy: { headline: '' }, lower_third: { text: '' },
    media: [{ asset: 'left', label: 'BEFORE' }, { asset: 'right', label: '<AFTER>' }] } as any;
  const proposal = proposalForPackage(corrected, 'Brief', [], false, old);
  assert.match(proposal.sourceReview!.scenes[0].copy, /Left panel label: "BEFORE"; Right panel label: "<AFTER>"/);
  assert.ok(proposal.revisionChanges!.some(change => change.label === 's1: On-screen copy' && change.after.includes('Right panel label: "<AFTER>"')));
  const html = renderSuperEasyProposal(proposal);
  assert.match(html, /&lt;AFTER&gt;/);
  assert.doesNotMatch(html, /<AFTER>/);
  corrected.format = { width: 1080, height: 1920 };
  assert.match(proposalForPackage(corrected, 'Brief').sourceReview!.scenes[0].copy, /Top panel label:.*Bottom panel label:/);
});

test('drawing review distinguishes hidden copy metadata from actual native text elements', () => {
  const proposal = proposalForPackage({ scenes: [{ id: 's1', layout: 'list',
    copy: { headline: 'RESERVOIR' }, lower_third: { text: 'COTTON WICK' },
    drawing: { elements: [{ type: 'text', text: 'ROOT ZONE' }] },
  }] }, 'A planter diagram');
  const copy = proposal.sourceReview!.scenes[0].copy;
  assert.match(copy, /Layout copy \(hidden by drawing\):.*RESERVOIR/);
  assert.match(copy, /Whole-scene lower third \(hidden by drawing\):.*COTTON WICK/);
  assert.match(copy, /Drawing text: \["ROOT ZONE"\]/);
});

test('mixed-film review distinguishes planned still panels from available generated motion', () => {
  const pkg = { assets: {
    left: { kind: 'image', status: 'pending', gen: { generator: 'flux3-klein' } },
    right: { kind: 'image', status: 'pending', gen: { generator: 'flux3-klein' } },
    motion: { kind: 'video', status: 'ready', gen: { generator: 'ltx25' } },
  }, scenes: [
    { id: 'suspects', layout: 'compare', background: { asset: 'motion' }, media: [{ asset: 'left', fit: 'contain', label: 'DISHWASHER' }, { asset: 'right', fit: 'contain', label: 'FERN' }] },
    { id: 'reveal', layout: 'list', media_only: true, background: { asset: 'motion' } },
  ] };
  const review = proposalForPackage(pkg, 'A fictional mystery');
  assert.match(review.sourceReview!.scenes[0].visual, /Two still-image panels with native labels/);
  assert.match(review.sourceReview!.scenes[0].visual, /planned; generation requires approval; fit contain/);
  assert.doesNotMatch(review.sourceReview!.scenes[0].visual, /Motion video|LTX/);
  assert.match(review.sourceReview!.scenes[1].visual, /Motion video \(LTX 2.5\): available/);
  assert.doesNotMatch(review.comfyContribution!, /LTX 2.5 in suspects/);
});

test('hidden media bindings do not claim visible generated footage in a proposal', () => {
  const video = { kind: 'video', status: 'ready', gen: { generator: 'fasth3-omni' } };
  for (const scene of [
    { id: 'drawing', drawing: { elements: [] }, background: { asset: 'video' } },
    { id: 'composition', composition: { layers: [] }, media: [{ asset: 'video' }] },
    { id: 'hidden-panels', layout: 'compare', media_only: true, media: [{ asset: 'video' }] },
  ]) {
    const review = proposalForPackage({ assets: { video }, scenes: [scene] }, 'Brief');
    assert.doesNotMatch(review.sourceReview!.scenes[0].visual, /Motion video|MiniMax H3/);
    assert.doesNotMatch(review.comfyContribution!, /MiniMax H3/);
  }
});
