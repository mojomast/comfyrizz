// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CharacterLibraryController,
  renderCharacterLibrary,
  renderLibraryGrid,
} from '../src/characters/library.ts';
import {
  CharacterEditorController,
  EDITOR_SECTIONS,
  FICTIONAL_NOTICE,
  renderCharacterEditor,
} from '../src/characters/editor.ts';

type Call = { method: string; id?: string; body?: unknown };

function character(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'comfyrizz.character/v1',
    id: 'chr_0123456789abcdef',
    revision: 2,
    name: 'Pip',
    handle: 'pip',
    role: 'mascot',
    kind: 'fictional',
    summary: 'Round, cheerful coffee-bean mascot',
    visual: {
      identityPrompt: 'small round coffee bean, glossy brown',
      negative: 'no human face',
      style: 'flat 3D',
      palette: ['#5b3a1e', '#f4e9dc'],
      wardrobe: [{ id: 'w1', label: 'barista apron', prompt: 'green apron', default: true }],
      expressions: [{ id: 'e1', label: 'delighted', prompt: 'wide smile' }],
      images: [
        {
          imgId: 'img_aaaaaaaaaaaaaaaa',
          view: 'front',
          primary: true,
          source: 'upload',
          sha256: 'a'.repeat(64),
          width: 64,
          height: 64,
        },
        {
          imgId: 'img_bbbbbbbbbbbbbbbb',
          view: 'side',
          primary: false,
          source: 'upload',
          sha256: 'b'.repeat(64),
          width: 64,
          height: 64,
        },
      ],
      sheet: { status: 'none' },
      seed: null,
      identity: { method: 'klein_ref' },
    },
    voice: {
      engine: 'kokoro',
      voice: 'am_michael',
      speed: 0.98,
      chunking: 'paragraph',
      sampleLines: ['Morning! Fresh is best.'],
    },
    bible: {
      personality: 'upbeat',
      mannerisms: ['bounces when excited'],
      catchphrases: ['Fresh is best.'],
      speakingStyle: 'short sentences',
      do: ['smiles'],
      dont: ['drinks coffee'],
      notes: '',
    },
    tags: ['coffee'],
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    ...overrides,
  };
}

const VOICE_OPTIONS = {
  version: 1,
  presets: [
    {
      id: 'heart',
      label: 'Heart · warm female',
      voice: { engine: 'kokoro', voice: 'af_heart', speed: 0.98, chunking: 'paragraph' },
    },
    {
      id: 'ryan-curious',
      label: 'Qwen Ryan · curious and conversational',
      voice: { engine: 'qwen3-tts', voice: 'Ryan', qwen_mode: 'custom', delivery: 'Warm.' },
    },
  ],
  kokoroVoices: [
    { id: 'am_michael', label: 'michael · US male', language: 'en-us' },
    { id: 'af_heart', label: 'heart · US female', language: 'en-us' },
  ],
  qwenSpeakers: ['Ryan', 'Aiden'],
};

function fakeApi(initial = character()) {
  let current = structuredClone(initial);
  const calls: Call[] = [];
  const api = {
    get: async () => structuredClone(current),
    update: async (id: string, patch: Record<string, unknown>) => {
      calls.push({ method: 'update', id, body: structuredClone(patch) });
      current = {
        ...current,
        ...structuredClone(patch),
        revision: current.revision + 1,
        visual: { ...current.visual, ...structuredClone(patch.visual ?? {}) },
        voice: { ...current.voice, ...structuredClone(patch.voice ?? {}) },
        bible: { ...current.bible, ...structuredClone(patch.bible ?? {}) },
      };
      return structuredClone(current);
    },
    create: async (input: Record<string, unknown>, options?: Record<string, unknown>) => {
      calls.push({ method: 'create', body: { input: structuredClone(input), options } });
      current = character({ ...structuredClone(input), revision: 1 });
      return structuredClone(current);
    },
    remove: async () => { calls.push({ method: 'remove' }); },
    voiceOptions: async () => structuredClone(VOICE_OPTIONS),
  };
  return { api, calls, get current() { return current; } };
}

test('library grid renders cards, role and voice chips, and project pins', () => {
  const first = character();
  const second = character({
    id: 'chr_fedcba9876543210',
    name: 'Bean',
    handle: 'bean',
    role: 'narrator',
    revision: 4,
    voice: { engine: 'qwen3-tts', voice: 'Ryan', sampleLines: [] },
  });
  const html = renderCharacterLibrary({
    characters: [first, second],
    loading: false,
    error: '',
    message: '',
    selectedId: 'chr_0123456789abcdef',
    project: { chr_0123456789abcdef: { revision: 1 } },
    thumbUrls: {},
  });

  assert.match(html, /data-character-library/);
  assert.equal((html.match(/data-character-id=/g) ?? []).length, 2);
  assert.match(html, /Mascot/);
  assert.match(html, /Narrator/);
  assert.match(html, /Kokoro · am_michael/);
  assert.match(html, /Qwen · Ryan/);
  assert.match(html, /In project v1/);
  assert.match(html, /data-update-available/);
  assert.match(html, /Library has v2/);
  assert.match(html, /Add to project/);

  const empty = renderLibraryGrid([]);
  assert.match(empty, /No characters yet/);
});

test('library controller loads a fake API and marks update availability without touching the DOM', async () => {
  const fake = fakeApi();
  const controller = new CharacterLibraryController({
    api: {
      list: async () => ({ characters: [fake.current] }),
    },
    project: { chr_0123456789abcdef: 1 },
  });
  const loaded = await controller.load();
  assert.equal(loaded.length, 1);
  assert.equal(controller.getState().characters[0].name, 'Pip');
  assert.match(renderCharacterLibrary(controller.getState()), /Library has v2/);
  controller.setProject({ chr_0123456789abcdef: 2 });
  assert.doesNotMatch(renderCharacterLibrary(controller.getState()), /data-update-available/);
  controller.destroy();
});

test('the editor renders exactly four sections with the fictional notice', async () => {
  const fake = fakeApi();
  const editor = new CharacterEditorController({
    api: fake.api,
    character: fake.current,
    voiceOptions: VOICE_OPTIONS,
  });
  const html = renderCharacterEditor(editor.getState());

  assert.deepEqual(EDITOR_SECTIONS.map(section => section.id), ['identity', 'look', 'voice', 'bible']);
  assert.equal((html.match(/data-section=/g) ?? []).length, 4);
  for (const id of ['identity', 'look', 'voice', 'bible']) {
    assert.match(html, new RegExp(`data-section="${id}"`));
  }
  assert.match(html, /data-character-editor/);
  assert.match(html, /This is a fictional character, not a real person\./);
  assert.match(html, new RegExp(FICTIONAL_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, /data-fictional/);
});

test('autosave on blur patches exactly one field once and ignores an unchanged blur', async () => {
  const fake = fakeApi();
  const editor = new CharacterEditorController({ api: fake.api, character: fake.current });

  const first = await editor.blurField('name', 'Pip Two');
  assert.equal(first, true);
  assert.deepEqual(fake.calls, [{ method: 'update', id: 'chr_0123456789abcdef', body: { name: 'Pip Two' } }]);
  assert.equal(editor.getState().revision, 3);

  const second = await editor.blurField('name', 'Pip Two');
  assert.equal(second, false);
  assert.equal(fake.calls.length, 1, 'an unchanged field is not patched again');

  await editor.blurField('summary', 'New summary');
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.calls[1].body, { summary: 'New summary' });
});

test('autosave on blur sends a nested patch for the look and voice sections', async () => {
  const fake = fakeApi();
  const editor = new CharacterEditorController({ api: fake.api, character: fake.current });

  await editor.blurField('visual.identityPrompt', 'glossy coffee bean');
  await editor.blurField('voice.speed', '1.1');
  await editor.blurField('bible.mannerisms', 'bounces\nwaves');

  assert.deepEqual(fake.calls.map(call => call.body), [
    { visual: { identityPrompt: 'glossy coffee bean' } },
    { voice: { speed: 1.1 } },
    { bible: { mannerisms: ['bounces', 'waves'] } },
  ]);
});

test('primary toggle keeps exactly one primary image and patches the image list once', async () => {
  const fake = fakeApi();
  const editor = new CharacterEditorController({ api: fake.api, character: fake.current });

  const html = renderCharacterEditor(editor.getState());
  assert.equal((html.match(/data-primary-badge/g) ?? []).length, 1);
  assert.match(html, /data-image-id="img_aaaaaaaaaaaaaaaa"/);

  const changed = await editor.setPrimary('img_bbbbbbbbbbbbbbbb');
  assert.equal(changed, true);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].body.visual.images.length, 2);
  assert.deepEqual(
    fake.calls[0].body.visual.images.map(image => [image.imgId, image.primary]),
    [
      ['img_aaaaaaaaaaaaaaaa', false],
      ['img_bbbbbbbbbbbbbbbb', true],
    ],
  );
  assert.equal(editor.getState().draft.visual.images.filter(image => image.primary).length, 1);
  assert.equal(editor.getState().draft.visual.images.find(image => image.primary).imgId, 'img_bbbbbbbbbbbbbbbb');
});

test('a new character cannot be saved until the fictional checkbox is acknowledged', async () => {
  const fake = fakeApi();
  const editor = new CharacterEditorController({
    api: fake.api,
    voiceOptions: VOICE_OPTIONS,
  });
  editor.setField('name', 'Nova');
  editor.setField('handle', 'nova');

  const blocked = await editor.save();
  assert.equal(blocked, false);
  assert.equal(fake.calls.length, 0, 'no create before the fictional acknowledgment');
  assert.equal(editor.getState().fictional, false);
  const blockedHtml = renderCharacterEditor(editor.getState());
  assert.match(blockedHtml, /data-fictional name="fictional"/);
  assert.doesNotMatch(blockedHtml, /data-fictional name="fictional" checked/);
  assert.match(blockedHtml, /data-action="save" disabled/);

  editor.setFictional(true);
  const saved = await editor.save();
  assert.equal(saved, true);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].method, 'create');
  assert.equal(fake.calls[0].body.options.fictional, true);
  assert.equal(fake.calls[0].body.input.name, 'Nova');
  assert.equal(editor.getState().fictional, true);
  assert.equal(editor.getState().mode, 'edit');
});

test('unchecking fictional blocks autosave on an existing character', async () => {
  const fake = fakeApi();
  const editor = new CharacterEditorController({ api: fake.api, character: fake.current });
  editor.setFictional(false);
  const saved = await editor.blurField('name', 'Changed');
  assert.equal(saved, false);
  assert.equal(fake.calls.length, 0);
});

test('voice pickers come from voice-options and presets expand into the character voice', async () => {
  const fake = fakeApi();
  const editor = new CharacterEditorController({
    api: fake.api,
    character: fake.current,
    voiceOptions: VOICE_OPTIONS,
  });

  const kokoro = renderCharacterEditor(editor.getState());
  assert.match(kokoro, /Heart · warm female/);
  assert.match(kokoro, /Qwen Ryan · curious and conversational/);
  assert.match(kokoro, /am_michael/);
  assert.match(kokoro, /af_heart/);
  assert.doesNotMatch(kokoro, /data-field="voice.voice"[^>]*>.*>Ryan</);

  editor.selectEngine('qwen3-tts');
  const qwen = renderCharacterEditor(editor.getState());
  assert.match(qwen, />Ryan</);
  assert.match(qwen, />Aiden</);
  assert.doesNotMatch(qwen, />am_michael</);

  const chosen = editor.choosePreset('ryan-curious');
  assert.equal(chosen, true);
  assert.equal(editor.getState().draft.voice.engine, 'qwen3-tts');
  assert.equal(editor.getState().draft.voice.voice, 'Ryan');
  assert.equal(editor.getState().draft.voice.presetId, 'ryan-curious');
  assert.match(renderCharacterEditor(editor.getState()), /Qwen Ryan · curious and conversational/);
});

test('voice options load from the injected endpoint or fake api', async () => {
  const fake = fakeApi();
  const fromApi = new CharacterEditorController({ api: fake.api, character: fake.current });
  await fromApi.loadVoiceOptions();
  assert.equal(fromApi.getState().voiceOptions.qwenSpeakers.length, 2);

  let requested = '';
  const fromFetch = new CharacterEditorController({
    api: {},
    character: fake.current,
    apiFetch: async (input: RequestInfo | URL) => {
      requested = String(input);
      return new Response(JSON.stringify(VOICE_OPTIONS), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  await fromFetch.loadVoiceOptions();
  assert.equal(requested, '/api/voice-options');
  assert.equal(fromFetch.getState().voiceOptions.kokoroVoices[0].id, 'am_michael');
});

test('audition button is enabled for local Kokoro and disabled with a reason for Qwen without a runtime', () => {
  const fake = fakeApi();
  const kokoro = new CharacterEditorController({ api: fake.api, character: fake.current });
  const kokoroState = kokoro.auditionState();
  assert.equal(kokoroState.disabled, false);
  const kokoroHtml = renderCharacterEditor(kokoro.getState());
  assert.match(kokoroHtml, /data-action="audition"[,>]/);
  assert.doesNotMatch(kokoroHtml, /data-action="audition" disabled/);

  const qwenCharacter = character({
    voice: { engine: 'qwen3-tts', voice: 'Ryan', qwen_mode: 'custom', sampleLines: [] },
  });
  const unavailable = new CharacterEditorController({ api: fake.api, character: qwenCharacter });
  assert.equal(unavailable.auditionState().disabled, true);
  const unavailableHtml = renderCharacterEditor(unavailable.getState());
  assert.match(unavailableHtml, /data-action="audition" disabled/);
  assert.match(unavailableHtml, /Qwen narration needs a local or remote runtime/);

  const available = new CharacterEditorController({
    api: fake.api,
    character: qwenCharacter,
    qwenAvailable: true,
  });
  assert.equal(available.auditionState().disabled, false);
  assert.match(renderCharacterEditor(available.getState()), /data-action="audition"[,>]/);

  const none = new CharacterEditorController({
    api: fake.api,
    character: character({ voice: { engine: 'none', sampleLines: [] } }),
  });
  assert.equal(none.auditionState().disabled, true);
  assert.match(renderCharacterEditor(none.getState()), /Choose a voice before auditioning/);
});

test('audition calls the injected synthesizer with the character voice and line', async () => {
  const fake = fakeApi();
  const requests: Array<Record<string, unknown>> = [];
  const editor = new CharacterEditorController({
    api: fake.api,
    character: fake.current,
    audition: async (draft, line, options) => {
      requests.push({ draft, line, options });
      return { ok: true, file: 'auditions/abc.wav', url: 'blob:audition' };
    },
  });
  const result = await editor.audition('Fresh is best.');
  assert.equal(result.status, 'ready');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].line, 'Fresh is best.');
  assert.equal(requests[0].options.voice.voice, 'am_michael');
  assert.match(renderCharacterEditor(editor.getState()), /blob:audition/);
});
