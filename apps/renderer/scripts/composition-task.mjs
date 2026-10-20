// Bridge for the legacy synchronous renderer. Production uses the cancellable
// async materializer directly; only the existing synchronous path uses stdin IPC.
import { readFileSync } from 'node:fs';
import { materializeCompositions } from './composition-worker.mjs';

const controller = new AbortController();
const abort = () => controller.abort(new Error('Composition preparation cancelled'));
process.once('SIGTERM', abort);
process.once('SIGINT', abort);
try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const result = await materializeCompositions({ ...input, signal: controller.signal });
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGTERM', abort);
  process.removeListener('SIGINT', abort);
}
