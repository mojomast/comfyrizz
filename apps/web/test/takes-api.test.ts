// The web package typecheck has no @types/node; node:test imports are only
// for this file's runtime, so type checking is skipped here like the other
// web tests that use node:test.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TakesApiError,
  clipPath,
  clipsPath,
  createTakesApi,
  takeTicketPath,
} from '../src/takes/api.ts';

type Call = { url: string; init?: RequestInit };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function client(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const api = createTakesApi({
    apiFetch: async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      return await handler(url, init);
    },
  });
  return { api, calls };
}

const CLIP_ID = 's1:a_plate1';
const PLAN_HASH = 'a'.repeat(64);
const TAKE_ID = 'tk_0123456789ab';

const clipSummary = {
  clipId: CLIP_ID,
  sceneId: 's1',
  assetId: 'a_plate1',
  slot: 'background',
  kind: 'plate',
  from: 0,
  durationInFrames: 90,
  state: 'review',
  selected: TAKE_ID,
  selectedN: 1,
  takeCount: 1,
  newTakes: 0,
  lastJob: null,
  queued: false,
};

const take = {
  takeId: TAKE_ID,
  assetId: 'a_plate1',
  n: 1,
  file: 'takes/a_plate1/tk_0123456789ab.mp4',
  sha256: 'b'.repeat(64),
  bytes: 12,
  media: { fps: 24, frames: 48 },
  gen: { generator: 'comfyui', prompt: 'a calm plate', seed: 7 },
  createdAt: '2026-10-20T12:00:00.000Z',
  verdict: 'unreviewed',
};

test('listClips and getTakes encode ids and go through apiFetch', async () => {
  const { api, calls } = client((url) => {
    if (url.endsWith('/takes')) {
      return json({
        packageId: 'pkg_1',
        revision: 4,
        clip: clipSummary,
        assetId: 'a_plate1',
        selected: TAKE_ID,
        takes: [take],
        history: [],
        lastJob: null,
        queued: null,
      });
    }
    return json({ packageId: 'pkg_1', revision: 4, clips: [clipSummary] });
  });

  const listed = await api.listClips('pkg_1');
  assert.equal(calls[0]?.url, '/api/package/pkg_1/clips');
  assert.equal(calls[0]?.init, undefined);
  assert.equal(listed.revision, 4);
  assert.equal(listed.clips[0]?.clipId, CLIP_ID);
  assert.equal(listed.clips[0]?.state, 'review');

  const takes = await api.getTakes('pkg_1', CLIP_ID);
  assert.equal(calls[1]?.url, '/api/package/pkg_1/clips/s1%3Aa_plate1/takes');
  assert.equal(takes.selected, TAKE_ID);
  assert.equal(takes.takes[0]?.takeId, TAKE_ID);
  assert.equal(takes.assetId, 'a_plate1');

  assert.equal(clipsPath('pkg /1'), '/api/package/pkg%20%2F1/clips');
  assert.equal(clipPath('pkg_1', 's1:a_plate1', '/verdict'), '/api/package/pkg_1/clips/s1%3Aa_plate1/verdict');
  assert.equal(
    takeTicketPath('pkg_1', CLIP_ID, TAKE_ID),
    '/api/package/pkg_1/clips/s1%3Aa_plate1/takes/tk_0123456789ab/ticket',
  );
});

test('regenerate surfaces approval_required as a value, even when the response status is not ok', async () => {
  let sent: unknown = null;
  const { api, calls } = client((url, init) => {
    sent = JSON.parse(String(init?.body));
    return json({
      kind: 'approval_required',
      approvalRequired: true,
      requiresApproval: true,
      clipId: CLIP_ID,
      assetId: 'a_plate1',
      diff: [{ path: 'gen.inputs.seed', before: 7, after: 11 }],
      correction: { note: 'cleaner background', seed: 11, by: 'user' },
      planHash: PLAN_HASH,
      estimate: { gpuMinutes: 2, overheadMinutes: 1 },
      budget: { allowed: true, required: 3 },
      backend: { id: 'colab' },
      jobs: 1,
    }, 409);
  });

  const result = await api.regenerate('pkg_1', CLIP_ID, {
    change: { note: 'cleaner background', seed: 11 },
    backendId: 'colab',
    budgetUnits: 10,
  });

  assert.equal(result.kind, 'approval');
  assert.equal(result.approvalRequired, true);
  assert.equal(result.planHash, PLAN_HASH);
  assert.deepEqual(result.estimate, { gpuMinutes: 2, overheadMinutes: 1 });
  assert.equal(result.clipId, CLIP_ID);
  assert.equal(result.assetId, 'a_plate1');
  assert.equal(result.correction?.note, 'cleaner background');
  assert.equal(calls[0]?.url, '/api/package/pkg_1/clips/s1%3Aa_plate1/regenerate');
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.equal((calls[0]?.init?.headers as Record<string, string>)['content-type'], 'application/json');
  assert.deepEqual(sent, {
    change: { note: 'cleaner background', seed: 11 },
    backendId: 'colab',
    budgetUnits: 10,
  });
});

test('a refused regeneration stays an error', async () => {
  const { api } = client(() => json({
    kind: 'refused',
    planHash: PLAN_HASH,
    budget: { allowed: false, required: 999 },
  }, 409));

  await assert.rejects(
    () => api.regenerate('pkg_1', CLIP_ID, { change: { note: 'too much' } }),
    (error: unknown) => {
      assert.ok(error instanceof TakesApiError);
      assert.equal(error.status, 409);
      assert.equal(error.code, 'refused');
      return true;
    },
  );
});

test('regenerate returns started with a run id and queued as a value', async () => {
  const started = client(() => json({
    kind: 'started',
    clipId: CLIP_ID,
    assetId: 'a_plate1',
    diff: [],
    correction: { note: 'warmer', by: 'user' },
    runId: 'run_new',
    status: 'starting',
    planHash: 'b'.repeat(64),
    estimate: { gpuMinutes: 1 },
    budget: { allowed: true, required: 1 },
  }));
  const began = await started.api.regenerate('pkg_1', CLIP_ID, {
    change: { note: 'warmer' },
    backendId: 'byo-comfyui',
    approved: true,
  });
  assert.equal(began.kind, 'started');
  assert.equal(began.runId, 'run_new');
  assert.equal(began.status, 'starting');
  assert.equal(began.correction?.note, 'warmer');

  const queued = client(() => json({
    kind: 'queued',
    clipId: CLIP_ID,
    assetId: 'a_plate1',
    diff: [],
    correction: { note: 'later', by: 'user' },
    planHash: 'c'.repeat(64),
  }, 202));
  const pending = await queued.api.regenerate('pkg_1', CLIP_ID, {
    change: { note: 'later' },
    backendId: 'colab',
  });
  assert.equal(pending.kind, 'queued');
  assert.equal(pending.planHash, 'c'.repeat(64));
  assert.equal(queued.calls[0]?.init?.method, 'POST');
});

test('approve reuses POST /api/run/approve with the plan hash', async () => {
  const { api, calls } = client(() => json({ planHash: PLAN_HASH, approved: true }));

  const approved = await api.approve(PLAN_HASH);
  assert.deepEqual(approved, { planHash: PLAN_HASH, approved: true });
  assert.equal(calls[0]?.url, '/api/run/approve');
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.equal((calls[0]?.init?.headers as Record<string, string>)['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { planHash: PLAN_HASH });

  await assert.rejects(
    () => api.approve(''),
    (error: unknown) => error instanceof TakesApiError && error.code === 'INVALID_ARGUMENT',
  );
});

test('select, revert and verdict call their clip routes', async () => {
  const { api, calls } = client((url) => {
    if (url.endsWith('/select')) {
      return json({ kind: 'selected', packageId: 'pkg_1', revision: 5, clip: clipSummary, takeId: TAKE_ID });
    }
    if (url.endsWith('/revert')) {
      return json({ kind: 'reverted', packageId: 'pkg_1', revision: 6, clip: clipSummary, takeId: null });
    }
    return json({
      kind: 'verdict',
      packageId: 'pkg_1',
      clip: { ...clipSummary, state: 'approved' },
      takeId: TAKE_ID,
      verdict: 'approved',
    });
  });

  const selected = await api.select('pkg_1', CLIP_ID, TAKE_ID);
  assert.equal(selected.kind, 'selected');
  assert.equal(selected.takeId, TAKE_ID);
  assert.equal(calls[0]?.url, '/api/package/pkg_1/clips/s1%3Aa_plate1/select');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { takeId: TAKE_ID });

  const reverted = await api.revert('pkg_1', CLIP_ID);
  assert.equal(reverted.kind, 'reverted');
  assert.equal(reverted.takeId, null);
  assert.equal(calls[1]?.url, '/api/package/pkg_1/clips/s1%3Aa_plate1/revert');
  assert.equal(calls[1]?.init?.method, 'POST');
  assert.equal(calls[1]?.init?.body, undefined);

  const verdict = await api.verdict('pkg_1', CLIP_ID, 'approved', { note: 'logo is readable', takeId: TAKE_ID });
  assert.equal(verdict.kind, 'verdict');
  assert.equal(verdict.clip.state, 'approved');
  assert.equal(calls[2]?.url, '/api/package/pkg_1/clips/s1%3Aa_plate1/verdict');
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), {
    verdict: 'approved',
    note: 'logo is readable',
    takeId: TAKE_ID,
  });
});

test('takeUrl mints a media ticket and never exposes the take file path', async () => {
  const { api, calls } = client(() => json({
    kind: 'ticket',
    takeId: TAKE_ID,
    ticket: 'd'.repeat(32),
    expiresAt: '2026-10-20T12:10:00.000Z',
    url: `/api/media/${'d'.repeat(32)}`,
  }));

  const url = await api.takeUrl('pkg_1', CLIP_ID, TAKE_ID);
  assert.equal(url, `/api/media/${'d'.repeat(32)}`);
  assert.doesNotMatch(url, /takes|\.mp4/);
  assert.equal(calls[0]?.url, '/api/package/pkg_1/clips/s1%3Aa_plate1/takes/tk_0123456789ab/ticket');
  assert.equal(calls[0]?.init?.method, 'POST');
});

test('a rejected ticket is an error and an unsafe ticket URL is refused', async () => {
  const missing = client(() => json({ error: 'take is not in this clip', code: 'UNKNOWN_TAKE' }, 404));
  await assert.rejects(
    () => missing.api.takeUrl('pkg_1', CLIP_ID, 'tk_000000000000'),
    (error: unknown) => {
      assert.ok(error instanceof TakesApiError);
      assert.equal(error.status, 404);
      assert.equal(error.code, 'UNKNOWN_TAKE');
      assert.match(error.message, /not in this clip/);
      return true;
    },
  );

  const unsafe = client(() => json({ ticket: 't', url: 'javascript:alert(1)' }));
  await assert.rejects(
    () => unsafe.api.takeUrl('pkg_1', CLIP_ID, TAKE_ID),
    (error: unknown) => error instanceof TakesApiError && error.code === 'INVALID_RESPONSE',
  );
});

test('an API error keeps its status and server code', async () => {
  const { api } = client(() => json({ error: 'package not found', code: 'NOT_FOUND' }, 404));
  await assert.rejects(
    () => api.listClips('pkg_missing'),
    (error: unknown) => {
      assert.ok(error instanceof TakesApiError);
      assert.equal(error.status, 404);
      assert.equal(error.code, 'NOT_FOUND');
      assert.match(error.message, /package not found/);
      return true;
    },
  );
});
