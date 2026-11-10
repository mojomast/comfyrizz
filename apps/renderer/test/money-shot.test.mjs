import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entranceSettleFrame, moneyShotEnabled, selectMoneyShot } from '../src/money-shot.js';

function film(scenes) {
  return {
    pkg: { format: { fps: 30, width: 1920, height: 1080 }, scenes },
    timeline: {
      fps: 30,
      scenes: scenes.map((scene, index) => ({
        id: scene.id,
        from: index * (scene.preferredFrames ?? 90),
        durationInFrames: scene.preferredFrames ?? 90,
        layout: scene.layout,
      })),
    },
  };
}

test('money shot is on unless the render option or COMFYRIZZ_MONEY_SHOT turns it off', () => {
  assert.equal(moneyShotEnabled(undefined, {}), true);
  assert.equal(moneyShotEnabled(true, { COMFYRIZZ_MONEY_SHOT: '0' }), true);
  assert.equal(moneyShotEnabled(false, {}), false);
  for (const flag of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.equal(moneyShotEnabled(undefined, { COMFYRIZZ_MONEY_SHOT: flag }), false, flag);
  }
  assert.equal(moneyShotEnabled(undefined, { COMFYRIZZ_MONEY_SHOT: '1' }), true);
});

test('a fading title opens on its settled frame and does not change the timeline', () => {
  const scenes = [{
    id: 's_title',
    layout: 'title',
    preferredFrames: 150,
    copy: { headline: 'Open here', sub: 'The hook is readable' },
  }];
  const { pkg, timeline } = film(scenes);
  const before = JSON.stringify(timeline);
  const shot = selectMoneyShot(pkg, timeline, {});
  assert.equal(shot.enabled, true);
  assert.equal(shot.reason, 'opening-settled');
  assert.equal(shot.coldOpen, false);
  assert.equal(shot.sceneId, 's_title');
  assert.equal(shot.holdFrames, 0);
  assert.ok(shot.openingSettle >= 32, `subtitle should be in by ${shot.openingSettle}`);
  assert.equal(shot.settleFrame, shot.openingSettle);
  assert.equal(JSON.stringify(timeline), before, 'selection does not move narration frames');
});

test('entry none with nothing left to reveal is already the money shot', () => {
  const { pkg, timeline } = film([{
    id: 's_title',
    layout: 'title',
    preferredFrames: 90,
    copy: { headline: 'Already here' },
    motion: { entry: 'none' },
  }]);
  const shot = selectMoneyShot(pkg, timeline, {});
  assert.equal(shot.enabled, false);
  assert.equal(shot.reason, 'already-settled');
  assert.equal(entranceSettleFrame({ ...pkg.scenes[0], durationInFrames: 90 }, 30), 0);
});

test('a later hero layout cold-opens, and a planner hero flag outranks layout', () => {
  const titled = {
    id: 's_title',
    layout: 'title',
    preferredFrames: 120,
    copy: { kicker: 'Open', headline: 'A quiet open', sub: 'Then the picture' },
    background: { procedural: { pattern: 'mesh' } },
  };
  const hero = {
    id: 's_hero',
    layout: 'hero',
    preferredFrames: 180,
    copy: { headline: 'The picture', sub: 'Full brightness' },
    background: { asset: 'a_still' },
    foreground: [{ asset: 'a_still', x: 0.62, y: 0.5, w: 0.4 }],
  };
  const flagged = { ...titled, id: 's_flag', hero: true, preferredFrames: 120 };
  const plain = selectMoneyShot(...Object.values(film([titled, hero])));
  assert.equal(plain.sceneId, 's_hero');
  assert.equal(plain.reason, 'cold-open');
  assert.equal(plain.coldOpen, true);
  assert.ok(plain.holdFrames >= plain.openingSettle && plain.holdFrames > 0);
  assert.ok(plain.openingSettle > 0, 'the opening scene is revealed under the cold open');
  const designated = selectMoneyShot(...Object.values(film([hero, flagged])));
  assert.equal(designated.sceneId, 's_flag', 'scene.hero is the planner designation');
});

test('an outro does not beat the opening hero, and media-only plates are not faded in', () => {
  const hero = { id: 's_hero', layout: 'hero', preferredFrames: 90, copy: { headline: 'Stay' } };
  const outro = { id: 's_out', layout: 'title', variant: 'outro', preferredFrames: 90, copy: { headline: 'Goodbye', sub: 'Credits' } };
  assert.equal(selectMoneyShot(...Object.values(film([hero, outro]))).sceneId, 's_hero');
  const plate = { id: 's_plate', layout: 'hero', media_only: true, preferredFrames: 60, background: { asset: 'a_clip' } };
  assert.equal(entranceSettleFrame({ ...plate, durationInFrames: 60 }, 30), 0);
});

test('a drawing settles on its last element, and the off switch wins', () => {
  const scene = {
    id: 's_draw',
    layout: 'hero',
    preferredFrames: 90,
    copy: { headline: 'Drawn' },
    drawing: { background: '#000000', elements: [{ type: 'rect', start: 0, end: 0 }, { type: 'rect', start: 30, end: 30 }] },
  };
  assert.equal(entranceSettleFrame({ ...scene, durationInFrames: 90 }, 30), 30);
  const shot = selectMoneyShot(...Object.values(film([scene])), { moneyShot: false });
  assert.equal(shot.enabled, false);
  assert.equal(shot.reason, 'disabled');
});
