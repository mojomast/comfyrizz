/** Bundle the installed animation dependencies' notices alongside the browser code. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const renderer = join(root, 'apps/renderer/package.json');
const packages = new Map();
function locate(name, from) {
  const require = createRequire(from);
  try { return require.resolve(`${name}/package.json`); }
  catch {
    let dir = dirname(require.resolve(name));
    while (dirname(dir) !== dir) {
      const file = join(dir, 'package.json');
      if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).name === name) return file;
      dir = dirname(dir);
    }
    throw Error(`Cannot locate animation dependency ${name}`);
  }
}
function visit(name, from) {
  const file = locate(name, from), pkg = JSON.parse(readFileSync(file, 'utf8'));
  const key = `${pkg.name}@${pkg.version}`;
  if (packages.has(key)) return;
  const dir = dirname(file);
  const notices = readdirSync(dir).filter(name => /^(license|licence|copying|notice)(\.|$)/i.test(name)).sort();
  if (!notices.length) throw Error(`No license notice found for ${key}`);
  packages.set(key, notices.map(name => `${name}\n${readFileSync(join(dir, name), 'utf8')}`).join('\n'));
  for (const dependency of Object.keys(pkg.dependencies ?? {}).sort()) visit(dependency, file);
}
for (const name of ['roughjs', 'perfect-freehand', 'flubber', '@dagrejs/dagre']) visit(name, renderer);
const text = 'Comfyrizz animation pack — third-party software notices\n\nThese notices cover the installed CPU animation toolkit and its runtime dependencies.\nOther application dependencies retain their own notices and terms.\n\n' + [...packages].sort(([a], [b]) => a.localeCompare(b)).map(([name, text]) => `${'='.repeat(72)}\n${name}\n${'='.repeat(72)}\n${text.trim()}\n`).join('\n');
const output = join(root, 'apps/renderer/public/animation-licenses.txt');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, text);
console.log(`Animation notices: ${packages.size} packages → apps/renderer/public/animation-licenses.txt`);
