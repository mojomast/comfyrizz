import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pipelineCommand } from '../src/pipeline-process.mjs';

test('pipelineCommand accepts an allowed narration-mismatch exit code', async () => {
  const result = await pipelineCommand(process.execPath, ['-e', 'process.exit(2)'], { allowedCodes: [0, 2] });
  assert.equal(result.code, 2);
});

test('pipelineCommand rejects exit codes outside the allowed set', async () => {
  await assert.rejects(
    () => pipelineCommand(process.execPath, ['-e', 'process.exit(3)'], { allowedCodes: [0, 2] }),
    /exited 3/,
  );
  await assert.rejects(
    () => pipelineCommand(process.execPath, ['-e', 'process.exit(2)']),
    /exited 2/,
  );
});
