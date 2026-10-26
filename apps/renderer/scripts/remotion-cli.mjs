// Resolve the local Remotion CLI once, without `npx`. Native Windows cannot
// spawn the `npx` shim with shell:false, and every render already has the CLI
// installed in this package.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageUrl = new URL(import.meta.resolve('@remotion/cli/package.json'));
const pkg = JSON.parse(readFileSync(packageUrl, 'utf8'));
const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.remotion;
if (typeof bin !== 'string' || bin === '') throw new Error('@remotion/cli does not expose a remotion binary');

export const remotionCli = join(dirname(fileURLToPath(packageUrl)), bin);
