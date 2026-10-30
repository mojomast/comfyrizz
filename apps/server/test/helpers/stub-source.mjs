// Source bytes for tests whose renderer is explicitly stubbed. These files are
// deliberately not decodable media or evidence of real model generation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function writeStubSource(pkg, packageDir, assetId) {
  const asset = pkg.assets[assetId];
  assert.match(asset.file, /^assets\/[A-Za-z0-9_./@-]+$/);
  assert(!asset.file.split('/').includes('..'));
  const bytes = Buffer.from(`Synthetic source for mocked renderer: ${assetId}`);
  const file = join(packageDir, asset.file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  Object.assign(asset, { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
}
