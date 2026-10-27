// SE10: the Super Easy Generate session.
//
// One Generate starts the run, then follows that production through the
// production watch. These tests drive the watch by hand: no network, no
// timers, no browser. The run itself is faked so this file stays about the
// session wiring; SE09 owns the run.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import { COPY } from './copy.ts';
import { createSuperEasySession } from './session.ts';

const PRODUCTION_ID = 'prod_0123456789abcdef01234567';

function fakeStore() {
  const state = {
    generate: { status: 'idle' },
  };
  const patches = [];
  return {
    state,
    patches,
    get() {
      return state;
    },
    patch(partial) {
      patches.push(partial);
      Object.assign(state, partial);
      return state;
    },
  };
}

function partialSnapshot() {
  return {
    production: {
      id: PRODUCTION_ID,
      revision: 2,
      shotIds: ['shot_1'],
      characterBindings: [
        { characterId: 'char_mira', name: 'Mira', artifactId: 'art_mira' },
        { characterId: 'char_bo', name: 'Bo' },
      ],
    },
    plan: { status: 'done' },
    characters: [
      { id: 'char_mira', name: 'Mira', status: 'ready', imageUrl: '/media/mira.png' },
      { id: 'char_bo', name: 'Bo', status: 'running' },
    ],
    shots: [{ id: 'shot_1', status: 'approved', url: '/media/shot-1.png' }],
    voice: { status: 'starting' },
    render: { status: 'running', fraction: 0.2 },
  };
}

function nextSnapshot() {
  const snapshot = partialSnapshot();
  snapshot.production.revision = 3;
  snapshot.production.shotIds = ['shot_1', 'shot_2'];
  snapshot.shots.push({ id: 'shot_2', status: 'running', url: '/media/shot-2.png' });
  snapshot.render = { status: 'running', fraction: 0.6 };
  return snapshot;
}

function finalSnapshot() {
  return {
    production: {
      id: PRODUCTION_ID,
      revision: 4,
      shotIds: ['shot_1', 'shot_2'],
      characterBindings: [
        { characterId: 'char_mira', name: 'Mira', artifactId: 'art_mira' },
        { characterId: 'char_bo', name: 'Bo', artifactId: 'art_bo' },
      ],
      latestDeliveryId: 'del_1',
    },
    plan: { status: 'done' },
    characters: [
      { id: 'char_mira', name: 'Mira', status: 'ready', imageUrl: '/media/mira.png' },
      { id: 'char_bo', name: 'Bo', status: 'ready', imageUrl: '/media/bo.png' },
    ],
    shots: [
      { id: 'shot_1', status: 'approved', url: '/media/shot-1.png' },
      { id: 'shot_2', status: 'approved', url: '/media/shot-2.png' },
    ],
    voice: { status: 'done' },
    render: { status: 'running', fraction: 0.7 },
    finalVideo: { ready: true, url: '/media/final.mp4' },
    deliveries: [{ id: 'del_1', status: 'ready', url: '/media/final.mp4' }],
  };
}

function harness(options = {}) {
  const store = fakeStore();
  const calls = [];
  const views = [];
  const errors = [];
  const dones = [];
  const previews = [];
  let watchOptions = null;
  let stopCalls = 0;

  const run = async (input) => {
    calls.push({ kind: 'run', input });
    if (options.runPatches) store.patch(options.runPatches);
    if (options.runResult) return options.runResult;
    return {
      ok: true,
      productionId: PRODUCTION_ID,
      draftCommand: { kind: 'iteration.set' },
      snapshot: { plan: { status: 'done' } },
      cpu: { ok: true, step: 'review' },
    };
  };

  const watch = (next) => {
    calls.push({ kind: 'watch', productionId: next.productionId });
    watchOptions = next;
    return () => {
      stopCalls += 1;
      calls.push({ kind: 'stop' });
    };
  };

  const session = createSuperEasySession({
    run,
    watch,
    api: {},
    host: {},
    store,
    go() {},
    onProgress(html, snapshot) {
      views.push({ html, snapshot });
    },
    onDone(snapshot) {
      dones.push(snapshot);
    },
    onError(result) {
      errors.push(result);
    },
    onPreviewReady(result) {
      previews.push(result);
    },
  });

  return {
    session,
    store,
    calls,
    views,
    errors,
    dones,
    previews,
    watchOptions: () => watchOptions,
    stopCalls: () => stopCalls,
  };
}

test('Generate runs the one prompt, then watches that production', async () => {
  const h = harness();

  const result = await h.session.generate({ prompt: '  A friendly robot who bakes bread  ', compute: 'cpu' });

  assert.equal(result.ok, true);
  assert.deepEqual(
    h.calls.filter((call) => call.kind === 'run').map((call) => call.input),
    [{ prompt: '  A friendly robot who bakes bread  ', compute: 'cpu' }],
  );
  const watched = h.calls.filter((call) => call.kind === 'watch');
  assert.equal(watched.length, 1);
  assert.equal(watched[0].productionId, PRODUCTION_ID);
  assert.equal(h.store.state.generate.status, 'running');
  assert.match(h.session.progressHtml(), /data-super-easy-progress/u);
});

test('watch callbacks move the stages and fill the gallery', async () => {
  const h = harness();
  await h.session.generate({ prompt: 'A friendly robot who bakes bread' });

  const before = h.session.progressHtml();
  h.watchOptions().onState(partialSnapshot());

  const after = h.session.progressHtml();
  assert.notEqual(after, before);
  assert.match(after, /data-stage-status="running"/u);
  assert.match(after, /data-super-easy-gallery-item="character:char_mira"/u);
  assert.match(after, /src="\/media\/mira\.png"/u);
  assert.match(after, /data-super-easy-gallery-item="shot:shot_1"/u);
  assert.equal(h.views.at(-1).html, after, 'the latest view is pushed to the progress sink');

  h.watchOptions().onState(nextSnapshot());
  const next = h.session.progressHtml();
  assert.match(next, /data-super-easy-gallery-item="shot:shot_2"/u);
  assert.match(next, /src="\/media\/shot-2\.png"/u);
  assert.match(next, /aria-valuenow="60"/u);
  assert.notEqual(next, after);
});

test('Stop cancels the watch once and ignores later updates', async () => {
  const h = harness();
  await h.session.generate({ prompt: 'A friendly robot who bakes bread' });
  h.watchOptions().onState(partialSnapshot());

  const stoppedAt = h.session.progressHtml();

  h.session.stop();
  h.session.stop();
  const viewsAtStop = h.views.length;

  assert.equal(h.stopCalls(), 1);
  assert.equal(h.store.state.generate.status, 'stopped');

  h.watchOptions().onState(finalSnapshot());
  assert.equal(h.session.progressHtml(), stoppedAt, 'no update lands after Stop');
  assert.equal(h.views.length, viewsAtStop, 'no view is pushed after Stop');
});

test('the final video marks the run done and stops the watch', async () => {
  const h = harness();
  await h.session.generate({ prompt: 'A friendly robot who bakes bread' });

  h.watchOptions().onState(finalSnapshot());

  const html = h.session.progressHtml();
  assert.equal(h.store.state.generate.status, 'done');
  assert.match(html, new RegExp(`>${COPY.done.title}<`, 'u'));
  assert.match(html, /src="\/media\/final\.mp4"/u);
  assert.match(html, /data-super-easy-stage="render" data-stage-status="done"/u);
  assert.equal(h.stopCalls(), 1, 'the final frame ends polling');
  assert.equal(h.dones.length, 1);

  h.session.stop();
  assert.equal(h.stopCalls(), 1, 'a later Stop does not cancel twice');
  assert.match(h.session.progressHtml(), /src="\/media\/final\.mp4"/u);
});

test('the run finishing its preview does not mark the whole video done', async () => {
  const h = harness({ runPatches: { generate: { status: 'done' } } });

  await h.session.generate({ prompt: 'A friendly robot who bakes bread' });

  assert.equal(h.store.state.generate.status, 'running', 'the production is still being watched');
  h.watchOptions().onState(finalSnapshot());
  assert.equal(h.store.state.generate.status, 'done');
  assert.match(h.session.progressHtml(), /src="\/media\/final\.mp4"/u);
});

test('a failed run reports the error and never starts a watch', async () => {
  const failure = {
    ok: false,
    code: 'CPU_FAILED',
    stage: 'run',
    message: 'The This computer preview did not finish.',
  };
  const h = harness({ runResult: failure });

  const result = await h.session.generate({ prompt: 'A friendly robot who bakes bread' });

  assert.deepEqual(result, failure);
  assert.equal(h.calls.some((call) => call.kind === 'watch'), false);
  assert.equal(h.store.state.generate.status, 'error');
  assert.deepEqual(h.errors, [failure]);
});

// UX06: preview-ready is separate from the finished MP4, and failures stay on
// the progress screen with a retry path.

test('a compiled CPU preview is preview-ready while the MP4 is still unfinished', async () => {
  const preview = {
    ok: true,
    productionId: PRODUCTION_ID,
    draftCommand: { kind: 'iteration.set' },
    snapshot: { plan: { status: 'done' } },
    cpu: { ok: true, step: 'review', previewReady: true, finalReady: false },
  };
  const h = harness({ runResult: preview });

  await h.session.generate({ prompt: 'A friendly robot who bakes bread', compute: 'cpu' });

  assert.equal(h.session.status(), 'running', 'the finished MP4 is still being watched');
  assert.equal(h.session.previewReady(), true);
  assert.equal(h.previews.length, 1);
  assert.match(h.session.progressHtml(), /data-super-easy-preview-ready/u);
  assert.match(h.session.progressHtml(), /data-super-easy-review/u);
  assert.doesNotMatch(h.session.progressHtml(), /data-super-easy-done-actions/u);
});

test('a delivery id without a playable URL never marks the run done', async () => {
  const h = harness();
  await h.session.generate({ prompt: 'A friendly robot who bakes bread' });
  h.watchOptions().onState(partialSnapshot());

  const deliveryOnly = finalSnapshot();
  delete deliveryOnly.finalVideo;
  deliveryOnly.production.deliveries = [{ id: 'del_1', status: 'ready' }];
  h.watchOptions().onState(deliveryOnly);

  assert.equal(h.session.status(), 'running');
  assert.doesNotMatch(h.session.progressHtml(), /data-super-easy-done-actions/u);

  h.watchOptions().onState(finalSnapshot());
  assert.equal(h.session.status(), 'done');
  assert.match(h.session.progressHtml(), /data-super-easy-done-actions/u);
});

test('a planning failure is visible on the progress screen and can be retried', async () => {
  const failure = {
    ok: false,
    code: 'PLAN_FAILED',
    stage: 'plan',
    message: 'The plan could not be written.',
  };
  const h = harness({ runResult: failure });

  await h.session.generate({ prompt: 'A friendly robot who bakes bread', compute: 'cpu' });

  assert.equal(h.session.status(), 'error');
  assert.equal(h.errors.length, 1);
  const html = h.session.progressHtml();
  assert.match(html, /data-super-easy-error/u);
  assert.match(html, /The plan could not be written\./u);
  assert.match(html, /data-super-easy-retry/u);
  assert.match(html, /data-super-easy-more-control/u);
  assert.match(html, /data-super-easy-open-editor/u);

  const before = h.calls.filter((call) => call.kind === 'run').length;
  const retried = await h.session.retry();
  assert.equal(retried, failure);
  assert.equal(h.calls.filter((call) => call.kind === 'run').length, before + 1);
  assert.equal(h.session.status(), 'error');
});

test('the session follows the run phases and republishes on each one', async () => {
  const store = fakeStore();
  const seen = [];
  let published = 0;
  let session;
  session = createSuperEasySession({
    async run(_input, deps) {
      for (const stage of ['plan', 'iteration', 'approval', 'run']) {
        deps.onPhase(stage);
        seen.push(session.phase());
      }
      return {
        ok: true,
        productionId: PRODUCTION_ID,
        draftCommand: { kind: 'iteration.set' },
        snapshot: null,
        cpu: { ok: true, step: 'review', previewReady: true },
      };
    },
    watch: () => () => {},
    api: {},
    host: {},
    store,
    go() {},
    onProgress() {
      published += 1;
    },
  });

  assert.equal(session.phase(), 'idle');
  await session.generate({ prompt: 'A friendly robot who bakes bread' });
  assert.deepEqual(seen, ['plan', 'iteration', 'approval', 'run']);
  assert.equal(session.phase(), 'preview');
  assert.ok(published >= 5, 'each phase repaints the gauges');
});
