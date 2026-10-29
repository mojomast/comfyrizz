import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCpuAgentRunner } from '../src/agent-runner.mjs';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { validatePackage } from '../../../packages/schema/src/index.mjs';

test('offline motion-explainer preserves explicit exact duration through the package', async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'exact-duration-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const run = createCpuAgentRunner({ runtimeDir });
  const result = await run({ brief: 'Draw a motion graphics explainer. Length: exactly 45 seconds. No narration.', videoType: 'motion-explainer' });
  assert.deepEqual(result.package.duration, { mode: 'target', targetFrames: 1350, exact: true });
  assert.equal(validatePackage(result.package).valid, true);
  assert.equal(compileTimeline(result.package).durationInFrames, 1350);
});
