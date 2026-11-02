import test from 'node:test';
import assert from 'node:assert/strict';
import { plannedShotSize, leadWithFraming } from '../src/framing.mjs';
import { applyPromptDefaults } from '../src/defaults.mjs';
import { lintSteer } from '../../../apps/server/src/ref-watch/steer.mjs';

test('planned shot sizes are detected; close shots are left alone', () => {
  assert.equal(plannedShotSize('Wide shot at night of Gus on a scooter'), 'wide');
  assert.equal(plannedShotSize('A full-body portrait of Nora on a pier'), 'wide');
  assert.equal(plannedShotSize('Extreme wide shot of a tiny figure on a dune'), 'extreme_wide');
  assert.equal(plannedShotSize('Medium shot of Gus clinging to the claw'), null);
  assert.equal(plannedShotSize('Close-up of an eye'), null);
});

test('a wide still leads with positive physical framing, once', () => {
  const led = leadWithFraming('Wide shot at night of Gus racing down a rainy street.');
  assert.equal(led.applied, true);
  assert.match(led.prompt, /^Wide shot, camera at a moderate distance, full body framed from head to toe/);
  assert.equal(lintSteer(led.lead).length, 0, 'the lead has no negative wording');
  assert.equal(leadWithFraming(led.prompt).applied, false, 'idempotent');
});

test('the planner applies the lead to stills only, and a package can opt out', () => {
  const still = { prompt: 'Wide shot of Gus on a scooter on a rainy street' };
  const r = applyPromptDefaults(still, { kind: 'still' });
  assert.ok(r.applied.some((a) => a.guard === 'framing'));
  assert.match(still.prompt, /^Wide shot, camera at a moderate distance/);
  const plate = { prompt: 'Wide shot of Gus on a scooter on a rainy street' };
  applyPromptDefaults(plate, { kind: 'plate', hasSourceImage: true });
  assert.doesNotMatch(plate.prompt, /moderate distance/);
  const off = { prompt: 'Wide shot of Gus on a scooter' };
  applyPromptDefaults(off, { kind: 'still', framingLead: false });
  assert.doesNotMatch(off.prompt, /moderate distance/);
});
