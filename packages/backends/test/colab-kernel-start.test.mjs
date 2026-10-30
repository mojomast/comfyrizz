import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createColabBackend } from '../src/colab-backend.mjs';

for (const beforeSubmission of [true, false]) test(`bootstrap ${beforeSubmission ? 'reconnects before' : 'does not replay uncertain'} script submission`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'colab-kernel-start-'));
  const calls = [];
  writeFileSync(join(dir, 'token'), 'test-only');
  let attempts = 0;
  const cli = { async run(args) {
    calls.push(args);
    if (args.includes('hf_token_dir.py')) {
      attempts++;
      if (attempts === 1) return { code: 1, output: beforeSubmission
        ? `execution.py:217 in exec_command\n"import os; os.makedirs('/content', exist_ok=True); os.chdir('/content')"\nRuntimeError: Connection was lost.`
        : 'RuntimeError: Connection was lost.' };
      return { code: 0, output: 'COMFYRIZZ_OK hf-token-dir' };
    }
    if (args.includes('bootstrap.py')) return { code: 0, output: 'COMFYRIZZ_OK bootstrap' };
    return { code: 0, output: 'ok' };
  } };
  const backend = createColabBackend({ cli, packageId: 'pkg_kernel_start', scratchDir: dir, hfTokenPath: join(dir, 'token') });
  try {
    if (beforeSubmission) {
      assert.equal((await backend.bootstrap()).code, 0);
      assert.equal(attempts, 2);
      assert.equal(calls.filter(args => args.includes('bootstrap.py')).length, 1);
    } else {
      await assert.rejects(backend.bootstrap());
      assert.equal(attempts, 1);
      assert.ok(!calls.some(args => args.includes('bootstrap.py')));
    }
    assert.ok(!calls.some(args => args[0] === 'new'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
