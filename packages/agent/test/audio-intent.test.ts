import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAudioIntent, classifyProductionIntent } from '../src/production-intent.js';
import { applyProductionIntentToScene, createToolset } from '../src/tools.js';

const prohibitions = [
  ['silent', true], ['no audio', true], ['without any audio', true], ['full silence', true],
  ['no spoken words', false], ['no narration', false], ['without speech', false],
  ['wordless with native foley and music', false], ['no dialogue, music or narration', false],
] as const;

for (const kind of ['motion-graphics', 'generated-film'] as const) {
  for (const [request, silent] of prohibitions) {
    test(`${kind}: ${request} survives propose and scene edits`, () => {
      const brief = `Create a ${kind === 'generated-film' ? 'generated film' : 'motion-graphics sequence'}; ${request}.`;
      const intent = classifyProductionIntent(brief);
      assert.equal(intent.kind, kind);
      assert.equal(intent.silent, silent);
      assert.equal(intent.wordless, true);
      assert.equal(intent.narrationRequested, false);
      assert.equal(intent.speechRequested, false);
      if (silent) assert.equal(intent.musicRequested, false);
      const tools = createToolset();
      const proposed = tools['storyboard.propose'].run({
        brief, scenes: [{ id: 's1', layout: 'hero', copy: { headline: 'The reveal' }, narration: 'Unwanted voice.', motion: { cue_phrases: ['Unwanted voice'] } }],
      }) as any;
      assert.equal(proposed.package.scenes[0].narration, undefined);
      assert.equal(proposed.package.scenes[0].motion?.cue_phrases, undefined);
      const edited = tools['storyboard.edit'].run({ scene_id: 's1', patch: { narration: 'Still unwanted.', motion: { cue_phrases: ['Still unwanted'] } } }) as any;
      assert.equal(edited.package.scenes[0].narration, undefined);
      assert.equal(edited.package.scenes[0].motion?.cue_phrases, undefined);
    });
  }
}

test('wordless retains native sound and explicit music; full silence prohibits both', () => {
  assert.equal(classifyAudioIntent('Wordless with native foley and music.').musicRequested, true);
  assert.equal(classifyAudioIntent('Wordless with native foley and music.').silent, false);
  assert.equal(classifyAudioIntent('Silent, no audio. Music and a narrator.').musicRequested, false);
  assert.equal(classifyAudioIntent('Silent, no audio. Music and a narrator.').narrationRequested, false);
  assert.equal(classifyAudioIntent('No sound effects. Narrate the story.').silent, false);
  assert.equal(classifyAudioIntent('No sound effects. Narrate the story.').narrationRequested, true);
  assert.equal(classifyAudioIntent('Not silent. A narrator explains the chart.').wordless, false);
  assert.equal(classifyAudioIntent('No music, but narrate the story.').narrationRequested, true);
});

test('speech prohibition clears stale voice bindings without mutating the source scene', () => {
  const scene = { id: 's1', layout: 'hero', narration: 'Old speech', narration_asset: 'a_voice', narration_duration_frames: 30, motion: { recipe: 'focus', cue_phrases: ['Old speech'] } };
  const clean = applyProductionIntentToScene(scene, classifyProductionIntent('Motion graphics; no spoken words.'));
  assert.equal(clean.narration_asset, undefined);
  assert.equal(clean.narration_duration_frames, undefined);
  assert.deepEqual(clean.motion, { recipe: 'focus' });
  assert.equal(scene.narration_asset, 'a_voice');
  assert.deepEqual(scene.motion.cue_phrases, ['Old speech']);
});

test('an active spoken request retains authored narration across native scene construction and edits', () => {
  const brief = 'Motion graphics. Narrate the supplied values. No music.';
  const intent = classifyProductionIntent(brief);
  assert.equal(intent.narrationRequested, true);
  assert.equal(intent.wordless, false);
  const tools = createToolset();
  const proposed = tools['storyboard.propose'].run({ brief, scenes: [{ id: 's1', layout: 'hero', narration: 'North has twelve.', copy: { headline: 'North' } }] }) as any;
  assert.equal(proposed.package.scenes[0].narration, 'North has twelve.');
  const edited = tools['storyboard.edit'].run({ scene_id: 's1', patch: { narration: 'South has nineteen.' } }) as any;
  assert.equal(edited.package.scenes[0].narration, 'South has nineteen.');
});
