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
