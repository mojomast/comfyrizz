import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remoteConcurrency } from '../scripts/render-remote-entry.mjs';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preparePublicDir } from '../scripts/render-package-lib.mjs';

test('a Google Colab render uses the VM CPUs up to 8', () => {
  assert.equal(remoteConcurrency(2), 2);
  assert.equal(remoteConcurrency(16), 8);
  assert.equal(remoteConcurrency(0), 1);
  assert.equal(remoteConcurrency(Number.NaN), 1);
});

test('VM-linked generated media becomes real public bytes for the Remotion bundle', t => {
  const root = mkdtempSync(join(tmpdir(), 'colab-linked-media-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'), generated = join(root, 'generated.mp4');
  mkdirSync(join(project, 'out/intermediates'), { recursive: true });
  writeFileSync(generated, 'generated video bytes');
  symlinkSync(generated, join(project, 'out/intermediates/plate.mp4'));
  const staged = preparePublicDir({ assets: { a_plate: { kind: 'video', file: 'out/intermediates/plate.mp4' } } }, project);
  t.after(() => rmSync(staged, { recursive: true, force: true }));
  const media = join(staged, 'out/intermediates/plate.mp4');
  assert.equal(lstatSync(media).isSymbolicLink(), false);
  rmSync(generated);
  assert.equal(readFileSync(media, 'utf8'), 'generated video bytes');
});
