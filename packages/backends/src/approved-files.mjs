import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

// Bind the actual package-file inputs, not only their paths in the jobs JSON.
export function fingerprintJobFiles(jobs, root) {
  const paths = new Set();
  for (const job of jobs) for (const input of job.fileInputs ?? []) {
    if (input.from !== 'package') continue;
    if (typeof input.path !== 'string' || !input.path || isAbsolute(input.path)) throw new Error('Invalid package input path.');
    paths.add(input.path);
  }
  const realRoot = realpathSync(root);
  return [...paths].sort().map(path => {
    const target = realpathSync(resolve(realRoot, path));
    const rel = relative(realRoot, target);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !statSync(target).isFile()) {
      throw new Error('A generation input escapes the package directory.');
    }
    return { path, sha256: createHash('sha256').update(readFileSync(target)).digest('hex') };
  });
}
