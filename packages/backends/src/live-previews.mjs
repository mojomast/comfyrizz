// Download only manifest-confirmed media while a batch is still generating. This
// is a separate cache: final collection and its success verdict remain authoritative.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

export function createLivePreviewCollector({ jobsDoc, directory, remoteRoot, download, onReady, onError = () => {} }) {
  const jobs = new Set((jobsDoc.jobs ?? []).map(job => job.id));
  const seen = new Set();
  let stopped = false;
  let pending = null;
  let timer;
  mkdirSync(directory, { recursive: true });

  async function collect() {
    const manifestFile = join(directory, 'manifest.preview.json');
    await download({ remote: `${remoteRoot}/manifest.json`, local: manifestFile });
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    if (!jobsDoc.hash || manifest.jobsHash !== jobsDoc.hash || manifest.packageId !== jobsDoc.packageId) {
      throw new Error('Live preview manifest does not match this plan');
    }
    // Prioritize motion previews when attaching to a run with a backlog of stills.
    const entries = [...(manifest.jobs ?? [])].sort((a, b) => Number(/\.(mp4|webm)$/i.test(b.outputs?.[0]?.relative ?? '')) - Number(/\.(mp4|webm)$/i.test(a.outputs?.[0]?.relative ?? '')));
    for (const entry of entries) {
      if (stopped) break;
      if (!jobs.has(entry.job) || !['succeeded', 'cached'].includes(entry.status)) continue;
      const output = entry.outputs?.[0];
      const path = output?.relative;
      if (typeof path !== 'string' || isAbsolute(path) || path.split(/[\\/]/).some(part => !part || part === '..' || part === '.')
        || !/\.(mp4|webm|png|jpe?g|webp|wav)$/i.test(path) || !/^[a-f0-9]{64}$/i.test(output.sha256 ?? '')) continue;
      const key = `${entry.job}:${output.sha256}`;
      if (seen.has(key)) continue;
      const local = join(directory, path);
      const temporary = `${local}.partial`;
      mkdirSync(dirname(local), { recursive: true });
      try {
        await download({ remote: `${remoteRoot}/${path}`, local: temporary });
        const bytes = readFileSync(temporary);
        if ((Number.isSafeInteger(output.bytes) && output.bytes !== bytes.length)
          || createHash('sha256').update(bytes).digest('hex') !== output.sha256.toLowerCase()) {
          throw new Error(`Live preview verification failed: ${entry.job}`);
        }
        renameSync(temporary, local);
        await onReady({ manifest: { ...manifest, complete: false, jobs: [{ ...entry, outputs: [output] }] }, outputDir: directory });
        seen.add(key);
      } catch (error) {
        onError(error);
      } finally {
        rmSync(temporary, { force: true });
      }
    }
  }

  function poll() {
    if (pending) return pending;
    pending = collect().finally(() => { pending = null; });
    return pending;
  }
  return {
    poll,
    start(intervalMs = 10000) {
      const tick = async () => {
        try { await poll(); } catch (error) { onError(error); }
        if (!stopped) timer = setTimeout(tick, intervalMs);
      };
      timer = setTimeout(tick, intervalMs);
    },
    async stop() { stopped = true; clearTimeout(timer); await pending?.catch(onError); },
  };
}
