// Google Colab run8: the chain-frames dir must be created before ffmpeg writes the last frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { runFfmpegArgs } from '../../src/run.mjs';
import { createLastFrameExtractor } from '../../src/ref-watch/last-frame.mjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('the last frame lands in a chain-frames dir that did not exist yet', { skip: !hasFfmpeg }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'chain-'));
  const clip = join(root, 'clip.mp4');
  assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=8:duration=1', '-pix_fmt', 'yuv420p', clip]).status, 0);
  const extract = createLastFrameExtractor({ runFfmpeg: runFfmpegArgs, outDir: join(root, 'receipts', 'chain-frames') });
  const frame = await extract({ id: 'c1', localPath: clip });
  assert.ok(existsSync(frame.path));
});
