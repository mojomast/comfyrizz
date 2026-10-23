// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AB_MAX_GAIN_DB,
  AB_TARGET_RMS_DBFS,
  createAuditionPanel,
  mountAuditionPanel,
} from '../src/characters/audition-panel.ts';

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

function fakeApi(outcomes) {
  const calls = { update: [], audition: [], decision: [] };
  let current = character();
  let auditionIndex = 0;
  return {
    calls,
    async update(id, patch, options) {
      calls.update.push({ id, patch: structuredClone(patch), options });
      current = {
        ...current,
        revision: current.revision + 1,
        voice: { ...current.voice, ...structuredClone(patch.voice) },
      };
      return structuredClone(current);
    },
    async requestAudition(request) {
      calls.audition.push(structuredClone(request));
      const scripted = outcomes[auditionIndex % outcomes.length];
      auditionIndex += 1;
      return { ...scripted, line: request.line };
    },
    async recordAuditionDecision(request) {
      calls.decision.push(structuredClone(request));
      return { ok: true };
    },
  };
}

function audioHarness() {
  const created = [];
  return {
    created,
    factory(url, options) {
      const handle = {
        url,
        options,
        playing: false,
        listeners: new Map(),
        play() { this.playing = true; },
        pause() { this.playing = false; },
        stop() { this.playing = false; },
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

function outcomes() {
  return [
    { ok: true, status: 200, code: 'AUDITION_READY', message: '', voicePath: 'kokoro', url: 'blob:a', rmsDbfs: -30 },
    { ok: true, status: 200, code: 'AUDITION_READY', message: '', voicePath: 'kokoro', url: 'blob:b', rmsDbfs: -20 },
  ];
}

test('IL20: A/B mode pairs two voices on the same line and toggles', () => {
  const panel = createAuditionPanel({
    api: fakeApi(outcomes()),
    character: character(),
    candidates: [candidateA(), candidateB()],
  });

  assert.equal(panel.getState().abEnabled, false);
  assert.match(panel.render(), /data-action="audition-ab-toggle"/);

  const on = panel.setAbMode(true);
  assert.equal(on.abEnabled, true);
  assert.equal(on.abActive, null);
  assert.equal(on.abBlind, false);
  assert.equal(on.abRevealed, false);
  assert.match(panel.render(), /data-ab-enabled="true"/);
  assert.match(panel.render(), /data-action="audition-ab-next"/);
  assert.match(panel.render(), /data-action="audition-ab-keep"/);

  const off = panel.setAbMode(false);
  assert.equal(off.abEnabled, false);
  assert.match(panel.render(), /data-ab-enabled="false"/);
});

test('IL20: A/B mode refuses two voices whose lines differ', () => {
  const panel = createAuditionPanel({
    api: fakeApi(outcomes()),
    character: character(),
    candidates: [candidateA(), candidateB({ sampleLine: 'A different line.' })],
  });

  const state = panel.setAbMode(true);
  assert.equal(state.abEnabled, false);
  assert.match(state.error, /same line/i);
});

test('IL20: compare playback alternates A, B, A', async () => {
  const audio = audioHarness();
  const panel = createAuditionPanel({
    api: fakeApi(outcomes()),
    character: character(),
    candidates: [candidateA(), candidateB()],
    audio: audio.factory,
  });

  panel.setAbMode(true);

  const first = await panel.compareNext();
  assert.equal(first.abActive, 'a');
  assert.equal(first.playingId, 'a');
  assert.equal(audio.created[0].url, 'blob:a');

  panel.ended({ candidateId: 'a' });
  const second = await panel.compareNext();
  assert.equal(second.abActive, 'b');
  assert.equal(second.playingId, 'b');
  assert.equal(audio.created[1].url, 'blob:b');

  panel.ended({ candidateId: 'b' });
  const third = await panel.compareNext();
  assert.equal(third.abActive, 'a');
  assert.equal(third.playingId, 'a');
  assert.equal(audio.created[2].url, 'blob:a');

  assert.deepEqual(audio.created.map(handle => handle.url), ['blob:a', 'blob:b', 'blob:a']);
});

test('IL20: A/B playback applies a client-side gain matched to the reported RMS', async () => {
  const audio = audioHarness();
  const panel = createAuditionPanel({
    api: fakeApi(outcomes()),
    character: character(),
    candidates: [candidateA(), candidateB()],
    audio: audio.factory,
  });
  panel.setAbMode(true);

  const first = await panel.playAbSlot('a');
  assert.equal(first.rows[0].rmsDbfs, -30);
  const loud = audio.created[0].options;
  assert.ok(loud, 'the factory receives the gain options');
  assert.equal(loud.candidateId, 'a');
  assert.equal(loud.blind, false);
  assert.equal(loud.gainDb, AB_TARGET_RMS_DBFS - -30);
  assert.ok(Math.abs(loud.gain - 3.162) < 0.001, `expected about 3.162, got ${loud.gain}`);
  assert.ok(AB_MAX_GAIN_DB >= loud.gainDb);

  const second = await panel.playAbSlot('b');
  assert.equal(second.rows[1].rmsDbfs, -20);
  const reference = audio.created[1].options;
  assert.equal(reference.gainDb, 0);
  assert.equal(reference.gain, 1);
});

test('IL20: blind mode hides names until the pick and keep saves the active voice', async () => {
  const audio = audioHarness();
  const api = fakeApi(outcomes());
  const panel = createAuditionPanel({
    api,
    character: character(),
    candidates: [candidateA(), candidateB()],
    audio: audio.factory,
  });

  panel.setAbMode(true);
  const blind = panel.setBlindMode(true);
  assert.equal(blind.abBlind, true);

  const hidden = panel.render();
  assert.match(hidden, /data-ab-blind="true"/);
  assert.match(hidden, /Voice A/);
  assert.match(hidden, /Voice B/);
  assert.doesNotMatch(hidden, /Michael/);
  assert.doesNotMatch(hidden, /Bella/);
  assert.doesNotMatch(hidden, /am_michael/);
  assert.doesNotMatch(hidden, /af_bella/);

  await panel.playAbSlot('b');
  const kept = await panel.keep();

  assert.equal(kept.abRevealed, true);
  assert.equal(kept.selectedId, 'b');
  assert.equal(kept.playingId, null);
  assert.equal(api.calls.update.length, 1);
  assert.deepEqual(api.calls.update[0].patch.voice, {
    engine: 'kokoro',
    voice: 'af_bella',
    language: 'en-us',
  });

  const revealed = panel.render();
  assert.match(revealed, /Bella/);
  assert.match(revealed, /af_bella/);
});

test('IL20: keyboard A, B and Enter drive playback and keep', async () => {
  const audio = audioHarness();
  const api = fakeApi(outcomes());
  const listeners = new Map();
  const element = {
    innerHTML: '',
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    querySelector() { return null; },
  };
  const mounted = mountAuditionPanel(element, {
    api,
    character: character(),
    candidates: [candidateA(), candidateB()],
    audio: audio.factory,
  });
  mounted.controller.setAbMode(true);
  mounted.controller.setBlindMode(true);

  const press = async (key, tagName = 'DIV') => {
    listeners.get('keydown')({
      key,
      target: { tagName, closest: () => null },
      preventDefault() {},
    });
    await new Promise(resolve => setImmediate(resolve));
  };

  await press('a', 'BUTTON');
  assert.equal(mounted.getState().playingId, 'a');
  assert.equal(audio.created[0].url, 'blob:a');

  mounted.controller.ended({ candidateId: 'a' });
  await press('b');
  assert.equal(mounted.getState().playingId, 'b');
  assert.equal(audio.created[1].url, 'blob:b');

  await press('Enter');
  const state = mounted.getState();
  assert.equal(state.selectedId, 'b');
  assert.equal(state.abRevealed, true);
  assert.equal(api.calls.update.length, 1);
  assert.match(element.innerHTML, /Bella/);

  mounted.destroy();
  assert.equal(element.innerHTML, '');
});
