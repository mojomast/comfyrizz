import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ColabCli } from '../src/cli.mjs';

test('default CLI logs use os.tmpdir rather than a hard-coded /tmp fallback', t => {
  const root = mkdtempSync(join(tmpdir(), 'comfyrizz-cli-tmpdir-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.mock.method(os, 'tmpdir', () => root);
  const cli = new ColabCli({ bin: 'not-run-in-this-test' });
  assert.equal(cli.logDir, join(root, `comfyrizz-colab-${process.pid}`));
});
