// Synchronous legacy helpers isolated in a cancellable local process group.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeMixLoudness } from '../../renderer/scripts/mix-loudness.mjs';
import { createExporter } from './export.mjs';
const [task, workDir, runDir] = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(join(workDir, 'package.json')));
if (task === 'normalize') {
  const result = normalizeMixLoudness(join(runDir, 'video.mp4'));
  writeFileSync(join(runDir, 'loudness.json'), JSON.stringify(result));
} else if (task === 'export') {
  const exporter = createExporter({ exportsDir: join(runDir, 'exports'), render: () => { throw new Error('Verified video must be reused'); } });
  const result = await exporter({ pkg, packagePath: join(workDir, 'package.json'), revision: pkg.revision, onLog: message => console.log(JSON.stringify({ event: 'export_progress', message })) });
  if (!result.complete) throw new Error(`Export incomplete: ${JSON.stringify(result.excluded)}`);
  writeFileSync(join(runDir, 'export.json'), JSON.stringify(result, null, 2));
} else throw new Error('Unknown CPU pipeline task');
