// P-fix3: a committed examples/*/timeline.json must equal a fresh compile of
// its package.json (with measured narration when audio/durations.json exists).
// This is the guard that caught the showcase-gpu2 drift: A6 repositioned
// foregrounds but the committed timeline kept the old positions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const examplesDir = join(repoRoot, 'examples');

/** The compiler narration options, mapped from a measured audio/durations.json. */
function optionsFromDurations(durations) {
  const narration = {};
  for (const [sceneId, scene] of Object.entries(durations.scenes ?? {})) {
    narration[sceneId] = scene.chunks.map(chunk => ({ text: chunk.text, seconds: chunk.seconds }));
  }
  return { narration, narrationGapSeconds: durations.gapSeconds, narrationPaddingSeconds: durations.paddingSeconds };
}

const examples = readdirSync(examplesDir)
  .map(name => join(examplesDir, name))
  .filter(dir => existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'timeline.json')));

for (const exampleDir of examples) {
  const name = exampleDir.slice(examplesDir.length + 1);
  test(`${name}: committed timeline.json matches a fresh compile`, () => {
    const pkg = JSON.parse(readFileSync(join(exampleDir, 'package.json'), 'utf8'));
    const committed = JSON.parse(readFileSync(join(exampleDir, 'timeline.json'), 'utf8'));
    const durationsPath = join(exampleDir, 'audio', 'durations.json');
    const options = existsSync(durationsPath) ? optionsFromDurations(JSON.parse(readFileSync(durationsPath, 'utf8'))) : {};
    const fresh = compileTimeline(pkg, options);
    assert.equal(
      JSON.stringify(committed),
      JSON.stringify(fresh),
      `${name}/timeline.json is stale (hash ${committed.hash} vs ${fresh.hash}); ` +
        `run "node apps/renderer/scripts/recompile-example-timeline.mjs --example examples/${name}"`,
    );
  });
}

test('the freshness guard covered the bundled examples', () => {
  assert.ok(examples.length >= 4, `expected to check the bundled examples, found ${examples.length}`);
});
