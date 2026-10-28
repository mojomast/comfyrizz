import assert from 'node:assert/strict';
import test from 'node:test';
import { renderSuperEasyProposal } from './proposal.ts';

test('the initial proposal offers a complete edit review before any paid generation', () => {
  const html = renderSuperEasyProposal({
    packageId: 'pkg_1', title: 'A test film', logline: 'A skater learns.',
    look: 'Photorealistic', soundtrack: 'Percussion', seconds: 12, shots: 2,
    basePrompt: 'A short film', revisionNotes: [],
  });
  assert.match(html, /data-super-easy-review-edit-plan/u);
  assert.match(html, /Review &amp; edit full plan/u);
  assert.match(html, /data-super-easy-approve-proposal/u);
  assert.match(html, /Nothing is generated or charged until you choose Make this film/u);
});
