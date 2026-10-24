// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { COPY, fill } from './copy.ts';
import { buildGalleryModel } from './gallery-model.ts';

function fullSnapshot() {
  return {
    production: {
      id: 'prod_1',
      revision: 4,
      shotIds: ['shot_1', 'shot_2', 'shot_3'],
      characterBindings: [
        { characterId: 'char_mira', name: 'Mira', artifactId: 'art_mira' },
        { characterId: 'char_bo' },
      ],
      latestDeliveryId: 'del_1',
    },
    characters: [{ id: 'char_mira', name: 'Mira', status: 'ready' }],
    artifacts: [
      { id: 'art_mira', kind: 'identity', metadata: { imageUrl: '/media/mira.png' } },
      { id: 'art_s1', kind: 'conditioning', shotId: 'shot_1', url: '/media/shot-1.png' },
      { id: 'art_s2', kind: 'native_take', metadata: { shotId: 'shot_2', videoUrl: 'https://cdn.example/shot-2.mp4' } },
      { id: 'art_v1', kind: 'audition', metadata: { shotId: 'shot_1', audioUrl: '/media/voice-1.mp3' } },
    ],
    actions: [
      { id: 'act_1', shotId: 'shot_1', state: 'completed' },
      { id: 'act_2', shotId: 'shot_2', state: 'running' },
      { id: 'act_3', shotId: 'shot_3', state: 'planned' },
    ],
    deliveries: [{ id: 'del_1', status: 'ready', url: '/media/final.mp4' }],
  };
}

function byId(model, id) {
  return model.items.find((item) => item.id === id);
}

test('orders stable character, shot, voice and final items', () => {
  const model = buildGalleryModel(fullSnapshot());

  assert.deepEqual(
    model.items.map((item) => item.kind),
    ['character', 'character', 'shot', 'shot', 'shot', 'voice', 'final'],
  );
  assert.deepEqual(
    model.items.map((item) => item.id),
    [
      'character:char_mira',
      'character:char_bo',
      'shot:shot_1',
      'shot:shot_2',
      'shot:shot_3',
      'voice:art_v1',
      'final',
    ],
  );
  assert.deepEqual(
    model.items.map((item) => item.index),
    [0, 1, 2, 3, 4, 5, 6],
  );
  assert.deepEqual(model.items.map((item) => item.state), [
    'ready',
    'empty',
    'ready',
    'ready',
    'empty',
    'ready',
    'ready',
  ]);
});

test('the final item is highlighted only while it is ready', () => {
  const ready = buildGalleryModel(fullSnapshot());
  const final = byId(ready, 'final');
  assert.equal(final.kind, 'final');
  assert.equal(final.state, 'ready');
  assert.equal(final.highlighted, true);
  assert.equal(final.url, '/media/final.mp4');
  assert.equal(ready.items.filter((item) => item.highlighted).length, 1);

  const loading = buildGalleryModel({
    production: { id: 'prod_2', shotIds: ['shot_1'] },
    actions: [{ id: 'act_1', shotId: 'shot_1', state: 'running' }],
  });
  assert.equal(byId(loading, 'final').state, 'loading');
  assert.equal(byId(loading, 'final').highlighted, false);

  const failed = buildGalleryModel({
    deliveries: [{ id: 'del_1', status: 'failed' }],
  });
  assert.equal(byId(failed, 'final').state, 'error');
  assert.equal(byId(failed, 'final').highlighted, false);
});

test('the same snapshot produces the same items and is not mutated', () => {
  const snapshot = fullSnapshot();
  const before = structuredClone(snapshot);

  const first = buildGalleryModel(snapshot);
  const second = buildGalleryModel(snapshot);

  assert.deepEqual(first, second);
  assert.deepEqual(first.items, second.items);
  assert.deepEqual(snapshot, before);
});

test('URLs are surfaced exactly as the snapshot carries them, never invented', () => {
  const model = buildGalleryModel(fullSnapshot());
  assert.equal(byId(model, 'character:char_mira').url, '/media/mira.png');
  assert.equal(byId(model, 'shot:shot_1').url, '/media/shot-1.png');
  assert.equal(byId(model, 'shot:shot_2').url, 'https://cdn.example/shot-2.mp4');
  assert.equal(byId(model, 'voice:art_v1').url, '/media/voice-1.mp3');
  assert.equal(byId(model, 'final').url, '/media/final.mp4');

  const bare = buildGalleryModel({
    production: {
      id: 'prod_bare',
      shotIds: ['shot_a', 'shot_b'],
      characterBindings: [{ characterId: 'char_a' }],
    },
    characters: [{ id: 'char_a', name: 'Ava' }],
    actions: [
      { id: 'act_a', shotId: 'shot_a', state: 'completed' },
      { id: 'act_b', shotId: 'shot_b', state: 'failed' },
    ],
  });
  for (const item of bare.items) {
    assert.equal(item.url, null, `${item.id} has no snapshot URL`);
    assert.doesNotMatch(item.url ?? '', /shot_a|shot_b|char_a|\/media\//u);
  }
});

test('failed tiles carry the Couldn\u2019t make reason from copy', () => {
  const model = buildGalleryModel({
    production: {
      id: 'prod_fail',
      shotIds: ['shot_fail'],
      characterBindings: [{ characterId: 'char_fail', status: 'failed' }],
      latestDeliveryId: 'del_fail',
    },
    artifacts: [
      { id: 'art_voice_fail', kind: 'audition', status: 'error', shotId: 'shot_fail' },
    ],
    actions: [{ id: 'act_fail', shotId: 'shot_fail', state: 'failed' }],
    deliveries: [{ id: 'del_fail', status: 'failed' }],
  });

  const expected = {
    'character:char_fail': fill(COPY.gallery.error, { stage: 'the characters' }),
    'shot:shot_fail': fill(COPY.gallery.error, { stage: 'this shot' }),
    'voice:art_voice_fail': fill(COPY.gallery.error, { stage: 'the voice' }),
    final: fill(COPY.gallery.error, { stage: 'the video' }),
  };
  for (const [id, reason] of Object.entries(expected)) {
    const item = byId(model, id);
    assert.equal(item.state, 'error', id);
    assert.equal(item.reason, reason, id);
    assert.match(item.reason, /^Couldn't make /u, id);
  }
  for (const item of model.items) {
    if (item.state !== 'error') assert.equal(item.reason, null, item.id);
  }
});

test('empty and loading tiles are honest about the snapshot', () => {
  const model = buildGalleryModel({
    production: {
      id: 'prod_states',
      shotIds: ['shot_waiting', 'shot_planned'],
      characterBindings: [{ characterId: 'char_quiet' }],
    },
    actions: [
      { id: 'act_waiting', shotId: 'shot_waiting', state: 'queued' },
      { id: 'act_planned', shotId: 'shot_planned', state: 'planned' },
    ],
  });

  assert.equal(byId(model, 'character:char_quiet').state, 'empty');
  assert.equal(byId(model, 'shot:shot_waiting').state, 'loading');
  assert.equal(byId(model, 'shot:shot_planned').state, 'empty');
  assert.equal(byId(model, 'final').state, 'loading');
  assert.equal(model.counts.character, 1);
  assert.equal(model.counts.shot, 2);
  assert.equal(model.counts.voice, 0);
  assert.equal(model.counts.final, 1);
  assert.equal(model.states.loading, 2);
});

test('duplicate ids collapse to the first item and keep the first URL', () => {
  const model = buildGalleryModel({
    production: {
      id: 'prod_dupe',
      shotIds: ['shot_1', 'shot_1'],
      characterBindings: [
        { characterId: 'char_1', imageUrl: '/media/first.png' },
        { characterId: 'char_1', imageUrl: '/media/second.png' },
      ],
    },
    artifacts: [
      { id: 'art_1', kind: 'conditioning', shotId: 'shot_1', url: '/media/shot-first.png' },
      { id: 'art_1', kind: 'conditioning', shotId: 'shot_1', url: '/media/shot-second.png' },
    ],
    actions: [
      { id: 'act_1', shotId: 'shot_1', state: 'completed' },
      { id: 'act_1', shotId: 'shot_1', state: 'failed' },
    ],
  });

  assert.equal(model.items.filter((item) => item.id === 'character:char_1').length, 1);
  assert.equal(model.items.filter((item) => item.id === 'shot:shot_1').length, 1);
  assert.equal(byId(model, 'character:char_1').url, '/media/first.png');
  assert.equal(byId(model, 'shot:shot_1').url, '/media/shot-first.png');
});

test('a journal-only production snapshot still builds every kind', () => {
  const model = buildGalleryModel({
    production: {
      id: 'prod_events',
      shotIds: ['shot_1'],
      latestDeliveryId: 'del_1',
    },
    events: [
      {
        id: 'evt_1',
        sequence: 1,
        type: 'character.created',
        data: {
          characterId: 'char_mira',
          name: 'Mira',
          status: 'ready',
          imageUrl: '/media/mira.png',
        },
      },
      {
        id: 'evt_2',
        sequence: 2,
        type: 'action.state_changed',
        data: { id: 'act_1', shotId: 'shot_1', state: 'running' },
      },
      {
        id: 'evt_3',
        sequence: 3,
        type: 'take.landed',
        data: { takeId: 'take_1', shotId: 'shot_1', url: '/media/take-1.mp4' },
      },
      {
        id: 'evt_4',
        sequence: 4,
        type: 'character.audition.ready',
        data: {
          characterId: 'char_mira',
          voiceId: 'voice_1',
          status: 'ready',
          audioUrl: '/media/mira-voice.mp3',
        },
      },
      {
        id: 'evt_5',
        sequence: 5,
        type: 'delivery.updated',
        data: { id: 'del_1', status: 'ready', url: '/media/final.mp4' },
      },
    ],
  });

  assert.equal(byId(model, 'character:char_mira').state, 'ready');
  assert.equal(byId(model, 'character:char_mira').url, '/media/mira.png');
  assert.equal(byId(model, 'shot:shot_1').state, 'ready');
  assert.equal(byId(model, 'shot:shot_1').url, '/media/take-1.mp4');
  assert.equal(model.items.filter((item) => item.kind === 'voice').length, 1);
  assert.equal(model.items.find((item) => item.kind === 'voice').url, '/media/mira-voice.mp3');
  assert.equal(byId(model, 'final').state, 'ready');
  assert.equal(byId(model, 'final').highlighted, true);
});

test('only safe snapshot URLs reach a tile', () => {
  const model = buildGalleryModel({
    production: {
      id: 'prod_urls',
      shotIds: ['shot_safe', 'shot_script', 'shot_file'],
      characterBindings: [],
    },
    artifacts: [
      { id: 'art_safe', kind: 'conditioning', shotId: 'shot_safe', url: 'https://cdn.example/ok.png' },
      { id: 'art_script', kind: 'conditioning', shotId: 'shot_script', url: 'javascript:alert(1)' },
      { id: 'art_file', kind: 'conditioning', shotId: 'shot_file', url: 'file:///etc/passwd' },
    ],
    actions: [
      { id: 'act_safe', shotId: 'shot_safe', state: 'completed' },
      { id: 'act_script', shotId: 'shot_script', state: 'completed' },
      { id: 'act_file', shotId: 'shot_file', state: 'completed' },
    ],
  });

  assert.equal(byId(model, 'shot:shot_safe').url, 'https://cdn.example/ok.png');
  assert.equal(byId(model, 'shot:shot_script').url, null);
  assert.equal(byId(model, 'shot:shot_file').url, null);
});

test('accepts a flat asset snapshot and a wrapped production snapshot', () => {
  const flat = buildGalleryModel({
    characters: [{ id: 'char_1', name: 'Mira', imageUrl: '/media/mira.png' }],
    shots: [{ id: 'shot_1', label: 'Opening', previewUrl: '/media/open.png', status: 'ready' }],
    voices: [{ id: 'voice_1', label: 'Narrator', audioUrl: '/media/voice.mp3', status: 'ready' }],
    final: { url: '/media/final.mp4', status: 'ready' },
  });
  assert.deepEqual(flat.items.map((item) => item.kind), ['character', 'shot', 'voice', 'final']);
  assert.equal(byId(flat, 'character:char_1').label, 'Mira');
  assert.equal(byId(flat, 'shot:shot_1').label, 'Opening');
  assert.equal(byId(flat, 'voice:voice_1').label, 'Narrator');
  assert.equal(byId(flat, 'final').highlighted, true);

  const wrapped = buildGalleryModel({
    snapshot: {
      production: { id: 'prod_wrapped', shotIds: ['shot_1'] },
      actions: [{ id: 'act_1', shotId: 'shot_1', state: 'running' }],
    },
  });
  assert.deepEqual(wrapped.items.map((item) => item.kind), ['shot', 'final']);
  assert.equal(byId(wrapped, 'shot:shot_1').state, 'loading');
});
