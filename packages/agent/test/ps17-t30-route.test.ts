// PS17: T30 auto routing. Shot 1 is a camera-led boat establishing shot (LTX-2.5);
// shots 2 and 3 are the same woman guiding the boat over a reef (FastH3). Reef and
// scenery nouns in the same direction must never outrank the character acting.
// These are deterministic ShotMotionDirection objects; no live suite is started.

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

test('T30 three shots route ltx,h3,h3 when shot 3 keeps character acting beside reef scenery', () => {
  const t30 = [
    direction({
      subject: 'The boat',
      composition: 'Open water under a grey sky, a slow wide establishing shot',
      action: 'Scenery drifting past the hull',
      camera: 'A slow wide drift',
      characterCount: 0,
    }),
    direction({
      subject: 'The same woman',
      composition: 'The boat on the reef, open water and coral',
      action: 'She guides the boat over a reef',
      camera: 'A slow push from the stern',
      characterCount: 1,
    }),
    direction({
      subject: 'The same woman guiding the boat over the reef',
      composition: 'The boat on the reef, open water and coral scenery',
      action: 'Scenery drifting past the reef',
      camera: 'A slow push from the stern',
      characterCount: 1,
    }),
  ];
  assert.deepEqual(t30.map(shot => autoMotionModel(shot)), ['ltx', 'h3', 'h3']);
});

test('scenery nouns in composition, action and subject never cancel character acting', () => {
  assert.equal(autoMotionModel(direction({
    subject: 'The same woman guiding the boat over the reef',
    composition: 'Reef, coral, open water and a grey sky',
    action: 'Scenery drifting past the reef',
    camera: 'A slow wide drift',
    characterCount: 1,
  })), 'h3');

  assert.equal(autoMotionModel(direction({
    subject: 'The boat over the reef',
    composition: 'Open water, reef and coral scenery',
    action: 'She guides the boat over the reef while the scenery drifts',
    camera: 'A slow wide drift',
    characterCount: 1,
  })), 'h3');

  assert.equal(autoMotionModel(direction({
    subject: 'The reef scenery',
    composition: 'The boat on the reef',
    action: 'The woman guides the boat past the reef and the scenery drifts',
    camera: 'A slow wide drift',
    characterCount: 1,
  })), 'h3');

  assert.equal(autoMotionModel(direction({
    subject: 'The reef scenery',
    composition: 'The boat on the reef',
    action: 'Scenery drifts past the reef while she guides the boat',
    camera: 'A slow wide drift',
    characterCount: 1,
  })), 'h3');
});

test('camera-led establishing and scenery-only shots stay ltx even beside reef nouns', () => {
  assert.equal(autoMotionModel(direction({
    subject: 'The boat',
    composition: 'Open water under a grey sky',
    action: 'Scenery drifting past the hull',
    camera: 'A slow wide drift',
    characterCount: 1,
  })), 'ltx');

  assert.equal(autoMotionModel(direction({
    subject: 'The reef',
    composition: 'A camera-led reef establishing shot with no people',
    action: 'Scenery drifting, reef and coral',
    camera: 'A slow wide establishing drift',
    characterCount: 0,
  })), 'ltx');

  assert.equal(autoMotionModel(direction({
    subject: 'The reef',
    composition: 'Aerial establishing, a woman tiny on the boat',
    action: 'The camera opens on the woman at the reef',
    camera: 'Aerial drift',
    characterCount: 1,
  })), 'ltx');

  assert.equal(autoMotionModel(direction({
    subject: 'The reef',
    composition: 'Aerial establishing, a woman tiny on the boat',
    action: 'A woman watches as the camera opens on the reef',
    camera: 'Aerial drift',
    characterCount: 1,
  })), 'ltx');
});

test('the motion prompt documents the scenery-proof character acting rule', () => {
  const source = readFileSync(sourceUrl(['../src/prompts/motion.ts', '../src/prompts/motion.js']), 'utf8');
  assert.ok(/guiding the boat/i.test(source), 'prompt names the T30 guiding-the-boat example');
  assert.ok(/scenery nouns? (?:never|do not)/i.test(source), 'prompt says scenery nouns never override acting');
  assert.ok(/subject or the action/i.test(source), 'prompt locates character evidence in subject or action');
});
