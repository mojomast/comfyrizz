import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRenderJob, projectTransferLists, readRenderStatus, renderStallMs, runColabRender } from '../src/pipeline-colab-render.mjs';

test('the render job ships host edits and links media that is still on the VM', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'colab-render-job-'));
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../../examples/data-story/package.json', import.meta.url)));
    pkg.scenes[1].copy.headline = 'Edited on the host before render';
    mkdirSync(join(workDir, 'audio'), { recursive: true });
    writeFileSync(join(workDir, 'audio/narration.norm.wav'), 'wav');
    writeFileSync(join(workDir, 'package.json'), JSON.stringify(pkg));
    const lists = projectTransferLists(pkg, workDir);
    assert.ok(lists.uploadFiles.includes('package.json'));
    assert.ok(lists.uploadFiles.includes('audio/narration.norm.wav'));
    assert.equal(lists.uploadFiles.some(file => file.includes('..')), false);
    const prepared = await prepareRenderJob(workDir, { voiced: true, presenters: false });
    assert.equal(prepared.job.location, 'colab');
    assert.equal(prepared.job.envArgs, false);
    assert.equal(JSON.stringify(prepared.job).includes('--env'), false);
    assert.ok(prepared.job.uploadFiles.includes('timeline.json'));
    assert.match(JSON.stringify(prepared.timeline), /Edited on the host before render/);
    assert.match(readFileSync(join(workDir, 'timeline.json'), 'utf8'), /Edited on the host before render/);
    assert.ok(prepared.bundleFiles.some(file => file.name === 'apps/renderer/scripts/render-remote-entry.mjs'));
    assert.ok(prepared.bundleFiles.some(file => file.name === 'scripts/tts/verify_mix.py'));
    for (const name of ['packages/compositions/src/index.mjs', 'packages/planner/src/index.ts', 'packages/vector/src/index.ts', 'packages/planner/tsconfig.json', 'apps/renderer/public/fonts/Inter-Variable.ttf']) assert.ok(prepared.bundleFiles.some(file => file.name === name), name);
    assert.equal(prepared.bundleFiles.some(file => file.name.includes('/dist/')), false);
    assert.equal(prepared.bundleFiles.some(file => /node_modules|token|\.env/.test(file.name)), false);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

/** A project and a run directory the render can work in. */
function renderFixture(t) {
  const runDir = mkdtempSync(join(tmpdir(), 'colab-render-run-'));
  const workDir = join(runDir, 'work');
  mkdirSync(workDir, { recursive: true });
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  const pkg = JSON.parse(readFileSync(new URL('../../../examples/data-story/package.json', import.meta.url)));
  writeFileSync(join(workDir, 'package.json'), JSON.stringify(pkg));
  return { runDir, workDir };
}

/** A clock the test drives: time only moves when the test says so. */
function fakeClock() {
  let time = 0;
  let next = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout: (fn, ms) => { const id = next++; timers.set(id, { fn, due: time + ms }); return id; },
    clearTimeout: id => { timers.delete(id); },
    advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers.entries()].filter(([, timer]) => timer.due <= time)) {
        timers.delete(id);
        timer.fn();
      }
    },
    pending: () => timers.size,
  };
}

/** A Google Colab backend whose render cell reports once and then goes quiet. */
function stallingBackend({ events = [] } = {}) {
  const calls = [];
  return {
    calls,
    async uploadFile(localPath, remotePath) { calls.push('upload'); return { ok: true }; },
    async execStep(script, stepName, options = {}) {
      calls.push(stepName);
      if (stepName === 'render-dirs') return { ok: true };
      for (const event of events) options.onEvent?.(event);
      return new Promise(() => {}); // the cell never reports again
    },
    async downloadFile() { calls.push('download'); throw new Error('the render must not download after it stalled'); },
  };
}

async function waitFor(predicate, what) {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('a Google Colab render with no progress for the stall window ends as stalled, with a retry hint', async t => {
  const { runDir, workDir } = renderFixture(t);
  const clock = fakeClock();
  const backend = stallingBackend({ events: [{ event: 'progress', phase: 'heartbeat', elapsed: 20 }] });
  const seen = [];
  const outcome = runColabRender({ backend, workDir, runDir, clock, stallMinutes: 5, onEvent: (event) => seen.push(event) })
    .then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
  await waitFor(() => backend.calls.includes('render'), 'the render step to start');
  clock.advance(5 * 60_000 + 1);
  const result = await outcome;
  assert.equal(result.ok, false);
  assert.equal(result.error.state, 'stalled');
  assert.equal(result.error.code, 'RENDER_STALLED');
  assert.match(result.error.message, /stopped reporting progress/);
  assert.equal(result.error.retry.retryable, true);
  assert.match(result.error.retry.hint, /retry the render/i);
  const stalled = seen.find((event) => event.state === 'stalled');
  assert.ok(stalled, 'the stall is surfaced as an event');
  assert.match(stalled.message, /stopped reporting progress/);
  assert.ok(stalled.retry?.hint, 'the stall event carries the retry hint');
  assert.equal(backend.calls.includes('download'), false, 'a stalled render does not collect');
  const status = readRenderStatus(runDir);
  assert.equal(status.state, 'stalled');
  assert.equal(status.code, 'RENDER_STALLED');
  assert.ok(status.retry.hint, 'the status carries the retry hint');
});

test('progress keeps a render alive: the stall window only counts silence', async t => {
  const { runDir, workDir } = renderFixture(t);
  const clock = fakeClock();
  const backend = stallingBackend({ events: [{ event: 'progress', phase: 'heartbeat', elapsed: 20 }] });
  let settled = false;
  const outcome = runColabRender({ backend, workDir, runDir, clock, stallMinutes: 5, onEvent: () => {} })
    .then(() => { settled = true; }, () => { settled = true; });
  await waitFor(() => backend.calls.includes('render'), 'the render step to start');
  for (let minute = 1; minute <= 4; minute++) {
    clock.advance(60_000);
    await waitFor(() => clock.pending() > 0, 'the stall timer');
    assert.equal(settled, false, 'a render that has not gone silent is not stalled');
  }
  assert.equal(settled, false);
  outcome.catch(() => {});
});

test('a render that never reports again still ends: the step has a deadline', async t => {
  const { runDir, workDir } = renderFixture(t);
  const clock = fakeClock();
  const backend = stallingBackend({ events: [] });
  const outcome = runColabRender({
    backend, workDir, runDir, clock,
    stallMinutes: 600,
    deadlines: { render: 60_000 },
    onEvent: () => {},
  }).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
  await waitFor(() => backend.calls.includes('render'), 'the render step to start');
  clock.advance(2 * 60_000);
  const result = await outcome;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'RENDER_TIMEOUT');
  assert.equal(result.error.state, 'timeout');
  assert.ok(result.error.retry.hint, 'a timed out render carries the retry hint');
  assert.equal(backend.calls.includes('download'), false);
});

test('a render cell that stops reporting is stalled too, not a plain failure', async t => {
  const { runDir, workDir } = renderFixture(t);
  const clock = fakeClock();
  const backend = stallingBackend({ events: [] });
  backend.execStep = async (script, stepName) => {
    backend.calls.push(stepName);
    if (stepName === 'render-dirs') return { ok: true };
    return { ok: false, lost: true, note: 'render: the exec did not report; reconcile before assuming the VM did anything' };
  };
  const seen = [];
  const outcome = runColabRender({ backend, workDir, runDir, clock, onEvent: (event) => seen.push(event) })
    .then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
  const result = await outcome;
  assert.equal(result.ok, false);
  assert.equal(result.error.state, 'stalled');
  assert.equal(result.error.code, 'RENDER_STALLED');
  assert.ok(result.error.retry.hint);
  assert.ok(seen.find((event) => event.state === 'stalled'), 'the stall is surfaced as an event');
  assert.equal(readRenderStatus(runDir).state, 'stalled');
});

test('the stall window is configurable, and a window that is not a number falls back to the default', () => {
  assert.equal(renderStallMs({ minutes: 2, env: {} }), 120_000);
  assert.equal(renderStallMs({ env: { COMFYRIZZ_COLAB_RENDER_STALL_MINUTES: '7' } }), 420_000);
  assert.equal(renderStallMs({ env: {} }), 5 * 60_000);
  assert.equal(renderStallMs({ minutes: 0, env: {} }), 5 * 60_000);
});
