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
import { proposalForPackage, renderSuperEasyProposal } from './proposal.ts';
import { createEasyStore, planInputsHash } from '../store.ts';

const PRODUCTION_ID = 'prod_0123456789abcdef01234567';

test('cold proposal reload restores reviewed revision and original revision notes without running or approving', async () => {
  const first = returnedProposalHarness();
  await first.session.generate(first.input);
  first.store.patch({ builtPackageInputsHash: planInputsHash(first.store.get()) });
  const stored = JSON.stringify(first.store.get());
  const store = createEasyStore({ key: 'test', storage: { getItem: () => stored, setItem() {}, removeItem() {} } });
  let pkg = first.pkg, runs = 0;
  const session = createSuperEasySession({ store, go() {},
    api: { getPackage: async () => ({ package: pkg }), compilePackage: async body => { assert.equal(body.revision, 6); return { timeline: { durationInFrames: 360 } }; } },
    host: { getPackage: () => pkg, adoptBuiltPackage: body => { assert.equal(body.timeline.durationInFrames, 360); assert.equal(body.revision, 6); pkg = body.package; }, editorStore: {} },
    run: async input => { runs++; assert.equal(input.reviewedPackageRevision, 6); assert.deepEqual(input.revisionNotes, first.input.revisionNotes); return { ok: false, stage: 'compute', code: 'GOOGLE_COLAB_CONFIRM_REQUIRED', message: 'test boundary' }; },
  });
  await session.restoreProposal();
  assert.equal(runs, 0);
  assert.equal(session.phase(), 'proposal');
  assert.equal(session.proposal().reviewedPackageRevision, 6);
  assert.equal(session.proposal().basePrompt, first.input.basePrompt);
  assert.deepEqual(session.proposal().revisionNotes, first.input.revisionNotes);
  await session.approveProposal();
  assert.equal(runs, 1, 'only the explicit Make this film gesture runs');
  assert.equal(store.get().proposalCheckpoint, null);
});

test('cold proposal checkpoints reject newer edits, changed inputs and existing production authority', async () => {
  for (const change of ['revision', 'inputs', 'production', 'late']) {
    const first = returnedProposalHarness();
    await first.session.generate(first.input);
    first.store.patch({ builtPackageInputsHash: planInputsHash(first.store.get()) });
    const store = first.store;
    if (change === 'inputs') store.patch({ idea: { ...store.get().idea, text: 'another idea' } });
    if (change === 'production') store.patch({ productionId: PRODUCTION_ID });
    let release;
    const session = createSuperEasySession({ store, go() {}, host: {},
      api: { compilePackage: async () => { throw Error('Invalid checkpoint must not compile'); }, getPackage: async () => {
        if (change === 'late') await new Promise(resolve => { release = resolve; });
        return { package: { ...first.pkg, revision: change === 'revision' ? 7 : 6 } };
      } }, run: () => { throw Error('Must not run'); },
    });
    const restored = session.restoreProposal();
    if (change === 'late') { session.stop(); release(); }
    await restored;
    assert.equal(session.proposal(), null, change);
  }
});

function returnedProposalHarness() {
  const store = createEasyStore({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  let pkg = { id: 'pkg_return', revision: 6, title: 'MORNING STILL', format: { fps: 30 },
    scenes: [{ id: 's1', preferredFrames: 278, copy: { headline: 'MORNING STILL' } }, { id: 's2', preferredFrames: 82, copy: { headline: 'Take your time.' } }], assets: {} };
  let saved = { status: 'saved', editSequence: 1, acknowledgedSequence: 1, acknowledgedRevision: 6 };
  const calls = [];
  const input = { prompt: 'Original unchanged user brief', basePrompt: 'Original unchanged user brief', revisionNotes: ['Keep the exact headlines'],
    motionModel: 'klein', compute: 'colab', setupConfirmed: true, deepSeekNoThinking: true,
    conversationId: 'chat_sources', attachmentSignature: 'pinned-source', attachmentRevision: 3,
    videoType: 'data-story', lengthS: 12, proposalOnly: true, run: { timeoutMs: 9876 } };
  store.patch({ packageId: pkg.id, idea: { ...store.get().idea, text: input.prompt, lengthS: 12 },
    compute: input.compute, motionModel: input.motionModel, spendCap: 9, chatId: input.conversationId,
    attachmentSignature: input.attachmentSignature, attachmentRevision: input.attachmentRevision, videoType: input.videoType });
  store.patch({ builtPackageInputsHash: planInputsHash(store.get()) });
  const session = createSuperEasySession({ store, api: {}, go() {}, host: { getPackage: () => pkg, editorStore: { saveState: () => saved } },
    run: async next => {
      calls.push(next);
      return next.proposalOnly ? { ok: true, proposal: { ...proposalForPackage(pkg, next.basePrompt, next.revisionNotes), motionModel: next.motionModel }, snapshot: null }
        : { ok: false, code: 'RUN_FAILED', stage: 'run', message: 'Fixture stops after explicit approval' };
    } });
  return { session, store, calls, input, get pkg() { return pkg; }, set pkg(value) { pkg = value; },
    save(revision, status = 'saved') { saved = { ...saved, status, acknowledgedRevision: revision }; } };
}

test('return re-review snapshots the old package and preserves brief, notes, model, sources, and cap', async () => {
  const h = returnedProposalHarness();
  await h.session.generate(h.input);
  // Mutating the same object must not destroy the before/after evidence.
  h.pkg.revision = 10;
  h.pkg.scenes[0].preferredFrames = h.pkg.scenes[1].preferredFrames = 180;
  h.save(10);
  assert.equal(h.session.refreshProposal(), 'refreshed');
  const proposal = h.session.proposal();
  assert.equal(proposal.reviewedPackageRevision, 10);
  assert.equal(proposal.basePrompt, h.input.basePrompt);
  assert.deepEqual(proposal.revisionNotes, h.input.revisionNotes);
  assert.equal(proposal.motionModel, 'klein');
  assert.match(renderSuperEasyProposal(proposal), /Before: 278 frames at 30 fps/);
  assert.equal(h.calls.length, 1, 'return is local review only');
  assert.equal(h.store.get().spendCap, 9);
  await h.session.approveProposal();
  for (const key of ['prompt', 'basePrompt', 'revisionNotes', 'motionModel', 'conversationId', 'attachmentSignature', 'attachmentRevision', 'compute', 'setupConfirmed', 'deepSeekNoThinking', 'run']) {
    assert.deepEqual(h.calls[1][key], h.input[key], key);
  }
  assert.equal(h.calls[1].reviewedPackageRevision, 10);
  assert.equal(h.calls[1].proposalOnly, false);
  assert.equal(h.session.refreshProposal(), 'unchanged');
});

test('pending, offline, conflicting, rejected, and unacknowledged editor changes cannot be approved', async () => {
  for (const status of ['pending', 'offline', 'conflict', 'rejected', 'saved']) {
    const h = returnedProposalHarness();
    await h.session.generate(h.input);
    // Unsaved edits normally still carry the previous acknowledged revision.
    h.pkg = { ...h.pkg, revision: status === 'saved' ? 10 : 6,
      scenes: h.pkg.scenes.map(scene => ({ ...scene, preferredFrames: 180 })) };
    h.save(6, status);
    assert.equal(h.session.refreshProposal(), 'waiting');
    assert.equal(h.session.proposal().reviewedPackageRevision, 6);
    const result = await h.session.approveProposal();
    assert.equal(result.ok, false);
    assert.match(result.message, /not saved yet/);
    assert.equal(h.calls.length, 1);
    assert.equal(h.session.proposal().reviewedPackageRevision, 6);
    assert.equal(h.session.phase(), 'proposal');
    assert.equal(h.session.failure(), null);
  }
});

test('an early approval while saving preserves the review, then saved 10 needs a separate explicit approval', async () => {
  const h = returnedProposalHarness();
  await h.session.generate(h.input);
  h.pkg = { ...h.pkg, scenes: h.pkg.scenes.map(scene => ({ ...scene, preferredFrames: 180 })) };
  h.save(6, 'pending');
  assert.equal(h.session.refreshProposal(), 'waiting');
  const reviewed = h.session.proposal();
  const blocked = await h.session.approveProposal();
  assert.equal(blocked.ok, false);
  assert.equal(h.session.proposal(), reviewed, 'the early click must not change the reviewed package');
  assert.equal(h.session.phase(), 'proposal');
  assert.equal(h.calls.length, 1);
  h.pkg = { ...h.pkg, revision: 10 };
  h.save(10);
  assert.equal(h.session.refreshProposal(), 'refreshed');
  assert.equal(h.session.proposal().reviewedPackageRevision, 10);
  assert.match(renderSuperEasyProposal(h.session.proposal()), /After: 180 frames at 30 fps/);
  assert.equal(h.calls.length, 1, 'save acknowledgement is review, not approval or replanning');
  await h.session.approveProposal();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].reviewedPackageRevision, 10);
  assert.equal(h.calls[1].proposalOnly, false);
  assert.equal(h.calls[1].attachmentSignature, h.input.attachmentSignature);
});

test('return does not manufacture attached-source provenance and ignores a stopped proposal', async () => {
  const h = returnedProposalHarness();
  await h.session.generate(h.input);
  const hash = h.store.get().builtPackageInputsHash;
  h.store.patch({ attachmentRevision: 4, plan: { ...h.store.get().plan, status: 'stale' } });
  h.pkg = { ...h.pkg, revision: 10 };
  h.save(10);
  h.session.refreshProposal();
  assert.equal(h.store.get().builtPackageInputsHash, hash);
  assert.equal(h.store.get().plan.status, 'stale');
  h.session.stop();
  h.pkg = { ...h.pkg, revision: 11 };
  h.save(11);
  assert.equal(h.session.refreshProposal(), 'unchanged');
  assert.equal(h.session.proposal().reviewedPackageRevision, 10);
});

test('production watch uses the authenticated transport supplied by the host', async () => {
  const requests = [];
  let resolveRequest;
  const requested = new Promise(resolve => { resolveRequest = resolve; });
  const fetchImpl = async (url, init) => {
    requests.push({ url, method: init.method });
    resolveRequest();
    return new Response(JSON.stringify({ production: { id: PRODUCTION_ID, revision: 1 }, revision: 1, lastSequence: 0 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const session = createSuperEasySession({
    api: {}, host: {}, store: fakeStore(), go() {}, fetchImpl,
    run: async () => ({ ok: true, productionId: PRODUCTION_ID, snapshot: {}, cpu: { ok: true, step: 'review', previewReady: true } }),
  });
  await session.generate({ prompt: 'A sufficiently long prompt' });
  await requested;
  assert.deepEqual(requests, [{ url: `/api/productions/${PRODUCTION_ID}`, method: 'GET' }]);
  session.stop();
});

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

test('measured narration repair goes to a new proposal for reapproval', async () => {
  const calls = [];
  const store = fakeStore();
  const session = createSuperEasySession({ api: {}, host: {}, store, go() {}, run: async input => {
    calls.push(input);
    if (calls.length === 1) return { ok: false, code: 'CPU_FAILED', stage: 'run', message: 'Narration is too long', retryable: false, narrationRevision: 'Keep the story; shorten s1 toward 8 words.' };
    return { ok: true, proposal: { basePrompt: input.basePrompt, revisionNotes: input.revisionNotes }, snapshot: null };
  } });
  await session.generate({ prompt: 'A 45 second historical explainer', compute: 'cpu', lengthS: 45, proposalOnly: false });
  assert.match(session.progressHtml(), /Revise narration for this length/);
  assert.equal(await session.retry(), null);
  await session.reviseNarration();
  assert.equal(calls[1].proposalOnly, true);
  assert.equal(calls[1].narrationOnly, true);
  assert.equal(calls[1].basePrompt, 'A 45 second historical explainer');
  assert.match(calls[1].revisionNotes[0], /shorten s1/);
  assert.ok(session.proposal());
});

test('a reviewed narration revision carries its package revision into approval', async () => {
  const calls = [];
  const session = createSuperEasySession({ api: {}, host: {}, store: fakeStore(), go() {}, watch: () => () => {}, run: async input => {
    calls.push(input);
    if (input.proposalOnly) return { ok: true, proposal: { basePrompt: input.basePrompt ?? input.prompt, revisionNotes: input.revisionNotes ?? [], reviewedPackageRevision: 43 }, snapshot: null };
    return { ok: true, productionId: PRODUCTION_ID, snapshot: {}, cpu: { ok: true, step: 'review' } };
  } });
  await session.generate({ prompt: 'A 45 second explainer', proposalOnly: true });
  await session.approveProposal();
  assert.equal(calls[1].reviewedPackageRevision, 43);
  assert.equal(calls[1].proposalOnly, false);
});

test('repeated measured overruns each stop at a fresh review before approval', async () => {
  const calls = [];
  const session = createSuperEasySession({ api: {}, host: {}, store: fakeStore(), go() {}, run: async input => {
    calls.push(input);
    if (input.proposalOnly) return { ok: true, proposal: { basePrompt: input.basePrompt, revisionNotes: input.revisionNotes, reviewedPackageRevision: calls.length }, snapshot: null };
    return { ok: false, code: 'CPU_FAILED', stage: 'run', message: 'Too long', retryable: false, narrationRevision: `measured overrun ${calls.length}` };
  } });
  await session.generate({ prompt: 'A 45 second story', proposalOnly: false });
  await session.reviseNarration();
  assert.equal(calls.length, 2);
  assert.ok(session.proposal());
  await session.approveProposal();
  await session.reviseNarration();
  assert.equal(calls.length, 4);
  assert.equal(calls[3].narrationOnly, true);
  assert.equal(calls[3].proposalOnly, true);
  assert.match(calls[3].revisionNotes.at(-1), /measured overrun 3/);
  assert.ok(session.proposal());
});

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

test('uncertain paid approval and run failures cannot replay a paid job', async () => {
  for (const stage of ['approval', 'run']) {
    const h = harness({ runResult: { ok: false, code: 'RUN_FAILED', stage, message: 'connection lost' } });
    const result = await h.session.generate({ prompt: 'A carefully planned action scene', compute: 'colab', setupConfirmed: true });
    assert.equal(result.retryable, false);
    assert.match(result.message, /existing production in Studio/);
    assert.doesNotMatch(h.session.progressHtml(), /data-super-easy-retry/);
    assert.equal(await h.session.retry(), null);
    assert.equal(h.calls.filter(call => call.kind === 'run').length, 1);
  }
});

test('Generate runs the one prompt, then watches that production', async () => {
  const h = harness();

  const result = await h.session.generate({ prompt: '  A friendly robot who bakes bread  ', compute: 'cpu' });

  assert.equal(result.ok, true);
  assert.deepEqual(
    h.calls.filter((call) => call.kind === 'run').map((call) => call.input),
    [{ prompt: '  A friendly robot who bakes bread  ', compute: 'cpu', motionModel: 'auto' }],
  );
  const watched = h.calls.filter((call) => call.kind === 'watch');
  assert.equal(watched.length, 1);
  assert.equal(watched[0].productionId, PRODUCTION_ID);
  assert.equal(h.store.state.generate.status, 'running');
  assert.match(h.session.progressHtml(), /data-super-easy-progress/u);
});

test('duration, video type, song trim, exact LRC and attachment identity survive proposal revisions and approval', async () => {
  const store = fakeStore();
  const inputs = [];
  const raw = '[00:05.00]<00:05.00>Exact <00:05.50>lyrics\r\n[00:07.00]Next line';
  const session = createSuperEasySession({
    async run(input) {
      inputs.push(input);
      if (input.proposalOnly) {
        return {
          ok: true,
          proposal: {
            basePrompt: input.basePrompt ?? input.prompt,
            revisionNotes: input.revisionNotes ?? [],
          },
          snapshot: null,
        };
      }
      return {
        ok: true,
        productionId: PRODUCTION_ID,
        draftCommand: { kind: 'iteration.set' },
        snapshot: { plan: { status: 'done' } },
        cpu: { ok: true, step: 'review' },
      };
    },
    watch: () => () => {},
    api: {},
    host: {},
    store,
    go() {},
  });

  await session.generate({
    prompt: 'A friendly robot who bakes bread',
    compute: 'cpu',
    lengthS: 120,
    videoType: 'music-video',
    songTrim: { startSeconds: 4, endSeconds: 45 },
    lyricsStyle: 'reel',
    lyricsLrc: raw,
    conversationId: 'chat_context123',
    attachmentSignature: 'ctx_12345678_2',
    attachmentRevision: 7,
    proposalOnly: true,
  });
  await session.reviseProposal('Make the ending playful');
  await session.approveProposal();

  assert.equal(inputs.length, 3);
  assert.deepEqual(inputs.map(input => input.lengthS), [120, 120, 120]);
  assert.deepEqual(inputs.map(input => input.videoType), ['music-video', 'music-video', 'music-video']);
  assert.deepEqual(inputs.map(input => input.songTrim), [{ startSeconds: 4, endSeconds: 45 }, { startSeconds: 4, endSeconds: 45 }, { startSeconds: 4, endSeconds: 45 }]);
  assert.deepEqual(inputs.map(input => input.lyricsStyle), ['reel', 'reel', 'reel']);
  assert.deepEqual(inputs.map(input => input.lyricsLrc), [raw, raw, raw]);
  assert.deepEqual(inputs.map(input => input.conversationId), ['chat_context123', 'chat_context123', 'chat_context123']);
  assert.deepEqual(inputs.map(input => input.attachmentSignature), ['ctx_12345678_2', 'ctx_12345678_2', 'ctx_12345678_2']);
  assert.deepEqual(inputs.map(input => input.attachmentRevision), [7, 7, 7]);
  assert.deepEqual(inputs[1].revisionNotes, ['Make the ending playful']);
  assert.deepEqual(inputs[2].revisionNotes, ['Make the ending playful']);
  assert.equal(inputs[2].proposalOnly, false);
});

test('approval uses current store inputs instead of restoring stale cached attachments or trim', async () => {
  const store = fakeStore();
  Object.assign(store.state, {
    idea: { lengthS: 60 },
    compute: 'cpu',
    motionModel: 'auto',
    videoType: 'music-video',
    songTrim: { startSeconds: 4, endSeconds: 45 },
    lyricsStyle: 'caption',
    lyricsLrc: '[00:01.00]Old lyric draft',
    chatId: 'chat_oldproject',
    attachmentSignature: 'ctx_old_1',
    attachmentRevision: 1,
  });
  const inputs = [];
  const session = createSuperEasySession({
    async run(input) {
      inputs.push(input);
      if (input.proposalOnly) {
        return { ok: true, proposal: { basePrompt: input.prompt, revisionNotes: [] }, snapshot: null };
      }
      return {
        ok: true,
        productionId: PRODUCTION_ID,
        draftCommand: { kind: 'iteration.set' },
        snapshot: { plan: { status: 'done' } },
        cpu: { ok: true, step: 'review' },
      };
    },
    watch: () => () => {},
    api: {}, host: {}, store, go() {},
  });
  await session.generate({
    prompt: 'Use the current supplied media',
    compute: 'cpu',
    lengthS: 60,
    videoType: 'music-video',
    songTrim: { startSeconds: 4, endSeconds: 45 },
    conversationId: 'chat_oldproject',
    attachmentSignature: 'ctx_old_1',
    attachmentRevision: 1,
    proposalOnly: true,
  });
  store.patch({
    idea: { lengthS: 30 },
    videoType: 'product-walkthrough',
    songTrim: null,
    lyricsStyle: 'reel',
    lyricsLrc: '[00:02.00]Current lyric draft',
    chatId: 'chat_newproject',
    attachmentSignature: 'ctx_new_2',
    attachmentRevision: 2,
  });
  await session.approveProposal();

  assert.equal(inputs.length, 2);
  assert.equal(inputs[1].lengthS, 30);
  assert.equal(inputs[1].videoType, 'product-walkthrough');
  assert.equal(inputs[1].songTrim, null);
  assert.equal(inputs[1].lyricsStyle, 'reel');
  assert.equal(inputs[1].lyricsLrc, '[00:02.00]Current lyric draft');
  assert.equal(inputs[1].conversationId, 'chat_newproject');
  assert.equal(inputs[1].attachmentSignature, 'ctx_new_2');
  assert.equal(inputs[1].attachmentRevision, 2);
});

test('retry carries the current store lyric style and exact raw LRC', async () => {
  const store = fakeStore();
  Object.assign(store.state, { videoType: 'music-video', lyricsStyle: 'off', lyricsLrc: '' });
  const inputs = [];
  const session = createSuperEasySession({
    async run(input) {
      inputs.push(input);
      if (inputs.length === 1) return { ok: false, code: 'PLAN_FAILED', stage: 'plan', message: 'Try again' };
      return {
        ok: true,
        productionId: PRODUCTION_ID,
        draftCommand: { kind: 'iteration.set' },
        snapshot: { plan: { status: 'done' } },
        cpu: { ok: true, step: 'review' },
      };
    },
    watch: () => () => {},
    api: {}, host: {}, store, go() {},
  });
  await session.generate({
    prompt: 'A friendly robot who bakes bread',
    compute: 'cpu',
    videoType: 'music-video',
    lyricsStyle: 'caption',
    lyricsLrc: '[00:01.00]First draft',
  });
  const current = '[00:02.00]<00:02.00>Current <00:02.50>draft';
  store.patch({ lyricsStyle: 'reel', lyricsLrc: current });
  await session.retry();
  assert.equal(inputs.length, 2);
  assert.equal(inputs[1].lyricsStyle, 'reel');
  assert.equal(inputs[1].lyricsLrc, current);
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

test('Stop cancels an active server run while leaving the generation screen', async () => {
  const store = fakeStore();
  const cancelled = [];
  let finish;
  const session = createSuperEasySession({
    run: async (_input, deps) => {
      deps.onRunStarted('run_active');
      return new Promise(resolve => { finish = resolve; });
    },
    watch: () => () => {},
    api: { cancelRun: async id => { cancelled.push(id); return {}; } },
    host: {}, store, go() {},
  });
  const pending = session.generate({ prompt: 'A robot', compute: 'colab' });
  await new Promise(resolve => setImmediate(resolve));
  session.stop();
  session.stop();
  assert.deepEqual(cancelled, ['run_active']);
  assert.equal(store.state.generate.status, 'stopped');
  finish({ ok: false, code: 'RUN_FAILED', stage: 'run', message: 'Stopped by user.' });
  await pending;
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

test('an already-final run marks done without starting a production watch', async () => {
  const snapshot = finalSnapshot();
  snapshot.finalVideo = { ready: true, status: 'done', url: 'blob:final-run' };
  const h = harness({
    runResult: {
      ok: true,
      productionId: PRODUCTION_ID,
      draftCommand: { kind: 'iteration.set' },
      snapshot,
      final: { ready: true, runId: 'run_1', videoUrl: 'blob:final-run', source: 'run' },
      finalReady: true,
      runId: 'run_1',
    },
  });

  const result = await h.session.generate({ prompt: 'A friendly robot', compute: 'colab', setupConfirmed: true });

  assert.equal(result.ok, true);
  assert.equal(h.session.status(), 'done');
  assert.equal(h.store.state.generate.status, 'done');
  assert.equal(h.calls.some(call => call.kind === 'watch'), false);
  assert.equal(h.dones.length, 1);
  assert.equal(h.previews.length, 0);
  assert.match(h.session.progressHtml(), /src="blob:final-run"/u);
});

test('the session revokes final object URLs on regeneration and teardown', async () => {
  const previousRevoke = URL.revokeObjectURL;
  const revoked = [];
  URL.revokeObjectURL = url => revoked.push(url);
  const snapshot = finalSnapshot();
  snapshot.finalVideo = { ready: true, status: 'done', url: 'blob:owned-final' };
  const h = harness({
    runResult: {
      ok: true,
      productionId: PRODUCTION_ID,
      draftCommand: { kind: 'iteration.set' },
      snapshot,
      final: { ready: true, runId: 'run_1', videoUrl: 'blob:owned-final', source: 'run' },
    },
  });
  try {
    await h.session.generate({ prompt: 'A friendly robot', compute: 'colab', setupConfirmed: true });
    assert.deepEqual(revoked, []);
    await h.session.generate({ prompt: 'A friendly robot again', compute: 'colab', setupConfirmed: true });
    assert.deepEqual(revoked, ['blob:owned-final']);
    h.session.stop();
    h.session.stop();
    assert.deepEqual(revoked, ['blob:owned-final', 'blob:owned-final']);
  } finally {
    URL.revokeObjectURL = previousRevoke;
  }
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
    message: 'http_429: ttft_admission_refused after 26 s',
  };
  const h = harness({ runResult: failure });

  await h.session.generate({
    prompt: 'A friendly robot who bakes bread',
    compute: 'cpu',
    lengthS: 90,
    videoType: 'music-video',
    songTrim: { startSeconds: 8, endSeconds: 60 },
    conversationId: 'chat_context123',
    attachmentSignature: 'ctx_12345678_1',
    attachmentRevision: 2,
  });

  assert.equal(h.session.status(), 'error');
  assert.equal(h.errors.length, 1);
  const html = h.session.progressHtml();
  assert.match(html, /data-super-easy-error/u);
  assert.match(html, /http_429: ttft_admission_refused after 26 s/u);
  assert.match(html, /data-super-easy-retry/u);
  assert.match(html, /data-super-easy-more-control/u);
  assert.match(html, /data-super-easy-open-editor/u);

  const before = h.calls.filter((call) => call.kind === 'run').length;
  const retried = await h.session.retry();
  assert.equal(retried, failure);
  const retries = h.calls.filter((call) => call.kind === 'run');
  assert.equal(retries.length, before + 1);
  assert.deepEqual(retries.map(call => call.input.lengthS), [90, 90]);
  assert.deepEqual(retries.map(call => call.input.videoType), ['music-video', 'music-video']);
  assert.deepEqual(retries.map(call => call.input.songTrim), [{ startSeconds: 8, endSeconds: 60 }, { startSeconds: 8, endSeconds: 60 }]);
  assert.deepEqual(retries.map(call => call.input.conversationId), ['chat_context123', 'chat_context123']);
  assert.deepEqual(retries.map(call => call.input.attachmentSignature), ['ctx_12345678_1', 'ctx_12345678_1']);
  assert.deepEqual(retries.map(call => call.input.attachmentRevision), [2, 2]);
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
