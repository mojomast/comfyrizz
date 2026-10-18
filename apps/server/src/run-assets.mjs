// G5-10: after a run, every file the applied package names must reach the package dir.
//
// The runner writes collected files under the run's own output dir, keyed by the same relative
// paths the package uses (upscaled cuts under `assets/<id>.mp4`, non-upscaled plates under
// `out/intermediates/<id>.plate.mp4`). `completeRun` used to copy only `<outputDir>/assets`, so
// the plates stayed on the VM side of the copy and the renderer drew placeholders. Copying every
// named file (asset `file` plus H12 `variants.*.file`) keeps the two in step without hard-coding
// the intermediate folder.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Every relative path a package names, asset `file`s first then variant files, de-duplicated. */
export function namedAssetFiles(pkg) {
  const files = new Set();
  for (const asset of Object.values(pkg?.assets ?? {})) {
    if (!asset || typeof asset !== 'object') continue;
    if (typeof asset.file === 'string' && asset.file) files.add(asset.file);
    if (asset.variants && typeof asset.variants === 'object') {
      for (const variant of Object.values(asset.variants)) {
        if (variant && typeof variant.file === 'string' && variant.file) files.add(variant.file);
      }
    }
  }
  return [...files];
}

/** True when `file` is a relative path that stays inside `root` (no absolute path, no `..` escape). */
export function isInside(root, file) {
  if (typeof file !== 'string' || file.length === 0 || isAbsolute(file)) return false;
  const rel = relative(resolve(root), resolve(root, file));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`);
}

/**
 * Copy each file the applied package names from the run's output dir into the package dir,
 * preserving the relative path. Missing files are skipped (a partial run keeps what it has);
 * escaping paths are skipped so a package can never write outside its own dir.
 *
 * @returns {string[]} the relative paths actually copied
 */
export function copyNamedAssets({ pkg, outputDir, packageDir }) {
  const copied = [];
  for (const file of namedAssetFiles(pkg)) {
    if (!isInside(outputDir, file)) continue;
    const source = join(outputDir, file);
    if (!existsSync(source)) continue;
    const dest = join(packageDir, file);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(source, dest);
    copied.push(file);
  }
  return copied;
}
