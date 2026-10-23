// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AuditionPanelController,
  createAuditionPanel,
  mountAuditionPanel,
  renderAuditionPanel,
} from '../src/characters/audition-panel.ts';
import {
  CharacterApiError,
  createCharacterApi,
} from '../src/characters/api.ts';

function clone(value) {
  return value === undefined ? value : structuredClone(value);
}

function character(overrides = {}) {
  return {
    schema: 'comfyrizz.character/v1',
    id: 'chr_0123456789abcdef',
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
    voice: { engine: 'kokoro', voice: 'am_michael', language: 'en-us', sampleLines: ['Fresh is best.'] },
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

function candidateA(overrides = {}) {
  return {
    candidateId: 'a',
    label: 'Michael',
    engine: 'kokoro',
    voice: 'am_michael',
    language: 'en-us',
    sampleLine: 'Fresh is best.',
    ...overrides,
  };
}

function candidateB(overrides = {}) {
  return {
    candidateId: 'b',
    label: 'Bella',
    engine: 'kokoro',
    voice: 'af_bella',
    language: 'en-us',
    sampleLine: 'Fresh is best.',
    ...overrides,
  };
}

function fakeApi(config = {}) {
  const calls = { update: [], audition: [], decision: [] };
  let current = character(config.character);
  const api = {
    calls,
    async update(id, patch, options) {
      calls.update.push({ id, patch: clone(patch), options });
      if (config.updateGate) await config.updateGate;
      if (config.updateError) throw config.updateError;
      current = {
        ...current,
        revision: current.revision + 1,
        voice: { ...current.voice, ...clone(patch.voice) },
      };
      return clone(current);
    },
    async requestAudition(request) {
      calls.audition.push(clone(request));
      if (config.audition) return config.audition(request, calls);
      return {
        ok: true,
        status: 200,
        code: 'AUDITION_READY',
        message: '',
        voicePath: 'kokoro',
        engine: 'kokoro',
        voice: 'am_michael',
        line: request.line,
        file: 'auditions/0123456789abcdef0123456789abcdef.wav',
        voiceHash: '0123456789abcdef0123456789abcdef',
        url: 'blob:audition',
      };
    },
  };
  if (config.record !== false) {
    api.recordAuditionDecision = async request => {
      calls.decision.push(clone(request));
      if (config.decisionGate) await config.decisionGate;
      if (config.decisionError) throw config.decisionError;
      return { ok: true };
    };
  }
  return api;
}

function audioHarness() {
  const created = [];
  return {
    created,
    factory(url) {
      const handle = {
        url,
        playing: false,
        stops: 0,
        listeners: new Map(),
        play() { this.playing = true; },
        pause() { this.playing = false; },
        stop() { this.stops += 1; this.playing = false; },
        addEventListener(type, listener) {
          const list = this.listeners.get(type) ?? [];
          list.push(listener);
          this.listeners.set(type, list);
        },
        removeEventListener(type, listener) {
          const list = this.listeners.get(type) ?? [];
          this.listeners.set(type, list.filter(item => item !== listener));
        },
        emit(type) {
          for (const listener of this.listeners.get(type) ?? []) listener({ type });
        },
      };
      created.push(handle);
      return handle;
    },
  };
}

test('select persists the Kokoro voice and only shows Selected after api.update resolves', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const api = fakeApi({ updateGate: gate });
  const panel = createAuditionPanel({
    api,
    character: character(),
    candidates: [candidateA()],
  });

  const pending = panel.select({ candidateId: 'a' });
  await Promise.resolve();

  assert.equal(panel.getState().selectedId, null);
  assert.equal(panel.getState().rows[0].decision, 'pending');
  assert.equal(panel.getState().rows[0].busy, true);
  assert.doesNotMatch(panel.render(), />Selected</);

  release();
  const state = await pending;

  assert.equal(state.selectedId, 'a');
  assert.equal(state.rows[0].decision, 'selected');
  assert.equal(state.rows[0].busy, false);
  assert.match(panel.render(), />Selected</);
  assert.equal(api.calls.update.length, 1);
  assert.equal(api.calls.update[0].id, 'chr_0123456789abcdef');
  assert.deepEqual(api.calls.update[0].patch, {
    voice: { engine: 'kokoro', voice: 'am_michael', language: 'en-us' },
  });
  assert.equal(api.calls.update[0].options.revision, 4, 'the character revision is the CAS base');
});

test('a failed select leaves the row pending and restores the previous decision with one error', async () => {
  const api = fakeApi();
  const panel = createAuditionPanel({
    api,
    character: character(),
    candidates: [candidateA(), candidateB()],
  });

  await panel.select({ candidateId: 'a' });
  assert.equal(panel.getState().selectedId, 'a');

  api.update = async () => {
    throw new CharacterApiError('character changed upstream', 409, 'REVISION_CONFLICT');
  };
  const state = await panel.select({ candidateId: 'b' });

  assert.equal(state.selectedId, 'a', 'the previous selection survives a conflicted save');
  assert.equal(state.rows[0].decision, 'selected');
  assert.equal(state.rows[1].decision, 'pending');
  assert.equal(state.rows[1].busy, false);
  assert.match(state.error, /character changed upstream/);
  assert.equal((panel.render().match(/data-role="audition-error"/g) || []).length, 1);
});

test('reject is disabled without a server recorder and never records a local decision', async () => {
  const api = fakeApi({ record: false });
  const panel = createAuditionPanel({
    api,
    character: character(),
    candidates: [candidateA()],
  });

  assert.equal(panel.getState().rejectEnabled, false);
  const html = panel.render();
  assert.match(html, /Saving rejections is not available yet/);
  assert.match(html, /data-action="audition-reject"[^>]*disabled/);

  const state = await panel.reject({ candidateId: 'a', reason: 'Too flat' });
  assert.equal(state.rows[0].decision, 'pending');
  assert.equal(api.calls.decision.length, 0);
});

test('reject requires a non-empty reason and records one decision object', async () => {
  const api = fakeApi();
  const panel = createAuditionPanel({
    api,
    character: character(),
    candidates: [candidateA()],
  });

  assert.equal(panel.getState().rejectEnabled, true);
  const empty = await panel.reject({ candidateId: 'a', reason: '   ' });
  assert.equal(empty.rows[0].decision, 'pending');
  assert.match(empty.error, /reason/i);
  assert.equal(api.calls.decision.length, 0);

  const state = await panel.reject({ candidateId: 'a', reason: 'Too flat' });
  assert.equal(state.rows[0].decision, 'rejected');
  assert.equal(state.rows[0].reason, 'Too flat');
  assert.equal(state.rejectedId, 'a');
  assert.deepEqual(api.calls.decision[0], {
    characterId: 'chr_0123456789abcdef',
    candidateId: 'a',
    status: 'rejected',
    reason: 'Too flat',
  });
});

test('a 409 AUDITION_NATIVE_VOICE becomes a native row and never plays', async () => {
  const audio = audioHarness();
  const api = fakeApi({
    audition: () => ({
      ok: false,
      status: 409,
      code: 'AUDITION_NATIVE_VOICE',
      message: 'This model speaks with its built-in voice; audition it in a generated take',
      voicePath: 'native',
      voice: 'minimax-narrator',
      language: 'en-us',
    }),
  });
  const panel = createAuditionPanel({
    api,
    character: character(),
    candidates: [candidateA()],
    audio: audio.factory,
  });

  assert.equal(panel.getState().rows[0].voicePath, 'unknown', 'unknown is never guessed as Kokoro');
  const state = await panel.play({ candidateId: 'a' });

  assert.equal(state.rows[0].voicePath, 'native');
  assert.equal(state.playingId, null);
  assert.equal(state.rows[0].playing, false);
  assert.equal(audio.created.length, 0);
  assert.match(panel.render(), /audition it in a generated take/);
  assert.doesNotMatch(panel.render(), /data-action="audition-play"/);
});

test('a thrown AUDITION_NATIVE_VOICE error is still a native row and never plays', async () => {
  const audio = audioHarness();
  const api = fakeApi({
    audition: () => {
      const error = new Error('This model speaks with its built-in voice');
      error.code = 'AUDITION_NATIVE_VOICE';
      error.status = 409;
      throw error;
    },
  });
  const panel = createAuditionPanel({
    api,
    character: character(),
    candidates: [candidateA()],
    audio: audio.factory,
  });

  const state = await panel.play({ candidateId: 'a' });
  assert.equal(state.rows[0].voicePath, 'native');
  assert.equal(state.playingId, null);
  assert.equal(audio.created.length, 0);
  assert.match(panel.render(), /audition it in a generated take/);
});

test('a server-provided native candidate is not played or sent to the audio path', async () => {
  const audio = audioHarness();
  const api = fakeApi();
  const panel = createAuditionPanel({
    api,
    character: character(),
    candidates: [{ candidateId: 'n', label: 'Model voice', voicePath: 'native' }],
    audio: audio.factory,
  });

  const state = await panel.play({ candidateId: 'n' });
  assert.equal(state.rows[0].voicePath, 'native');
  assert.equal(state.playingId, null);
  assert.equal(api.calls.audition.length, 0);
  assert.equal(audio.created.length, 0);
  assert.match(panel.render(), /audition it in a generated take/);
});

test('starting another row stops the first and an ended event never approves', async () => {
  const audio = audioHarness();
  const api = fakeApi();
  const panel = createAuditionPanel({
    api,
    character: character(),
    candidates: [candidateA(), candidateB()],
    audio: audio.factory,
  });

  await panel.play({ candidateId: 'a' });
  assert.equal(panel.getState().playingId, 'a');
  assert.equal(panel.getState().rows[0].playing, true);
  assert.equal(audio.created.length, 1);

  await panel.play({ candidateId: 'b' });
  assert.equal(panel.getState().playingId, 'b');
  assert.equal(panel.getState().rows[0].playing, false);
  assert.equal(panel.getState().rows[1].playing, true);
  assert.ok(audio.created[0].stops >= 1, 'the first row was stopped');

  audio.created[1].emit('ended');
  assert.equal(panel.getState().playingId, null);
  assert.equal(panel.getState().rows[1].playing, false);
  assert.equal(panel.getState().selectedId, null);
  assert.equal(panel.getState().rows[1].decision, 'pending');

  await panel.play({ candidateId: 'a' });
  panel.ended({ candidateId: 'a' });
  assert.equal(panel.getState().selectedId, null);
  assert.equal(panel.getState().rows[0].decision, 'pending');
});

test('labels, messages and reasons are escaped in the rendered panel', async () => {
  const api = fakeApi();
  const panel = createAuditionPanel({
    api,
    character: character(),
    candidates: [candidateA({ label: '<img src=x onerror=alert(1)>', voice: 'am_<x>' })],
  });
  api.update = async () => { throw new Error('<script>boom</script>'); };

  await panel.select({ candidateId: 'a' });
  const html = panel.render();

  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;boom&lt;\/script&gt;/);
  assert.match(html, /data-role="audition-error"/);
});

test('play, select and reject controls are native buttons with a visible focus hook', () => {
  const panel = createAuditionPanel({
    api: fakeApi(),
    character: character(),
    candidates: [candidateA()],
  });
  const html = panel.render();

  for (const action of ['play', 'select', 'reject']) {
    assert.match(
      html,
      new RegExp(`<button type="button"[^>]*data-action="audition-${action}"[^>]*>`),
      `${action} is a keyboard-operable button`,
    );
  }
  assert.match(html, /data-focus-ring="visible"/);
  assert.match(html, /data-role="audition-reason"/);
});

test('the public module keeps one name per action and no client capability detector', async () => {
  const module = await import('../src/characters/audition-panel.ts');
  for (const name of [
    'supportsNativeVoice',
    'candidateVoicePath',
    'voicePathForModel',
    'auditionVoice',
    'auditionOutcome',
    'accept',
    'rejectCandidate',
    'audition',
    'normalizeAuditionCandidate',
  ]) {
    assert.equal(module[name], undefined, `${name} must not exist`);
  }
  assert.equal(typeof module.createAuditionPanel, 'function');
  assert.equal(typeof module.renderAuditionPanel, 'function');
  assert.equal(typeof module.mountAuditionPanel, 'function');
  assert.equal(typeof module.AuditionPanelController, 'function');

  const apiModule = await import('../src/characters/api.ts');
  assert.equal(apiModule.supportsNativeVoice, undefined);
  const api = createCharacterApi({ apiFetch: async () => new Response('{}', { status: 200 }) });
  assert.equal(typeof api.requestAudition, 'function');
  assert.equal(api.supportsNativeVoice, undefined);
});

test('requestAudition is non-throwing and normalizes only the server voice path', async () => {
  const calls = [];
  const native = createCharacterApi({
    apiFetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({
        ok: false,
        code: 'AUDITION_NATIVE_VOICE',
        voicePath: 'native',
        message: 'This model speaks with its built-in voice',
      }), { status: 409, headers: { 'content-type': 'application/json' } });
    },
  });
  const outcome = await native.requestAudition({
    characterId: 'chr_0123456789abcdef',
    line: 'Fresh is best.',
    nativeVoice: 'minimax-narrator',
    language: 'en-us',
  });
  assert.equal(calls[0].url, '/api/characters/chr_0123456789abcdef/audition');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    line: 'Fresh is best.',
    nativeVoice: 'minimax-narrator',
    language: 'en-us',
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 409);
  assert.equal(outcome.code, 'AUDITION_NATIVE_VOICE');
  assert.equal(outcome.voicePath, 'native');

  const offline = createCharacterApi({
    apiFetch: async () => { throw new Error('offline'); },
  });
  const failed = await offline.requestAudition({ characterId: 'chr_0123456789abcdef' });
  assert.equal(failed.ok, false);
  assert.equal(failed.voicePath, 'unknown');
  assert.match(failed.message, /offline/);
});

test('update sends the CAS revision header and stays backwards compatible', async () => {
  const calls = [];
  const api = createCharacterApi({
    apiFetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify(character({ revision: 5 })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  await api.update('chr_0123456789abcdef', { voice: { engine: 'kokoro', voice: 'af_bella' } }, { revision: 4 });
  const headers = calls[0].init.headers;
  assert.equal(headers['if-match'], '4');
  assert.equal(headers['x-character-revision'], undefined, 'one CAS header, no alias');

  await api.update('chr_0123456789abcdef', { summary: 'plain' });
  assert.equal(calls[1].init.headers['if-match'], undefined);
});

test('mounting wires play, select and reject through delegated controls', async () => {
  const api = fakeApi();
  const listeners = new Map();
  const reason = { value: 'Too flat' };
  const element = {
    innerHTML: '',
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    querySelector() { return reason; },
  };
  const mounted = mountAuditionPanel(element, {
    api,
    character: character(),
    candidates: [candidateA()],
  });
  assert.match(element.innerHTML, /data-action="audition-play"/);

  const target = action => ({
    getAttribute(name) {
      if (name === 'data-action') return action;
      if (name === 'data-candidate-id') return 'a';
      return null;
    },
    closest(selector) {
      return selector === '[data-action]' ? this : null;
    },
  });
  listeners.get('click')({ target: target('audition-select') });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.calls.update.length, 1);
  assert.match(element.innerHTML, />Selected</);

  listeners.get('click')({ target: target('audition-reject') });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.calls.decision.length, 1);
  assert.equal(api.calls.decision[0].reason, 'Too flat');

  mounted.destroy();
  assert.equal(element.innerHTML, '');
});

test('renderAuditionPanel accepts controller state without a DOM', () => {
  const panel = createAuditionPanel({
    api: fakeApi(),
    character: character(),
    candidates: [candidateB()],
  });
  const html = renderAuditionPanel(panel.getState());
  assert.match(html, /Bella/);
  assert.match(html, /data-candidate-id="b"/);
  assert.equal(panel instanceof AuditionPanelController, true);
});

test('IP46 review fix-up: one selected row, Kokoro only, and the voice path is never sniffed from a URL', async () => {
  const saved = [];
  const api = { update: async (id, patch) => { saved.push(patch); return character({ revision: 5 }); } };
  const panel = createAuditionPanel({
    api,
    character: character(),
    candidates: [
      { candidateId: 'a', engine: 'kokoro', voice: 'af_heart' },
      { candidateId: 'b', engine: 'kokoro', voice: 'af_bella' },
      { candidateId: 'q', engine: 'qwen3-tts', voice: 'Ryan' },
    ],
  });
  await panel.select({ candidateId: 'a' });
  const state = await panel.select({ candidateId: 'b' });
  assert.deepEqual(state.rows.map(row => [row.candidateId, row.decision]), [['a', 'pending'], ['b', 'selected'], ['q', 'pending']]);
  const qwen = await panel.select({ candidateId: 'q' });
  assert.equal(saved.length, 2, 'a Qwen3-TTS candidate is never saved');
  assert.equal(qwen.selectedId, 'b');
  assert.match(qwen.error, /Kokoro/);
  assert.equal(panel.snapshot, undefined);
  assert.equal(panel.toHTML, undefined);

  const sniffed = createCharacterApi({
    apiFetch: async () => new Response(JSON.stringify({ ok: true, url: '/api/media/abc', file: 'x.wav' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });
  const outcome = await sniffed.requestAudition({ characterId: 'chr_0123456789abcdef' });
  assert.equal(outcome.voicePath, 'unknown');
});
