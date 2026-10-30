// PS09: auto motion routing keeps camera-led establishing/scenery shots on LTX
// and sends character acting to FastH3, using characterCount plus the subject.
// These are fixture-like ShotMotionDirection objects; no live suite is started.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

function sourceUrl(candidates: string[]): URL {
  for (const candidate of candidates) {
    const url = new URL(candidate, import.meta.url);
    if (existsSync(url)) return url;
  }
  throw new Error(`none of ${candidates.join(', ')} exists`);
}

const motionModelUrl = sourceUrl(['../src/motion-model.ts', '../src/motion-model.js']);
const { autoMotionModel } = await import(motionModelUrl.href) as typeof import('../src/motion-model.js');
type ShotMotionDirection = import('../src/motion-model.js').ShotMotionDirection;

function direction(overrides: Partial<ShotMotionDirection> = {}): ShotMotionDirection {
  return {
    subject: 'The reef',
    composition: 'A wide reef at dawn',
    action: 'Scenery drifting',
    camera: 'A slow wide drift',
    soundscape: 'Wind and water',
    characterCount: 0,
    ...overrides,
  };
}

test('H24, T30 and W20 shaped directions route ltx,h3,h3', () => {
  const h24 = [
    direction({
      subject: 'The lighthouse',
      composition: 'A lighthouse on a rocky headland at dusk',
      action: 'Scenery drifting as the beam sweeps',
      camera: 'A slow wide drift',
    }),
    direction({
      subject: 'The same woman',
      composition: 'The lamp room at night',
      action: 'She places the lantern on the sill',
      characterCount: 1,
    }),
    direction({
      subject: 'The same woman',
      composition: 'The lamp room at night',
      action: 'She places the lantern on the sill',
      characterCount: 1,
    }),
  ];
  assert.deepEqual(h24.map(shot => autoMotionModel(shot)), ['ltx', 'h3', 'h3']);

  const t30 = [
    direction({
      subject: 'The boat',
      composition: 'Open water under a grey sky',
      action: 'Scenery drifting past the hull',
      camera: 'A slow wide drift',
    }),
    direction({
      subject: 'The same woman',
      composition: 'The boat on the reef',
      action: 'She guides the boat over a reef',
      characterCount: 1,
    }),
    direction({
      subject: 'The same woman',
      composition: 'The boat on the reef',
      action: 'She guides the boat over a reef',
      characterCount: 1,
    }),
  ];
  assert.deepEqual(t30.map(shot => autoMotionModel(shot)), ['ltx', 'h3', 'h3']);

  const w20 = [
    direction({
      subject: 'The reef',
      composition: 'A camera-led reef establishing shot with no people',
      action: 'Scenery drifting',
      camera: 'A slow wide establishing drift',
    }),
    direction({
      subject: 'The same woman',
      composition: 'The reef flat',
      action: 'She places a slate on the sand',
      characterCount: 1,
    }),
    direction({
      subject: 'The same woman',
      composition: 'The reef flat',
      action: 'She places a slate on the sand',
      characterCount: 1,
    }),
  ];
  assert.deepEqual(w20.map(shot => autoMotionModel(shot)), ['ltx', 'h3', 'h3']);
});

test('camera-led establishing and scenery stay ltx even when composition mentions a person', () => {
  const negatives: ShotMotionDirection[] = [
    direction({
      subject: 'The cliff',
      composition: "Establishing shot of the woman's cottage on the cliff",
      action: 'The camera pans left past the cottage',
      camera: 'The camera pans left',
    }),
    direction({
      subject: 'The pier',
      composition: 'A lone man far away on the pier, wide establishing',
      action: 'The sun sets over the water',
      camera: 'Static wide shot',
    }),
    direction({
      subject: 'The reef',
      composition: 'Aerial establishing, a woman tiny on the boat',
      action: 'Light moves across the water',
      camera: 'Aerial drift',
    }),
    direction({
      subject: 'The bay',
      composition: 'Wide shot, a boy on the shore',
      action: 'The tide turns and the camera drifts',
      camera: 'The camera drifts',
    }),
  ];
  for (const shot of negatives) {
    assert.equal(autoMotionModel({ ...shot, characterCount: 0 }), 'ltx', `${shot.subject} at characterCount 0`);
    assert.equal(autoMotionModel({ ...shot, characterCount: 1 }), 'ltx', `${shot.subject} at characterCount 1`);
  }
});

test('pronoun and role subjects with characterCount 1 and an acted verb route h3', () => {
  assert.equal(autoMotionModel(direction({
    subject: 'She',
    composition: 'Lamp room',
    action: 'She places the lantern',
    characterCount: 1,
  })), 'h3');
  assert.equal(autoMotionModel(direction({
    subject: 'The lighthouse keeper',
    composition: 'Lamp room',
    action: 'Placing the lantern',
    characterCount: 1,
  })), 'h3');
  assert.equal(autoMotionModel(direction({
    subject: 'The fisherman',
    composition: 'The harbour wall',
    action: 'Hauling the net onto the quay',
    characterCount: 1,
  })), 'h3');
});

test('characterCount 0 never routes to h3 through the acting rule', () => {
  assert.equal(autoMotionModel(direction({
    subject: 'The same woman',
    composition: 'The lamp room',
    action: 'She places the lantern',
    characterCount: 0,
  })), 'ltx');
  assert.equal(autoMotionModel(direction({
    subject: 'The lighthouse keeper',
    composition: 'The lamp room',
    action: 'Placing the lantern',
    characterCount: 0,
  })), 'ltx');
});

test('a real character acting outranks camera drift words', () => {
  assert.equal(autoMotionModel(direction({
    subject: 'She',
    composition: 'Open water',
    action: 'She guides the boat while the camera drifts',
    characterCount: 1,
  })), 'h3');
});

test('dialogue and native sound still route h3 at characterCount 0', () => {
  assert.equal(autoMotionModel(direction({
    subject: 'The reef',
    composition: 'A wide reef at dawn',
    action: 'Scenery drifting',
    soundscape: 'Recorded dialogue and footsteps',
    characterCount: 0,
  })), 'h3');
});

test('the motion prompt documents the auto route rule and characterCount', () => {
  const source = readFileSync(sourceUrl(['../src/prompts/motion.ts', '../src/prompts/motion.js']), 'utf8');
  assert.match(source, /characterCount/);
  assert.match(source, /camera-led/i);
  assert.match(source, /FastH3/);
  assert.match(source, /LTX-2\.5/);
  assert.match(source, /he\/she\/they/i);
  assert.match(source, /never the composition or camera/i);
  assert.match(source, /places the lantern/);
  assert.match(source, /characterCount 0/);
});
