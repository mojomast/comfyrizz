/**
 * C1 dev export CLI: package JSON -> shared CPU render. The C2 server imports
 * the same library instead of spawning this script.
 */
import { resolve } from 'node:path';
import { renderPackage } from '../../renderer/scripts/render-package-lib.mjs';

const packagePath = resolve(process.argv[2] ?? '');
if (!packagePath) throw new Error('usage: render-package.mjs <package.json> [output.mp4]');
const output = resolve(process.argv[3] ?? packagePath.replace(/\.package\.json$/, '.mp4'));
const result = renderPackage(packagePath, output, { onLog: line => process.stderr.write(`${line}\n`) });
process.stdout.write(`OUTPUT=${result.output}\n`);
process.stdout.write(`FRAMES=${result.frames}\nHASH=${result.hash}\nBYTES=${result.bytes}\n`);
