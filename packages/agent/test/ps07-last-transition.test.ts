// PS07: the CPU slice normalizes the true last scene's outgoing transition to a
// cut so a valid plan never fails compile with "Scene ... has a transition but is
// the last scene". Any remaining untyped slice failure is a 422, never a 500.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCpuSlice } from '../src/cpu-slice.js';
import { createScriptedModel } from '../src/scripted-model.js';
import type { ChatChunk, ChatModel, ChatRequest } from '../src/types.js';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#6d8cff"/></svg>';
const BRIEF = 'Create a two-scene motion-graphics sequence. No narration.';

function generateSvg() {
  return {
    svg: SVG,
    attempts: 1,
    repairs: 0,
    sanitizerVersion: '1.0.0',
    renderCheck: { ok: true, version: '1.0.0', width: 512, height: 512, opaqueFraction: 0.8, outOfPaletteFraction: 0 },
  };
}

function scriptedPackage(finalTransition: Record<string, unknown> | null) {
  return createScriptedModel([
    {
      name: 'storyboard.propose',
      args: {
        brief: BRIEF,
        title: 'Two Scenes',
        scenes: [
          { id: 's1', layout: 'title', preferredFrames: 120, copy: { headline: 'One' }, transitionOut: { type: 'fade', frames: 15 } },
          {
            id: 's2',
            layout: 'hero',
            preferredFrames: 120,
            copy: { headline: 'Two' },
            ...(finalTransition ? { transitionOut: finalTransition } : {}),
          },
        ],
      },
    },
  ]);
}

test('PS07 clears the final scene fade to a cut/0 before packaging', async () => {
  const slice = await runCpuSlice({
    brief: BRIEF,
    model: scriptedPackage({ type: 'fade', frames: 15 }),
    generateSvg,
    now: () => '2026-10-28T00:00:00.000Z',
  });

  assert.deepEqual(slice.package.scenes[0].transitionOut, { type: 'fade', frames: 15 });
  assert.deepEqual(slice.package.scenes.at(-1).transitionOut, { type: 'cut', frames: 0 });
});

test('PS07 leaves a final scene without a transition untouched', async () => {
  const slice = await runCpuSlice({
    brief: BRIEF,
    model: scriptedPackage(null),
    generateSvg,
    now: () => '2026-10-28T00:00:00.000Z',
  });

  assert.equal('transitionOut' in slice.package.scenes.at(-1), false);
});

test('PS07 converts an untyped slice failure into an actionable 422', async () => {
  const model: ChatModel = {
    id: 'explode',
    async *stream(_request: ChatRequest): AsyncIterable<ChatChunk> {
      throw new Error('provider stream terminated');
    },
  };

  await assert.rejects(
    () => runCpuSlice({ brief: BRIEF, model, generateSvg }),
    (error: any) => {
      assert.equal(error.name, 'CpuSliceError');
      assert.equal(error.status, 422);
      assert.equal(error.code, 'CPU_SLICE_FAILED');
      assert.match(error.message, /provider stream terminated/);
      return true;
    },
  );
});
