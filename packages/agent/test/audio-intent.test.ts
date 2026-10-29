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

for (const brief of [
  'No additional on-screen copy, people, music or claims about watering frequency.',
  'No people, music or captions.',
  'No subtitles or people and soundtrack.',
  'Without people, logos, or music.',
  'Please exclude additional on-screen text, people and score.',
  'Do not include photos, people or instrumental bed.',
]) {
  test(`mixed production list prohibits music without silencing speech: ${brief}`, () => {
    const intent = classifyAudioIntent(`${brief} Narrate the supplied script.`);
    assert.equal(intent.musicProhibited, true);
    assert.equal(intent.musicRequested, false);
    assert.equal(intent.silent, false);
    assert.equal(intent.wordless, false);
    assert.equal(intent.narrationRequested, true);
  });
}

for (const brief of ['No narration,music.', 'No people, music or narration.', 'No logos, speech or music.']) {
  test(`coordinated speech and music prohibitions remain separate from full silence: ${brief}`, () => {
    const intent = classifyAudioIntent(brief);
    assert.equal(intent.wordless, true);
    assert.equal(intent.musicProhibited, true);
    assert.equal(intent.silent, false);
    assert.equal(intent.speechRequested, false);
  });
}

for (const brief of [
  'No people, but add music.',
  'No people and use music.',
  'No people, then use music.',
  'No people; add music.',
  'No people. Use music.',
  'No people\nUse music.',
  'No loud music; soft piano music.',
  'No people, loud music; use soft piano music.',
  'No people, music with lyrics. Use soft instrumental music.',
]) {
  test(`a positive music directive survives a separate or qualified prohibition: ${brief}`, () => {
    const intent = classifyAudioIntent(brief);
    assert.equal(intent.musicProhibited, false);
    assert.equal(intent.musicRequested, true);
    assert.equal(intent.silent, false);
    assert.equal(intent.wordless, false);
  });
}

test('mentions of negative lists are not blanket production-audio instructions', () => {
  for (const brief of [
    'The story says there are no people, music or lights.',
    'Discuss a painting with no people, music or buildings in its title.',
    'No claims about people and music.',
    'Show the words "No people, music or lights".',
  ]) {
    const intent = classifyAudioIntent(brief);
    assert.equal(intent.musicProhibited, false, brief);
    assert.equal(intent.silent, false, brief);
    assert.equal(intent.wordless, false, brief);
  }
});

test('no score does not prohibit narration or native sound', () => {
  const intent = classifyAudioIntent('No score. Narrate the story over native sound effects.');
  assert.equal(intent.musicProhibited, true);
  assert.equal(intent.silent, false);
  assert.equal(intent.wordless, false);
  assert.equal(intent.narrationRequested, true);
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
