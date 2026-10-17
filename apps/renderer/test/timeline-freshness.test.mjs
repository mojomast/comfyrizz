// P-fix3: a committed examples/*/timeline.json must equal a fresh compile of
// its package.json (with measured narration when audio/durations.json exists).
// This is the guard that caught the showcase-gpu2 drift: A6 repositioned
// foregrounds but the committed timeline kept the old positions.
//
// Some examples do not commit audio/durations.json, so a clean worktree cannot
// recompile with measured narration. Those fall back to checking the committed
// timeline against narration-report.json and are reported as the weaker
// 'report' mode (see scripts/timeline-freshness.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { assessFreshness } from '../scripts/timeline-freshness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const examplesDir = join(repoRoot, 'examples');

const examples = readdirSync(examplesDir)
  .map(name => join(examplesDir, name))
  .filter(dir => existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'timeline.json')));

for (const exampleDir of examples) {
  const name = exampleDir.slice(examplesDir.length + 1);
  test(`${name}: committed timeline.json matches a fresh compile`, t => {
    const result = assessFreshness(exampleDir);
    if (result.mode !== 'measured') t.diagnostic(`${name}: ${result.detail}`);
    assert.ok(
      result.ok,
      `${name}/timeline.json is stale (${result.detail}); ` +
        `run "node apps/renderer/scripts/recompile-example-timeline.mjs --example examples/${name}"`,
    );
  });
}

test('the freshness guard covered the bundled examples', () => {
  assert.ok(examples.length >= 4, `expected to check the bundled examples, found ${examples.length}`);
});

// The fallback path is what lets a clean clone pass for an example whose audio/
// is not committed. Exercise it with a narrated example whose durations.json is
// absent: the report-frame check still passes, then catches tampering.
test('narration-report fallback checks frames when durations.json is absent', () => {
  const source = join(examplesDir, 'willem-birthday');
  const dir = mkdtempSync(join(tmpdir(), 'freshness-fallback-'));
  try {
    for (const file of ['package.json', 'timeline.json', 'narration-report.json']) {
      cpSync(join(source, file), join(dir, file));
    }

    const fallback = assessFreshness(dir);
    assert.equal(fallback.mode, 'report');
    assert.ok(fallback.ok, fallback.detail);

    const reportPath = join(dir, 'narration-report.json');
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    report.scenes[0].frames += 30;
    writeFileSync(reportPath, JSON.stringify(report));
    assert.equal(assessFreshness(dir).ok, false, 'the fallback must catch frame drift');

    // Without a report the guard has nothing measured to compare against, so it
    // compiles plain and the provisional timeline will not match.
    rmSync(join(dir, 'narration-report.json'));
    assert.equal(assessFreshness(dir).mode, 'plain');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
