import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plannerProgressAnnouncement } from './plan-writer.ts';

test('planner announcements expose the current model, tool, phase and elapsed time', () => {
  assert.equal(
    plannerProgressAnnouncement({ phase: 'initial', activity: 'model_waiting', step: 2, maxSteps: 16, elapsedMs: 43000 }),
    'Planning initial plan · step 2/16 · waiting for model · 43s',
  );
  assert.equal(
    plannerProgressAnnouncement({ phase: 'repair', activity: 'model_streaming', milestone: 'first_reasoning', step: 1, elapsedMs: 5200 }),
    'Planning repair · step 1 · first reasoning · 5s',
  );
  assert.equal(
    plannerProgressAnnouncement({ phase: 'initial', activity: 'tool_complete', step: 3, lastTool: { name: 'assets.generate_video', durationMs: 1250 }, elapsedMs: 48000 }),
    'Planning initial plan · step 3 · assets.generate_video 1s · 48s',
  );
  assert.equal(
    plannerProgressAnnouncement({ phase: 'repair', activity: 'validation', elapsedMs: 90000 }),
    'Planning repair · validating package · 90s',
  );
});
