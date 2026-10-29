import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAudioIntent, classifyProductionIntent } from '../src/production-intent.js';
import { applyGeneratedFilmPresentation, applyProductionIntentToScene, createToolset, SILENT_CONDITIONING_ASSET_ID } from '../src/tools.js';
import { LAST_SIGNAL_CREDITS, LAST_SIGNAL_CREDIT_LINES, LAST_SIGNAL_SPEAKING } from './fixtures/last-signal.js';

test('exact speaking acceptance brief requests native speech, room tone and editable overlays', () => {
  const intent = classifyProductionIntent(LAST_SIGNAL_SPEAKING);
  assert.equal(intent.generatedFilm, true);
  assert.equal(intent.requestedSeconds, 45);
  assert.equal(intent.exactDuration, true);
  assert.equal(intent.silent, false);
  assert.equal(intent.wordless, false);
  assert.equal(intent.speechRequested, true);
  assert.equal(intent.narrationRequested, false);
  assert.equal(intent.musicProhibited, true);
  assert.equal(intent.noCaptions, false);
});

test('exact credits acceptance brief keeps its score and credits without any speech', () => {
  const intent = classifyProductionIntent(LAST_SIGNAL_CREDITS);
  assert.equal(intent.generatedFilm, true);
  assert.equal(intent.requestedSeconds, 45);
  assert.equal(intent.exactDuration, true);
  assert.equal(intent.silent, false);
  assert.equal(intent.wordless, true);
  assert.equal(intent.speechRequested, false);
  assert.equal(intent.narrationRequested, false);
  assert.equal(intent.musicRequested, true);
  assert.equal(intent.musicProhibited, false);
  assert.equal(intent.noCaptions, false);
});

test('exact speaking brief permits a native H3 dialogue plan using the supplied line conditioning', () => {
  const intent = classifyProductionIntent(LAST_SIGNAL_SPEAKING);
  const draft = createToolset()['storyboard.propose'].run({
    brief: LAST_SIGNAL_SPEAKING, title: 'THE LAST SIGNAL',
    scenes: [{ id: 's1', layout: 'title', headline_size: 104, preferredFrames: 180, copy: { headline: 'THE LAST SIGNAL' } }],
  }) as any;
  // Ready-asset metadata is a test double; this test only plans a job.
  const readyAsset = (kind: string, file: string) => ({ kind, origin: 'upload', status: 'ready', file, sha256: 'a'.repeat(64) });
  const pkg = { ...draft.package, assets: {
    a_identity: readyAsset('image', 'assets/identity.png'),
    a_composition: readyAsset('image', 'assets/composition.png'),
    a_line: { ...readyAsset('audio', 'assets/line.wav'), media: { durationSeconds: 3 }, gen: { inputs: { text: 'Yesterday, the signal went silent.' } } },
  } };
  let planned: any;
  const tools = createToolset({ initialPackage: pkg, initialIntent: intent, motionModel: 'h3', onPackageChange: value => { planned = value; } });
  const result = tools['assets.generate_video'].run({
    scene_id: 's1', motion_model: 'h3', subject: 'Mara Vale, fictional adult radio archivist.',
    composition: 'Medium shot at her radio desk; face and mouth visible.',
    action: 'Mara speaks the line while touching the tuning knob.', camera: 'Slow push in.',
    soundscape: 'Quiet room tone and faint radio hiss.', characterCount: 1,
    image: 'a_identity', reference: 'a_composition', audio: 'a_line', wordless: false,
    dialogue: { text: 'Yesterday, the signal went silent.', conditioningText: 'Yesterday, the signal went silent.', language: 'en-us', voice: 'af_heart', delivery: 'quietly' },
  }) as any;
  assert.equal(result.asset.gen.generator, 'fasth3-omni');
  assert.equal(result.asset.gen.inputs.audio, 'a_line');
  assert.equal(result.asset.gen.direction.dialogue.text, 'Yesterday, the signal went silent.');
  assert.equal(result.asset.gen.direction.soundscape, 'Quiet room tone and faint radio hiss.');
  assert.notEqual(result.asset.media?.audio, 'muted');
  assert.equal(planned.assets[SILENT_CONDITIONING_ASSET_ID], undefined);
  assert.equal(planned.scenes[0].copy.headline, 'THE LAST SIGNAL');
  assert.equal(planned.scenes[0].narration, undefined);
});

test('quoted source content never becomes audio, text, medium or duration policy', () => {
  for (const [open, close] of [['"', '"'], ['“', '”'], ["'", "'"], ['‘', '’']]) {
    const content = `${open}I'm here. I’m listening. Full silence. No audio. No text. No speaking, music or vocals. A photorealistic film lasting exactly 90 seconds.${close}`;
    const brief = `Create exactly 45 seconds of native motion graphics. Use this exact narration: ${content} Add instrumental music.`;
    const intent = classifyProductionIntent(brief);
    assert.equal(intent.silent, false, content);
    assert.equal(intent.wordless, false, content);
    assert.equal(intent.narrationRequested, true, content);
    assert.equal(intent.musicRequested, true, content);
    assert.equal(intent.noCaptions, false, content);
    assert.equal(intent.generatedFilm, false, content);
    assert.equal(intent.requestedSeconds, 45, content);
  }
});

test('descriptive silence does not mute the output; genuine full silence still does', () => {
  for (const brief of ['Yesterday, the signal went silent.', 'She enters a silent room.', 'Show a silent character listening to the radio.', 'The silent radio sits on the desk.']) {
    assert.equal(classifyAudioIntent(`${brief} Narrate over a piano score.`).silent, false, brief);
  }
  for (const brief of ['Silent.', 'Silent output.', 'Create a silent film.', 'Make it silent.', 'Keep the video completely silent.', 'Full silence.', 'No audio.', 'Without any sound.']) {
    const intent = classifyAudioIntent(brief);
    assert.equal(intent.silent, true, brief);
    assert.equal(intent.wordless, true, brief);
    assert.equal(intent.musicProhibited, true, brief);
  }
});

test('negative speech/vocal lists support comma, and, or and Oxford comma coordination', () => {
  for (const list of ['speaking,narration,dialogue', 'logos and speaking', 'logos or vocals', 'logos, lyrics, or vocal samples', 'logos, singing and whispered voices', 'captions, people, and speech', 'speaking, vocals or music']) {
    const intent = classifyAudioIntent(`No ${list}. Add an instrumental score.`);
    assert.equal(intent.wordless, true, list);
    assert.equal(intent.silent, false, list);
    assert.equal(intent.musicProhibited, list.includes('music'), list);
    assert.equal(intent.musicRequested, !list.includes('music'), list);
  }
  for (const brief of ['No logos, but add dialogue.', 'No logos and use narration.', 'Show the title "No speaking or music". A narrator explains it.']) {
    assert.equal(classifyAudioIntent(brief).wordless, false, brief);
  }
});

test('subtitle and generated-lettering restrictions do not ban native editorial copy', () => {
  for (const restriction of ['No subtitles.', 'No subtitles or additional words.', 'No additional text, logos or baked-in lettering in generated imagery.', 'No text in generated imagery.', 'Keep generated footage text-free.']) {
    const intent = classifyProductionIntent(`Create a generated film. Native editable overlays: THE LAST SIGNAL. ${restriction}`);
    assert.equal(intent.noCaptions, false, restriction);
    const scene = { id: 's1', layout: 'title', headline_size: 104, copy: { headline: 'THE LAST SIGNAL' } };
    assert.deepEqual(applyProductionIntentToScene(scene, intent), scene);
  }
  for (const restriction of ['No subtitles.', 'No additional text.', 'No baked-in lettering in generated imagery.', 'No text in generated imagery.', 'Keep generated footage text-free.', 'Use text-free generated images.']) {
    assert.equal(classifyProductionIntent(`Create a generated film. ${restriction}`).noCaptions, false, restriction);
  }
  for (const restriction of ['No text.', 'No on-screen text.', 'Without any text.', 'No copy.']) {
    assert.equal(classifyProductionIntent(`Create a generated film. Native editable overlays. ${restriction}`).noCaptions, true, restriction);
  }
});

test('actual acceptance briefs preserve authored title sizes and copy through intent and shared schema', async () => {
  const { validatePackage } = await import(new URL('../../../schema/src/index.mjs', import.meta.url).href);
  for (const [brief, lines] of [[LAST_SIGNAL_SPEAKING, ['THE LAST SIGNAL', 'MARA VALE', 'THE LAST SIGNAL']], [LAST_SIGNAL_CREDITS, LAST_SIGNAL_CREDIT_LINES]] as const) {
    const intent = classifyProductionIntent(brief);
    const scenes = lines.map((headline, i) => ({ id: `s${i}`, layout: 'title', headline_size: 104, preferredFrames: 450, copy: { headline }, narration: 'Yesterday, the signal went silent.' }));
    const original = structuredClone(scenes);
    const applied = scenes.map(scene => applyProductionIntentToScene(scene, intent));
    assert.deepEqual(scenes, original, 'intent application never mutates source scenes');
    for (const [i, scene] of applied.entries()) {
      assert.equal(scene.layout, 'title');
      assert.equal(scene.headline_size, 104);
      assert.equal(scene.copy.headline, lines[i]);
      assert.equal(scene.narration, undefined, 'native character speech and wordless credits must not create detached narration');
    }
    const tools = createToolset();
    const result = tools['storyboard.propose'].run({ brief, title: 'THE LAST SIGNAL', scenes: applied }) as any;
    const validation = validatePackage(result.package);
    assert.equal(validation.valid, true, JSON.stringify(validation.errors));
    assert.deepEqual(result.package.scenes.map((scene: any) => scene.copy.headline), lines);
  }
});

for (const conversion of ['intent', 'footage-only presentation'] as const) {
  test(`${conversion}: copy-free title conversion clears title-only fields and validates without invented copy`, async () => {
    const { validatePackage } = await import(new URL('../../../schema/src/index.mjs', import.meta.url).href);
    let pkg: any;
    const tools = createToolset({ onPackageChange: value => { pkg = value; } });
    tools['storyboard.propose'].run({
      brief: 'Native title.',
      scenes: [{ id: 's1', layout: 'title', headline_size: 104, copy: { headline: 'Original title' }, preferredFrames: 180 }],
    });
    const image = tools['assets.generate_image'].run({ scene_id: 's1', intent: 'A fictional radio room at night.' }) as any;
    const scene = { ...pkg.scenes[0], background: { asset: image.asset.id } };
    const original = structuredClone(scene);
    const intent = classifyProductionIntent('Create a generated film. No text.');
    const clean = conversion === 'intent'
      ? applyProductionIntentToScene(scene, intent)
      : applyGeneratedFilmPresentation([{ ...scene, copy: undefined, media_only: true }], { ...intent, noCaptions: false, bookends: false }, 'THE LAST SIGNAL')[0];
    assert.deepEqual(scene, original);
    assert.equal(clean.layout, 'list');
    assert.equal(clean.copy, undefined, 'do not synthesize a headline to satisfy the old layout');
    assert.equal(clean.headline_size, undefined, 'headline_size is valid only on title layouts');
    assert.deepEqual(clean.background, original.background);
    const validation = validatePackage({ ...pkg, scenes: [clean] });
    assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  });
}
