/**
 * P-fix3 freshness helper.
 *
 * The strong check recompiles an example's committed timeline.json from
 * package.json plus its measured audio/durations.json and requires an exact
 * match. Some examples (e.g. the earliest narrated ones) may not commit
 * audio/durations.json though, so a clean clone cannot recompile with measured
 * narration. In that case we fall back to checking the committed timeline
 * against the committed narration-report.json frame counts, which still catches
 * timing drift, and report the weaker mode to the caller.
 *
 * test/timeline-freshness.test.mjs uses this; the fallback exists so the guard
 * passes from a clean worktree instead of failing on a provisional compile.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';

/** The compiler narration options, mapped straight from a durations.json. */
export function optionsFromDurations(durations) {
  const narration = {};
  for (const [sceneId, scene] of Object.entries(durations.scenes ?? {})) {
    narration[sceneId] = scene.chunks.map(chunk =>
      chunk.words && chunk.words.length > 0
        ? { text: chunk.text, seconds: chunk.seconds, words: chunk.words }
        : { text: chunk.text, seconds: chunk.seconds },
    );
  }
  return {
    narration,
    narrationGapSeconds: durations.gapSeconds,
    narrationPaddingSeconds: durations.paddingSeconds,
  };
}

const isNarrated = pkg =>
  (pkg.voice?.enabled ?? false) &&
  (pkg.scenes ?? []).some(scene => typeof scene.narration === 'string' && scene.narration.trim().length > 0);

const sameTimeline = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Assess one example directory (must contain package.json + timeline.json).
 * Returns { mode: 'measured' | 'report' | 'plain', ok, detail }.
 */
export function assessFreshness(exampleDir) {
  const name = basename(exampleDir);
  const pkg = JSON.parse(readFileSync(join(exampleDir, 'package.json'), 'utf8'));
  const committed = JSON.parse(readFileSync(join(exampleDir, 'timeline.json'), 'utf8'));
  const durationsPath = join(exampleDir, 'audio', 'durations.json');
  const reportPath = join(exampleDir, 'narration-report.json');

  if (existsSync(durationsPath)) {
    const durations = JSON.parse(readFileSync(durationsPath, 'utf8'));
    const fresh = compileTimeline(pkg, optionsFromDurations(durations));
    return {
      mode: 'measured',
      ok: sameTimeline(committed, fresh),
      detail: `hash ${committed.hash} vs ${fresh.hash}`,
    };
  }

  if (isNarrated(pkg) && existsSync(reportPath)) {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const frames = new Map((committed.scenes ?? []).map(scene => [scene.id, scene.durationInFrames]));
    const mismatches = [];
    if (committed.durationInFrames !== report.durationInFrames) {
      mismatches.push(`total ${committed.durationInFrames} vs report ${report.durationInFrames}`);
    }
    for (const scene of report.scenes ?? []) {
      if (frames.get(scene.id) !== scene.frames) {
        mismatches.push(`${scene.id} ${frames.get(scene.id)} vs report ${scene.frames}`);
      }
    }
    return {
      mode: 'report',
      ok: mismatches.length === 0,
      detail: mismatches.length
        ? `no committed audio/durations.json; ${mismatches.join('; ')}`
        : `no committed audio/durations.json; ${report.scenes?.length ?? 0} scenes match narration-report.json (foreground drift not covered)`,
    };
  }

  const fresh = compileTimeline(pkg, {});
  return {
    mode: 'plain',
    ok: sameTimeline(committed, fresh),
    detail: `hash ${committed.hash} vs ${fresh.hash}`,
  };
}
