/**
 * Author-time metadata filler for bundled examples.
 *
 * Hand-written `package.json` files leave `llm-svg` assets without sha256/bytes
 * or a CPU render-check. This script reads each SVG, runs the A5 sanitizer and
 * render-check, records the real hashes, then validates the package. Run it
 * after editing an example's SVGs or copy:
 *
 *   npm --prefix packages/vector run build
 *   node examples/tools/author-package.mjs examples/product-explainer/package.json
 *
 * It never touches the network and only rewrites the fields it owns.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validatePackage } from '../../packages/schema/src/index.mjs';
import { renderCheck, sanitizeSvg, SANITIZER_VERSION } from '../../packages/vector/dist/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const packageArg = process.argv[2];
if (!packageArg) throw new Error('usage: node examples/tools/author-package.mjs <package.json>');
const packagePath = resolve(repoRoot, packageArg);
const packageDir = dirname(packagePath);

// Make sure the vector build is current before importing it.
const build = spawnSync('npm', ['run', 'build'], { cwd: join(repoRoot, 'packages', 'vector'), stdio: 'pipe', encoding: 'utf8' });
if (build.status !== 0) {
  process.stderr.write(build.stdout ?? '');
  process.stderr.write(build.stderr ?? '');
  throw new Error('packages/vector build failed');
}

const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
const palette = pkg.theme?.palette;
let updated = 0;

for (const [id, asset] of Object.entries(pkg.assets ?? {})) {
  if (asset?.gen?.generator !== 'llm-svg') continue;
  const file = join(packageDir, asset.file);
  const raw = readFileSync(file, 'utf8');
  const sanitized = sanitizeSvg(raw);
  if (!sanitized.ok) throw new Error(`${id}: sanitize failed: ${sanitized.errors.map(error => error.code).join(', ')}`);
  const check = renderCheck(sanitized.svg, { width: 512, palette });
  if (!check.ok) throw new Error(`${id}: render-check failed: ${check.errors.map(error => error.code).join(', ')}`);
  asset.status = 'ready';
  asset.sha256 = createHash('sha256').update(raw).digest('hex');
  asset.bytes = Buffer.byteLength(raw);
  asset.gen.sanitizer_version = SANITIZER_VERSION;
  asset.gen.render_check = {
    ok: true,
    version: SANITIZER_VERSION,
    rasterizer: 'resvg',
    width: check.width,
    height: check.height,
    palette_ok: check.outOfPaletteFraction === null || check.outOfPaletteFraction <= 0.5,
  };
  updated += 1;
  process.stdout.write(`authored ${id}: ${check.width}x${check.height} opaque=${(check.opaqueFraction * 100).toFixed(1)}%\n`);
}

writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
const validation = validatePackage(pkg);
for (const warning of validation.warnings ?? []) process.stdout.write(`warn ${warning.code} ${warning.path}: ${warning.message}\n`);
if (!validation.valid) {
  for (const error of validation.errors) process.stderr.write(`FAIL ${error.code} ${error.path}: ${error.message}\n`);
  throw new Error(`${packageArg} is invalid`);
}
process.stdout.write(`authored ${updated} llm-svg asset(s); ${packageArg} VALID\n`);
