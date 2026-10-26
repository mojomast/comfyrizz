// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCharacterApi } from './api.ts';
import {
  AuditionPanelController,
  createAuditionPanel,
} from './audition-panel.ts';
import { CharacterEditorController, mountCharacterEditor } from './editor.ts';
import {
  focusWrapTarget,
  shouldCloseCharactersForEscape,
} from './mount.ts';

const CHARACTER_ID = 'chr_0123456789abcdef';
const PLAYED_HASH = '0123456789abcdef0123456789abcdef';
const OTHER_HASH = 'fedcba9876543210fedcba9876543210';

function character(overrides = {}) {
  return {
    schema: 'comfyrizz.character/v1',
    id: CHARACTER_ID,
    revision: 4,
    name: 'Pip',
    handle: 'pip',
    role: 'mascot',
    kind: 'fictional',
    summary: 'Round coffee bean',
    visual: {
      identityPrompt: 'glossy coffee bean',
      negative: '',
      palette: [],
      wardrobe: [],
      expressions: [],
      images: [],
      sheet: { status: 'none' },
      seed: null,
      identity: { method: 'klein_ref' },
    },
    voice: {
      engine: 'kokoro',
      voice: 'am_michael',
      language: 'en-us',
      sampleLines: ['Fresh is best.'],
    },
    bible: {
      personality: '',
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
    ...overrides,
  };
}

function voiceOptions() {
  return {
    version: 1,
    presets: [
      {
        id: 'heart',
        label: 'Heart · warm female',
        voice: { engine: 'kokoro', voice: 'af_heart', language: 'en-us' },
      },
    ],
    kokoroVoices: [
      { id: 'am_michael', label: 'michael · US male', language: 'en-us' },
      { id: 'af_heart', label: 'heart · US female', language: 'en-us' },
    ],
    qwenSpeakers: [],
  };
}

function candidate(overrides = {}) {
  return {
    candidateId: 'heart',
    label: 'Heart',
    engine: 'kokoro',
    voice: 'af_heart',
    language: 'en-us',
    sampleLine: 'Fresh is best.',
    ...overrides,
  };
}

function panelApi(config = {}) {
  const calls = { update: [], audition: [] };
  const api = {
    calls,
    async update(id, patch, options) {
      calls.update.push({ id, patch: structuredClone(patch), options });
      return character({
        revision: 5,
        voice: { ...character().voice, ...structuredClone(patch.voice ?? {}) },
      });
    },
    async requestAudition(request) {
      calls.audition.push(structuredClone(request));
      if (config.audition) return config.audition(request);
      return {
        ok: true,
        status: 200,
        code: 'AUDITION_READY',
        message: '',
        voicePath: 'kokoro',
        voiceHash: PLAYED_HASH,
        line: request.line,
        url: 'blob:audition',
      };
    },
  };
  return api;
}

test('ordinary preset audition calls requestAudition on the character route', async () => {
  const fetches = [];
  const api = createCharacterApi({
    apiFetch: async (input, init) => {
      fetches.push({ url: String(input), init });
      return new Response(JSON.stringify({
        ok: true,
        code: 'AUDITION_READY',
        voicePath: 'kokoro',
        engine: 'kokoro',
        voice: 'af_heart',
        line: 'Fresh is best.',
        voiceHash: PLAYED_HASH,
        file: 'auditions/0123456789abcdef0123456789abcdef.wav',
        url: '/api/media/0123456789abcdef0123456789abcdef',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const editor = new CharacterEditorController({
    api,
    character: character(),
    voiceOptions: voiceOptions(),
  });

  assert.equal(editor.choosePreset('heart'), true);
  const result = await editor.audition('Fresh is best.');

  assert.equal(fetches.length, 1, 'the mounted editor used the character API, not a stock synth');
  assert.equal(fetches[0].url, `/api/characters/${CHARACTER_ID}/audition`);
  assert.equal(fetches[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(fetches[0].init.body)), { line: 'Fresh is best.' });
  assert.equal(result.status, 'ready');
  assert.equal(result.url, '/api/media/0123456789abcdef0123456789abcdef');
  assert.equal(result.file, 'auditions/0123456789abcdef0123456789abcdef.wav');
});

test('the mounted editor sends a preset audition through requestAudition', async () => {
  const fetches = [];
  const api = createCharacterApi({
    apiFetch: async (input, init) => {
      fetches.push({ url: String(input), init });
      return new Response(JSON.stringify({
        ok: true,
        code: 'AUDITION_READY',
        voicePath: 'kokoro',
        voiceHash: PLAYED_HASH,
        url: '/api/media/0123456789abcdef0123456789abcdef',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const listeners = new Map();
  const element = {
    innerHTML: '',
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    querySelector() { return null; },
  };
  const mounted = mountCharacterEditor(element, {
    api,
    character: character(),
    voiceOptions: voiceOptions(),
  });
  mounted.controller.choosePreset('heart');

  listeners.get('click')({
    target: { closest: () => ({ dataset: { action: 'audition' } }) },
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].url, `/api/characters/${CHARACTER_ID}/audition`);
  assert.deepEqual(JSON.parse(String(fetches[0].init.body)), { line: 'Fresh is best.' });
  mounted.destroy();
});

test('Describe shows a real prompt plan without treating it as a failure', async () => {
  const fetches = [];
  const api = createCharacterApi({
    apiFetch: async (input, init) => {
      fetches.push({ url: String(input), init });
      return new Response(JSON.stringify({
        ok: false,
        code: 'AUDITION_PROMPT_PLANNED',
        voicePath: 'prompt',
        state: 'planned',
        message: 'The prompt-mode voice audition is planned as a short generated take; approve it before dispatch',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const editor = new CharacterEditorController({
    api,
    character: character({
      voice: {
        engine: 'kokoro',
        voice: 'am_michael',
        h3Mode: 'prompt',
        voiceDescription: 'Warm and low.',
        seed: 7,
        sampleLines: ['Fresh is best.'],
      },
    }),
  });

  const ok = await editor.auditionVoiceModeDescription();

  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].url, `/api/characters/${CHARACTER_ID}/audition`);
  assert.equal(ok, false, 'a plan is not an approved or dispatched audition');
  assert.equal(editor.voiceUi.code, 'AUDITION_PROMPT_PLANNED');
  assert.equal(editor.voiceUi.error, false, 'the plan status is information, not an error');
  assert.equal(editor.voiceUi.auditionUrl, '');
});

test('Describe sends the prompt mode and description to the audition route', async () => {
  const fetches = [];
  const api = {
    async update(id, patch) {
      return character({ revision: 5, voice: { ...character().voice, ...patch.voice } });
    },
  };
  const editor = new CharacterEditorController({
    api,
    character: character({
      voice: {
        engine: 'kokoro',
        voice: 'am_michael',
        h3Mode: 'prompt',
        voiceDescription: 'Old description.',
        seed: 7,
        sampleLines: ['Fresh is best.'],
      },
    }),
    apiFetch: async (input, init) => {
      fetches.push({ url: String(input), init });
      return new Response(JSON.stringify({
        ok: false,
        code: 'AUDITION_PROMPT_PLANNED',
        voicePath: 'prompt',
        state: 'planned',
        message: 'The prompt-mode voice audition is planned as a short generated take; approve it before dispatch',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  editor.setVoiceModeDescription('Warm and low.');
  await editor.auditionVoiceModeDescription();

  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].url, `/api/characters/${CHARACTER_ID}/audition`);
  assert.deepEqual(JSON.parse(String(fetches[0].init.body)), {
    line: 'Fresh is best.',
    description: 'Warm and low.',
    h3VoiceMode: 'prompt',
  });
  assert.equal(editor.voiceUi.code, 'AUDITION_PROMPT_PLANNED');
  assert.equal(editor.voiceUi.error, false);
});

test('played and selected candidate identities use the same immutable config hash', async () => {
  const api = panelApi();
  const config = {
    engine: 'kokoro',
    voice: 'af_heart',
    language: 'en-us',
    speed: 1.1,
  };
  const panel = createAuditionPanel({
    api,
    character: character(),
    candidates: [candidate({ voiceConfig: config, voiceHash: PLAYED_HASH })],
  });

  const played = await panel.play({ candidateId: 'heart' });
  assert.equal(api.calls.audition.length, 1);
  assert.equal(api.calls.audition[0].candidateId, 'heart');
  assert.equal(api.calls.audition[0].voiceHash, PLAYED_HASH);
  assert.deepEqual(api.calls.audition[0].voice, config);
  assert.equal(played.rows[0].audioHash, PLAYED_HASH);

  const selected = await panel.select({ candidateId: 'heart' });
  assert.deepEqual(api.calls.update[0].patch, { voice: config });
  assert.equal(selected.rows[0].selectedHash, PLAYED_HASH);
  assert.equal(selected.rows[0].selectedHash, selected.rows[0].audioHash);
});

test('candidate config is captured at construction time', async () => {
  const api = panelApi();
  const config = { engine: 'kokoro', voice: 'af_heart', language: 'en-us', speed: 1.1 };
  const source = candidate({ voiceConfig: config, voiceHash: PLAYED_HASH });
  const panel = createAuditionPanel({
    api,
    character: character(),
    candidates: [source],
  });

  config.speed = 1.5;
  source.voice = 'am_michael';

  await panel.play({ candidateId: 'heart' });
  await panel.select({ candidateId: 'heart' });

  assert.equal(api.calls.audition[0].voice.speed, 1.1);
  assert.equal(api.calls.update[0].patch.voice.speed, 1.1);
  assert.equal(api.calls.update[0].patch.voice.voice, 'af_heart');
});

test('an audition whose audio hash differs from the candidate never plays or selects', async () => {
  const audio = [];
  const api = panelApi({
    audition: () => ({
      ok: true,
      status: 200,
      code: 'AUDITION_READY',
      message: '',
      voicePath: 'kokoro',
      voiceHash: OTHER_HASH,
      line: 'Fresh is best.',
      url: 'blob:wrong',
    }),
  });
  const panel = createAuditionPanel({
    api,
    character: character(),
    candidates: [candidate({ voiceHash: PLAYED_HASH, voiceConfig: { engine: 'kokoro', voice: 'af_heart' } })],
    audio: url => {
      audio.push(url);
      return { play() {}, stop() {} };
    },
  });

  const state = await panel.play({ candidateId: 'heart' });
  assert.equal(state.playingId, null);
  assert.equal(audio.length, 0, 'mismatched audio is never handed to the player');
  assert.equal(state.rows[0].audioHash, '');
  assert.equal(state.rows[0].audioMismatch, true);
  assert.match(state.error, /does not match/i);

  const selected = await panel.select({ candidateId: 'heart' });
  assert.equal(api.calls.update.length, 0, 'a mismatched candidate is never saved');
  assert.equal(selected.rows[0].selectedHash, '');
});

test('a rejected candidate stays rejected when the panel is rebuilt from server state', () => {
  const api = panelApi();
  const rejected = candidate({ decision: 'rejected', reason: 'Too flat' });
  const first = new AuditionPanelController({
    api,
    character: character(),
    candidates: [rejected],
  });
  const reloaded = new AuditionPanelController({
    api,
    character: character(),
    candidates: [candidate({ decision: 'rejected', reason: 'Too flat' })],
  });

  for (const panel of [first, reloaded]) {
    const state = panel.getState();
    assert.equal(state.rejectedId, 'heart');
    assert.equal(state.rows[0].decision, 'rejected');
    assert.equal(state.rows[0].reason, 'Too flat');
  }
});

test('Tab wraps inside the Characters modal instead of leaving it', () => {
  const first = { hidden: false, getAttribute: () => null };
  const middle = { hidden: false, getAttribute: () => null };
  const last = { hidden: false, getAttribute: () => null };
  const root = {
    querySelectorAll: () => [first, middle, last],
  };

  assert.equal(focusWrapTarget(root, last, false), first);
  assert.equal(focusWrapTarget(root, first, true), last);
  assert.equal(focusWrapTarget(root, middle, false), null);
  assert.equal(focusWrapTarget(root, middle, true), null);
  assert.equal(focusWrapTarget(root, { hidden: false, getAttribute: () => null }, false), first);
});

test('Escape ignores a dialog above the Characters surface', () => {
  const aboveDialog = { open: true };
  const root = {
    contains: node => node === root,
  };
  const above = {
    closest: selector => selector === 'dialog[open]' ? aboveDialog : null,
  };
  const inside = {
    closest: () => null,
  };

  assert.equal(shouldCloseCharactersForEscape(above, root), false);
  assert.equal(shouldCloseCharactersForEscape(inside, root), true);
  assert.equal(shouldCloseCharactersForEscape(null, root), true);
});
