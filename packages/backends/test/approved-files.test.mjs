import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fingerprintJobFiles } from '../src/approved-files.mjs';

test('approved input files bind bytes and cannot escape through symlinks', t => {
  const root = mkdtempSync(join(tmpdir(), 'approved-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'reference.png');
  writeFileSync(path, 'first');
  const jobs = [{ fileInputs: [{ from: 'package', path: 'reference.png' }] }];
  const first = fingerprintJobFiles(jobs, root);
  writeFileSync(path, 'changed');
  assert.notDeepEqual(fingerprintJobFiles(jobs, root), first);
  symlinkSync('/etc/passwd', join(root, 'outside'));
  assert.throws(() => fingerprintJobFiles([{ fileInputs: [{ from: 'package', path: 'outside' }] }], root), /escapes/);
});
