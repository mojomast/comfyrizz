// Synchronous legacy helpers isolated in a cancellable local process group.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeMixLoudness } from '../../renderer/scripts/mix-loudness.mjs';
import { createExporter } from './export.mjs';
import { verifyPreparedCompositions } from '../../renderer/scripts/composition-worker.mjs';
const [task, workDir, runDir] = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(join(workDir, 'package.json')));
if (task === 'normalize') {
  const result = normalizeMixLoudness(join(runDir, 'video.mp4'));
  writeFileSync(join(runDir, 'loudness.json'), JSON.stringify(result));
} else if (task === 'export') {
  const rendered = JSON.parse(readFileSync(join(runDir, 'render.json')));
  const exporter = createExporter({ exportsDir: join(runDir, 'exports'), render: () => { throw new Error('Verified video must be reused'); },
    ...(rendered.location === 'colab' ? { materialize: verifyPreparedCompositions } : {}) });
  const verifiedVideoSha256 = createHash('sha256').update(readFileSync(join(runDir, 'video.mp4'))).digest('hex');
  const result = await exporter({ pkg, packagePath: join(workDir, 'package.json'), revision: pkg.revision, verifiedVideoSha256, onLog: message => console.log(JSON.stringify({ event: 'export_progress', message })) });
  if (!result.complete) throw new Error(`Export incomplete: ${JSON.stringify(result.excluded)}`);
  writeFileSync(join(runDir, 'export.json'), JSON.stringify(result, null, 2));
} else throw new Error('Unknown CPU pipeline task');
