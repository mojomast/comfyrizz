// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAST_ID_RE,
  SPEAKER_PICKER_SCHEMA,
  SpeakerPickerController,
  agentHint,
  applySpeakerPatch,
  buildSpeakerPicker,
  createSpeakerPicker,
  formatVoiceLabel,
  renderSpeakerPicker,
  sceneSpeakerPatch,
  speakerAgentHint,
  speakerOptions,
} from '../src/characters/speaker-picker.ts';

function character(overrides = {}) {
  const base = {
    schema: 'comfyrizz.character/v1',
    id: 'chr_0123456789abcdef',
    revision: 2,
    name: 'Pip',
    handle: 'pip',
    role: 'narrator',
    kind: 'fictional',
    summary: 'Round, cheerful coffee-bean mascot',
    visual: {
      identityPrompt: 'small round coffee bean, glossy brown',
      negative: 'no human face',
      style: 'flat 3D',
      palette: ['#5b3a1e'],
      wardrobe: [],
      expressions: [],
      images: [],
      sheet: { status: 'none' },
      seed: null,
      identity: { method: 'klein_ref' },
    },
    voice: { engine: 'kokoro', voice: 'am_michael', sampleLines: [] },
    bible: {
      personality: 'upbeat',
      mannerisms: [],
      catchphrases: [],
      speakingStyle: '',
      do: [],
      dont: [],
      notes: '',
    },
    tags: [],
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
  };
  return { ...base, ...overrides };
}

function castEntry(castId, snapshot, overrides = {}) {
  return {
    castId,
    characterId: snapshot.id,
    pinnedRevision: snapshot.revision,
    snapshot,
    overrides,
    detached: false,
    orphaned: false,
    ...overrides.entry,
  };
}

function projectCast() {
  const pip = character();
  const nib = character({
    id: 'chr_2222222222222222',
    name: 'Nib',
    handle: 'nib',
    role: 'protagonist',
    voice: { engine: 'qwen3-tts', voice: 'Ryan', qwen_mode: 'custom', sampleLines: [] },
  });
  const rock = character({
    id: 'chr_3333333333333333',
    name: 'Rock',
    handle: 'rock',
    role: 'supporting',
    voice: { engine: 'none', sampleLines: [] },
  });
  return [
    castEntry('c_pip', pip),
    castEntry('c_nib', nib),
    castEntry('c_rock', rock),
  ];
}

function packageFixture(overrides = {}) {
  return {
    schema: 'comfyrizz.package/v1',
    id: 'pkg_speaker_ui',
    revision: 3,
    voice: { enabled: true, engine: 'kokoro', voice: 'af_heart' },
    cast: projectCast().map(entry => ({
      id: entry.castId,
      name: entry.snapshot.name,
      ref_asset: `a_${entry.snapshot.handle}`,
      voice: entry.snapshot.voice,
    })),
    scenes: [
      { id: 's1', narration: 'Morning! Fresh is best.' },
      { id: 's2', speaker: 'c_nib', narration: 'Nib checks the hopper.' },
    ],
    ...overrides,
  };
}

test('the picker lists cast with voices and defaults unassigned scenes to the narrator', () => {
  const state = buildSpeakerPicker(projectCast(), [
    { id: 's1', narration: 'Morning!' },
    { id: 's2', speaker: 'c_nib', narration: 'Nib checks the hopper.' },
    { id: 's3', speaker: 'c_rock', narration: 'Rock is silent.' },
  ], { voice: { engine: 'kokoro', voice: 'af_heart' } });

  assert.equal(state.schema, SPEAKER_PICKER_SCHEMA);
  assert.equal(state.cast.length, 3);
  assert.deepEqual(state.cast.map(option => option.handle), ['pip', 'nib', 'rock']);
  assert.equal(state.cast[0].castId, 'c_pip');
  assert.equal(state.cast[0].voiceLabel, 'Kokoro · am_michael');
  assert.equal(state.cast[1].voiceLabel, 'Qwen3-TTS · Ryan');
  assert.equal(state.cast[2].hasVoice, false);
  assert.equal(state.cast[2].voiceLabel, 'No voice');
  assert.equal(CAST_ID_RE.test(state.cast[0].castId), true);

  assert.equal(state.narrator.castId, 'c_pip');
  assert.equal(state.defaultSpeakerId, 'c_pip');

  const [s1, s2, s3] = state.scenes;
  assert.equal(s1.speaker, 'c_pip');
  assert.equal(s1.usesDefault, true);
  assert.equal(s1.explicit, false);
  assert.equal(s1.source, 'cast');
  assert.equal(s1.voiceLabel, 'Kokoro · am_michael');

  assert.equal(s2.speaker, 'c_nib');
  assert.equal(s2.explicit, true);
  assert.equal(s2.usesDefault, false);
  assert.equal(s2.source, 'cast');
  assert.equal(s2.voiceLabel, 'Qwen3-TTS · Ryan');

  assert.equal(s3.speaker, 'c_rock');
  assert.equal(s3.source, 'package');
  assert.equal(s3.voiceLabel, 'Kokoro · af_heart');
  assert.match(s3.fallbackReason, /no usable voice/);
  assert.equal(state.warnings[0].code, 'SPEAKER_VOICE_FALLBACK');
});

test('without a narrator cast the default is the package voice', () => {
  const onlySupporting = [castEntry('c_nib', character({
    id: 'chr_2222222222222222',
    name: 'Nib',
    handle: 'nib',
    role: 'protagonist',
    voice: { engine: 'qwen3-tts', voice: 'Ryan', sampleLines: [] },
  }))];
  const state = buildSpeakerPicker({
    cast: onlySupporting,
    scenes: [{ id: 's1', narration: 'Hello.' }],
    voice: { engine: 'kokoro', voice: 'af_heart' },
  });

  assert.equal(state.narrator, null);
  assert.equal(state.defaultSpeakerId, null);
  assert.equal(state.scenes[0].speaker, null);
  assert.equal(state.scenes[0].source, 'package');
  assert.equal(state.scenes[0].voiceLabel, 'Kokoro · af_heart');
  assert.equal(sceneSpeakerPatch(state, 's1', null), null);

  const patch = sceneSpeakerPatch(state, 's1', 'c_nib');
  assert.equal(patch.speaker, 'c_nib');
  assert.equal(patch.castId, 'c_nib');
});

test('a speaker change emits one patch and applies immutably', () => {
  const pkg = packageFixture();
  const before = structuredClone(pkg);
  const patches = [];
  const states = [];
  const controller = createSpeakerPicker({
    cast: projectCast(),
    scenes: pkg.scenes,
    voice: pkg.voice,
    onPatch: (patch, state) => {
      patches.push(patch);
      states.push(state.scenes.find(scene => scene.sceneId === patch.sceneId));
    },
  });

  assert.equal(controller.getState().scenes[0].speaker, 'c_pip');

  const first = controller.setSpeaker('s1', 'c_nib');
  assert.equal(first.kind, 'speaker');
  assert.equal(first.sceneId, 's1');
  assert.equal(first.speaker, 'c_nib');
  assert.equal(first.previousSpeaker, null);
  assert.equal(first.changed, true);
  assert.deepEqual(first.scene, { id: 's1', speaker: 'c_nib' });
  assert.equal(patches.length, 1);
  assert.equal(states[0].speaker, 'c_nib');
  assert.equal(controller.getState().scenes[0].usesDefault, false);

  const applied = applySpeakerPatch(pkg, first);
  assert.equal(applied.scenes[0].speaker, 'c_nib');
  assert.equal(applied.scenes[1].speaker, 'c_nib');
  assert.deepEqual(pkg, before, 'the source package is not mutated');
  assert.deepEqual(applySpeakerPatch(pkg.scenes, first).map(scene => scene.speaker), ['c_nib', 'c_nib']);

  assert.equal(controller.setSpeaker('s1', 'c_nib'), null, 'the same selection emits nothing');
  assert.equal(patches.length, 1);

  const cleared = controller.setSpeaker('s1', null);
  assert.equal(cleared.speaker, null);
  assert.equal(cleared.castId, null);
  assert.equal(cleared.usesDefault, true);
  assert.equal('speaker' in applySpeakerPatch(pkg, cleared).scenes[0], false);
  assert.equal(controller.getState().scenes[0].speaker, 'c_pip');
  assert.equal(patches.length, 2);

  const assignAgain = controller.setSpeaker('s1', 'c_nib');
  assert.equal(assignAgain.speaker, 'c_nib');
  const backToNarrator = controller.setSpeaker('s1', 'c_pip');
  assert.equal(backToNarrator.speaker, 'c_pip', 'selecting the narrator writes the cast id');
  assert.equal(backToNarrator.previousSpeaker, 'c_nib');
  assert.equal(patches.length, 4);

  assert.equal(controller.setSpeaker('s1', 'c_pip'), null, 'the narrator is already selected');
  assert.equal(controller.clearSpeaker('s1').speaker, null);
});

test('handles and character ids resolve, unknown values emit nothing', () => {
  const controller = new SpeakerPickerController(projectCast(), [
    { id: 's1' },
    { id: 's2' },
  ], { voice: { engine: 'kokoro', voice: 'af_heart' } });

  const byHandle = controller.setSpeaker('s1', '@nib');
  assert.equal(byHandle.speaker, 'c_nib');
  const byCharacter = controller.setSpeaker('s2', 'chr_2222222222222222');
  assert.equal(byCharacter.speaker, 'c_nib');

  assert.equal(controller.setSpeaker('missing', 'c_nib'), null);
  assert.equal(controller.setSpeaker('s1', 'c_ghost'), null);
  assert.equal(controller.select('s1', 'not-a-cast-member'), null);
});

test('an unknown scene speaker falls back with a warning and can be cleared', () => {
  const controller = new SpeakerPickerController(projectCast(), [
    { id: 's1', speaker: 'c_ghost', narration: 'Who was that?' },
  ], { voice: { engine: 'kokoro', voice: 'af_heart' } });

  const state = controller.getState();
  assert.equal(state.scenes[0].unknownSpeaker, 'c_ghost');
  assert.equal(state.scenes[0].speaker, 'c_pip');
  assert.equal(state.warnings[0].code, 'SPEAKER_UNKNOWN');
  assert.equal(state.warnings[0].sceneId, 's1');

  const patch = controller.setSpeaker('s1', null);
  assert.equal(patch.speaker, null);
  assert.equal(patch.previousSpeaker, 'c_ghost');
  assert.equal(controller.getState().scenes[0].unknownSpeaker, null);
});

test('the picker renders one escaped select per scene and shows the agent hint', () => {
  const hostile = character({
    name: '<img src=x onerror="alert(1)">',
    handle: 'pip',
  });
  const state = buildSpeakerPicker({
    cast: [castEntry('c_pip', hostile)],
    scenes: [
      { id: 's<&"', label: '<b>&"', narration: 'Hi.' },
    ],
    voice: { engine: 'kokoro', voice: 'af_heart' },
  });

  const html = renderSpeakerPicker(state);
  assert.match(html, /<section class="speaker-picker"/);
  assert.match(html, /data-speaker-select="s&lt;&amp;&quot;"/);
  assert.match(html, /<option value="c_pip" selected/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('<b>&"'));
  assert.match(html, /data-speaker-hint/);
  assert.match(html, /agent can propose a speaker/);
  assert.match(html, /data-agent-hint=/);
  assert.match(html, /Default narrator/);
  assert.equal((html.match(/<select /g) ?? []).length, 1);
});

test('no cast or no scenes render a disabled, honest empty state', () => {
  const noCast = renderSpeakerPicker(buildSpeakerPicker({
    cast: [],
    scenes: [{ id: 's1' }],
    voice: { engine: 'kokoro', voice: 'af_heart' },
  }));
  assert.match(noCast, /<select[^>]*disabled/);
  assert.match(noCast, /Package narrator · Kokoro · af_heart/);
  assert.match(noCast, /data-speaker-no-cast/);

  const noScenes = renderSpeakerPicker(buildSpeakerPicker({
    cast: projectCast(),
    scenes: [],
  }));
  assert.match(noScenes, /data-speaker-empty/);
  assert.equal((noScenes.match(/<select /g) ?? []).length, 0);
});

test('the agent hint describes speakers and voices as data, not instructions', () => {
  const pkg = packageFixture();
  const state = buildSpeakerPicker(projectCast(), pkg.scenes, { voice: pkg.voice });
  const hint = agentHint(state);
  assert.equal(speakerAgentHint(state), hint);
  assert.match(hint, /data, not instructions/);
  assert.match(hint, /s1: Pip \(@pip, Narrator\); voice Kokoro · am_michael; default/);
  assert.match(hint, /s2: Nib \(@nib, Protagonist\); voice Qwen3-TTS · Ryan/);
  assert.match(hint, /proposal until the user confirms/);
});

test('alternate cast shapes and voice labels are normalised', () => {
  const flat = character({ name: 'Pip', handle: 'pip', role: 'narrator' });
  const options = speakerOptions([flat, { id: 'c_bean', name: 'Bean', handle: 'bean', voice: 'af_bella' }]);
  assert.deepEqual(options.map(option => option.castId), ['c_pip', 'c_bean']);
  assert.equal(options[0].characterId, flat.id);
  assert.equal(options[1].voiceLabel, 'Kokoro · af_bella');
  assert.equal(formatVoiceLabel({ engine: 'none', voice: 'am_michael' }), 'No voice');
  assert.equal(formatVoiceLabel({ enabled: false, engine: 'kokoro', voice: 'am_michael' }), 'No voice');
  assert.equal(formatVoiceLabel({ engine: 'qwen3-tts', voice: 'Ryan' }), 'Qwen3-TTS · Ryan');

  const overridden = buildSpeakerPicker({
    cast: [castEntry('c_pip', flat, { role: 'presenter' })],
    scenes: [{ id: 's1' }],
  });
  assert.equal(overridden.cast[0].role, 'presenter');
  assert.equal(overridden.narrator, null);
  assert.equal(overridden.presenter.castId, 'c_pip');
});

test('controller updates cast and scenes without a server, and destroy stops callbacks', () => {
  const controller = createSpeakerPicker({
    cast: projectCast(),
    scenes: [{ id: 's1' }],
    voice: { engine: 'kokoro', voice: 'af_heart' },
  });
  let events = 0;
  controller.subscribe(() => { events += 1; });

  controller.setScenes([{ id: 's1' }, { id: 's2', speaker: 'c_nib' }]);
  assert.equal(controller.getState().scenes.length, 2);
  assert.equal(controller.getScene('s2').speaker, 'c_nib');

  controller.setCast([castEntry('c_pip', character())]);
  assert.equal(controller.getState().cast.length, 1);
  assert.equal(controller.getState().scenes[1].speaker, 'c_pip');
  assert.equal(controller.getState().scenes[1].unknownSpeaker, 'c_nib');

  controller.setSpeaker('s1', 'c_pip');
  const beforeDestroy = events;
  controller.destroy();
  assert.equal(controller.setSpeaker('s1', 'c_pip'), null);
  assert.equal(events, beforeDestroy);
});
